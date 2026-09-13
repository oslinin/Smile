// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { AquaApp } from "@1inch/aqua/src/AquaApp.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { IPriceOracle } from "@1inch/swap-vm/src/instructions/interfaces/IPriceOracle.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

import { SmileMath } from "../swapvm/SmileMath.sol";
import { AquaOptionSettlement } from "../vaults/AquaOptionSettlement.sol";
import { OptionToken } from "../OptionToken.sol";
import { OptionTokenFactory } from "../OptionTokenFactory.sol";
import { SmilePremiumLib } from "./SmilePremiumLib.sol";

interface IBetaSource {
    function beta() external view returns (int256);
}

/// @notice Hybrid RFQ tier (R6 in docs/limitations.md — tradfi's "NBBO +
/// price improvement"). Tier 1 is the formula-priced on-chain surface the
/// main vault runs: permissionless, always live, the guaranteed fallback.
/// Tier 2 is this vault: an LP ships the same kind of range to Aqua, then
/// signs EIP-712 quotes off-chain — `(authId, strike, maxAmount,
/// premiumPerUnit, ttl, nonce)` — from whatever fast repricing or toxicity
/// model they like, and a taker who holds a quote fills it here. The
/// collateral still sits in the LP wallet until the fill pulls it JIT
/// through the official Aqua registry, exactly as tier 1 does; a signed
/// quote changes the price, never the custody model.
///
/// {formulaQuote} exposes the tier-1 Ask for the same range so a taker (or
/// the UI) can see the improvement a signed quote offers; a quote worse
/// than the formula is legal but nobody should take it. Quotes are
/// single-use (nonce), time-boxed (ttl), and size-capped (maxAmount);
/// the LP can cancel a nonce at any time. No `close()` in this vault —
/// sellbacks go through tier 1 so holders are never captive to a market
/// maker's uptime.
contract RfqVault is AquaApp, Ownable, EIP712 {
    using SafeERC20 for IERC20;

    struct Range {
        address lp;
        uint256 strikeMin;
        uint256 strikeMax;
        uint256 expiry;
        uint256 maxCollateral;
        address collateralToken;
        address premiumToken;
        bool isCall;
        bool active;
        bytes32 strategyHash;
        uint32 feeBps;
        address feeRecipient;
    }

    /// @notice What an LP signs. `premiumPerUnit` is in premium-token units
    /// per 1e18 option units, protocol fee excluded (grossed up on fill).
    struct Quote {
        uint256 authId;
        uint256 strike;
        uint256 maxAmount;
        uint256 premiumPerUnit;
        uint256 ttl;
        uint256 nonce;
    }

    struct Pricing {
        uint16 baseSpreadBps;
        uint16 stalenessSpreadBpsPerHour;
        uint64 impactPerUnit;
        uint16 spotStaleness;
        int256 beta;
    }

    struct Position {
        uint256 locked;
        address collateralToken;
    }

    bytes32 public constant QUOTE_TYPEHASH =
        keccak256("Quote(uint256 authId,uint256 strike,uint256 maxAmount,uint256 premiumPerUnit,uint256 ttl,uint256 nonce)");
    bytes32 private constant RFQ_STRATEGY_TYPE = keccak256("SMILE-RFQ-1");

    address public immutable weth;
    address public immutable usdc;
    IPriceOracle public immutable oracle;
    address public immutable hook;
    OptionTokenFactory public immutable tokenFactory;
    address public settlement;

    uint256 public maxSpotStaleness = 1 hours;
    uint16 public defaultBaseSpreadBps;
    uint16 public defaultStalenessSpreadBpsPerHour;
    uint64 public defaultImpactPerUnit;
    uint32 public protocolFeeBps;
    address public feeRecipient;

    uint256 public nextAuthId;
    mapping(uint256 => Range) public ranges;
    mapping(uint256 => Pricing) public pricingOf;
    /// @notice authId => strike => OptionToken (deployed on first fill).
    mapping(uint256 => mapping(uint256 => address)) public optionTokens;
    mapping(address => mapping(address => Position)) public positions;
    /// @notice lp => nonce => consumed (filled or cancelled).
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    error ExpiryInPast();
    error ZeroCapacity();
    error ZeroAmount();
    error InvalidRange();
    error UnknownRange();
    error RangeInactive();
    error Expired();
    error StrikeOutOfRange();
    error QuoteExpired();
    error QuoteUsed();
    error OverQuoteSize();
    error BadSigner(address recovered, address lp);
    error PremiumAboveMax();
    error SelfOnly();
    error NotLp();
    error AlreadySet();
    error NotSettled();
    error NothingToReclaim();

    event RangeOpened(uint256 indexed authId, address indexed lp, uint256 strikeMin, uint256 strikeMax, uint256 expiry, bool isCall, uint256 maxCollateral);
    event RangeRevoked(uint256 indexed authId);
    event QuoteCancelled(address indexed lp, uint256 indexed nonce);
    /// @dev Same ABI as AquaCollateralVault.OptionBought; `premium` includes the fee.
    event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium);
    event QuoteFilled(bytes32 indexed quoteHash, uint256 indexed authId, address indexed buyer, uint256 amount, uint256 premium, uint256 formulaPremium);
    event Redeemed(address indexed optionToken, address indexed holder, uint256 amount, uint256 payout);
    event CollateralReleased(address indexed optionToken, address indexed lp, uint256 amount);

    constructor(address aqua_, address oracle_, address hook_, address owner_, address tokenFactory_, address weth_, address usdc_)
        AquaApp(IAqua(aqua_))
        Ownable(owner_)
        EIP712("Smile RFQ", "1")
    {
        oracle = IPriceOracle(oracle_);
        hook = hook_;
        tokenFactory = OptionTokenFactory(tokenFactory_);
        weth = weth_;
        usdc = usdc_;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setSettlement(address settlement_) external onlyOwner {
        require(settlement == address(0), AlreadySet());
        settlement = settlement_;
    }

    function setPricingDefaults(uint16 baseSpreadBps_, uint16 stalenessSpreadBpsPerHour_, uint64 impactPerUnit_) external onlyOwner {
        require(baseSpreadBps_ <= 2000 && stalenessSpreadBpsPerHour_ <= 2000, "spread too wide");
        defaultBaseSpreadBps = baseSpreadBps_;
        defaultStalenessSpreadBpsPerHour = stalenessSpreadBpsPerHour_;
        defaultImpactPerUnit = impactPerUnit_;
    }

    function setProtocolFee(uint32 feeBps_, address recipient_) external onlyOwner {
        require(feeBps_ <= 0.05e9, "fee too high");
        require(feeBps_ == 0 || recipient_ != address(0), "no recipient");
        protocolFeeBps = feeBps_;
        feeRecipient = recipient_;
    }

    // ── Ranges ───────────────────────────────────────────────────────────────

    /// @notice Same terms as the main vault's range: strikes, expiry, and
    /// the collateral capacity Aqua may pull (WETH for calls, USDC for
    /// puts — fully collateralized, tier-1 rules). Premiums are USDC.
    function openRange(uint256 strikeMin, uint256 strikeMax, uint256 expiry, uint256 maxCollateral, bool isCall)
        external
        returns (uint256 authId)
    {
        require(strikeMin > 0 && strikeMin <= strikeMax, InvalidRange());
        require(expiry > block.timestamp, ExpiryInPast());
        require(maxCollateral > 0, ZeroCapacity());

        authId = nextAuthId++;
        Pricing storage p = pricingOf[authId];
        p.baseSpreadBps = defaultBaseSpreadBps;
        p.stalenessSpreadBpsPerHour = defaultStalenessSpreadBpsPerHour;
        p.impactPerUnit = defaultImpactPerUnit;
        p.spotStaleness = SafeCast.toUint16(maxSpotStaleness);
        p.beta = hook != address(0) ? IBetaSource(hook).beta() : int256(0);

        Range storage r = ranges[authId];
        r.lp = msg.sender;
        r.strikeMin = strikeMin;
        r.strikeMax = strikeMax;
        r.expiry = expiry;
        r.maxCollateral = maxCollateral;
        r.collateralToken = isCall ? weth : usdc;
        r.premiumToken = usdc;
        r.isCall = isCall;
        r.active = true;
        r.feeBps = protocolFeeBps;
        r.feeRecipient = feeRecipient;
        r.strategyHash = keccak256(_strategy(authId));
        emit RangeOpened(authId, msg.sender, strikeMin, strikeMax, expiry, isCall, maxCollateral);
    }

    function revokeRange(uint256 authId) external {
        require(ranges[authId].lp == msg.sender, NotLp());
        ranges[authId].active = false;
        emit RangeRevoked(authId);
    }

    /// @notice Burn a quote the LP no longer stands behind.
    function cancelQuote(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit QuoteCancelled(msg.sender, nonce);
    }

    // ── Quotes ───────────────────────────────────────────────────────────────

    /// @notice EIP-712 digest an LP signs for `q` (domain: "Smile RFQ" v1, this chain, this vault).
    function quoteHash(Quote memory q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(QUOTE_TYPEHASH, q.authId, q.strike, q.maxAmount, q.premiumPerUnit, q.ttl, q.nonce))
        );
    }

    /// @notice Tier-1 reference: what the formula surface would charge for
    /// the same (range, strike, amount) right now — LP premium and fee.
    /// A signed quote's job is to beat `lpPremium`.
    function formulaQuote(uint256 authId, uint256 strike, uint256 amount)
        public
        view
        returns (uint256 lpPremium, uint256 fee)
    {
        Range storage r = ranges[authId];
        require(r.lp != address(0), UnknownRange());
        Pricing storage p = pricingOf[authId];
        SmilePremiumLib.Terms memory t;
        (t.spotWad, t.ageSec) = SmilePremiumLib.readSpot(oracle, p.spotStaleness);
        t.strike = strike;
        t.expiry = r.expiry;
        t.sigmaSource = hook;
        t.beta = p.beta;
        t.baseSpreadBps = p.baseSpreadBps;
        t.stalenessSpreadBpsPerHour = p.stalenessSpreadBpsPerHour;
        t.impactPerUnit = p.impactPerUnit;
        t.isCall = r.isCall;
        return SmilePremiumLib.quote(t, amount, true, IERC20Metadata(r.premiumToken).decimals(), r.feeBps);
    }

    /// @notice What a fill of `amount` against quote `q` costs the taker: LP premium + fee.
    function fillCost(Quote memory q, uint256 amount) public view returns (uint256 lpPremium, uint256 fee) {
        lpPremium = Math.ceilDiv(q.premiumPerUnit * amount, 1e18);
        uint32 feeBps = ranges[q.authId].feeBps;
        fee = feeBps > 0 ? Math.ceilDiv(lpPremium * feeBps, BPS - feeBps) : 0;
    }

    // ── Fill ─────────────────────────────────────────────────────────────────

    /// @notice Take an LP's signed quote for `amount` units. Verifies the
    /// EIP-712 signature against the range's LP, the ttl, the size cap and
    /// the nonce, then settles exactly like a tier-1 fill: premium (+ fee)
    /// from the taker, collateral pulled JIT from the LP wallet through
    /// this vault's Aqua strategy, one OptionToken series per (range, strike).
    function fill(Quote calldata q, bytes calldata signature, uint256 amount, uint256 maxPremium)
        external
        returns (address token, uint256 premiumPaid)
    {
        Range storage r = ranges[q.authId];
        require(r.lp != address(0), UnknownRange());
        require(r.active, RangeInactive());
        require(block.timestamp < r.expiry, Expired());
        require(q.strike >= r.strikeMin && q.strike <= r.strikeMax, StrikeOutOfRange());
        require(amount > 0, ZeroAmount());
        require(amount <= q.maxAmount, OverQuoteSize());
        require(block.timestamp <= q.ttl, QuoteExpired());
        require(!nonceUsed[r.lp][q.nonce], QuoteUsed());

        bytes32 digest = quoteHash(q);
        address signer = ECDSA.recover(digest, signature);
        require(signer == r.lp, BadSigner(signer, r.lp));
        nonceUsed[r.lp][q.nonce] = true;

        (uint256 lpPremium, uint256 fee) = fillCost(q, amount);
        premiumPaid = lpPremium + fee;
        require(premiumPaid <= maxPremium, PremiumAboveMax());

        uint256 collateral = r.isCall ? amount : (q.strike * amount) / 1e30;
        this.execPull(r.lp, r.strategyHash, msg.sender, r.feeRecipient, r.premiumToken, r.collateralToken, lpPremium, fee, collateral);

        token = _mintSeries(q.authId, r, q.strike, amount, collateral, msg.sender);

        (uint256 formulaPremium,) = formulaQuote(q.authId, q.strike, amount);
        emit QuoteFilled(digest, q.authId, msg.sender, amount, lpPremium, formulaPremium);
        emit OptionBought(q.authId, token, msg.sender, q.strike, amount, premiumPaid);
    }

    /// @dev Self-call under the official per-strategy reentrancy guard.
    function execPull(
        address lp,
        bytes32 strategyHash,
        address buyer,
        address feeRecipient_,
        address premiumToken,
        address collateralToken,
        uint256 lpPremium,
        uint256 fee,
        uint256 collateral
    ) external nonReentrantStrategy(lp, strategyHash) {
        require(msg.sender == address(this), SelfOnly());
        if (lpPremium > 0) IERC20(premiumToken).safeTransferFrom(buyer, lp, lpPremium);
        if (fee > 0) IERC20(premiumToken).safeTransferFrom(buyer, feeRecipient_, fee);
        AQUA.pull(lp, strategyHash, collateralToken, collateral, address(this));
    }

    function seriesId(uint256 authId, uint256 strike) public pure returns (bytes32) {
        return keccak256(abi.encode("SMILE-RFQ-1", authId, strike));
    }

    // ── Settlement, redeem, reclaim (same shape as the main vault) ───────────

    function redeem(uint256 authId, uint256 strike, uint256 amount) external returns (uint256 payout) {
        require(amount > 0, ZeroAmount());
        address token = optionTokens[authId][strike];
        require(token != address(0), UnknownRange());
        (bool settled, uint256 price) = _settlementOf(authId, strike);
        require(settled, NotSettled());
        Range storage r = ranges[authId];

        OptionToken(token).burn(msg.sender, amount);
        payout = _intrinsic(r.isCall, price, strike, amount);
        Position storage pos = positions[token][r.lp];
        if (payout > pos.locked) payout = pos.locked;
        if (payout > 0) {
            pos.locked -= payout;
            IERC20(pos.collateralToken).safeTransfer(msg.sender, payout);
        }
        emit Redeemed(token, msg.sender, amount, payout);
    }

    function reclaim(uint256 authId, uint256 strike) external returns (uint256 amount) {
        Range storage r = ranges[authId];
        require(msg.sender == r.lp, NotLp());
        address token = optionTokens[authId][strike];
        require(token != address(0), UnknownRange());
        (bool settled, uint256 price) = _settlementOf(authId, strike);
        require(settled, NotSettled());

        uint256 owed = _intrinsic(r.isCall, price, strike, IERC20(token).totalSupply());
        Position storage pos = positions[token][r.lp];
        require(pos.locked > owed, NothingToReclaim());
        amount = pos.locked - owed;
        pos.locked = owed;
        IERC20(pos.collateralToken).safeTransfer(r.lp, amount);
        emit CollateralReleased(token, r.lp, amount);
    }

    function _intrinsic(bool isCall, uint256 price, uint256 strike, uint256 amount) internal pure returns (uint256) {
        if (isCall) return price > strike ? (amount * (price - strike)) / price : 0;
        return price < strike ? (amount * (strike - price)) / 1e30 : 0;
    }

    function _settlementOf(uint256 authId, uint256 strike) internal view returns (bool settled, uint256 price) {
        require(settlement != address(0), AlreadySet());
        (,,,, settled, price) = AquaOptionSettlement(settlement).series(seriesId(authId, strike));
    }

    // ── Official Aqua strategy plumbing ──────────────────────────────────────

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
        tokens[0] = r.collateralToken;
        amounts = new uint256[](1);
        amounts[0] = r.maxCollateral;
    }

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
        tokens[0] = r.collateralToken;
    }

    function _strategy(uint256 authId) internal view returns (bytes memory) {
        Range storage r = ranges[authId];
        return abi.encode(RFQ_STRATEGY_TYPE, authId, r.lp, r.strikeMin, r.strikeMax, r.expiry, r.maxCollateral, r.collateralToken, r.isCall);
    }

    function _mintSeries(uint256 authId, Range storage r, uint256 strike, uint256 amount, uint256 collateral, address buyer)
        internal
        returns (address token)
    {
        token = optionTokens[authId][strike];
        if (token == address(0)) {
            token = tokenFactory.deployOption(r.collateralToken, strike, r.expiry, r.isCall, address(this));
            optionTokens[authId][strike] = token;
            if (settlement != address(0)) {
                AquaOptionSettlement(settlement).registerSeries(seriesId(authId, strike), token, r.expiry, strike, r.isCall);
            }
        }
        Position storage pos = positions[token][r.lp];
        pos.locked += collateral;
        pos.collateralToken = r.collateralToken;
        OptionToken(token).mint(buyer, amount);
    }
}
