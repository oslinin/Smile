// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { AquaApp } from "@1inch/aqua/src/AquaApp.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { IPriceOracle } from "@1inch/swap-vm/src/instructions/interfaces/IPriceOracle.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

import { SmileMath } from "../swapvm/SmileMath.sol";
import { SmilePremiumLib } from "./SmilePremiumLib.sol";

interface IBetaSource {
    function beta() external view returns (int256);
}

/// @notice Defined-risk netting sibling vault (S12, rung 2 of the capital-
/// efficiency ladder — design: docs/plans/2026-07-12-s12-defined-risk-netting.md).
/// A call credit spread (short K1, long K2) escrows only its true worst
/// case, `(K2-K1)/K2` WETH, instead of a full WETH as if the short leg were
/// naked. A separate AquaApp, same pattern as FirmEscrow/SmileQuoteLens —
/// `AquaCollateralVault` is never touched.
///
/// Pricing is not a new model: both legs are quoted off the identical
/// surface the main vault uses (SmilePremiumLib is that math lifted into a
/// library), so a spread is purely a collateral-accounting layer.
///
/// Scope so far: A1 scaffold, A2 quote (call credit + put credit; iron
/// condor is strike-validated but not priced yet).
contract SpreadVault is AquaApp, Ownable {
    enum Kind { CallCredit, PutCredit, IronCondor }

    /// @dev strikes layout: CallCredit uses [2]=K1,[3]=K2; PutCredit uses
    /// [0]=K1,[1]=K2; IronCondor uses all four (put K1<K2 <= call K1<K2).
    struct Structure {
        address lp;
        Kind kind;
        uint256[4] strikes;
        uint256 expiry;
        uint256 maxCollateral;
        bool active;
        bytes32 strategyHash;
        uint32 feeBps;
        address feeRecipient;
    }

    /// @dev Pricing/risk terms snapshotted at open, same knobs as the main
    /// vault's AuthPricing so the two vaults quote identically.
    struct Pricing {
        uint16 baseSpreadBps;
        uint16 stalenessSpreadBpsPerHour;
        uint64 impactPerUnit;
        uint16 sigmaMulBps;
        uint16 spotStaleness;
        int256 beta;
    }

    bytes32 private constant SPREAD_STRATEGY_TYPE = keccak256("SMILE-SPREAD-1");
    uint32 public constant MAX_PROTOCOL_FEE_BPS = 0.05e9;
    uint16 internal constant MAX_HALF_SPREAD_BPS = 2000;

    address public immutable weth;
    address public immutable usdc;
    uint8 public immutable usdcDecimals;
    IPriceOracle public immutable oracle;
    address public immutable hook;
    address public settlement;

    uint256 public maxSpotStaleness = 1 hours;
    uint16 public defaultBaseSpreadBps;
    uint16 public defaultStalenessSpreadBpsPerHour;
    uint64 public defaultImpactPerUnit;
    uint32 public protocolFeeBps;
    address public feeRecipient;

    uint256 public nextAuthId;
    mapping(uint256 => Structure) public structures;
    mapping(uint256 => Pricing) public pricingOf;

    error ExpiryInPast();
    error ZeroCapacity();
    error ZeroAmount();
    error InvalidStrikes();
    error UnknownStructure();
    error StructureInactive();
    error UnsupportedKind();
    error NotLp();
    error AlreadySet();

    event StructureOpened(
        uint256 indexed authId, address indexed lp, Kind kind, uint256[4] strikes, uint256 expiry, uint256 maxCollateral
    );
    event StructureRevoked(uint256 indexed authId);

    constructor(address aqua_, address oracle_, address hook_, address owner_, address weth_, address usdc_)
        AquaApp(IAqua(aqua_))
        Ownable(owner_)
    {
        oracle = IPriceOracle(oracle_);
        hook = hook_;
        weth = weth_;
        usdc = usdc_;
        usdcDecimals = IERC20Metadata(usdc_).decimals();
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// @notice One-time wiring, mirrors AquaCollateralVault.setSettlement.
    function setSettlement(address settlement_) external onlyOwner {
        require(settlement == address(0), AlreadySet());
        settlement = settlement_;
    }

    /// @notice R3/R4 + R2 defaults snapshotted into NEW structures.
    function setPricingDefaults(uint16 baseSpreadBps_, uint16 stalenessSpreadBpsPerHour_, uint64 impactPerUnit_)
        external
        onlyOwner
    {
        require(baseSpreadBps_ <= MAX_HALF_SPREAD_BPS && stalenessSpreadBpsPerHour_ <= MAX_HALF_SPREAD_BPS, "spread too wide");
        defaultBaseSpreadBps = baseSpreadBps_;
        defaultStalenessSpreadBpsPerHour = stalenessSpreadBpsPerHour_;
        defaultImpactPerUnit = impactPerUnit_;
    }

    /// @notice Protocol fee on spread BUYS (1e9 = 100%), grossed up on the
    /// taker's net premium; snapshotted per structure.
    function setProtocolFee(uint32 feeBps_, address recipient_) external onlyOwner {
        require(feeBps_ <= MAX_PROTOCOL_FEE_BPS, "fee too high");
        require(feeBps_ == 0 || recipient_ != address(0), "no recipient");
        protocolFeeBps = feeBps_;
        feeRecipient = recipient_;
    }

    // ── Structures ───────────────────────────────────────────────────────────

    /// @notice Opens a defined-risk structure. `maxCollateral` is the total
    /// escrow capacity in the structure's collateral token; per-unit escrow
    /// is derived in {quote} from the S12 table, and `buy()` pulls exactly
    /// that per fill (A3).
    function openStructure(Kind kind, uint256[4] calldata strikes, uint256 expiry, uint256 maxCollateral)
        external
        returns (uint256 authId)
    {
        require(expiry > block.timestamp, ExpiryInPast());
        require(maxCollateral > 0, ZeroCapacity());
        if (kind == Kind.CallCredit) {
            require(strikes[2] < strikes[3], InvalidStrikes());
        } else if (kind == Kind.PutCredit) {
            require(strikes[0] < strikes[1], InvalidStrikes());
        } else {
            require(strikes[0] < strikes[1] && strikes[1] <= strikes[2] && strikes[2] < strikes[3], InvalidStrikes());
        }

        authId = nextAuthId++;

        // Snapshot pricing terms BEFORE the strategy hash is computed — the
        // shipped strategy commits to them, same discipline as the main vault.
        Pricing storage p = pricingOf[authId];
        p.baseSpreadBps = defaultBaseSpreadBps;
        p.stalenessSpreadBpsPerHour = defaultStalenessSpreadBpsPerHour;
        p.impactPerUnit = defaultImpactPerUnit;
        p.spotStaleness = SafeCast.toUint16(maxSpotStaleness);
        p.beta = hook != address(0) ? IBetaSource(hook).beta() : int256(0);

        Structure storage s = structures[authId];
        s.lp = msg.sender;
        s.kind = kind;
        s.strikes = strikes;
        s.expiry = expiry;
        s.maxCollateral = maxCollateral;
        s.active = true;
        s.feeBps = protocolFeeBps;
        s.feeRecipient = feeRecipient;
        s.strategyHash = keccak256(_strategy(authId));

        emit StructureOpened(authId, msg.sender, kind, strikes, expiry, maxCollateral);
    }

    /// @notice LP revokes in this vault's registry. The Aqua allowance
    /// itself is revoked separately via `Aqua.dock()` with {getDockParams},
    /// same two-step pattern as the main vault's revokeAuthorization.
    function revokeStructure(uint256 authId) external {
        require(structures[authId].lp == msg.sender, NotLp());
        structures[authId].active = false;
        emit StructureRevoked(authId);
    }

    // ── Quote ────────────────────────────────────────────────────────────────

    /// @notice Taker-side quote for `units` of a structure.
    /// @return premium Net premium the taker pays, in USDC units: the leg
    ///         they go long at Ask minus the leg they go short at Bid — the
    ///         spread's natural debit. Floored at one whole USDC so a
    ///         degenerate spread never quotes zero.
    /// @return fee Protocol-fee gross-up on the net premium (same shape as
    ///         the main vault's `_putQuote` / the SwapVM fee opcode).
    /// @return escrow The S12 true max loss for `units`, in the structure's
    ///         collateral token — what `buy()` pulls from the LP (A3).
    function quote(uint256 authId, uint256 units)
        public
        view
        returns (uint256 premium, uint256 fee, uint256 escrow)
    {
        Structure storage s = structures[authId];
        require(s.lp != address(0), UnknownStructure());
        require(s.active, StructureInactive());
        require(units > 0, ZeroAmount());

        uint256 ask;
        uint256 bid;
        if (s.kind == Kind.CallCredit) {
            // Taker: long the K1 call at Ask, short the K2 call at Bid.
            (ask,) = SmilePremiumLib.quote(_terms(authId, s.strikes[2], true), units, true, usdcDecimals, 0);
            (bid,) = SmilePremiumLib.quote(_terms(authId, s.strikes[3], true), units, false, usdcDecimals, 0);
            // (K2-K1)/K2 WETH per unit.
            escrow = Math.mulDiv(units, s.strikes[3] - s.strikes[2], s.strikes[3], Math.Rounding.Ceil);
        } else if (s.kind == Kind.PutCredit) {
            // Taker: long the K2 put at Ask, short the K1 put at Bid.
            (ask,) = SmilePremiumLib.quote(_terms(authId, s.strikes[1], false), units, true, usdcDecimals, 0);
            (bid,) = SmilePremiumLib.quote(_terms(authId, s.strikes[0], false), units, false, usdcDecimals, 0);
            // K2-K1 USDC per unit.
            escrow = SmileMath.scaleFromWad(Math.ceilDiv(units * (s.strikes[1] - s.strikes[0]), 1e18), usdcDecimals, true);
        } else {
            revert UnsupportedKind();
        }

        premium = ask > bid ? ask - bid : 0;
        uint256 minPremium = 10 ** usdcDecimals;
        if (premium < minPremium) premium = minPremium;
        fee = s.feeBps > 0 ? Math.ceilDiv(premium * s.feeBps, BPS - s.feeBps) : 0;
    }

    // ── Official Aqua strategy plumbing ──────────────────────────────────────

    /// @notice Everything needed for `Aqua.ship(app, strategy, tokens, amounts)`.
    function getShipParams(uint256 authId)
        external
        view
        returns (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts)
    {
        Structure storage s = structures[authId];
        require(s.lp != address(0), UnknownStructure());
        app = address(this);
        strategy = _strategy(authId);
        tokens = new address[](1);
        tokens[0] = _collateralToken(s.kind);
        amounts = new uint256[](1);
        amounts[0] = s.maxCollateral;
    }

    /// @notice Everything needed for `Aqua.dock(app, strategyHash, tokens)`.
    function getDockParams(uint256 authId)
        external
        view
        returns (address app, bytes32 strategyHash, address[] memory tokens)
    {
        Structure storage s = structures[authId];
        require(s.lp != address(0), UnknownStructure());
        app = address(this);
        strategyHash = s.strategyHash;
        tokens = new address[](1);
        tokens[0] = _collateralToken(s.kind);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /// @dev Call credit spreads escrow WETH (the S12 table's `(K2-K1)/K2`
    /// WETH); put credit escrows USDC. Iron condor's max-not-sum requirement
    /// isn't wired yet — it inherits the USDC slot for now.
    function _collateralToken(Kind kind) internal view returns (address) {
        return kind == Kind.CallCredit ? weth : usdc;
    }

    function _terms(uint256 authId, uint256 strike, bool isCall)
        internal
        view
        returns (SmilePremiumLib.Terms memory t)
    {
        Structure storage s = structures[authId];
        Pricing storage p = pricingOf[authId];
        (t.spotWad, t.ageSec) = SmilePremiumLib.readSpot(oracle, p.spotStaleness);
        t.strike = strike;
        t.expiry = s.expiry;
        t.sigmaSource = hook;
        t.beta = p.beta;
        t.sigmaMulBps = p.sigmaMulBps;
        t.baseSpreadBps = p.baseSpreadBps;
        t.stalenessSpreadBpsPerHour = p.stalenessSpreadBpsPerHour;
        t.impactPerUnit = p.impactPerUnit;
        t.isCall = isCall;
    }

    /// @dev Self-hosted AquaApp strategy (this vault is `app`), same pattern
    /// as AquaCollateralVault._putStrategy — a plain encoded terms blob, no
    /// SwapVM order. Full terms included for Aqua's data-availability
    /// requirement per Aqua docs.
    function _strategy(uint256 authId) internal view returns (bytes memory) {
        Structure storage s = structures[authId];
        return abi.encode(
            SPREAD_STRATEGY_TYPE, authId, s.lp, s.kind, s.strikes, s.expiry, s.maxCollateral, _collateralToken(s.kind)
        );
    }
}
