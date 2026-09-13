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
/// docs/plans/2026-09-05-aqua.md).
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
    /// actually absorb a default. 7, not 10: a writer sitting exactly at MM
    /// (30% buffer) who gaps 40% before settlement leaves a shortfall of
    /// 0.1·S against 0.7·S of naked notional — one seventh — and the
    /// gap-40 test holds holders whole at exactly that.
    uint256 public constant BACKSTOP_MULTIPLE = 7;
    /// @notice A series can be finalized this long after expiry even if some
    /// writer never settled; their margin repays the pool when they do.
    uint256 public constant FINALIZE_GRACE = 6 hours;
    /// @notice IM buffer raise after any holder haircut.
    uint16 public constant HAIRCUT_RATCHET_BPS = 500;

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

    /// @notice A flagged writer gets this long to cure before an auction can start.
    uint256 public constant GRACE = 1 hours;
    /// @notice Takeover window; the bidder bonus rises linearly across it.
    uint256 public constant AUCTION_LENGTH = 30 minutes;
    uint16 public constant BONUS_START_BPS = 100;
    uint16 public constant BONUS_END_BPS = 1000;
    /// @notice Liquidated writer's penalty (of notional); a slice goes to the flagger.
    uint16 public constant PENALTY_BPS = 200;
    uint16 public constant FLAGGER_BPS = 25;
    /// @notice Keeper tip (of notional) for pushing an unsold position into the backstop.
    uint16 public constant KEEPER_TIP_BPS = 50;
    /// @dev Position `authId` for a short acquired at auction — no range, no credit line.
    uint256 internal constant NO_RANGE = type(uint256).max;

    uint256 public nextAuthId;
    mapping(uint256 => Range) public ranges;
    mapping(uint256 => Pricing) public pricingOf;
    mapping(bytes32 => Series) public seriesOf;
    mapping(bytes32 => mapping(address => Position)) public positions;
    mapping(address => Account) public accounts;
    /// @dev Series a writer has an open short in — walked by {withdraw}.
    // ponytail: O(open series) loop; a writer with hundreds of series pays for it in gas.
    mapping(address => bytes32[]) internal _openSeries;
    mapping(address => uint256) public flaggedCount;
    bytes32[] internal _allSeries;
    /// @notice Insurance drawn per series at finalization; repaid by late settlers.
    mapping(bytes32 => uint256) public insuranceDrawn;

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
    error NoPosition();
    error Covered();
    error Healthy();
    error AlreadyFlagged();
    error NotFlagged();
    error GraceNotOver();
    error NoRoundSinceFlag();
    error AuctionAlreadyStarted();
    error InDebt();
    error WhileFlagged();
    error InsufficientFree();
    error WithdrawBelowIM(uint256 have, uint256 need);
    error AuctionNotStarted();
    error AuctionOver();
    error AuctionNotOver();
    error SelfTakeover();
    error Expired();
    error NotSettled();
    error NotFinalized();
    error AlreadyFinalized();
    error NotAllSettled();

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
    event Deposited(address indexed writer, uint256 amount, uint256 debtRepaid);
    event Withdrawn(address indexed writer, uint256 amount);
    event ToppedUp(bytes32 indexed sid, address indexed writer, uint256 fromFree, uint256 fromCreditLine, uint256 fromCaller);
    event Flagged(bytes32 indexed sid, address indexed writer, address indexed flagger, uint256 locked, uint256 maintenance);
    event FlagCleared(bytes32 indexed sid, address indexed writer);
    event AuctionStarted(bytes32 indexed sid, address indexed writer, uint256 locked, uint256 maintenance);
    event ShortCovered(bytes32 indexed sid, address indexed writer, uint256 units, uint256 released);
    event TakenOver(
        bytes32 indexed sid, address indexed writer, address indexed bidder, uint256 units, uint256 moved, uint256 bonus, uint256 penalty, uint256 posted
    );
    event Absorbed(bytes32 indexed sid, address indexed writer, uint256 units, uint256 moved, uint256 drawn, uint256 tip, uint256 penalty);
    event PositionSettled(
        bytes32 indexed sid, address indexed writer, uint256 units, uint256 owed, uint256 paid, uint256 shortfall, uint256 released
    );
    event SeriesFinalized(
        bytes32 indexed sid, uint256 owed, uint256 pot, uint256 backstopDrawn, uint256 insuranceDrawn, uint256 payoutPerUnit
    );
    event HolderHaircut(bytes32 indexed sid, uint256 owed, uint256 paid, uint16 haircutBps, uint16 newImBufferBps);
    /// @dev Same ABI as AquaCollateralVault.Redeemed.
    event Redeemed(address indexed optionToken, address indexed holder, uint256 amount, uint256 payout);

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
        return _worstOf(block.timestamp > MARK_WINDOW ? block.timestamp - MARK_WINDOW : 0);
    }

    /// @dev Lowest answer among rounds updated at/after `cutoff`, newest first.
    function _worstOf(uint256 cutoff) internal view returns (uint256 spotWad, uint256 latestUpdatedAt, uint256 roundsUsed) {
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        if (answer <= 0) return (0, updatedAt, 0);
        latestUpdatedAt = updatedAt;
        uint256 lowest = uint256(answer);
        roundsUsed = 1;
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
        if (pos.units == 0) {
            s.positionCount++;
            _openSeries[r.lp].push(sid);
        }
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
            _allSeries.push(sid);
            if (settlement != address(0)) {
                AquaOptionSettlement(settlement).registerSeries(sid, token, expiry, strike, false);
            }
        }
    }

    // ── Margin calls, covered immunity, withdrawals (B4) ────────────────────

    /// @notice A writer's free USDC here — swept into margin calls first,
    /// withdrawable while every open position stays at IM. Repays bad debt
    /// (to the insurance fund that covered it) before anything is credited.
    function deposit(uint256 amount) external nonReentrant {
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        Account storage a = accounts[msg.sender];
        uint256 repaid = a.badDebt < amount ? a.badDebt : amount;
        a.badDebt -= repaid;
        insuranceFund += repaid;
        a.free += amount - repaid;
        emit Deposited(msg.sender, amount, repaid);
    }

    /// @notice Withdraw free USDC. Refused while flagged, in debt, or on a
    /// stale mark, and never below IM across every open position at the
    /// current mark — free balance counts toward that requirement.
    function withdraw(uint256 amount) external nonReentrant {
        Account storage a = accounts[msg.sender];
        require(a.badDebt == 0, InDebt());
        require(flaggedCount[msg.sender] == 0, WhileFlagged());
        require(!isMarkStale(), StaleMark());
        require(amount <= a.free, InsufficientFree());
        a.free -= amount;

        (uint256 spot,,) = markSpot();
        uint256 have = a.free;
        uint256 need;
        bytes32[] storage open = _openSeries[msg.sender];
        for (uint256 i = 0; i < open.length; i++) {
            Position storage pos = positions[open[i]][msg.sender];
            if (pos.units == 0) continue;
            have += pos.locked;
            need += marginRequirement(seriesOf[open[i]].strike, pos.units, spot, true);
        }
        require(have >= need, WithdrawBelowIM(have, need));

        IERC20(usdc).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Locked margin against the maintenance and initial requirements
    /// at the current mark.
    function health(bytes32 sid, address writer) public view returns (uint256 locked, uint256 mm, uint256 im) {
        Position storage pos = positions[sid][writer];
        (uint256 spot,,) = markSpot();
        locked = pos.locked;
        mm = marginRequirement(seriesOf[sid].strike, pos.units, spot, false);
        im = marginRequirement(seriesOf[sid].strike, pos.units, spot, true);
    }

    /// @notice A position whose locked margin is the full strike value is a
    /// cash-secured put — it cannot be flagged. Wallet and Aqua balances
    /// never count; only what is locked here.
    function isCovered(bytes32 sid, address writer) public view returns (bool) {
        Position storage pos = positions[sid][writer];
        return pos.units > 0 && pos.locked >= (seriesOf[sid].strike * pos.units) / 1e30;
    }

    /// @notice Margin call. Anyone may call. Below MM at the worst-of-hour
    /// mark, the vault first tries to cure to IM on the writer's behalf —
    /// free balance, then (if the range opted in) a bounded pull from the
    /// same Aqua allowance the fill used — and flags only if the position is
    /// still under MM afterwards. Covered positions cannot be flagged.
    function flag(bytes32 sid, address writer) external nonReentrant {
        Position storage pos = positions[sid][writer];
        require(pos.units > 0, NoPosition());
        require(pos.flaggedAt == 0, AlreadyFlagged());
        require(!isCovered(sid, writer), Covered());

        (uint256 locked, uint256 mm, uint256 im) = health(sid, writer);
        require(locked < mm, Healthy());

        uint256 deficit = im - locked;
        uint256 fromFree = _sweepFree(sid, writer, deficit);
        uint256 fromLine;
        if (deficit > fromFree) fromLine = _creditLine(writer, pos, deficit - fromFree);
        if (fromFree + fromLine > 0) emit ToppedUp(sid, writer, fromFree, fromLine, 0);

        if (pos.locked >= mm) return;
        pos.flaggedAt = uint64(block.timestamp);
        pos.flagger = msg.sender;
        flaggedCount[writer]++;
        emit Flagged(sid, writer, msg.sender, pos.locked, mm);
    }

    /// @notice Anyone adds margin to a position. Clears the flag once the
    /// position is back at IM. Whatever exceeds the strike value (full
    /// cover) lands in the writer's free balance instead.
    function topUp(bytes32 sid, address writer, uint256 amount) external nonReentrant {
        Position storage pos = positions[sid][writer];
        require(pos.units > 0, NoPosition());
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        uint256 room = (seriesOf[sid].strike * pos.units) / 1e30 - pos.locked;
        uint256 toLock = amount < room ? amount : room;
        _lock(pos, toLock);
        accounts[writer].free += amount - toLock;
        emit ToppedUp(sid, writer, 0, 0, amount);
        _maybeClearFlag(sid, writer, pos);
    }

    /// @notice After the grace period, open the takeover window — but judge
    /// health on rounds posted AFTER the flag only, so a dip that already
    /// recovered cannot be used to liquidate. A position back above MM is
    /// unflagged instead.
    function startAuction(bytes32 sid, address writer) external nonReentrant {
        Position storage pos = positions[sid][writer];
        require(pos.flaggedAt != 0, NotFlagged());
        require(pos.auctionStart == 0, AuctionAlreadyStarted());
        require(block.timestamp >= pos.flaggedAt + GRACE, GraceNotOver());

        uint256 windowCutoff = block.timestamp > MARK_WINDOW ? block.timestamp - MARK_WINDOW : 0;
        uint256 cutoff = pos.flaggedAt + 1 > windowCutoff ? pos.flaggedAt + 1 : windowCutoff;
        (uint256 spot, uint256 latestAt,) = _worstOf(cutoff);
        require(latestAt > pos.flaggedAt, NoRoundSinceFlag());

        uint256 mm = marginRequirement(seriesOf[sid].strike, pos.units, spot, false);
        if (pos.locked >= mm) {
            _clearFlag(sid, writer, pos);
            return;
        }
        pos.auctionStart = uint64(block.timestamp);
        emit AuctionStarted(sid, writer, pos.locked, mm);
    }

    /// @notice A writer who also holds the series burns their own long
    /// tokens against the short. The units net out; the margin they backed
    /// is released to the writer's free balance pro rata.
    function coverShort(bytes32 sid, uint256 units) external nonReentrant {
        Position storage pos = positions[sid][msg.sender];
        require(pos.units > 0 && units > 0 && units <= pos.units, NoPosition());
        Series storage s = seriesOf[sid];
        OptionToken(s.token).burn(msg.sender, units);

        uint256 released = (pos.locked * units) / pos.units;
        uint256 notionalOff = (s.strike * units) / 1e30;
        pos.units -= units;
        pos.locked -= released;
        s.totalUnits -= units;
        nakedNotional -= notionalOff - released;
        accounts[msg.sender].free += released;

        if (pos.units == 0) {
            s.positionCount--;
            if (pos.flaggedAt != 0) _clearFlag(sid, msg.sender, pos);
        } else {
            _maybeClearFlag(sid, msg.sender, pos);
        }
        emit ShortCovered(sid, msg.sender, units, released);
    }

    /// @dev Move `amount` into a position's margin and take it off naked notional.
    function _lock(Position storage pos, uint256 amount) internal {
        pos.locked += amount;
        nakedNotional -= amount;
    }

    function _sweepFree(bytes32 sid, address writer, uint256 deficit) internal returns (uint256 taken) {
        Account storage a = accounts[writer];
        taken = a.free < deficit ? a.free : deficit;
        if (taken == 0) return 0;
        a.free -= taken;
        _lock(positions[sid][writer], taken);
    }

    /// @dev Opt-in Aqua credit line: the range's shipped allowance, bounded
    /// by what is still shipped, what the wallet holds, and what it has
    /// approved. Best effort — a failed pull is not a revert, the flag is.
    function _creditLine(address writer, Position storage pos, uint256 want) internal returns (uint256 pulled) {
        Range storage r = ranges[pos.authId];
        if (!r.autoTopUp) return 0;
        (uint248 shipped,) = AQUA.rawBalances(writer, address(this), r.strategyHash, usdc);
        uint256 amt = want;
        if (shipped < amt) amt = shipped;
        uint256 wallet = IERC20(usdc).balanceOf(writer);
        if (wallet < amt) amt = wallet;
        uint256 allowance = IERC20(usdc).allowance(writer, address(AQUA));
        if (allowance < amt) amt = allowance;
        if (amt == 0) return 0;
        try this.execPull(writer, r.strategyHash, address(0), 0, 0, amt) {
            _lock(pos, amt);
            pulled = amt;
        } catch {}
    }

    function _maybeClearFlag(bytes32 sid, address writer, Position storage pos) internal {
        if (pos.flaggedAt == 0) return;
        (uint256 spot,,) = markSpot();
        if (pos.locked >= marginRequirement(seriesOf[sid].strike, pos.units, spot, true)) _clearFlag(sid, writer, pos);
    }

    function _clearFlag(bytes32 sid, address writer, Position storage pos) internal {
        pos.flaggedAt = 0;
        pos.auctionStart = 0;
        pos.flagger = address(0);
        flaggedCount[writer]--;
        emit FlagCleared(sid, writer);
    }

    // ── Takeover auction and backstop absorb (B5) ───────────────────────────

    /// @notice Bidder bonus right now, bps of notional: 1% at the auction's
    /// open rising to 10% at its close.
    function takeoverBonusBps(bytes32 sid, address writer) public view returns (uint256) {
        uint64 start = positions[sid][writer].auctionStart;
        if (start == 0) return 0;
        uint256 elapsed = block.timestamp - start;
        if (elapsed > AUCTION_LENGTH) elapsed = AUCTION_LENGTH;
        return BONUS_START_BPS + ((BONUS_END_BPS - BONUS_START_BPS) * elapsed) / AUCTION_LENGTH;
    }

    /// @notice Another writer takes over a position in auction. The holder's
    /// token is untouched — only who stands behind it changes. Collateral
    /// travels with the position: `min(locked, MM + bonus + penalty)` moves;
    /// the bonus goes to the bidder, the penalty to insurance (a slice to
    /// the flagger), the rest seeds the bidder's margin and the bidder posts
    /// only `IM − that`. Whatever exceeded the liability is the old
    /// writer's again as free balance. The forfeit is taken from the old
    /// writer's excess, never from the liability itself, so a losing writer
    /// cannot self-liquidate at a discount — and cannot bid on themselves.
    function takeOver(bytes32 sid, address writer) external nonReentrant returns (uint256 posted) {
        Position storage pos = positions[sid][writer];
        require(pos.auctionStart != 0, AuctionNotStarted());
        require(block.timestamp < pos.auctionStart + AUCTION_LENGTH, AuctionOver());
        require(msg.sender != writer, SelfTakeover());
        Series storage s = seriesOf[sid];
        require(block.timestamp < s.expiry, Expired());

        uint256 notional = (s.strike * pos.units) / 1e30;
        (uint256 spot,,) = markSpot();
        uint256 mm = marginRequirement(s.strike, pos.units, spot, false);
        uint256 im = marginRequirement(s.strike, pos.units, spot, true);
        uint256 bonus = (notional * takeoverBonusBps(sid, writer)) / 1e4;
        uint256 penalty = (notional * PENALTY_BPS) / 1e4;

        (uint256 moved, uint256 seed) = _detach(writer, pos, mm + bonus + penalty, bonus, penalty, msg.sender);

        // Bidder brings the position to IM: free balance first, then wallet.
        uint256 units = pos.units;
        posted = im > seed ? im - seed : 0;
        uint256 fromFree = accounts[msg.sender].free < posted ? accounts[msg.sender].free : posted;
        accounts[msg.sender].free -= fromFree;
        if (posted > fromFree) IERC20(usdc).safeTransferFrom(msg.sender, address(this), posted - fromFree);
        accounts[msg.sender].free += bonus > moved ? moved : bonus;

        _attach(sid, msg.sender, units, seed + posted);
        _closeOut(sid, writer, pos);
        emit TakenOver(sid, writer, msg.sender, units, moved, bonus, penalty, posted);
    }

    /// @notice Nobody bid: the backstop pool adopts the position. It draws
    /// only the shortfall to MM after what travelled with the position; the
    /// keeper who pushed it gets a tip from the old writer's margin.
    function absorb(bytes32 sid, address writer) external nonReentrant returns (uint256 drawn) {
        Position storage pos = positions[sid][writer];
        require(pos.auctionStart != 0, AuctionNotStarted());
        require(block.timestamp >= pos.auctionStart + AUCTION_LENGTH, AuctionNotOver());
        Series storage s = seriesOf[sid];
        require(block.timestamp < s.expiry, Expired());

        uint256 notional = (s.strike * pos.units) / 1e30;
        (uint256 spot,,) = markSpot();
        uint256 mm = marginRequirement(s.strike, pos.units, spot, false);
        uint256 tip = (notional * KEEPER_TIP_BPS) / 1e4;
        uint256 penalty = (notional * PENALTY_BPS) / 1e4;

        (uint256 moved, uint256 seed) = _detach(writer, pos, mm + tip + penalty, tip, penalty, msg.sender);
        accounts[msg.sender].free += tip > moved ? moved : tip;

        if (seed < mm) {
            drawn = backstop.draw(mm - seed);
            s.backstopDrawn += drawn;
        }
        uint256 units = pos.units;
        _attach(sid, address(backstop), units, seed + drawn);
        backstop.noteRequirement(notional, true);
        _closeOut(sid, writer, pos);
        emit Absorbed(sid, writer, units, moved, drawn, tip, penalty);
    }

    /// @notice True while some series has expired and not been finalized —
    /// the backstop freezes withdrawals until every claim on it is known.
    function hasExpiredUnfinalized() external view returns (bool) {
        for (uint256 i = 0; i < _allSeries.length; i++) {
            Series storage s = seriesOf[_allSeries[i]];
            if (block.timestamp >= s.expiry && !s.finalized && s.totalUnits > 0) return true;
        }
        return false;
    }

    /// @dev Take `min(locked, liability)` off the old writer: pay `reward`
    /// (bonus or tip) and `penalty` out of it in that order, credit the
    /// remainder of `locked` back to the writer as free, and return what
    /// moved and what is left to seed the new holder's margin.
    function _detach(
        address writer,
        Position storage pos,
        uint256 liability,
        uint256 reward,
        uint256 penalty,
        address caller
    ) internal returns (uint256 moved, uint256 seed) {
        uint256 locked = pos.locked;
        moved = locked < liability ? locked : liability;
        accounts[writer].free += locked - moved;

        uint256 rewardPaid = reward < moved ? reward : moved;
        uint256 penaltyPaid = penalty < moved - rewardPaid ? penalty : moved - rewardPaid;
        seed = moved - rewardPaid - penaltyPaid;

        uint256 toFlagger = (penaltyPaid * FLAGGER_BPS) / PENALTY_BPS;
        address flagger = pos.flagger == address(0) ? caller : pos.flagger;
        accounts[flagger].free += toFlagger;
        insuranceFund += penaltyPaid - toFlagger;
    }

    /// @dev Give `units` with `locked` margin to `to` in a series.
    function _attach(bytes32 sid, address to, uint256 units, uint256 locked) internal {
        Position storage np = positions[sid][to];
        if (np.units == 0) {
            seriesOf[sid].positionCount++;
            _openSeries[to].push(sid);
            np.authId = NO_RANGE;
        }
        np.units += units;
        np.locked += locked;
        nakedNotional += (seriesOf[sid].strike * units) / 1e30 - locked;
    }

    /// @dev Zero out the liquidated writer's position and its naked share.
    function _closeOut(bytes32 sid, address writer, Position storage pos) internal {
        nakedNotional -= (seriesOf[sid].strike * pos.units) / 1e30 - pos.locked;
        seriesOf[sid].positionCount--;
        _clearFlag(sid, writer, pos);
        pos.units = 0;
        pos.locked = 0;
    }

    // ── Two-step settlement: per-writer waterfall, then finalization (B6) ───

    /// @notice What every holder unit of a series is owed at its settlement
    /// price, in USDC per 1e18 units: `max(K − S, 0)`.
    function intrinsicPerUnit(bytes32 sid) public view returns (uint256) {
        (bool settled, uint256 price) = _settlementOf(sid);
        require(settled, NotSettled());
        uint256 k = seriesOf[sid].strike;
        return price < k ? (k - price) / 1e12 : 0;
    }

    /// @notice Settle one writer's short against the series' settlement
    /// price. Waterfall: locked margin, then free balance; whatever is
    /// still short is the writer's bad debt, plus the 2 % default penalty
    /// — junior to the holder claim, so it never eats into what holders
    /// get. Anything left of the margin is released to the writer. Before
    /// finalization the money goes to the holder pot; after it (a late
    /// settler) it repays the backstop first, then insurance, then the
    /// writer.
    function settlePosition(bytes32 sid, address writer) external nonReentrant {
        Position storage pos = positions[sid][writer];
        require(pos.units > 0, NoPosition());
        Series storage s = seriesOf[sid];
        uint256 units = pos.units;
        uint256 owed = (intrinsicPerUnit(sid) * units) / 1e18;
        uint256 notional = (s.strike * units) / 1e30;

        uint256 paid = pos.locked < owed ? pos.locked : owed;
        uint256 released = pos.locked - paid;
        uint256 shortfall = owed - paid;
        Account storage a = accounts[writer];
        if (shortfall > 0 && writer != address(backstop)) {
            uint256 fromFree = a.free < shortfall ? a.free : shortfall;
            a.free -= fromFree;
            paid += fromFree;
            shortfall -= fromFree;
            if (shortfall > 0) a.badDebt += shortfall + (notional * PENALTY_BPS) / 1e4;
        }
        if (writer == address(backstop)) {
            // The pool stands behind what it absorbed: draw the rest now.
            if (shortfall > 0) {
                uint256 drawn = backstop.draw(shortfall);
                paid += drawn;
                shortfall -= drawn;
                s.backstopDrawn += drawn;
            }
            backstop.noteRequirement(notional, false);
        }

        nakedNotional -= notional - pos.locked;
        pos.units = 0;
        pos.locked = 0;
        if (pos.flaggedAt != 0) _clearFlag(sid, writer, pos);
        s.positionCount--;
        s.settledPositions++;

        if (!s.finalized) {
            s.owedTotal += owed;
            s.pot += paid;
            _credit(writer, released);
        } else {
            // Late settler: repay whoever covered the holders in their absence.
            uint256 left = paid + released;
            uint256 toBackstop = left < s.backstopDrawn ? left : s.backstopDrawn;
            if (toBackstop > 0) {
                s.backstopDrawn -= toBackstop;
                IERC20(usdc).safeTransfer(address(backstop), toBackstop);
                left -= toBackstop;
            }
            uint256 toInsurance = left < insuranceDrawn[sid] ? left : insuranceDrawn[sid];
            insuranceDrawn[sid] -= toInsurance;
            insuranceFund += toInsurance;
            left -= toInsurance;
            _credit(writer, left);
        }
        emit PositionSettled(sid, writer, units, owed, paid, shortfall, released);
    }

    /// @notice Close the books on a series: once every writer has settled,
    /// or {FINALIZE_GRACE} after expiry regardless. The remaining holder
    /// shortfall is drawn from the backstop, then insurance; only if both
    /// run dry do holders take a haircut — announced loudly, and the IM
    /// buffer ratchets up {HAIRCUT_RATCHET_BPS} so the next series is
    /// margined harder.
    function finalizeSeries(bytes32 sid) external nonReentrant {
        Series storage s = seriesOf[sid];
        require(!s.finalized, AlreadyFinalized());
        uint256 perUnit = intrinsicPerUnit(sid);
        require(s.positionCount == 0 || block.timestamp >= s.expiry + FINALIZE_GRACE, NotAllSettled());

        uint256 owed = (perUnit * s.totalUnits) / 1e18;
        uint256 shortfall = owed > s.pot ? owed - s.pot : 0;
        if (shortfall > 0) {
            uint256 drawn = backstop.draw(shortfall);
            s.backstopDrawn += drawn;
            s.pot += drawn;
            shortfall -= drawn;
        }
        if (shortfall > 0) {
            uint256 take = insuranceFund < shortfall ? insuranceFund : shortfall;
            insuranceFund -= take;
            insuranceDrawn[sid] += take;
            s.pot += take;
            shortfall -= take;
        }
        s.owedTotal = owed;
        s.finalized = true;
        s.payoutPerUnit = s.totalUnits == 0 ? 0 : (s.pot * 1e18) / s.totalUnits;
        if (shortfall > 0) {
            s.haircutBps = uint16((shortfall * 1e4) / owed);
            uint16 im = imBufferBps + HAIRCUT_RATCHET_BPS > 1e4 ? 1e4 : imBufferBps + HAIRCUT_RATCHET_BPS;
            imBufferBps = im;
            emit HolderHaircut(sid, owed, s.pot, s.haircutBps, im);
        }
        emit SeriesFinalized(sid, owed, s.pot, s.backstopDrawn, insuranceDrawn[sid], s.payoutPerUnit);
    }

    /// @notice Holder burns `units` of a finalized series for its payout.
    function redeem(bytes32 sid, uint256 units) external nonReentrant returns (uint256 payout) {
        Series storage s = seriesOf[sid];
        require(s.finalized, NotFinalized());
        require(units > 0, ZeroAmount());
        OptionToken(s.token).burn(msg.sender, units);
        payout = (s.payoutPerUnit * units) / 1e18;
        if (payout > s.pot) payout = s.pot;
        s.pot -= payout;
        if (payout > 0) IERC20(usdc).safeTransfer(msg.sender, payout);
        emit Redeemed(s.token, msg.sender, units, payout);
    }

    function _settlementOf(bytes32 sid) internal view returns (bool settled, uint256 price) {
        (,,,, settled, price) = AquaOptionSettlement(settlement).series(sid);
    }

    /// @dev Released margin: a writer's free balance, or straight back to the pool.
    function _credit(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (to == address(backstop)) IERC20(usdc).safeTransfer(to, amount);
        else accounts[to].free += amount;
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
