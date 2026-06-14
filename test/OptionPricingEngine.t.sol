// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/swapvm/OptionPricingEngine.sol";

contract OptionPricingEngineTest is Test {
    OptionPricingEngine engine;
    uint256 constant WAD = 1e18;

    function setUp() public {
        engine = new OptionPricingEngine();
        vm.warp(1_000_000); // set a known timestamp
    }

    // ATM: ln(K/S)=0, smile returns sigmaGlobal unchanged
    function test_smileVol_ATM() public view {
        uint256 vol = engine.smileVol(2000e18, 2000e18, 0.8e18, 2e18);
        assertEq(vol, 0.8e18);
    }

    // OTM: K > S → ln(K/S) > 0 → smile > sigmaGlobal
    function test_smileVol_OTM_higher() public view {
        uint256 vol = engine.smileVol(2000e18, 2200e18, 0.8e18, 2e18);
        assertGt(vol, 0.8e18);
    }

    // ITM: K < S → ln(K/S) < 0, but squared → also > sigmaGlobal
    function test_smileVol_ITM_higher() public view {
        uint256 vol = engine.smileVol(2000e18, 1800e18, 0.8e18, 2e18);
        assertGt(vol, 0.8e18);
    }

    // Symmetric: OTM and ITM equidistant in log-space give same vol
    function test_smileVol_symmetric() public view {
        // K/S = 1.1 and K/S = 1/1.1 ≈ 0.909: same |ln|
        uint256 volUp = engine.smileVol(1000e18, 1100e18, 0.8e18, 2e18);
        // 1/1.1 = 909.09...
        uint256 volDn = engine.smileVol(1100e18, 1000e18, 0.8e18, 2e18);
        // Allow 0.5% tolerance due to integer ln approximation
        assertApproxEqRel(volUp, volDn, 0.005e18);
    }

    // BUY > SELL on same strike = consistent spread
    function test_spread_buyGtSell() public view {
        uint256 expiry = block.timestamp + 30 days;
        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: 2000e18,
            strike: 2000e18,
            expiry: expiry,
            sigmaGlobal: 0.8e18,
            alpha: 2e18,
            isBuy: true
        });
        uint256 ask = engine.quote(p);
        p.isBuy = false;
        uint256 bid = engine.quote(p);
        assertGt(ask, bid);
    }

    // Premium must be positive for a live option
    function test_premium_positive() public view {
        uint256 expiry = block.timestamp + 30 days;
        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: 2000e18,
            strike: 2000e18,
            expiry: expiry,
            sigmaGlobal: 0.8e18,
            alpha: 2e18,
            isBuy: false
        });
        assertGt(engine.quote(p), 0);
    }

    // Expired option reverts
    function test_expired_reverts() public {
        uint256 expiry = block.timestamp - 1;
        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: 2000e18,
            strike: 2000e18,
            expiry: expiry,
            sigmaGlobal: 0.8e18,
            alpha: 2e18,
            isBuy: true
        });
        vm.expectRevert("expired");
        engine.quote(p);
    }
}
