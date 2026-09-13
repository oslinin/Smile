// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { MarginVault } from "../src/periphery/MarginVault.sol";
import { MarginBackstop } from "../src/periphery/MarginBackstop.sol";
import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { OptionPricingEngine } from "../src/swapvm/OptionPricingEngine.sol";
import { OptionPricingHook } from "../src/hooks/OptionPricingHook.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice B7: the two invariants Part B must never lose. Margin is a
/// function of the oracle alone — trading can move sigma, and with it the
/// premium, but never what a writer has to post (L7: a manipulated sigma
/// must not be able to drain margin). And the main vault's bytecode is
/// provably untouched by all of this.
contract MarginInvariantsTest is Test {
    Aqua aqua;
    MarginVault mv;
    MarginBackstop backstop;
    AquaCollateralVault vault;
    OptionPricingHook hook;
    MockV3Aggregator oracle;
    MockERC20 usdc;
    MockERC20 weth;

    address owner = address(this);
    address lp = address(0xA11CE);
    uint256 constant K = 3000e18;
    uint256 expiry;
    uint256 authId;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 3000e8);
        OptionPricingEngine engine = new OptionPricingEngine();
        hook = new OptionPricingHook(address(engine), address(1), 0.8e18);
        // This test plays the vault so it can drive sigma the way fills do.
        hook.setVault(address(this));

        OptionTokenFactory tf = new OptionTokenFactory();
        SmileSwapVMRouter router = new SmileSwapVMRouter(address(aqua), address(weth), owner);
        vault = new AquaCollateralVault(address(aqua), payable(address(router)), address(oracle), owner, address(tf));

        mv = new MarginVault(address(aqua), address(oracle), address(hook), owner, address(tf), address(usdc));
        AquaOptionSettlement settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(mv));
        mv.setSettlement(address(settlement));
        backstop = new MarginBackstop(address(usdc), address(mv));
        mv.setBackstop(address(backstop));
        mv.setPricingDefaults(50, 25, 0.001e18);
        mv.setProtocolFee(0.01e9);
        mv.setNotionalCeiling(250_000e6);
        usdc.mint(address(backstop), 25_000e6);

        expiry = block.timestamp + 30 days;
        vm.prank(lp);
        authId = mv.openRange(2500e18, 3500e18, expiry, 100_000e6, 0, false, 0);
    }

    /// @dev Bump sigma 400 times through the hook exactly as the main
    /// vault's fills do. The premium must move; margin must not, bit for bit.
    function test_marginIndependentOfSigma() public {
        bytes32 sid = mv.seriesId(K, expiry);
        uint256 sigma0 = hook.sigmaFor(30 days);
        (uint256 premium0,) = mv.quote(authId, K, 1e18);
        uint256 im0 = mv.initialMargin(authId, K, 1e18);
        uint256 reqIm0 = mv.marginRequirement(K, 1e18, 2000e18, true);
        uint256 reqMm0 = mv.marginRequirement(K, 1e18, 2000e18, false);
        (uint256 locked0, uint256 mm0, uint256 imH0) = mv.health(sid, lp);
        (uint256 spot0,,) = mv.markSpot();

        for (uint256 i = 0; i < 400; i++) hook.bumpSigma(true, 30 days);

        assertGt(hook.sigmaFor(30 days), sigma0, "sigma moved");
        (uint256 premium1,) = mv.quote(authId, K, 1e18);
        assertGt(premium1, premium0, "the premium follows sigma, as it should");

        assertEq(mv.initialMargin(authId, K, 1e18), im0, "IM at fill: bit-identical");
        assertEq(mv.marginRequirement(K, 1e18, 2000e18, true), reqIm0, "IM rule: bit-identical");
        assertEq(mv.marginRequirement(K, 1e18, 2000e18, false), reqMm0, "MM rule: bit-identical");
        (uint256 locked1, uint256 mm1, uint256 imH1) = mv.health(sid, lp);
        assertEq(locked1, locked0);
        assertEq(mm1, mm0);
        assertEq(imH1, imH0);
        (uint256 spot1,,) = mv.markSpot();
        assertEq(spot1, spot0, "the mark reads the oracle only");
    }

    /// @dev EIP-170 guards: the main vault is byte-for-byte the size it was
    /// before this plan (nothing in it changed), and MarginVault fits
    /// without an auctioneer split.
    function test_bytecodeGuards() public view {
        assertEq(address(vault).code.length, 24_364, "AquaCollateralVault untouched");
        assertLt(address(mv).code.length, 24_576, "MarginVault under the EIP-170 limit");
        assertLt(address(backstop).code.length, 24_576);
    }
}
