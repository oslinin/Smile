// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { AquaApp } from "@1inch/aqua/src/AquaApp.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { IPriceOracle } from "@1inch/swap-vm/src/instructions/interfaces/IPriceOracle.sol";

import { ControlsArgsBuilder } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { FeeArgsBuilder, BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

import { OptionToken } from "../OptionToken.sol";
import { SmileMath } from "../swapvm/SmileMath.sol";
import { SmileSwapVMRouter } from "../swapvm/SmileSwapVMRouter.sol";
import { OptionPremiumArgsBuilder } from "../swapvm/OptionPremiumInstruction.sol";
import { AquaOptionSettlement } from "./AquaOptionSettlement.sol";

interface IOptionPricingHook {
    function bumpSigma(bool isBuy, uint256 timeToExpiry) external;
    function sigmaFor(uint256 timeToExpiry) external view returns (uint256);
    function beta() external view returns (int256);
}

/// @notice JIT collateral vault built on the official 1inch Aqua protocol.
///
/// LPs authorize a strike range — e.g. "all calls between $3000 and $4000" —
/// then `Aqua.ship()` that strategy so collateral STAYS IN THEIR WALLET until
/// a buyer matches. Two official integration modes are used:
///
/// - COVERED CALLS run through the official SwapVM: the strategy is an Aqua
///   order on `SmileSwapVMRouter` whose program prices premiums with the
///   custom option-premium instruction. On `buy()` the vault acts as taker:
///   the router `Aqua.push()`es the buyer's premium into the LP wallet and
///   `Aqua.pull()`s collateral JIT from the LP into this vault.
///
/// - CASH-SECURED PUTS use this vault directly as an official `AquaApp`:
///   the LP ships a put strategy to this contract, and on match the vault
///   calls `Aqua.pull()` itself under the official reentrancy guard.
///
/// Either way, between authorization and match the LP's assets keep earning
/// in their own wallet — displayed option-chain depth is a function of wallet
/// balance, not of pre-allocated per-strike collateral.
contract AquaCollateralVault is AquaApp, Ownable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    SmileSwapVMRouter public immutable router;
    IPriceOracle public immutable oracle;
    IOptionPricingHook public hook;
    AquaOptionSettlement public settlement;
    uint256 public constant ALPHA = 2e18;          // smile curvature — matches frontend
    uint256 public constant DEFAULT_SIGMA = 0.8e18; // fallback σ when no hook wired
    bytes32 private constant PUT_STRATEGY_TYPE = "SMILE-PUT-1";

    /// @notice Max age of the Chainlink spot answer accepted when pricing.
    /// Snapshotted into each strategy at authorize time (strategies are immutable).
    uint256 public maxSpotStaleness = 1 hours;

    /// @notice Protocol fee on option BUYS (1e9 = 100%), grossed up on top of
    /// the Ask so the LP always nets the full premium; sellbacks are fee-free.
    /// Snapshotted per authorization; applies to ranges authorized afterwards.
    uint32 public protocolFeeBps;
    /// @notice Where the protocol fee accrues (e.g. the 1inch DAO treasury).
    address public feeRecipient;
    /// @dev Sanity ceiling: 5% (scale 1e9 = 100%).
    uint32 public constant MAX_PROTOCOL_FEE_BPS = 0.05e9;

    struct LPAuthorization {
        address lp;
        uint256 strikeMin;       // WAD lower bound
        uint256 strikeMax;       // WAD upper bound
        uint256 expiry;          // unix timestamp
        uint256 maxCollateral;   // total capacity (WAD for calls, 6-dec for puts)
        uint256 usedCollateral;  // informational — Aqua virtual balance enforces capacity
        address collateralToken; // WETH for calls, USDC for puts
        bool isCall;
        bool active;
        // Fields below are appended so the tuple prefix stays ABI-compatible
        // with pre-Aqua frontend readers of `authorizations(authId)`.
        address premiumToken;    // token buyers pay premiums in (typically USDC)
        address sigmaSource;     // hook snapshot — baked into the immutable strategy
        uint8 premiumDecimals;   // premiumToken decimals snapshot
        bytes32 strategyHash;    // Aqua strategy hash (order hash for calls)
        int256 beta;             // skew snapshot (surface tilt at authorize time)
        uint16 spotStaleness;    // oracle staleness bound baked into the strategy
        uint32 feeBps;           // protocol fee snapshot (1e9 = 100%), 0 = no fee
        address feeRecipient;    // DAO treasury the fee accrues to
    }

    struct LPPosition {
        uint256 lockedCollateral;
        address collateralToken;
    }

    /// @notice Per-authorization pricing & risk parameters (Phase 1–2
    /// hardening — see docs/solutions.md). Kept in a separate mapping so the
    /// `authorizations` getter (and every ABI reader of it) is untouched.
    struct AuthPricing {
        uint16 baseSpreadBps;              // R4: half-spread floor (1e4 = 100%)
        uint16 stalenessSpreadBpsPerHour;  // R3: half-spread slope per hour of oracle age
        uint64 impactPerUnit;              // R2: WAD σ added per option unit traded
        uint16 sigmaMulBps;                // S5: LP vol multiplier (1e4 = 1.0x; 0 = default)
        uint128 maxBlockNotional;          // R1: collateral units per block; 0 = uncapped
        uint128 blockNotional;             // R1: running total for lastTradeBlock
        uint64 lastTradeBlock;
    }

    struct SeriesRef {
        uint256 authId;
        uint256 strike; // WAD
    }

    uint256 public nextAuthId;
    mapping(uint256 => LPAuthorization) public authorizations;
    // authId => hardening/pricing parameters snapshot
    mapping(uint256 => AuthPricing) public pricingOf;
    // S2: authId => remaining firmness bond (collateral-token units)
    mapping(uint256 => uint256) public bondOf;
    // S3: per-LP fill-reliability counters
    mapping(address => uint64) public fills;
    mapping(address => uint64) public failedPulls;

    /// @notice Defaults snapshotted into NEW authorizations (existing shipped
    /// strategies keep their immutable snapshot).
    uint16 public defaultBaseSpreadBps;
    uint16 public defaultStalenessSpreadBpsPerHour;
    uint64 public defaultImpactPerUnit;
    /// @notice S2: firmness bond as bps of maxCollateral (1e4 scale); 0 = disabled.
    uint16 public firmnessBondBps;
    /// @dev Spread caps mirror the instruction's MAX_HALF_SPREAD_BPS.
    uint16 public constant MAX_HALF_SPREAD_BPS = 2000;
    uint16 public constant MAX_BOND_BPS = 500; // 5% of maxCollateral
    // authId => strike (WAD) => OptionToken address (deployed lazily on first buy)
    mapping(uint256 => mapping(uint256 => address)) public optionTokens;
    // optionToken => (authId, strike) reverse lookup
    mapping(address => SeriesRef) public seriesOf;
    // optionToken => lp => locked position
    mapping(address => mapping(address => LPPosition)) public positions;

    event RangeAuthorized(uint256 indexed authId, address indexed lp, uint256 strikeMin, uint256 strikeMax, uint256 expiry, bool isCall, uint256 maxCollateral);
    event AuthorizationRevoked(uint256 indexed authId);
    event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium);
    event PremiumPaid(address indexed optionToken, address indexed buyer, address indexed lp, uint256 premium);
    event OptionClosed(address indexed optionToken, address indexed holder, uint256 amount);
    event CollateralReleased(address indexed optionToken, address indexed lp, uint256 amount);
    event Redeemed(address indexed optionToken, address indexed holder, uint256 amount, uint256 payout);
    event PullFailed(uint256 indexed authId, address indexed lp, address indexed buyer, uint256 compensation);

    constructor(address aqua_, address payable router_, address oracle_, address owner_)
        AquaApp(IAqua(aqua_))
        Ownable(owner_)
    {
        router = SmileSwapVMRouter(router_);
        oracle = IPriceOracle(oracle_);
    }

    function setHook(address hook_) external onlyOwner {
        hook = IOptionPricingHook(hook_);
    }

    /// @notice Update the staleness bound applied to NEW authorizations
    /// (existing shipped strategies keep their snapshot).
    function setMaxSpotStaleness(uint256 maxSpotStaleness_) external onlyOwner {
        maxSpotStaleness = maxSpotStaleness_;
    }

    /// @notice One-time wiring of the settlement price registry. Every series
    /// minted afterwards is registered there and becomes redeemable at expiry.
    function setSettlement(address settlement_) external onlyOwner {
        require(address(settlement) == address(0), "already set");
        settlement = AquaOptionSettlement(settlement_);
    }

    /// @notice Set the protocol fee for NEW authorizations (existing shipped
    /// strategies keep their snapshot — fee terms are immutable per range).
    function setProtocolFee(uint32 feeBps_, address feeRecipient_) external onlyOwner {
        require(feeBps_ <= MAX_PROTOCOL_FEE_BPS, "fee too high");
        require(feeBps_ == 0 || feeRecipient_ != address(0), "no recipient");
        protocolFeeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    /// @notice Set the spread/impact defaults snapshotted into NEW
    /// authorizations (R2–R4). Half-spread values are bps at 1e4 scale.
    function setPricingDefaults(uint16 baseSpreadBps_, uint16 stalenessSpreadBpsPerHour_, uint64 impactPerUnit_)
        external
        onlyOwner
    {
        require(baseSpreadBps_ <= MAX_HALF_SPREAD_BPS && stalenessSpreadBpsPerHour_ <= MAX_HALF_SPREAD_BPS, "spread too high");
        defaultBaseSpreadBps = baseSpreadBps_;
        defaultStalenessSpreadBpsPerHour = stalenessSpreadBpsPerHour_;
        defaultImpactPerUnit = impactPerUnit_;
    }

    /// @notice S2: set the firmness bond rate for NEW authorizations.
    function setFirmnessBondBps(uint16 bps_) external onlyOwner {
        require(bps_ <= MAX_BOND_BPS, "bond too high");
        firmnessBondBps = bps_;
    }

    /// @notice Canonical series id for a (range, strike) pair.
    function seriesId(uint256 authId, uint256 strike) public pure returns (bytes32) {
        return keccak256(abi.encode(authId, strike));
    }

    // ── LP Range Authorization ────────────────────────────────────────────────

    /// @notice LP commits to writing options at any K in [strikeMin, strikeMax].
    /// No transfer occurs here — this registers the strategy locally and fixes
    /// its immutable terms. To activate it, the LP must (1) ERC-20 approve the
    /// official Aqua contract for up to maxCollateral and (2) call
    /// `Aqua.ship()` with the parameters from {getShipParams}. Collateral
    /// stays in the LP wallet earning yield until a buyer matches.
    function authorizeRange(
        uint256 strikeMin,
        uint256 strikeMax,
        uint256 expiry,
        uint256 maxCollateral,
        address collateralToken,
        address premiumToken,
        bool isCall
    ) external returns (uint256 authId) {
        return authorizeRange(strikeMin, strikeMax, expiry, maxCollateral, collateralToken, premiumToken, isCall, 0, 0);
    }

    /// @notice Full-parameter overload:
    /// @param maxBlockNotional R1 — cap on collateral matched per block from
    ///        this range (0 = uncapped). Bounds the worst-case loss per
    ///        stale-oracle event to one block's cap instead of the whole range.
    /// @param sigmaMulBps S5 — the LP's own vol quote as a multiplier on the
    ///        protocol surface (1e4 = 1.0x, bounded to [0.1x, 3x]; 0 = default).
    ///        Competing ranges with different multipliers ARE the vol discovery.
    function authorizeRange(
        uint256 strikeMin,
        uint256 strikeMax,
        uint256 expiry,
        uint256 maxCollateral,
        address collateralToken,
        address premiumToken,
        bool isCall,
        uint128 maxBlockNotional,
        uint16 sigmaMulBps
    ) public returns (uint256 authId) {
        require(strikeMin <= strikeMax, "invalid range");
        require(expiry > block.timestamp, "expiry in past");
        require(maxCollateral > 0, "zero capacity");
        require(isCall ? collateralToken != premiumToken : collateralToken == premiumToken, "bad token pair");
        require(sigmaMulBps == 0 || (sigmaMulBps >= 1000 && sigmaMulBps <= 30000), "sigma mult out of bounds");

        authId = nextAuthId++;

        // Snapshot pricing/risk parameters BEFORE the strategy hash is
        // computed — the shipped strategy commits to them immutably.
        AuthPricing storage pricing = pricingOf[authId];
        pricing.baseSpreadBps = defaultBaseSpreadBps;
        pricing.stalenessSpreadBpsPerHour = defaultStalenessSpreadBpsPerHour;
        pricing.impactPerUnit = defaultImpactPerUnit;
        pricing.sigmaMulBps = sigmaMulBps;
        pricing.maxBlockNotional = maxBlockNotional;
        LPAuthorization storage auth = authorizations[authId];
        auth.lp = msg.sender;
        auth.strikeMin = strikeMin;
        auth.strikeMax = strikeMax;
        auth.expiry = expiry;
        auth.maxCollateral = maxCollateral;
        auth.collateralToken = collateralToken;
        auth.premiumToken = premiumToken;
        auth.isCall = isCall;
        auth.active = true;
        auth.sigmaSource = address(hook);
        auth.premiumDecimals = IERC20Metadata(premiumToken).decimals();
        auth.beta = address(hook) != address(0) ? hook.beta() : int256(0);
        auth.spotStaleness = SafeCast.toUint16(maxSpotStaleness);
        auth.feeBps = protocolFeeBps;
        auth.feeRecipient = feeRecipient;
        auth.strategyHash = isCall
            ? keccak256(abi.encode(buildOrder(authId)))   // == router.hash() for Aqua orders
            : keccak256(_putStrategy(authId));

        // S2: firmness bond — a small slashable stake that makes displaying
        // depth the LP wallet won't honor cost something. Refunded in full at
        // revocation; split buyer/LP if a JIT pull ever fails (see {_handlePullFailure}).
        uint256 bond = (maxCollateral * firmnessBondBps) / 1e4;
        if (bond > 0) {
            bondOf[authId] = bond;
            IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), bond);
        }

        emit RangeAuthorized(authId, msg.sender, strikeMin, strikeMax, expiry, isCall, maxCollateral);
    }

    /// @notice LP revokes a range in the vault's registry. To also revoke the
    /// Aqua allowance, the LP calls `Aqua.dock()` with {getDockParams}.
    /// Already-matched positions (optionTokens in circulation) are unaffected.
    function revokeAuthorization(uint256 authId) external {
        require(authorizations[authId].lp == msg.sender, "not lp");
        authorizations[authId].active = false;
        // S2: honest exit returns the firmness bond in full.
        uint256 bond = bondOf[authId];
        if (bond > 0) {
            bondOf[authId] = 0;
            IERC20(authorizations[authId].collateralToken).safeTransfer(msg.sender, bond);
        }
        emit AuthorizationRevoked(authId);
    }

    // ── Official Aqua strategy plumbing ──────────────────────────────────────

    /// @dev Program counter of the pricing instruction when the fee prefix is
    /// present: salt (2+8) + deadline (2+5) + jumpIfTokenIn (2+22) +
    /// aquaProtocolFee (2+24) = 67. The jump lands sellbacks here, skipping
    /// the fee.
    uint16 private constant PC_AFTER_FEE = 67;

    /// @notice Rebuilds the canonical SwapVM order for a call range. The
    /// program composes up to five instructions — four official plus the
    /// custom pricing opcode:
    ///   salt            — order-hash uniqueness per range
    ///   deadline        — VM-level expiry guard
    ///   jumpIfTokenIn   — sellbacks (collateral in) skip the fee
    ///   aquaProtocolFee — official protocol fee, grossed up on the Ask and
    ///                     pulled to the fee recipient through Aqua
    ///   optionPremium   — the vol-surface pricing instruction
    function buildOrder(uint256 authId) public view returns (ISwapVM.Order memory) {
        LPAuthorization storage auth = authorizations[authId];
        AuthPricing storage pricing = pricingOf[authId];
        bytes memory premiumArgs = OptionPremiumArgsBuilder.build(
            address(oracle),
            auth.sigmaSource,
            auth.premiumToken,
            auth.collateralToken,
            auth.premiumDecimals,
            auth.strikeMin.toUint128(),
            auth.strikeMax.toUint128(),
            auth.expiry.toUint40(),
            ALPHA.toUint64(),
            SafeCast.toInt64(auth.beta),
            auth.spotStaleness,
            pricing.baseSpreadBps,
            pricing.stalenessSpreadBpsPerHour,
            pricing.impactPerUnit,
            pricing.sigmaMulBps
        );
        bytes memory program = abi.encodePacked(
            uint8(20), uint8(8), uint64(authId),                        // Controls._salt
            uint8(13), uint8(5), auth.expiry.toUint40()                 // Controls._deadline
        );
        if (auth.feeBps > 0) {
            bytes memory jumpArgs = ControlsArgsBuilder.buildJumpIfToken(auth.collateralToken, PC_AFTER_FEE);
            bytes memory feeArgs = FeeArgsBuilder.buildProtocolFee(auth.feeBps, auth.feeRecipient);
            program = abi.encodePacked(
                program,
                uint8(11), uint8(jumpArgs.length), jumpArgs,            // Controls._jumpIfTokenIn
                uint8(28), uint8(feeArgs.length), feeArgs               // Fee._aquaProtocolFeeAmountInXD
            );
        }
        program = abi.encodePacked(
            program,
            uint8(router.OPCODE_OPTION_PREMIUM()), uint8(premiumArgs.length), premiumArgs
        );
        return MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: auth.lp,
            receiver: address(0),
            shouldUnwrapWeth: false,
            useAquaInsteadOfSignature: true,
            allowZeroAmountIn: false,
            hasPreTransferInHook: false,
            hasPostTransferInHook: false,
            hasPreTransferOutHook: false,
            hasPostTransferOutHook: false,
            preTransferInTarget: address(0),
            preTransferInData: "",
            postTransferInTarget: address(0),
            postTransferInData: "",
            preTransferOutTarget: address(0),
            preTransferOutData: "",
            postTransferOutTarget: address(0),
            postTransferOutData: "",
            program: program
        }));
    }

    /// @notice Everything the LP needs to pass to the official
    /// `Aqua.ship(app, strategy, tokens, amounts)` to activate a range.
    /// @dev The LP must ERC-20 approve Aqua for BOTH tokens: the collateral
    /// (JIT pulls on buys — approve above maxCollateral, since capacity
    /// restored by sellbacks can be pulled again) and the premium token
    /// (Bid pulls on holder sellbacks via {close}, and protocol-fee pulls
    /// on buys). Fee-enabled ranges ship with a small premium-token virtual
    /// seed: the official fee instruction pulls the fee BEFORE the buyer's
    /// premium push lands, so early trades draw on that headroom (it is an
    /// allowance number — no tokens move at ship time — but the LP wallet
    /// must hold a matching float when a trade executes).
    function getShipParams(uint256 authId)
        external
        view
        returns (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts)
    {
        LPAuthorization storage auth = authorizations[authId];
        require(auth.lp != address(0), "unknown auth");
        if (auth.isCall) {
            app = address(router);
            strategy = abi.encode(buildOrder(authId));
            tokens = new address[](2);
            tokens[0] = auth.collateralToken;
            tokens[1] = auth.premiumToken;
            amounts = new uint256[](2);
            amounts[0] = auth.maxCollateral;
            // Premium balance grows via Aqua.push on every match; fee-enabled
            // ranges start with $25 of headroom for the first fee pulls.
            amounts[1] = auth.feeBps > 0 ? 25 * (10 ** auth.premiumDecimals) : 0;
        } else {
            app = address(this);
            strategy = _putStrategy(authId);
            tokens = new address[](1);
            tokens[0] = auth.collateralToken;
            amounts = new uint256[](1);
            amounts[0] = auth.maxCollateral;
        }
    }

    /// @notice Parameters for the official `Aqua.dock(app, strategyHash, tokens)`.
    function getDockParams(uint256 authId)
        external
        view
        returns (address app, bytes32 strategyHash, address[] memory tokens)
    {
        LPAuthorization storage auth = authorizations[authId];
        require(auth.lp != address(0), "unknown auth");
        strategyHash = auth.strategyHash;
        if (auth.isCall) {
            app = address(router);
            tokens = new address[](2);
            tokens[0] = auth.collateralToken;
            tokens[1] = auth.premiumToken;
        } else {
            app = address(this);
            tokens = new address[](1);
            tokens[0] = auth.collateralToken;
        }
    }

    /// @dev Put strategies are shipped to this vault itself (an official
    /// AquaApp). Full terms are encoded for data availability, per Aqua docs.
    function _putStrategy(uint256 authId) internal view returns (bytes memory) {
        LPAuthorization storage auth = authorizations[authId];
        return abi.encode(
            PUT_STRATEGY_TYPE,
            authId,
            auth.lp,
            auth.strikeMin,
            auth.strikeMax,
            auth.expiry,
            auth.maxCollateral,
            auth.collateralToken
        );
    }

    // ── Buy ──────────────────────────────────────────────────────────────────

    /// @notice Buy an option at a specific strike within an LP's shipped range.
    ///
    /// Covered calls execute as an official SwapVM swap: premium is
    /// `Aqua.push()`ed into the LP wallet and collateral is `Aqua.pull()`ed
    /// JIT into this vault, atomically. Puts pull collateral through this
    /// vault's own AquaApp strategy. Either way an OptionToken series is
    /// deployed lazily and minted to the buyer.
    ///
    /// @param authId     LP's range authorization to match against.
    /// @param strike     Strike (WAD) the buyer wants — any K in [strikeMin, strikeMax].
    /// @param amount     Option units to buy (WAD).
    /// @param maxPremium Premium slippage bound in premiumToken units.
    function buy(
        uint256 authId,
        uint256 strike,
        uint256 amount,
        uint256 maxPremium
    ) external returns (address optionToken, uint256 premiumPaid) {
        return _buy(msg.sender, authId, strike, amount, maxPremium);
    }

    /// @dev Shared by {buy} and {buyBest}. Returns (address(0), 0) — WITHOUT
    /// reverting — when the LP wallet couldn't honor the JIT pull: the buyer
    /// was compensated from the firmness bond and the range deactivated (S2).
    /// Every other failure (slippage, staleness, capacity) reverts as before.
    function _buy(
        address buyer,
        uint256 authId,
        uint256 strike,
        uint256 amount,
        uint256 maxPremium
    ) internal returns (address optionToken, uint256 premiumPaid) {
        LPAuthorization storage auth = authorizations[authId];
        require(auth.active, "authorization inactive");
        require(block.timestamp < auth.expiry, "expired");
        require(strike >= auth.strikeMin && strike <= auth.strikeMax, "strike out of range");
        require(amount > 0, "zero amount");

        uint256 collateralNeeded = auth.isCall ? amount : (strike * amount) / 1e30; // puts: 6-dec USDC cash security

        // R1: per-block notional cap — a stale-oracle event can cost at most
        // one block's cap instead of the range's whole remaining capacity.
        AuthPricing storage pricing = pricingOf[authId];
        if (pricing.maxBlockNotional > 0) {
            if (pricing.lastTradeBlock != uint64(block.number)) {
                pricing.lastTradeBlock = uint64(block.number);
                pricing.blockNotional = 0;
            }
            require(pricing.blockNotional + collateralNeeded <= pricing.maxBlockNotional, "block cap");
            pricing.blockNotional += SafeCast.toUint128(collateralNeeded);
        }

        bool filled;
        (filled, premiumPaid) = auth.isCall
            ? _tryBuyCall(buyer, authId, auth, strike, amount, maxPremium, collateralNeeded)
            : _tryBuyPut(buyer, authId, auth, strike, amount, collateralNeeded, maxPremium);
        if (!filled) return (address(0), 0);

        auth.usedCollateral += collateralNeeded;
        fills[auth.lp] += 1; // S3: reliability numerator

        optionToken = _mintSeries(authId, auth, strike, amount, collateralNeeded, buyer);

        if (address(hook) != address(0)) hook.bumpSigma(true, auth.expiry - block.timestamp);

        emit PremiumPaid(optionToken, buyer, auth.lp, premiumPaid);
        emit OptionBought(authId, optionToken, buyer, strike, amount, premiumPaid);
    }

    /// @dev Call leg with firmness handling: the quote and the slippage bound
    /// run OUTSIDE the try (their failures revert the whole tx as before);
    /// only the swap — the part a drained LP wallet can break — is caught.
    function _tryBuyCall(
        address buyer,
        uint256 authId,
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amount,
        uint256 maxPremium,
        uint256 collateralNeeded
    ) internal returns (bool filled, uint256 premiumPaid) {
        ISwapVM.Order memory order = buildOrder(authId);
        bytes memory takerData = _callTakerData(strike, maxPremium);

        (uint256 quoted,,) = router.quote(order, auth.premiumToken, auth.collateralToken, amount, takerData);
        require(quoted <= maxPremium, "premium above max");

        try this.execCallLeg(order, auth.premiumToken, auth.collateralToken, amount, takerData, buyer, quoted)
            returns (uint256 paid)
        {
            return (true, paid);
        } catch (bytes memory reason) {
            if (_isFirmnessFailure(auth, collateralNeeded)) {
                _handlePullFailure(authId, auth, buyer);
                return (false, 0);
            }
            // Not a firmness problem (e.g. Aqua capacity, fee float) — bubble
            // the original revert unchanged.
            assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        }
    }

    /// @dev Put leg with the same firmness handling; premium quote + slippage
    /// check stay outside the try.
    function _tryBuyPut(
        address buyer,
        uint256 authId,
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amount,
        uint256 collateralNeeded,
        uint256 maxPremium
    ) internal returns (bool filled, uint256 premiumPaid) {
        (uint256 lpPremium, uint256 fee) = _putQuote(authId, auth, strike, amount);
        premiumPaid = lpPremium + fee;
        require(premiumPaid <= maxPremium, "premium above max");

        try this.execPutLeg(
            auth.lp, auth.strategyHash, auth.premiumToken, auth.collateralToken,
            auth.feeRecipient, buyer, lpPremium, fee, collateralNeeded
        ) {
            return (true, premiumPaid);
        } catch (bytes memory reason) {
            if (_isFirmnessFailure(auth, collateralNeeded)) {
                _handlePullFailure(authId, auth, buyer);
                return (false, 0);
            }
            assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        }
    }

    /// @dev Self-call wrapper so the call-leg swap can be try/caught as a
    /// unit: buyer premium in, router swap (Aqua JIT pull) — a failure rolls
    /// everything back atomically, leaving only the catch-branch compensation.
    function execCallLeg(
        ISwapVM.Order calldata order,
        address premiumToken,
        address collateralToken,
        uint256 amount,
        bytes calldata takerData,
        address buyer,
        uint256 premium
    ) external returns (uint256 premiumPaid) {
        require(msg.sender == address(this), "self only");
        IERC20(premiumToken).safeTransferFrom(buyer, address(this), premium);
        IERC20(premiumToken).forceApprove(address(router), premium);
        (premiumPaid,,) = router.swap(order, premiumToken, collateralToken, amount, takerData);
    }

    /// @dev Self-call wrapper for the put leg, under the official per-strategy
    /// reentrancy guard (this vault is the AquaApp for puts).
    function execPutLeg(
        address lp,
        bytes32 strategyHash,
        address premiumToken,
        address collateralToken,
        address feeRecipient_,
        address buyer,
        uint256 lpPremium,
        uint256 fee,
        uint256 collateralNeeded
    ) external nonReentrantStrategy(lp, strategyHash) {
        require(msg.sender == address(this), "self only");
        if (lpPremium > 0) {
            IERC20(premiumToken).safeTransferFrom(buyer, lp, lpPremium);
        }
        if (fee > 0) {
            IERC20(premiumToken).safeTransferFrom(buyer, feeRecipient_, fee);
        }
        AQUA.pull(lp, strategyHash, collateralToken, collateralNeeded, address(this));
    }

    /// @dev S1 firmness check: can the LP wallet actually honor a JIT pull of
    /// `collateralNeeded` right now? Quoted depth that fails this is phantom.
    function _lpCannotCover(LPAuthorization storage auth, uint256 collateralNeeded) internal view returns (bool) {
        IERC20 c = IERC20(auth.collateralToken);
        return c.balanceOf(auth.lp) < collateralNeeded || c.allowance(auth.lp, address(AQUA)) < collateralNeeded;
    }

    /// @dev Collateral capacity still shipped on the strategy (Aqua virtual
    /// balance). Distinguishes "range sold out" (a taker-size error that must
    /// revert) from "LP wallet drained" (a firmness failure that compensates).
    function _shippedCapacity(LPAuthorization storage auth) internal view returns (uint256) {
        address app = auth.isCall ? address(router) : address(this);
        (uint248 virtualBal,) = AQUA.rawBalances(auth.lp, app, auth.strategyHash, auth.collateralToken);
        return uint256(virtualBal);
    }

    /// @dev A caught buy failure is the LP's dishonesty ONLY when the shipped
    /// strategy still had the capacity and the wallet didn't back it.
    function _isFirmnessFailure(LPAuthorization storage auth, uint256 collateralNeeded) internal view returns (bool) {
        return _shippedCapacity(auth) >= collateralNeeded && _lpCannotCover(auth, collateralNeeded);
    }

    /// @dev S2/S3: a JIT pull failed because the LP moved the backing balance
    /// (or revoked Aqua's allowance). Deactivate the phantom range, count it
    /// against the LP, and split the firmness bond: half compensates the buyer
    /// for revealing their trade intention against unhonored depth, half
    /// returns to the LP.
    function _handlePullFailure(uint256 authId, LPAuthorization storage auth, address buyer) internal {
        auth.active = false;
        failedPulls[auth.lp] += 1;
        uint256 bond = bondOf[authId];
        uint256 compensation;
        if (bond > 0) {
            bondOf[authId] = 0;
            compensation = bond / 2;
            IERC20(auth.collateralToken).safeTransfer(buyer, compensation);
            IERC20(auth.collateralToken).safeTransfer(auth.lp, bond - compensation);
        }
        emit PullFailed(authId, auth.lp, buyer, compensation);
    }

    /// @dev Ask-side put quote: LP premium (ceil, Ask) plus the fee gross-up
    /// (same shape as the SwapVM fee opcode on the call leg).
    function _putQuote(uint256 authId, LPAuthorization storage auth, uint256 strike, uint256 amount)
        internal
        view
        returns (uint256 lpPremium, uint256 fee)
    {
        uint256 totalWad = Math.ceilDiv(_putUnitPremiumWad(authId, auth, strike, amount, true) * amount, 1e18);
        lpPremium = SmileMath.scaleFromWad(totalWad, auth.premiumDecimals, true);
        fee = auth.feeBps > 0 ? Math.ceilDiv(lpPremium * auth.feeBps, BPS - auth.feeBps) : 0;
    }

    // ── Best-quote routing (S6) ──────────────────────────────────────────────

    /// @notice Scan every authorization covering (strike, expiry, isCall) and
    /// return the cheapest executable Ask for `amount` — skipping phantom
    /// quotes the LP wallet can't honor (S1), ranges out of per-block capacity
    /// (R1), and candidates whose quote reverts. Overlapping ranges quoting
    /// different vols (S5) compete here: the touch IS the discovered vol.
    /// @dev O(nextAuthId) with an external quote per call candidate — meant
    /// for eth_call (it is static-callable) and small on-chain marketplaces.
    /// Returns (type(uint256).max, type(uint256).max) when nothing quotes.
    function bestQuote(uint256 strike, uint256 expiry, bool isCall, uint256 amount)
        public
        returns (uint256 bestAuthId, uint256 bestPremium)
    {
        bestAuthId = type(uint256).max;
        bestPremium = type(uint256).max;
        uint256 n = nextAuthId;
        for (uint256 i = 0; i < n; i++) {
            LPAuthorization storage auth = authorizations[i];
            if (!auth.active || auth.isCall != isCall || auth.expiry != expiry) continue;
            if (strike < auth.strikeMin || strike > auth.strikeMax) continue;

            uint256 collateralNeeded = isCall ? amount : (strike * amount) / 1e30;
            if (_shippedCapacity(auth) < collateralNeeded) continue; // sold out / docked
            if (_lpCannotCover(auth, collateralNeeded)) continue;    // S1: phantom depth

            AuthPricing storage pricing = pricingOf[i];
            if (pricing.maxBlockNotional > 0) {
                uint256 usedThisBlock = pricing.lastTradeBlock == uint64(block.number) ? pricing.blockNotional : 0;
                if (usedThisBlock + collateralNeeded > pricing.maxBlockNotional) continue; // R1
            }

            uint256 premium;
            if (isCall) {
                try router.quote(
                    buildOrder(i), auth.premiumToken, auth.collateralToken, amount,
                    _callTakerData(strike, type(uint256).max)
                ) returns (uint256 amountIn, uint256, bytes32) {
                    premium = amountIn;
                } catch {
                    continue;
                }
            } else {
                (uint256 lpPremium, uint256 fee) = _putQuote(i, auth, strike, amount);
                premium = lpPremium + fee;
            }

            if (premium < bestPremium) {
                bestPremium = premium;
                bestAuthId = i;
            }
        }
    }

    /// @notice Buy `amount` options at `strike`/`expiry` from whichever LP
    /// quotes the best executable Ask (S6). Reverts when no range quotes.
    function buyBest(uint256 strike, uint256 expiry, bool isCall, uint256 amount, uint256 maxPremium)
        external
        returns (address optionToken, uint256 premiumPaid)
    {
        (uint256 authId, uint256 premium) = bestQuote(strike, expiry, isCall, amount);
        require(authId != type(uint256).max, "no executable quote");
        require(premium <= maxPremium, "premium above max");
        return _buy(msg.sender, authId, strike, amount, maxPremium);
    }

    /// @dev Taker traits for the call leg: the vault is the taker (exactOut →
    /// Ask side); `to` defaults to the vault so pulled collateral lands here
    /// for escrow; the router pushes the premium into the LP wallet via Aqua.
    function _callTakerData(uint256 strike, uint256 maxPremium) internal view returns (bytes memory) {
        return TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(this),
            isExactIn: false,                    // exactOut: fix option units → Ask side
            shouldUnwrapWeth: false,
            isStrictThresholdAmount: false,
            isFirstTransferFromTaker: true,      // premium in before collateral out
            useTransferFromAndAquaPush: true,    // router pushes premium into LP wallet via Aqua
            threshold: abi.encode(maxPremium),
            to: address(0),                      // defaults to taker (this vault)
            deadline: 0,
            hasPreTransferInCallback: false,
            hasPreTransferOutCallback: false,
            preTransferInHookData: "",
            postTransferInHookData: "",
            preTransferOutHookData: "",
            postTransferOutHookData: "",
            preTransferInCallbackData: "",
            preTransferOutCallbackData: "",
            instructionsArgs: abi.encodePacked(strike), // taker picks the strike within the range
            signature: ""
        }));
    }

    /// @dev Deploy the (authId, strike) OptionToken series lazily and mint.
    function _mintSeries(
        uint256 authId,
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amount,
        uint256 collateralNeeded,
        address buyer
    ) internal returns (address optionToken) {
        optionToken = optionTokens[authId][strike];
        if (optionToken == address(0)) {
            optionToken = address(new OptionToken(
                string(abi.encodePacked(auth.isCall ? "CALL-" : "PUT-", _uint2str(strike / 1e18))),
                auth.isCall ? "CALL" : "PUT",
                auth.collateralToken,
                strike,
                auth.expiry,
                auth.isCall,
                address(this)
            ));
            optionTokens[authId][strike] = optionToken;
            seriesOf[optionToken] = SeriesRef({authId: authId, strike: strike});
            if (address(settlement) != address(0)) {
                settlement.registerSeries(seriesId(authId, strike), optionToken, auth.expiry, strike, auth.isCall);
            }
        }

        LPPosition storage pos = positions[optionToken][auth.lp];
        pos.lockedCollateral += collateralNeeded;
        pos.collateralToken = auth.collateralToken;

        OptionToken(optionToken).mint(buyer, amount);
    }

    // ── Close (sellback at Bid) ──────────────────────────────────────────────

    /// @notice Early close = SELLBACK: the holder sells the option back to the
    /// LP at the live Bid (same smile/surface math that priced the Ask), so a
    /// long position always has a mark-to-market exit.
    ///
    /// Covered calls execute as a REVERSE SwapVM swap through the same shipped
    /// strategy: escrowed collateral is `Aqua.push()`ed back into the LP wallet
    /// (restoring the range's JIT capacity) and the Bid premium is
    /// `Aqua.pull()`ed from the LP wallet straight to the holder. Puts do the
    /// symmetric pull/push with this vault as the official AquaApp.
    ///
    /// The buyback is funded by premiums the LP has already earned — if their
    /// premium balance can't cover the Bid, the sellback reverts and the
    /// holder can instead hold to expiry and `redeem()`.
    ///
    /// @param optionToken Series being sold back.
    /// @param lp          The LP whose position is unwound (must match the series' LP).
    /// @param amount      Option units to sell back (WAD).
    /// @param minPayout   Bid-slippage bound in premiumToken units.
    function close(
        address optionToken,
        address lp,
        uint256 amount,
        uint256 minPayout
    ) external returns (uint256 payout) {
        require(amount > 0, "zero amount");
        SeriesRef memory ref = seriesOf[optionToken];
        require(optionTokens[ref.authId][ref.strike] == optionToken, "unknown series");
        LPAuthorization storage auth = authorizations[ref.authId];
        require(lp == auth.lp, "wrong lp");
        LPPosition storage pos = positions[optionToken][lp];

        OptionToken(optionToken).burn(msg.sender, amount);

        uint256 collateralReturned;
        if (auth.isCall) {
            collateralReturned = amount;
            pos.lockedCollateral -= collateralReturned;
            payout = _sellbackCallViaSwapVM(ref.authId, auth, ref.strike, amount, minPayout);
        } else {
            collateralReturned = (ref.strike * amount) / 1e30;
            pos.lockedCollateral -= collateralReturned;
            payout = _sellbackPutViaAqua(ref.authId, auth, ref.strike, amount, collateralReturned, minPayout);
        }

        if (address(hook) != address(0)) {
            hook.bumpSigma(false, auth.expiry > block.timestamp ? auth.expiry - block.timestamp : 0);
        }

        emit OptionClosed(optionToken, msg.sender, amount);
        emit CollateralReleased(optionToken, lp, collateralReturned);
    }

    /// @dev Covered-call sellback: reverse swap through the official SwapVM.
    /// exactIn = option units → Bid side; `to` routes the premium to the holder.
    function _sellbackCallViaSwapVM(
        uint256 authId,
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amount,
        uint256 minPayout
    ) internal returns (uint256 payout) {
        ISwapVM.Order memory order = buildOrder(authId);
        bytes memory takerData = TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(this),
            isExactIn: true,                     // exactIn: fixed option units → Bid side
            shouldUnwrapWeth: false,
            isStrictThresholdAmount: false,
            isFirstTransferFromTaker: true,      // collateral back to LP before premium out
            useTransferFromAndAquaPush: true,    // push restores the strategy's JIT capacity
            threshold: abi.encode(minPayout),    // exactIn → minimum amountOut
            to: msg.sender,                      // Bid premium goes straight to the holder
            deadline: 0,
            hasPreTransferInCallback: false,
            hasPreTransferOutCallback: false,
            preTransferInHookData: "",
            postTransferInHookData: "",
            preTransferOutHookData: "",
            postTransferOutHookData: "",
            preTransferInCallbackData: "",
            preTransferOutCallbackData: "",
            instructionsArgs: abi.encodePacked(strike),
            signature: ""
        }));

        IERC20(auth.collateralToken).forceApprove(address(router), amount);
        (, payout,) = router.swap(order, auth.collateralToken, auth.premiumToken, amount, takerData);
    }

    /// @dev Put sellback: this vault is the official AquaApp. Bid premium is
    /// pulled from the LP wallet to the holder; escrowed USDC collateral is
    /// pushed back, restoring the strategy's capacity.
    function _sellbackPutViaAqua(
        uint256 authId,
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amount,
        uint256 collateralReturned,
        uint256 minPayout
    ) internal nonReentrantStrategy(auth.lp, auth.strategyHash) returns (uint256 payout) {
        require(block.timestamp < auth.expiry, "expired");
        uint256 totalWad = (_putUnitPremiumWad(authId, auth, strike, amount, false) * amount) / 1e18; // floor → Bid
        payout = SmileMath.scaleFromWad(totalWad, auth.premiumDecimals, false);
        require(payout >= minPayout, "payout below min");

        if (payout > 0) {
            AQUA.pull(auth.lp, auth.strategyHash, auth.premiumToken, payout, msg.sender);
        }
        IERC20(auth.collateralToken).forceApprove(address(AQUA), collateralReturned);
        AQUA.push(auth.lp, address(this), auth.strategyHash, auth.collateralToken, collateralReturned);
    }

    // ── Settlement: redeem & reclaim ─────────────────────────────────────────

    /// @notice Holder redeems option tokens for the cash-settled intrinsic
    /// after the series settled (via CRE or permissionless Chainlink-round
    /// settlement in {AquaOptionSettlement}). Paid from the locked collateral:
    ///   call → (S−K)/S of collateral (WETH) per unit, i.e. the intrinsic in
    ///          collateral terms at the settlement price;
    ///   put  → (K−S) USDC per unit.
    /// OTM redeems burn for zero — the collateral belongs to the LP.
    function redeem(address optionToken, uint256 amount) external returns (uint256 payout) {
        require(amount > 0, "zero amount");
        SeriesRef memory ref = seriesOf[optionToken];
        require(optionTokens[ref.authId][ref.strike] == optionToken, "unknown series");
        LPAuthorization storage auth = authorizations[ref.authId];

        (bool settled, uint256 settlementPrice) = _settlementOf(ref);
        require(settled, "not settled");

        OptionToken(optionToken).burn(msg.sender, amount);

        payout = _intrinsicPayout(auth.isCall, settlementPrice, ref.strike, amount);
        LPPosition storage pos = positions[optionToken][auth.lp];
        if (payout > pos.lockedCollateral) payout = pos.lockedCollateral;
        if (payout > 0) {
            pos.lockedCollateral -= payout;
            IERC20(auth.collateralToken).safeTransfer(msg.sender, payout);
        }
        emit Redeemed(optionToken, msg.sender, amount, payout);
    }

    /// @notice LP reclaims collateral no longer needed after settlement: the
    /// locked amount minus the worst-case still owed to outstanding holders
    /// (OTM → everything; ITM → the non-intrinsic remainder).
    function reclaimCollateral(address optionToken) external returns (uint256 amount) {
        SeriesRef memory ref = seriesOf[optionToken];
        require(optionTokens[ref.authId][ref.strike] == optionToken, "unknown series");
        LPAuthorization storage auth = authorizations[ref.authId];
        require(msg.sender == auth.lp, "not lp");

        (bool settled, uint256 settlementPrice) = _settlementOf(ref);
        require(settled, "not settled");

        uint256 outstanding = IERC20(optionToken).totalSupply();
        uint256 owed = _intrinsicPayout(auth.isCall, settlementPrice, ref.strike, outstanding);
        LPPosition storage pos = positions[optionToken][auth.lp];
        require(pos.lockedCollateral > owed, "nothing to reclaim");

        amount = pos.lockedCollateral - owed;
        pos.lockedCollateral = owed;
        IERC20(auth.collateralToken).safeTransfer(auth.lp, amount);
        emit CollateralReleased(optionToken, auth.lp, amount);
    }

    /// @dev Cash-settled intrinsic in COLLATERAL-TOKEN units for `amount`
    /// (WAD) option units — decimals-consistent for both legs:
    ///   call: intrinsic (S−K) USD converted to WETH at S → amount·(S−K)/S
    ///   put:  intrinsic (K−S) USD in 6-dec USDC → amount·(K−S)/1e30
    function _intrinsicPayout(bool isCall, uint256 settlementPrice, uint256 strike, uint256 amount)
        internal
        pure
        returns (uint256)
    {
        if (isCall) {
            if (settlementPrice <= strike) return 0;
            return (amount * (settlementPrice - strike)) / settlementPrice;
        }
        if (strike <= settlementPrice) return 0;
        return (amount * (strike - settlementPrice)) / 1e30;
    }

    function _settlementOf(SeriesRef memory ref) internal view returns (bool settled, uint256 settlementPrice) {
        require(address(settlement) != address(0), "settlement not set");
        (,,,, settled, settlementPrice) = settlement.series(seriesId(ref.authId, ref.strike));
    }

    /// @notice Owner escape hatch to release locked collateral back to an LP.
    function releaseCollateral(address optionToken, address lp, uint256 amount) external onlyOwner {
        LPPosition storage pos = positions[optionToken][lp];
        require(pos.lockedCollateral >= amount, "insufficient locked");
        pos.lockedCollateral -= amount;
        IERC20(pos.collateralToken).safeTransfer(lp, amount);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Per-unit put premium in WAD USD from the live surface (Ask when
    /// isBuy, Bid otherwise) — the vault-side twin of the SwapVM instruction,
    /// including its hardening layers: the LP vol multiplier (S5), the
    /// size-convex impact for a trade of `amountWad` units (R2), and the
    /// staleness-scaled half-spread over a base floor (R3/R4).
    function _putUnitPremiumWad(
        uint256 authId,
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amountWad,
        bool isBuy
    ) internal view returns (uint256 premiumWad) {
        (uint256 spot, uint256 ageSec) = _spotWad(auth.spotStaleness);
        uint256 timeToExpiry = auth.expiry - block.timestamp;
        uint256 sigma = auth.sigmaSource != address(0)
            ? IOptionPricingHook(auth.sigmaSource).sigmaFor(timeToExpiry)
            : DEFAULT_SIGMA;

        AuthPricing storage pricing = pricingOf[authId];
        if (pricing.sigmaMulBps != 0) sigma = (sigma * pricing.sigmaMulBps) / 1e4; // S5

        uint256 sigmaStrike = SmileMath.smileVol(spot, strike, sigma, ALPHA, auth.beta);

        // R2: size-convex impact, mirroring the instruction exactly.
        uint256 impact = (uint256(pricing.impactPerUnit) * amountWad) / (2 * 1e18);
        if (isBuy) {
            sigmaStrike += impact;
        } else {
            uint256 floorSigma = sigmaStrike / 10;
            sigmaStrike = sigmaStrike > impact ? sigmaStrike - impact : floorSigma;
            if (sigmaStrike < floorSigma) sigmaStrike = floorSigma;
        }

        premiumWad = SmileMath.premium(spot, strike, timeToExpiry, sigmaStrike, false, isBuy);

        // R3/R4: half-spread floor + staleness slope, capped at 20%.
        uint256 halfSpreadBps = uint256(pricing.baseSpreadBps) + (uint256(pricing.stalenessSpreadBpsPerHour) * ageSec) / 3600;
        if (halfSpreadBps > MAX_HALF_SPREAD_BPS) halfSpreadBps = MAX_HALF_SPREAD_BPS;
        if (halfSpreadBps > 0) {
            premiumWad = isBuy
                ? Math.ceilDiv(premiumWad * (1e4 + halfSpreadBps), 1e4)
                : (premiumWad * (1e4 - halfSpreadBps)) / 1e4;
        }
    }

    function _spotWad(uint256 maxStaleness) internal view returns (uint256 spotWad, uint256 ageSec) {
        (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        require(answer > 0, "bad oracle price");
        require(
            maxStaleness == 0 || (updatedAt != 0 && block.timestamp <= updatedAt + maxStaleness),
            "stale oracle price"
        );
        spotWad = SmileMath.scaleToWad(uint256(answer), oracle.decimals());
        ageSec = updatedAt >= block.timestamp ? 0 : block.timestamp - updatedAt;
    }

    function _uint2str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 digits;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory b = new bytes(digits);
        while (v != 0) { digits--; b[digits] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
