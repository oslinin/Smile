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

import { OptionToken } from "../OptionToken.sol";
import { SmileMath } from "../swapvm/SmileMath.sol";
import { SmileSwapVMRouter } from "../swapvm/SmileSwapVMRouter.sol";
import { OptionPremiumArgsBuilder } from "../swapvm/OptionPremiumInstruction.sol";

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
    uint256 public constant ALPHA = 2e18;          // smile curvature — matches frontend
    uint256 public constant DEFAULT_SIGMA = 0.8e18; // fallback σ when no hook wired
    bytes32 private constant PUT_STRATEGY_TYPE = "SMILE-PUT-1";

    /// @notice Max age of the Chainlink spot answer accepted when pricing.
    /// Snapshotted into each strategy at authorize time (strategies are immutable).
    uint256 public maxSpotStaleness = 1 hours;

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
    }

    struct LPPosition {
        uint256 lockedCollateral;
        address collateralToken;
    }

    uint256 public nextAuthId;
    mapping(uint256 => LPAuthorization) public authorizations;
    // authId => strike (WAD) => OptionToken address (deployed lazily on first buy)
    mapping(uint256 => mapping(uint256 => address)) public optionTokens;
    // optionToken => lp => locked position
    mapping(address => mapping(address => LPPosition)) public positions;

    event RangeAuthorized(uint256 indexed authId, address indexed lp, uint256 strikeMin, uint256 strikeMax, uint256 expiry, bool isCall, uint256 maxCollateral);
    event AuthorizationRevoked(uint256 indexed authId);
    event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium);
    event PremiumPaid(address indexed optionToken, address indexed buyer, address indexed lp, uint256 premium);
    event OptionClosed(address indexed optionToken, address indexed holder, uint256 amount);
    event CollateralReleased(address indexed optionToken, address indexed lp, uint256 amount);

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
        require(strikeMin <= strikeMax, "invalid range");
        require(expiry > block.timestamp, "expiry in past");
        require(maxCollateral > 0, "zero capacity");
        require(isCall ? collateralToken != premiumToken : collateralToken == premiumToken, "bad token pair");

        authId = nextAuthId++;
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
        auth.strategyHash = isCall
            ? keccak256(abi.encode(buildOrder(authId)))   // == router.hash() for Aqua orders
            : keccak256(_putStrategy(authId));

        emit RangeAuthorized(authId, msg.sender, strikeMin, strikeMax, expiry, isCall, maxCollateral);
    }

    /// @notice LP revokes a range in the vault's registry. To also revoke the
    /// Aqua allowance, the LP calls `Aqua.dock()` with {getDockParams}.
    /// Already-matched positions (optionTokens in circulation) are unaffected.
    function revokeAuthorization(uint256 authId) external {
        require(authorizations[authId].lp == msg.sender, "not lp");
        authorizations[authId].active = false;
        emit AuthorizationRevoked(authId);
    }

    // ── Official Aqua strategy plumbing ──────────────────────────────────────

    /// @notice Rebuilds the canonical SwapVM order for a call range. The
    /// program composes three instructions: salt (uniqueness), deadline
    /// (VM-level expiry guard) and the custom option-premium instruction.
    function buildOrder(uint256 authId) public view returns (ISwapVM.Order memory) {
        LPAuthorization storage auth = authorizations[authId];
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
            auth.spotStaleness
        );
        bytes memory program = abi.encodePacked(
            uint8(20), uint8(8), uint64(authId),                        // Controls._salt
            uint8(13), uint8(5), auth.expiry.toUint40(),                // Controls._deadline
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
            amounts[1] = 0; // premium balance grows via Aqua.push on every match
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
        LPAuthorization storage auth = authorizations[authId];
        require(auth.active, "authorization inactive");
        require(block.timestamp < auth.expiry, "expired");
        require(strike >= auth.strikeMin && strike <= auth.strikeMax, "strike out of range");
        require(amount > 0, "zero amount");

        uint256 collateralNeeded;
        if (auth.isCall) {
            collateralNeeded = amount;
            premiumPaid = _buyCallViaSwapVM(authId, auth, strike, amount, maxPremium);
        } else {
            collateralNeeded = (strike * amount) / 1e30; // 6-dec USDC cash security
            premiumPaid = _buyPutViaAquaPull(auth, strike, amount, collateralNeeded, maxPremium);
        }
        auth.usedCollateral += collateralNeeded;

        optionToken = _mintSeries(authId, auth, strike, amount, collateralNeeded);

        if (address(hook) != address(0)) hook.bumpSigma(true, auth.expiry - block.timestamp);

        emit PremiumPaid(optionToken, msg.sender, auth.lp, premiumPaid);
        emit OptionBought(authId, optionToken, msg.sender, strike, amount, premiumPaid);
    }

    /// @dev Covered-call leg: quote + swap through the official SwapVM router.
    /// The vault is the taker; `to` defaults to the vault so pulled collateral
    /// lands here for escrow.
    function _buyCallViaSwapVM(
        uint256 authId,
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amount,
        uint256 maxPremium
    ) internal returns (uint256 premiumPaid) {
        ISwapVM.Order memory order = buildOrder(authId);
        bytes memory takerData = TakerTraitsLib.build(TakerTraitsLib.Args({
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

        (premiumPaid,,) = router.quote(order, auth.premiumToken, auth.collateralToken, amount, takerData);

        IERC20(auth.premiumToken).safeTransferFrom(msg.sender, address(this), premiumPaid);
        IERC20(auth.premiumToken).forceApprove(address(router), premiumPaid);
        router.swap(order, auth.premiumToken, auth.collateralToken, amount, takerData);
    }

    /// @dev Cash-secured-put leg: this vault is the official AquaApp. Premium
    /// goes buyer → LP wallet directly; collateral is pulled JIT from the LP
    /// wallet via `Aqua.pull()` under the official per-strategy reentrancy lock.
    function _buyPutViaAquaPull(
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amount,
        uint256 collateralNeeded,
        uint256 maxPremium
    ) internal nonReentrantStrategy(auth.lp, auth.strategyHash) returns (uint256 premiumPaid) {
        uint256 spot = _spotWad(auth.spotStaleness);
        uint256 timeToExpiry = auth.expiry - block.timestamp;
        uint256 sigma = auth.sigmaSource != address(0)
            ? IOptionPricingHook(auth.sigmaSource).sigmaFor(timeToExpiry)
            : DEFAULT_SIGMA;
        uint256 sigmaStrike = SmileMath.smileVol(spot, strike, sigma, ALPHA, auth.beta);
        uint256 premiumWadPerUnit = SmileMath.premium(spot, strike, timeToExpiry, sigmaStrike, false, true);
        uint256 totalWad = Math.ceilDiv(premiumWadPerUnit * amount, 1e18);
        premiumPaid = SmileMath.scaleFromWad(totalWad, auth.premiumDecimals, true);
        require(premiumPaid <= maxPremium, "premium above max");

        if (premiumPaid > 0) {
            IERC20(auth.premiumToken).safeTransferFrom(msg.sender, auth.lp, premiumPaid);
        }
        AQUA.pull(auth.lp, auth.strategyHash, auth.collateralToken, collateralNeeded, address(this));
    }

    /// @dev Deploy the (authId, strike) OptionToken series lazily and mint.
    function _mintSeries(
        uint256 authId,
        LPAuthorization storage auth,
        uint256 strike,
        uint256 amount,
        uint256 collateralNeeded
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
        }

        LPPosition storage pos = positions[optionToken][auth.lp];
        pos.lockedCollateral += collateralNeeded;
        pos.collateralToken = auth.collateralToken;

        OptionToken(optionToken).mint(msg.sender, amount);
    }

    // ── Close ────────────────────────────────────────────────────────────────

    /// @notice Early close: burn holder's OptionTokens, return collateral to LP pro-rata.
    /// Vault is OptionToken owner so can burn without allowance from holder.
    function close(
        address optionToken,
        address lp,
        uint256 amount
    ) external {
        require(amount > 0, "zero amount");
        LPPosition storage pos = positions[optionToken][lp];
        require(pos.lockedCollateral > 0, "no position");

        uint256 supply = IERC20(optionToken).totalSupply();
        uint256 collateralToRelease = (pos.lockedCollateral * amount) / supply;

        pos.lockedCollateral -= collateralToRelease;
        OptionToken(optionToken).burn(msg.sender, amount);
        IERC20(pos.collateralToken).safeTransfer(lp, collateralToRelease);

        if (address(hook) != address(0)) {
            uint256 tokenExpiry = OptionToken(optionToken).expiry();
            hook.bumpSigma(false, tokenExpiry > block.timestamp ? tokenExpiry - block.timestamp : 0);
        }

        emit OptionClosed(optionToken, msg.sender, amount);
        emit CollateralReleased(optionToken, lp, collateralToRelease);
    }

    // ── Settlement support ───────────────────────────────────────────────────

    /// @notice Release locked collateral back to LP (called by settlement contract after expiry).
    function releaseCollateral(address optionToken, address lp, uint256 amount) external onlyOwner {
        LPPosition storage pos = positions[optionToken][lp];
        require(pos.lockedCollateral >= amount, "insufficient locked");
        pos.lockedCollateral -= amount;
        IERC20(pos.collateralToken).safeTransfer(lp, amount);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _spotWad(uint256 maxStaleness) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
        require(answer > 0, "bad oracle price");
        require(
            maxStaleness == 0 || (updatedAt != 0 && block.timestamp <= updatedAt + maxStaleness),
            "stale oracle price"
        );
        return SmileMath.scaleToWad(uint256(answer), oracle.decimals());
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
