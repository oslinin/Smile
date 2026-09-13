// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { MarginVault } from "../src/periphery/MarginVault.sol";
import { MarginBackstop } from "../src/periphery/MarginBackstop.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20X is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) { _dec = d; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract GasProbeTest is Test {
    function test_firstVsRepeatBuyGas() public {
        MockERC20X usdc = new MockERC20X("USDC", "USDC", 6);
        MockERC20X weth = new MockERC20X("WETH", "WETH", 18);
        Aqua aqua = new Aqua();
        SmileSwapVMRouter router = new SmileSwapVMRouter(address(aqua), address(weth), address(this));
        MockV3Aggregator oracle = new MockV3Aggregator(8, 3000e8);
        OptionTokenFactory tf = new OptionTokenFactory();
        AquaCollateralVault vault = new AquaCollateralVault(
            address(aqua), payable(address(router)), address(oracle), address(this), address(tf)
        );

        address lp = address(0x1111);
        address buyer = address(0x2222);
        uint256 expiry = block.timestamp + 30 days;

        weth.mint(lp, 10e18);
        vm.startPrank(lp);
        uint256 authId = vault.authorizeRange(2500e18, 3500e18, expiry, 10e18, address(weth), address(usdc), true, 0, 0);
        weth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = vault.getShipParams(authId);
        aqua.ship(app, strategy, tokens, amounts);
        vm.stopPrank();

        usdc.mint(buyer, 1_000_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(vault), type(uint256).max);

        uint256 g0 = gasleft();
        vault.buy(authId, 3000e18, 1e18, type(uint256).max);
        uint256 firstBuy = g0 - gasleft();

        g0 = gasleft();
        vault.buy(authId, 3000e18, 1e18, type(uint256).max);
        uint256 repeatBuy = g0 - gasleft();

        g0 = gasleft();
        vault.buy(authId, 3100e18, 1e18, type(uint256).max);
        uint256 newStrikeBuy = g0 - gasleft();
        vm.stopPrank();

        console.log("first buy at a strike (deploys OptionToken):", firstBuy);
        console.log("repeat buy, same series:                    ", repeatBuy);
        console.log("first buy at ANOTHER strike (new deploy):   ", newStrikeBuy);

        // L12 (docs/limitations.md): the gas floor is series bootstrapping,
        // not pricing math. Loose ceilings so a regression that breaks this
        // story — e.g. accidental re-deploys or a pricing-path blowup — fails.
        assertLt(repeatBuy, 400_000, "repeat fill should stay near a DEX-swap cost");
        assertLt(firstBuy, 1_500_000, "first fill = one series deploy + a repeat fill");
        assertGt(firstBuy - repeatBuy, 500_000, "deploy should dominate the first fill");
    }

    /// @dev Part B / B3: a margined put fill does the main vault's work plus
    /// a one-hour oracle walk and the ceiling bookkeeping. Own fixture; the
    /// main vault's 400k bound above is untouched.
    function test_marginRepeatBuyGas() public {
        MockERC20X usdc = new MockERC20X("USDC", "USDC", 6);
        Aqua aqua = new Aqua();
        MockV3Aggregator oracle = new MockV3Aggregator(8, 3000e8);
        MarginVault mv = new MarginVault(
            address(aqua), address(oracle), address(0), address(this), address(new OptionTokenFactory()), address(usdc)
        );
        MarginBackstop backstop = new MarginBackstop(address(usdc), address(mv));
        mv.setBackstop(address(backstop));
        mv.setPricingDefaults(50, 25, 0.001e18);
        mv.setProtocolFee(0.01e9);
        mv.setNotionalCeiling(250_000e6);
        usdc.mint(address(backstop), 25_000e6);

        address lp = address(0x1111);
        address buyer = address(0x2222);
        uint256 expiry = block.timestamp + 30 days;
        usdc.mint(lp, 100_000e6);
        vm.startPrank(lp);
        uint256 authId = mv.openRange(2500e18, 3500e18, expiry, 100_000e6, 0, false, 0);
        usdc.approve(address(aqua), type(uint256).max);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = mv.getShipParams(authId);
        aqua.ship(app, strategy, tokens, amounts);
        vm.stopPrank();

        // A busy hour on the feed: the mark walks every one of these rounds.
        for (uint256 i = 0; i < 12; i++) {
            vm.warp(block.timestamp + 5 minutes);
            oracle.setAnswer(int256(3000e8 - i * 1e8));
        }

        usdc.mint(buyer, 1_000_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(mv), type(uint256).max);
        mv.buy(authId, 3000e18, 1e18, type(uint256).max);
        uint256 g0 = gasleft();
        mv.buy(authId, 3000e18, 1e18, type(uint256).max);
        uint256 repeatBuy = g0 - gasleft();
        vm.stopPrank();

        console.log("margined put repeat buy (12-round mark walk):", repeatBuy);
        assertLt(repeatBuy, 450_000, "margined repeat fill stays within 450k");
    }
}
