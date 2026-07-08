// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import "../swapvm/OptionPricingEngine.sol";

/// @notice Uniswap v4 hook for the options pool — and the on-chain VOL SURFACE.
/// beforeSwap: veto trades priced outside oracle-safe bounds.
/// afterSwap: adjust demand-driven implied vol up on buy, down on sell.
///
/// The surface is multiparameter: σ is stored per TENOR BUCKET
/// ([0,7d) [7d,30d) [30d,90d) [90d,∞)) and a signed skew β tilts the strike
/// dimension (σ_strike = σ_tenor · (1 + α·ln²(K/S) + β·ln(K/S))). The SwapVM
/// option-premium instruction reads σ live via {sigmaFor}.
///
/// Hook address must encode BEFORE_SWAP_FLAG (bit 7) and AFTER_SWAP_FLAG (bit 6):
///   address & 0xFF == 0xC0  (1100_0000)
/// Use HookMiner in the deploy script to find a salt that satisfies this.
contract OptionPricingHook is IHooks {
    OptionPricingEngine public immutable pricingEngine;
    address public immutable poolManager;
    address public immutable admin;

    /// @dev Tenor cutoffs for the σ term structure.
    uint256 public constant TENOR_1 = 7 days;
    uint256 public constant TENOR_2 = 30 days;
    uint256 public constant TENOR_3 = 90 days;

    /// @dev σ per tenor bucket in WAD, adjusted by demand feedback.
    uint256[4] public sigmaBuckets;

    /// @dev Signed skew β in WAD (0 = symmetric smile; negative = downside skew).
    int256 public beta;

    /// @dev Demand feedback step: γ = 0.5% per trade (in WAD).
    uint256 public constant GAMMA = 0.005e18;
    uint256 public constant WAD = 1e18;

    /// @dev Oracle price tolerance: 5% band around the engine's fair value.
    uint256 public constant PRICE_TOLERANCE = 0.05e18;

    address public vault;

    constructor(address pricingEngine_, address poolManager_, uint256 initialSigma_) {
        pricingEngine = OptionPricingEngine(pricingEngine_);
        poolManager = poolManager_;
        admin = msg.sender;
        for (uint256 i = 0; i < 4; i++) sigmaBuckets[i] = initialSigma_;
    }

    /// @notice One-time registration of the vault that can drive σ updates on primary mints.
    function setVault(address vault_) external {
        require(vault == address(0), "already set");
        vault = vault_;
    }

    /// @notice Set the skew tilt of the surface (deployer only).
    function setBeta(int256 beta_) external {
        require(msg.sender == admin, "only admin");
        beta = beta_;
    }

    // ── Vol surface reads ─────────────────────────────────────────────────────

    /// @notice σ for a given time-to-expiry — the tenor dimension of the surface.
    /// This is the live σ source the SwapVM option-premium instruction queries.
    function sigmaFor(uint256 timeToExpiry) public view returns (uint256) {
        return sigmaBuckets[_bucketOf(timeToExpiry)];
    }

    /// @notice Back-compat scalar view: the 30-day bucket (legacy readers).
    function sigmaGlobal() external view returns (uint256) {
        return sigmaBuckets[1];
    }

    function _bucketOf(uint256 timeToExpiry) internal pure returns (uint256) {
        if (timeToExpiry < TENOR_1) return 0;
        if (timeToExpiry < TENOR_2) return 1;
        if (timeToExpiry < TENOR_3) return 2;
        return 3;
    }

    // ── Demand feedback ───────────────────────────────────────────────────────

    /// @notice Tenor-aware demand feedback: bump only the bucket that traded.
    function bumpSigma(bool isBuy, uint256 timeToExpiry) external {
        require(msg.sender == vault, "only vault");
        _bump(_bucketOf(timeToExpiry), isBuy);
    }

    /// @notice Legacy surface-wide feedback (no tenor info): bump every bucket.
    function bumpSigma(bool isBuy) external {
        require(msg.sender == vault, "only vault");
        for (uint256 i = 0; i < 4; i++) _bump(i, isBuy);
    }

    function _bump(uint256 bucket, bool isBuy) internal {
        if (isBuy) {
            sigmaBuckets[bucket] += GAMMA;
        } else {
            sigmaBuckets[bucket] = sigmaBuckets[bucket] > GAMMA ? sigmaBuckets[bucket] - GAMMA : 0;
        }
    }

    // ── IHooks required stubs ─────────────────────────────────────────────────

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { return IHooks.beforeAddLiquidity.selector; }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { return IHooks.beforeRemoveLiquidity.selector; }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { return IHooks.beforeDonate.selector; }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { return IHooks.afterDonate.selector; }

    // ── Core hook logic ───────────────────────────────────────────────────────

    /// @notice Veto trades whose execution price deviates > 5% from the engine's fair value.
    /// hookData must encode (spot, strike, expiry, alpha) as abi.encode(uint256 x4).
    function beforeSwap(
        address,
        PoolKey calldata,
        SwapParams calldata params,
        bytes calldata hookData
    ) external view returns (bytes4, BeforeSwapDelta, uint24) {
        if (hookData.length >= 128) {
            (uint256 spot, uint256 strike, uint256 expiry, uint256 alpha) =
                abi.decode(hookData, (uint256, uint256, uint256, uint256));

            bool isBuy = params.amountSpecified < 0; // exactOut → buy
            OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
                spot: spot,
                strike: strike,
                expiry: expiry,
                sigmaGlobal: sigmaFor(expiry > block.timestamp ? expiry - block.timestamp : 0),
                alpha: alpha,
                isBuy: isBuy
            });

            uint256 fairValue = pricingEngine.quote(p);
            uint256 executionPrice = _abs(params.amountSpecified);

            uint256 diff = executionPrice > fairValue
                ? executionPrice - fairValue
                : fairValue - executionPrice;

            require(diff * WAD / fairValue <= PRICE_TOLERANCE, "price outside oracle bounds");
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @notice Bump σ_global up on buy, down on sell — demand-driven IV feedback.
    function afterSwap(
        address,
        PoolKey calldata,
        SwapParams calldata params,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes4, int128) {
        require(msg.sender == poolManager, "only pool manager");
        bool isBuy = params.amountSpecified < 0;
        // Pool swaps carry no tenor info — treat as a surface-wide demand shift.
        for (uint256 i = 0; i < 4; i++) _bump(i, isBuy);
        return (IHooks.afterSwap.selector, 0);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }
}
