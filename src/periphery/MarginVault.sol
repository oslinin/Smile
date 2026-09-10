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

import { AquaOptionSettlement } from "../vaults/AquaOptionSettlement.sol";
import { OptionTokenFactory } from "../OptionTokenFactory.sol";
import { MarginBackstop } from "./MarginBackstop.sol";

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
/// backstop wiring, and the timelocked vol-buffer ratchet.
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

    bytes32 private constant MARGIN_STRATEGY_TYPE = keccak256("SMILE-MARGIN-1");
    uint16 public constant MAX_BUFFER_STEP_BPS = 1000;
    uint256 public constant MM_BUFFER_DELAY = 24 hours;

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

    uint256 public nextAuthId;
    mapping(uint256 => Range) public ranges;
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

    constructor(address aqua_, address oracle_, address hook_, address owner_, address tokenFactory_, address usdc_)
        AquaApp(IAqua(aqua_))
        Ownable(owner_)
    {
        oracle = IPriceOracle(oracle_);
        hook = hook_;
        tokenFactory = OptionTokenFactory(tokenFactory_);
        usdc = usdc_;
        usdcDecimals = IERC20Metadata(usdc_).decimals();
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
