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

    // ── Vol surface: tenor buckets + skew ─────────────────────────────────────

    function test_sigmaFor_selectsTenorBucket() public {
        address vault = address(0xA117);
        hook.setVault(vault);

        // Bump only the 30–90d bucket via a 45-day trade
        vm.prank(vault);
        hook.bumpSigma(true, 45 days);

        assertEq(hook.sigmaFor(1 days),  SIGMA);                 // [0,7d) untouched
        assertEq(hook.sigmaFor(10 days), SIGMA);                 // [7d,30d) untouched
        assertEq(hook.sigmaFor(45 days), SIGMA + hook.GAMMA());  // [30d,90d) bumped
        assertEq(hook.sigmaFor(180 days), SIGMA);                // [90d,∞) untouched
    }

    function test_sigmaGlobal_backCompat_is30dBucket() public {
        address vault = address(0xA117);
        hook.setVault(vault);
        vm.prank(vault);
        hook.bumpSigma(true, 10 days); // [7d,30d) bucket
        assertEq(hook.sigmaGlobal(), SIGMA + hook.GAMMA());
    }

    function test_afterSwap_bumpsAllBuckets() public {
        SwapParams memory params = SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: 0});
        vm.prank(poolManager);
        hook.afterSwap(address(0), poolKey, params, BalanceDelta.wrap(0), "");
        assertEq(hook.sigmaFor(1 days),   SIGMA + hook.GAMMA());
        assertEq(hook.sigmaFor(180 days), SIGMA + hook.GAMMA());
    }

    function test_setBeta_onlyAdmin() public {
        hook.setBeta(-0.5e18);
        assertEq(hook.beta(), -0.5e18);

        vm.prank(address(0xBAD));
        vm.expectRevert("only admin");
        hook.setBeta(0);
    }

    // β<0 makes low strikes (downside) price richer than the symmetric smile
    function test_negativeBeta_downsideSkew() public view {
        uint256 expiry = block.timestamp + 30 days;
        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: SPOT, strike: 1600e18, expiry: expiry, // K < S → ln(K/S) < 0
            sigmaGlobal: SIGMA, alpha: ALPHA, isBuy: true
        });
        uint256 symmetric = engine.quoteSurface(p, 0);
        uint256 skewed = engine.quoteSurface(p, -0.5e18);
        assertGt(skewed, symmetric);

        // ...and high strikes (upside) price cheaper
        p.strike = 2400e18; // K > S → ln(K/S) > 0
        assertLt(engine.quoteSurface(p, -0.5e18), engine.quoteSurface(p, 0));
    }
}
