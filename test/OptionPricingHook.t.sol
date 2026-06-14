// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/hooks/OptionPricingHook.sol";
import "../src/swapvm/OptionPricingEngine.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

contract OptionPricingHookTest is Test {
    OptionPricingHook hook;
    OptionPricingEngine engine;

    address poolManager = address(0x1234567890123456789012345678901234567890);

    uint256 constant SIGMA = 0.8e18;
    uint256 constant ALPHA = 2e18;
    uint256 constant SPOT  = 2000e18;
    uint256 constant STRIKE = 2000e18;

    PoolKey poolKey;
    SwapParams buyParams;

    function setUp() public {
        vm.warp(1_000_000);
        engine = new OptionPricingEngine();
        hook = new OptionPricingHook(address(engine), poolManager, SIGMA);

        poolKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(1)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        // exactOut (amountSpecified < 0) = BUY
        buyParams = SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: 0});
    }

    function _hookData(uint256 spot, uint256 strike, uint256 expiry, uint256 alpha)
        internal pure returns (bytes memory) {
        return abi.encode(spot, strike, expiry, alpha);
    }

    // ── Commit 7: beforeSwap veto ─────────────────────────────────────────────

    // Within tolerance: should pass
    function test_beforeSwap_withinTolerance_passes() public view {
        uint256 expiry = block.timestamp + 30 days;
        uint256 fairValue = engine.quote(OptionPricingEngine.PricingParams({
            spot: SPOT, strike: STRIKE, expiry: expiry,
            sigmaGlobal: SIGMA, alpha: ALPHA, isBuy: true
        }));

        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(fairValue), // exactly at fair value
            sqrtPriceLimitX96: 0
        });

        bytes memory data = _hookData(SPOT, STRIKE, expiry, ALPHA);
        (bytes4 sel,,) = hook.beforeSwap(address(0), poolKey, params, data);
        assertEq(sel, IHooks.beforeSwap.selector);
    }

    // 10% above fair value: should revert
    function test_beforeSwap_stalePriceAbove_reverts() public {
        uint256 expiry = block.timestamp + 30 days;
        uint256 fairValue = engine.quote(OptionPricingEngine.PricingParams({
            spot: SPOT, strike: STRIKE, expiry: expiry,
            sigmaGlobal: SIGMA, alpha: ALPHA, isBuy: true
        }));

        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(fairValue * 110 / 100), // 10% above
            sqrtPriceLimitX96: 0
        });

        bytes memory data = _hookData(SPOT, STRIKE, expiry, ALPHA);
        vm.expectRevert("price outside oracle bounds");
        hook.beforeSwap(address(0), poolKey, params, data);
    }

    // 10% below fair value: should revert
    function test_beforeSwap_stalePriceBelow_reverts() public {
        uint256 expiry = block.timestamp + 30 days;
        uint256 fairValue = engine.quote(OptionPricingEngine.PricingParams({
            spot: SPOT, strike: STRIKE, expiry: expiry,
            sigmaGlobal: SIGMA, alpha: ALPHA, isBuy: true
        }));

        SwapParams memory params = SwapParams({
            zeroForOne: true,
            amountSpecified: -int256(fairValue * 85 / 100), // 15% below
            sqrtPriceLimitX96: 0
        });

        bytes memory data = _hookData(SPOT, STRIKE, expiry, ALPHA);
        vm.expectRevert("price outside oracle bounds");
        hook.beforeSwap(address(0), poolKey, params, data);
    }

    // Empty hookData: no veto (passthrough)
    function test_beforeSwap_noHookData_passes() public view {
        (bytes4 sel,,) = hook.beforeSwap(address(0), poolKey, buyParams, "");
        assertEq(sel, IHooks.beforeSwap.selector);
    }

    // ── Commit 8: afterSwap IV feedback ──────────────────────────────────────

    // Buy bumps sigmaGlobal up by GAMMA
    function test_afterSwap_buy_bumpsSigma() public {
        uint256 before = hook.sigmaGlobal();
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: 0});
        vm.prank(poolManager);
        hook.afterSwap(address(0), poolKey, params, BalanceDelta.wrap(0), "");
        assertEq(hook.sigmaGlobal(), before + hook.GAMMA());
    }

    // Sell decreases sigmaGlobal by GAMMA
    function test_afterSwap_sell_decreasesSigma() public {
        uint256 before = hook.sigmaGlobal();
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: 1e18, sqrtPriceLimitX96: 0});
        vm.prank(poolManager);
        hook.afterSwap(address(0), poolKey, params, BalanceDelta.wrap(0), "");
        assertEq(hook.sigmaGlobal(), before - hook.GAMMA());
    }

    // Back-to-back buys raise the next premium
    function test_backToBuysBumpPremium() public {
        uint256 expiry = block.timestamp + 30 days;
        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: SPOT, strike: STRIKE, expiry: expiry,
            sigmaGlobal: hook.sigmaGlobal(), alpha: ALPHA, isBuy: true
        });
        uint256 premiumBefore = engine.quote(p);

        // Execute two buys to bump sigma
        SwapParams memory buyP = SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: 0});
        vm.startPrank(poolManager);
        hook.afterSwap(address(0), poolKey, buyP, BalanceDelta.wrap(0), "");
        hook.afterSwap(address(0), poolKey, buyP, BalanceDelta.wrap(0), "");
        vm.stopPrank();

        p.sigmaGlobal = hook.sigmaGlobal();
        uint256 premiumAfter = engine.quote(p);
        assertGt(premiumAfter, premiumBefore);
    }

    // Non-pool-manager cannot call afterSwap
    function test_afterSwap_nonManager_reverts() public {
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: 0});
        vm.expectRevert("only pool manager");
        hook.afterSwap(address(0), poolKey, params, BalanceDelta.wrap(0), "");
    }
}
