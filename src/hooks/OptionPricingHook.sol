// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import "../swapvm/OptionPricingEngine.sol";

/// @notice Uniswap v4 hook for the options pool.
/// beforeSwap: veto trades priced outside oracle-safe bounds.
/// afterSwap: adjust demand-driven implied vol (σ_global) up on buy, down on sell.
///
/// Hook address must encode BEFORE_SWAP_FLAG (bit 7) and AFTER_SWAP_FLAG (bit 6):
///   address & 0xFF == 0xC0  (1100_0000)
/// Use HookMiner in the deploy script to find a salt that satisfies this.
contract OptionPricingHook is IHooks {
    OptionPricingEngine public immutable pricingEngine;
    address public immutable poolManager;

    /// @dev σ_global in WAD, adjusted by afterSwap demand feedback.
    uint256 public sigmaGlobal;

    /// @dev Demand feedback step: γ = 0.5% per trade (in WAD).
    uint256 public constant GAMMA = 0.005e18;
    uint256 public constant WAD = 1e18;

    /// @dev Oracle price tolerance: 5% band around the engine's fair value.
    uint256 public constant PRICE_TOLERANCE = 0.05e18;

    constructor(address pricingEngine_, address poolManager_, uint256 initialSigma_) {
        pricingEngine = OptionPricingEngine(pricingEngine_);
        poolManager = poolManager_;
        sigmaGlobal = initialSigma_;
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
                sigmaGlobal: sigmaGlobal,
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
        if (isBuy) {
            sigmaGlobal = sigmaGlobal + GAMMA;
        } else {
            sigmaGlobal = sigmaGlobal > GAMMA ? sigmaGlobal - GAMMA : 0;
        }
        return (IHooks.afterSwap.selector, 0);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }
}
