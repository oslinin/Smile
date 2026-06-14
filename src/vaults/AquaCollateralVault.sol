// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../OptionToken.sol";
import "../swapvm/OptionPricingEngine.sol";

interface IOptionPricingHook {
    function bumpSigma(bool isBuy) external;
    function sigmaGlobal() external view returns (uint256);
}

/// @notice JIT collateral vault implementing Aqua-style range authorization.
///
/// LPs authorize a strike range — e.g. "all calls between $3000 and $4000" —
/// backed by a single collateral pool that STAYS IN THEIR WALLET until a buyer
/// matches. On match, collateral is pulled JIT, premium flows to the LP, and
/// an OptionToken for that specific strike is deployed lazily if needed.
///
/// Key property: between authorization and match, LP collateral earns whatever
/// yield it would earn in the LP's wallet (staking, lending, etc). No vault
/// lock-in. This is the DeFi equivalent of a TradFi covered call writer who
/// still receives dividends on the underlying.
contract AquaCollateralVault is Ownable {
    using SafeERC20 for IERC20;

    OptionPricingEngine public immutable pricingEngine;
    IOptionPricingHook public hook;
    uint256 public constant ALPHA = 2e18; // smile curvature — matches frontend

    struct LPAuthorization {
        address lp;
        uint256 strikeMin;       // WAD lower bound
        uint256 strikeMax;       // WAD upper bound
        uint256 expiry;          // unix timestamp
        uint256 maxCollateral;   // total capacity (WAD for calls, 6-dec for puts)
        uint256 usedCollateral;  // consumed so far by matched buys
        address collateralToken; // WETH for calls, USDC for puts
        bool isCall;
        bool active;
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

    constructor(address pricingEngine_, address owner_) Ownable(owner_) {
        pricingEngine = OptionPricingEngine(pricingEngine_);
    }

    function setHook(address hook_) external onlyOwner {
        hook = IOptionPricingHook(hook_);
    }

    // ── LP Range Authorization ────────────────────────────────────────────────

    /// @notice LP commits to writing options at any K in [strikeMin, strikeMax].
    /// No transfer occurs here — collateral stays in LP wallet earning yield.
    /// LP must separately ERC-20 approve this vault up to maxCollateral.
    function authorizeRange(
        uint256 strikeMin,
        uint256 strikeMax,
        uint256 expiry,
        uint256 maxCollateral,
        address collateralToken,
        bool isCall
    ) external returns (uint256 authId) {
        require(strikeMin <= strikeMax, "invalid range");
        require(expiry > block.timestamp, "expiry in past");
        require(maxCollateral > 0, "zero capacity");

        authId = nextAuthId++;
        authorizations[authId] = LPAuthorization({
            lp: msg.sender,
            strikeMin: strikeMin,
            strikeMax: strikeMax,
            expiry: expiry,
            maxCollateral: maxCollateral,
            usedCollateral: 0,
            collateralToken: collateralToken,
            isCall: isCall,
            active: true
        });

        emit RangeAuthorized(authId, msg.sender, strikeMin, strikeMax, expiry, isCall, maxCollateral);
    }

    /// @notice LP revokes a range before any further matching.
    /// Already-matched positions (optionTokens in circulation) are unaffected.
    function revokeAuthorization(uint256 authId) external {
        require(authorizations[authId].lp == msg.sender, "not lp");
        authorizations[authId].active = false;
        emit AuthorizationRevoked(authId);
    }

    // ── Buy ──────────────────────────────────────────────────────────────────

    /// @notice Buy an option at a specific strike within an LP's authorized range.
    ///
    /// Flow:
    ///   1. Validate strike is within LP's range and capacity remains.
    ///   2. Calculate premium on-chain from the pricing engine (using live σ from hook).
    ///   3. Transfer premium from buyer → LP (yield earned immediately).
    ///   4. Pull collateral from LP wallet JIT.
    ///   5. Deploy OptionToken for (authId, strike) lazily if first buy here.
    ///   6. Mint OptionTokens to buyer.
    ///   7. Bump σ_global to signal demand.
    ///
    /// @param authId       LP's range authorization to match against.
    /// @param strike       Specific strike (WAD) the buyer wants — must be in [strikeMin, strikeMax].
    /// @param spot         Current spot price (WAD) — caller-supplied for premium calculation.
    /// @param buyer        Receives the minted OptionToken.
    /// @param amount       Units to buy (WAD).
    /// @param premiumToken ERC-20 token buyer pays premium in (typically USDC).
    function buy(
        uint256 authId,
        uint256 strike,
        uint256 spot,
        address buyer,
        uint256 amount,
        address premiumToken
    ) external {
        LPAuthorization storage auth = authorizations[authId];
        require(auth.active, "authorization inactive");
        require(block.timestamp < auth.expiry, "expired");
        require(strike >= auth.strikeMin && strike <= auth.strikeMax, "strike out of range");
        require(amount > 0, "zero amount");
        require(buyer != address(0), "zero buyer");

        // Collateral: call = amount WAD of underlying; put = strike × amount in 6-dec USDC
        uint256 collateralNeeded = auth.isCall
            ? amount
            : (strike * amount) / 1e30;
        require(auth.usedCollateral + collateralNeeded <= auth.maxCollateral, "capacity exceeded");

        // Calculate premium on-chain; σ is live from hook (or fallback 80%)
        uint256 sigma = address(hook) != address(0) ? hook.sigmaGlobal() : 0.8e18;
        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: spot,
            strike: strike,
            expiry: auth.expiry,
            sigmaGlobal: sigma,
            alpha: ALPHA,
            isBuy: true
        });
        uint256 premiumPerUnit = pricingEngine.quote(p);
        uint256 totalPremium = (premiumPerUnit * amount) / 1e18;

        // Premium: buyer → LP (direct, no vault intermediary)
        if (totalPremium > 0) {
            IERC20(premiumToken).safeTransferFrom(buyer, auth.lp, totalPremium);
        }

        // Collateral: LP wallet → vault JIT
        IERC20(auth.collateralToken).safeTransferFrom(auth.lp, address(this), collateralNeeded);
        auth.usedCollateral += collateralNeeded;

        // Deploy OptionToken lazily on first buy at this strike
        address optionToken = optionTokens[authId][strike];
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

        OptionToken(optionToken).mint(buyer, amount);

        if (address(hook) != address(0)) hook.bumpSigma(true);

        emit PremiumPaid(optionToken, buyer, auth.lp, totalPremium);
        emit OptionBought(authId, optionToken, buyer, strike, amount, totalPremium);
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

        if (address(hook) != address(0)) hook.bumpSigma(false);

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
