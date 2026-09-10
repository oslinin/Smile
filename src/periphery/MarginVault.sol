// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { AquaApp } from "@1inch/aqua/src/AquaApp.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { IPriceOracle } from "@1inch/swap-vm/src/instructions/interfaces/IPriceOracle.sol";

import { SmileMath } from "../swapvm/SmileMath.sol";
import { AquaOptionSettlement } from "../vaults/AquaOptionSettlement.sol";
import { OptionToken } from "../OptionToken.sol";
import { OptionTokenFactory } from "../OptionTokenFactory.sol";
import { MarginBackstop } from "./MarginBackstop.sol";
import { SmilePremiumLib } from "./SmilePremiumLib.sol";

interface IBetaSource {
    function beta() external view returns (int256);
}

/// @notice Opt-in true-margin sibling vault (S13, rung 4 of the capital-
/// efficiency ladder — design: Part B of
/// docs/plans/2026-09-05-ethonline2026-continuation-track.md).
///
/// v1 scope: short PUTS, USDC only. A put writer posts initial margin — a
/// fraction of the strike keyed off a conservative Chainlink mark — instead
/// of the full strike the main vault locks, and a margin-call / takeover /
/// backstop waterfall stands behind the holder. The promise "a written
/// option always pays" can break here, but only inside this vault, only
/// after writer margin, a takeover bidder, the backstop pool and the
/// insurance fund are all empty — and never because sigma moved: margin
/// reads the oracle only, never the vault's own vol hook.
///
/// Separate AquaApp, same pattern as SpreadVault/FirmEscrow —
/// `AquaCollateralVault` is never touched.
///
/// Scope so far: B1 scaffold — ranges shipped to Aqua, own settlement and
/// backstop wiring, the timelocked vol-buffer ratchet; B2 — the worst-of-
/// hour Chainlink mark and the sigma-free margin rule; B3 — buy() pulls
/// only initial margin, under a naked-notional ceiling sized off the
/// backstop, with pull-based fee splits.
contract MarginVault is AquaApp, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A put range the writer ships: any strike in [strikeMin,
    /// strikeMax] at `expiry`, up to `maxCapacity` USDC of margin pulled
    /// JIT. `autoTopUp` opts the same Aqua allowance in as a credit line for
    /// margin calls (B4). `lpMarginBps` lets a writer post more than the
    /// vault minimum (0 = vault IM).
    struct Range {
        address lp;
        uint256 strikeMin;
        uint256 strikeMax;
        uint256 expiry;
        uint256 maxCapacity;
        bool active;
        bool autoTopUp;
        uint16 lpMarginBps;
        uint16 sigmaMulBps;
        bytes32 strategyHash;
        uint32 feeBps;
        int256 beta;
        uint16 spotStaleness;
    }

    /// @notice One pooled series per (strike, expiry) so takeovers are
    /// fungible across writers.
    struct Series {
        uint256 strike;
        uint256 expiry;
        address token;
        uint256 totalUnits;
        uint256 positionCount;
        uint256 settledPositions;
        uint256 owedTotal;
        uint256 pot;
        uint256 backstopDrawn;
        bool finalized;
        uint256 payoutPerUnit;
        uint16 haircutBps;
    }

    /// @notice A writer's short in one series. `locked` is the margin held
    /// here; it travels with the position on takeover.
    struct Position {
        uint256 authId;
        uint256 units;
        uint256 locked;
        uint64 flaggedAt;
        uint64 auctionStart;
        address flagger;
    }

    struct Account {
        uint256 free;
        uint256 badDebt;
    }

    /// @dev Premium terms snapshotted at open — the same knobs as the main
    /// vault's AuthPricing, so a margined put quotes exactly like a fully
    /// collateralized one. Margin never reads these.
    struct Pricing {
        uint16 baseSpreadBps;
        uint16 stalenessSpreadBpsPerHour;
        uint64 impactPerUnit;
    }

    bytes32 private constant MARGIN_STRATEGY_TYPE = keccak256("SMILE-MARGIN-1");
    uint16 public constant MAX_BUFFER_STEP_BPS = 1000;
    uint256 public constant MM_BUFFER_DELAY = 24 hours;
    /// @notice The mark is the lowest answer posted in this window (one
    /// mainnet heartbeat), so a single spike can't liquidate anyone and a
    /// single dip can't be hidden by a later round.
    uint256 public constant MARK_WINDOW = 1 hours;
    /// @notice Past this, fills and withdrawals stop; liquidation keeps working.
    uint256 public constant MARK_STALE_AFTER = 90 minutes;
    // ponytail: bounded round walk — a feed posting >64 rounds/hour makes the
    // mark see less than the full hour, never revert.
    uint256 internal constant MAX_MARK_ROUNDS = 64;

    address public immutable usdc;
    uint8 public immutable usdcDecimals;
    IPriceOracle public immutable oracle;
    address public immutable hook;
    OptionTokenFactory public immutable tokenFactory;
    address public settlement;
    MarginBackstop public backstop;

    /// @notice Spot buffers over intrinsic, in bps of spot per unit: IM at
    /// fill, MM the liquidation floor (B2). IM raises apply at once; MM
    /// raises wait {MM_BUFFER_DELAY} so open writers can top up first.
    uint16 public imBufferBps = 5000;
    uint16 public mmBufferBps = 3000;
    uint16 public pendingMmBufferBps;
    uint64 public pendingMmAt;

    uint256 public maxSpotStaleness = 1 hours;
    uint32 public protocolFeeBps;
    uint16 public defaultBaseSpreadBps;
    uint16 public defaultStalenessSpreadBpsPerHour;
    uint64 public defaultImpactPerUnit;

    /// @notice Fills must leave at least this long to expiry, so a margin
    /// call has a grace period and an auction before settlement.
    uint256 public constant MIN_TIME_TO_EXPIRY = 3 hours;
    /// @notice Naked notional may never exceed this multiple of the backstop
    /// pool — the Maker debt-ceiling idea: exposure is bounded by what could
    /// actually absorb a default.
    uint256 public constant BACKSTOP_MULTIPLE = 10;

    /// @notice Owner ceiling on naked notional (USDC); the effective ceiling
    /// is `min(notionalCeiling, backstop.totalAssets() * BACKSTOP_MULTIPLE)`.
    uint256 public notionalCeiling;
    /// @notice Sum over open positions of `K*units - margin locked at fill`.
    uint256 public nakedNotional;
    /// @notice Fee split (bps of the protocol fee): insurance, backstop, the rest to `dao`.
    uint16 public insuranceFeeBps = 5000;
    uint16 public backstopFeeBps = 3000;
    address public dao;
    uint256 public insuranceFund;
    mapping(address => uint256) public claimable;

    uint256 public nextAuthId;
    mapping(uint256 => Range) public ranges;
    mapping(uint256 => Pricing) public pricingOf;
    mapping(bytes32 => Series) public seriesOf;
    mapping(bytes32 => mapping(address => Position)) public positions;
    mapping(address => Account) public accounts;

    error ExpiryInPast();
    error ZeroCapacity();
    error InvalidRange();
    error UnknownRange();
    error NotLp();
    error AlreadySet();
    error BufferOnlyTightens();
    error BufferStepTooLarge();
    error MmAboveIm();
    error NothingPending();
    error TooEarly();
    error RangeInactive();
    error StrikeOutOfRange();
    error TooCloseToExpiry();
    error ZeroAmount();
    error StaleMark();
    error NakedCeiling(uint256 wouldBe, uint256 ceiling);
    error PremiumAboveMax();
    error SelfOnly();
    error NothingToClaim();

    event RangeOpened(
        uint256 indexed authId,
        address indexed lp,
        uint256 strikeMin,
        uint256 strikeMax,
        uint256 expiry,
        uint256 maxCapacity,
        bool autoTopUp
    );
    event RangeClosed(uint256 indexed authId);
    event VolBufferScheduled(uint16 imBufferBps, uint16 mmBufferBps, uint64 mmEffectiveAt);
    event VolBufferApplied(uint16 mmBufferBps);
    /// @dev Same ABI as AquaCollateralVault.OptionBought so indexers and the
    /// frontend consume every vault with one decoder. `premium` includes the fee.
    event OptionBought(
        uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium
    );
    event MarginLocked(bytes32 indexed sid, address indexed writer, uint256 pulled, uint256 fromFree, uint256 notional);
    event InsuranceFunded(address indexed from, uint256 amount);

    constructor(address aqua_, address oracle_, address hook_, address owner_, address tokenFactory_, address usdc_)
        AquaApp(IAqua(aqua_))
        Ownable(owner_)
    {
        oracle = IPriceOracle(oracle_);
        hook = hook_;
        tokenFactory = OptionTokenFactory(tokenFactory_);
        usdc = usdc_;
        usdcDecimals = IERC20Metadata(usdc_).decimals();
        dao = owner_;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice One-time wiring; the settlement's registrar must be this vault.
    function setSettlement(address settlement_) external onlyOwner {
        require(settlement == address(0), AlreadySet());
        settlement = settlement_;
    }

    /// @notice One-time wiring of the backstop pool the naked-notional
    /// ceiling is sized against.
    function setBackstop(address backstop_) external onlyOwner {
        require(address(backstop) == address(0), AlreadySet());
        backstop = MarginBackstop(backstop_);
    }

    /// @notice Governance only tightens: neither buffer can go down, a step
    /// is at most +{MAX_BUFFER_STEP_BPS}, MM never exceeds IM. The IM raise
    /// hits new fills immediately; the MM raise is queued for
    /// {MM_BUFFER_DELAY} so nobody is liquidated by a parameter change they
    /// had no time to answer.
    function scheduleVolBuffer(uint16 im, uint16 mm) external onlyOwner {
        uint16 mmBase = pendingMmAt != 0 ? pendingMmBufferBps : mmBufferBps;
        require(mm <= im, MmAboveIm());
        require(im >= imBufferBps && mm >= mmBase, BufferOnlyTightens());
        require(im - imBufferBps <= MAX_BUFFER_STEP_BPS && mm - mmBase <= MAX_BUFFER_STEP_BPS, BufferStepTooLarge());
        imBufferBps = im;
        pendingMmBufferBps = mm;
        pendingMmAt = uint64(block.timestamp + MM_BUFFER_DELAY);
        emit VolBufferScheduled(im, mm, pendingMmAt);
    }

    /// @notice Anyone applies a matured MM raise.
    function applyVolBuffer() external {
        require(pendingMmAt != 0, NothingPending());
        require(block.timestamp >= pendingMmAt, TooEarly());
        mmBufferBps = pendingMmBufferBps;
        pendingMmAt = 0;
        pendingMmBufferBps = 0;
        emit VolBufferApplied(mmBufferBps);
    }

    function setProtocolFee(uint32 feeBps_) external onlyOwner {
        require(feeBps_ <= 0.05e9, "fee too high");
        protocolFeeBps = feeBps_;
    }

    /// @notice R3/R4 + R2 premium defaults snapshotted into NEW ranges.
    function setPricingDefaults(uint16 baseSpreadBps_, uint16 stalenessSpreadBpsPerHour_, uint64 impactPerUnit_)
        external
        onlyOwner
    {
        require(baseSpreadBps_ <= 2000 && stalenessSpreadBpsPerHour_ <= 2000, "spread too wide");
        defaultBaseSpreadBps = baseSpreadBps_;
        defaultStalenessSpreadBpsPerHour = stalenessSpreadBpsPerHour_;
        defaultImpactPerUnit = impactPerUnit_;
    }

    function setNotionalCeiling(uint256 ceiling) external onlyOwner {
        notionalCeiling = ceiling;
    }

    /// @notice Split of the protocol fee; whatever is left of 10,000 bps is the DAO's.
    function setFeeSplit(uint16 insuranceBps, uint16 backstopBps, address dao_) external onlyOwner {
        require(uint256(insuranceBps) + backstopBps <= 1e4, "split > 100%");
        require(dao_ != address(0), "no dao");
        insuranceFeeBps = insuranceBps;
        backstopFeeBps = backstopBps;
        dao = dao_;
    }

    /// @notice Anyone can top up the insurance fund — the layer between the
    /// backstop pool and a holder haircut.
    function fundInsurance(uint256 amount) external {
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        insuranceFund += amount;
        emit InsuranceFunded(msg.sender, amount);
    }

    /// @notice Pull-based claim of the DAO's fee share.
    function claim() external returns (uint256 amount) {
        amount = claimable[msg.sender];
        require(amount > 0, NothingToClaim());
        claimable[msg.sender] = 0;
        IERC20(usdc).safeTransfer(msg.sender, amount);
    }

    // ── Ranges ───────────────────────────────────────────────────────────────

    /// @notice Opens a margined put range. `maxCapacity` is the USDC margin
    /// the writer lets this vault pull JIT — not the notional. Capacity is
    /// enforced by Aqua's virtual balance, same as the main vault.
    function openRange(
        uint256 strikeMin,
        uint256 strikeMax,
        uint256 expiry,
        uint256 maxCapacity,
        uint16 lpMarginBps,
        bool autoTopUp,
        uint16 sigmaMulBps
    ) external returns (uint256 authId) {
        require(strikeMin > 0 && strikeMin <= strikeMax, InvalidRange());
        require(expiry > block.timestamp, ExpiryInPast());
        require(maxCapacity > 0, ZeroCapacity());
        require(sigmaMulBps == 0 || (sigmaMulBps >= 1000 && sigmaMulBps <= 30000), "sigma mult out of bounds");

        authId = nextAuthId++;
        Pricing storage p = pricingOf[authId];
        p.baseSpreadBps = defaultBaseSpreadBps;
        p.stalenessSpreadBpsPerHour = defaultStalenessSpreadBpsPerHour;
        p.impactPerUnit = defaultImpactPerUnit;
        Range storage r = ranges[authId];
        r.lp = msg.sender;
        r.strikeMin = strikeMin;
        r.strikeMax = strikeMax;
        r.expiry = expiry;
        r.maxCapacity = maxCapacity;
        r.active = true;
        r.autoTopUp = autoTopUp;
        r.lpMarginBps = lpMarginBps;
        r.sigmaMulBps = sigmaMulBps;
        r.feeBps = protocolFeeBps;
        r.beta = hook != address(0) ? IBetaSource(hook).beta() : int256(0);
        r.spotStaleness = SafeCast.toUint16(maxSpotStaleness);
        r.strategyHash = keccak256(_strategy(authId));

        emit RangeOpened(authId, msg.sender, strikeMin, strikeMax, expiry, maxCapacity, autoTopUp);
    }

    /// @notice Writer closes the range in this registry; the Aqua allowance
    /// is docked separately with {getDockParams}. Open positions are
    /// unaffected — margin already pulled stays here.
    function closeRange(uint256 authId) external {
        require(ranges[authId].lp == msg.sender, NotLp());
        ranges[authId].active = false;
        emit RangeClosed(authId);
    }

    /// @notice Series id for the settlement registry — pooled per (strike, expiry).
    function seriesId(uint256 strike, uint256 expiry) public pure returns (bytes32) {
        return keccak256(abi.encode("SMILE-MARGIN-1", strike, expiry));
    }

    // ── Mark and margin rule (B2) ────────────────────────────────────────────

    /// @notice The margin mark: the LOWEST Chainlink answer in the last
    /// {MARK_WINDOW}, walking `getRoundData` back from the latest round and
    /// stopping at the first round updated before the window (the same stop
    /// rule `settleWithChainlinkRound` uses around expiry). Reads the oracle
    /// only — never `hook.sigmaFor` — so margin cannot be moved by trading.
    /// Never reverts on staleness; callers that must not act on a stale
    /// mark check `latestUpdatedAt` themselves ({isMarkStale}).
    /// @return spotWad     worst-of-window price, WAD USD (0 if the feed is broken)
    /// @return latestUpdatedAt  timestamp of the newest round
    /// @return roundsUsed  how many rounds fed the minimum
    function markSpot() public view returns (uint256 spotWad, uint256 latestUpdatedAt, uint256 roundsUsed) {
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        if (answer <= 0) return (0, updatedAt, 0);
        latestUpdatedAt = updatedAt;
        uint256 lowest = uint256(answer);
        roundsUsed = 1;
        uint256 cutoff = block.timestamp > MARK_WINDOW ? block.timestamp - MARK_WINDOW : 0;
        while (roundId > 0 && roundsUsed < MAX_MARK_ROUNDS) {
            roundId--;
            try oracle.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 u, uint80) {
                if (u == 0 || u < cutoff) break;
                if (a > 0 && uint256(a) < lowest) lowest = uint256(a);
                roundsUsed++;
            } catch {
                break; // phase boundary / missing predecessor — the window ends here
            }
        }
        spotWad = SmileMath.scaleToWad(lowest, oracle.decimals());
    }

    /// @notice True when the newest round is older than {MARK_STALE_AFTER}.
    function isMarkStale() public view returns (bool) {
        (, uint256 latestUpdatedAt,) = markSpot();
        return block.timestamp > latestUpdatedAt + MARK_STALE_AFTER;
    }

    /// @notice Margin for a short put of `units` at `strike` against mark
    /// `spotWad`, in USDC: intrinsic plus a buffer of `bufferBps` of spot per
    /// unit, never more than the strike itself (a put's max loss).
    ///   IM (initial = true)  uses {imBufferBps}, MM uses {mmBufferBps}.
    ///   K 3000, 1 unit: S 3000 → IM 1500, MM 900; S 2000 → 2000, 1600; S 0 → 3000, 3000.
    function marginRequirement(uint256 strike, uint256 units, uint256 spotWad, bool initial)
        public
        view
        returns (uint256)
    {
        uint256 cap = (strike * units) / 1e30;
        uint256 intrinsic = spotWad < strike ? ((strike - spotWad) * units) / 1e30 : 0;
        uint256 buffer = (units * spotWad * (initial ? imBufferBps : mmBufferBps)) / 1e4 / 1e30;
        uint256 req = intrinsic + buffer;
        return req > cap ? cap : req;
    }

    // ── Quote and buy (B3) ───────────────────────────────────────────────────

    /// @notice Ask-side quote for `units` of a put at `strike` from a range:
    /// the writer's premium plus the protocol-fee gross-up, in USDC. Same
    /// surface as the main vault (`SmilePremiumLib` is that math), so the
    /// only thing a margined put changes is how much the writer locks.
    function quote(uint256 authId, uint256 strike, uint256 units)
        public
        view
        returns (uint256 lpPremium, uint256 fee)
    {
        Range storage r = ranges[authId];
        require(r.lp != address(0), UnknownRange());
        require(units > 0, ZeroAmount());
        Pricing storage p = pricingOf[authId];
        SmilePremiumLib.Terms memory t;
        (t.spotWad, t.ageSec) = SmilePremiumLib.readSpot(oracle, r.spotStaleness);
        t.strike = strike;
        t.expiry = r.expiry;
        t.sigmaSource = hook;
        t.beta = r.beta;
        t.sigmaMulBps = r.sigmaMulBps;
        t.baseSpreadBps = p.baseSpreadBps;
        t.stalenessSpreadBpsPerHour = p.stalenessSpreadBpsPerHour;
        t.impactPerUnit = p.impactPerUnit;
        t.isCall = false;
        return SmilePremiumLib.quote(t, units, true, usdcDecimals, r.feeBps);
    }

    /// @notice The margin a fill of `units` at `strike` locks right now:
    /// the vault IM off the worst-of-hour mark, raised to the range's own
    /// `lpMarginBps` of notional if the writer chose to post more.
    function initialMargin(uint256 authId, uint256 strike, uint256 units) public view returns (uint256 im) {
        (uint256 spot,,) = markSpot();
        im = marginRequirement(strike, units, spot, true);
        uint256 lpMin = ((strike * units) / 1e30) * ranges[authId].lpMarginBps / 1e4;
        if (lpMin > im) im = lpMin;
    }

    /// @notice Effective naked-notional ceiling right now.
    function effectiveCeiling() public view returns (uint256) {
        uint256 byBackstop = address(backstop) != address(0) ? backstop.totalAssets() * BACKSTOP_MULTIPLE : 0;
        return byBackstop < notionalCeiling ? byBackstop : notionalCeiling;
    }

    /// @notice Buy `units` of a put at `strike` from a margined range. The
    /// buyer pays premium (+ fee) in USDC; the writer locks only the
    /// initial margin — the main vault would lock the whole strike. IM comes
    /// from the writer's free balance first, the rest is pulled JIT through
    /// this vault's Aqua strategy. One OptionToken series per (strike,
    /// expiry), shared by every writer, so takeovers are fungible.
    function buy(uint256 authId, uint256 strike, uint256 units, uint256 maxPremium)
        external
        nonReentrant
        returns (address token, uint256 premiumPaid)
    {
        Range storage r = ranges[authId];
        require(r.active, RangeInactive());
        require(strike >= r.strikeMin && strike <= r.strikeMax, StrikeOutOfRange());
        require(block.timestamp + MIN_TIME_TO_EXPIRY <= r.expiry, TooCloseToExpiry());
        require(units > 0, ZeroAmount());
        require(!isMarkStale(), StaleMark());

        uint256 notional = (strike * units) / 1e30;
        uint256 im = initialMargin(authId, strike, units);
        uint256 naked = notional > im ? notional - im : 0;
        uint256 ceiling = effectiveCeiling();
        require(nakedNotional + naked <= ceiling, NakedCeiling(nakedNotional + naked, ceiling));

        (uint256 lpPremium, uint256 fee) = quote(authId, strike, units);
        premiumPaid = lpPremium + fee;
        require(premiumPaid <= maxPremium, PremiumAboveMax());

        // Free balance first, JIT pull for the rest.
        Account storage acct = accounts[r.lp];
        uint256 fromFree = acct.free < im ? acct.free : im;
        acct.free -= fromFree;
        this.execPull(r.lp, r.strategyHash, msg.sender, lpPremium, fee, im - fromFree);
        _splitFee(fee);

        bytes32 sid = seriesId(strike, r.expiry);
        token = _series(sid, strike, r.expiry);
        Series storage s = seriesOf[sid];
        s.totalUnits += units;
        Position storage pos = positions[sid][r.lp];
        if (pos.units == 0) s.positionCount++;
        pos.authId = authId;
        pos.units += units;
        pos.locked += im;
        nakedNotional += naked;

        OptionToken(token).mint(msg.sender, units);
        emit MarginLocked(sid, r.lp, im - fromFree, fromFree, notional);
        emit OptionBought(authId, token, msg.sender, strike, units, premiumPaid);
    }

    /// @dev Self-call under the official per-strategy reentrancy guard:
    /// premium to the writer, fee here, then the JIT pull of the margin.
    function execPull(address lp, bytes32 strategyHash, address buyer, uint256 lpPremium, uint256 fee, uint256 pull)
        external
        nonReentrantStrategy(lp, strategyHash)
    {
        require(msg.sender == address(this), SelfOnly());
        if (lpPremium > 0) IERC20(usdc).safeTransferFrom(buyer, lp, lpPremium);
        if (fee > 0) IERC20(usdc).safeTransferFrom(buyer, address(this), fee);
        if (pull > 0) AQUA.pull(lp, strategyHash, usdc, pull, address(this));
    }

    function _splitFee(uint256 fee) internal {
        if (fee == 0) return;
        uint256 toInsurance = fee * insuranceFeeBps / 1e4;
        uint256 toBackstop = fee * backstopFeeBps / 1e4;
        insuranceFund += toInsurance;
        if (toBackstop > 0 && address(backstop) != address(0)) {
            IERC20(usdc).safeTransfer(address(backstop), toBackstop);
        } else {
            toBackstop = 0;
        }
        claimable[dao] += fee - toInsurance - toBackstop;
    }

    /// @dev Deploy the (strike, expiry) series on first fill and register it
    /// with the settlement registry.
    function _series(bytes32 sid, uint256 strike, uint256 expiry) internal returns (address token) {
        Series storage s = seriesOf[sid];
        token = s.token;
        if (token == address(0)) {
            token = tokenFactory.deployOption(usdc, strike, expiry, false, address(this));
            s.token = token;
            s.strike = strike;
            s.expiry = expiry;
            if (settlement != address(0)) {
                AquaOptionSettlement(settlement).registerSeries(sid, token, expiry, strike, false);
            }
        }
    }

    // ── Official Aqua strategy plumbing ──────────────────────────────────────

    /// @notice Everything needed for `Aqua.ship(app, strategy, tokens, amounts)`.
    function getShipParams(uint256 authId)
        external
        view
        returns (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts)
    {
        Range storage r = ranges[authId];
        require(r.lp != address(0), UnknownRange());
        app = address(this);
        strategy = _strategy(authId);
        tokens = new address[](1);
        tokens[0] = usdc;
        amounts = new uint256[](1);
        amounts[0] = r.maxCapacity;
    }

    /// @notice Everything needed for `Aqua.dock(app, strategyHash, tokens)`.
    function getDockParams(uint256 authId)
        external
        view
        returns (address app, bytes32 strategyHash, address[] memory tokens)
    {
        Range storage r = ranges[authId];
        require(r.lp != address(0), UnknownRange());
        app = address(this);
        strategyHash = r.strategyHash;
        tokens = new address[](1);
        tokens[0] = usdc;
    }

    /// @dev Self-hosted AquaApp strategy (this vault is `app`), a plain
    /// encoded terms blob like the main vault's put strategy. Full terms
    /// included for Aqua's data-availability requirement.
    function _strategy(uint256 authId) internal view returns (bytes memory) {
        Range storage r = ranges[authId];
        return abi.encode(
            MARGIN_STRATEGY_TYPE,
            authId,
            r.lp,
            r.strikeMin,
            r.strikeMax,
            r.expiry,
            r.maxCapacity,
            r.lpMarginBps,
            r.autoTopUp,
            usdc
        );
    }
}
