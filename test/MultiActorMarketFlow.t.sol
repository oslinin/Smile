// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { OptionPricingEngine } from "../src/swapvm/OptionPricingEngine.sol";
import { OptionToken } from "../src/OptionToken.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice End-to-end multi-actor market scenario on the official 1inch Aqua
/// stack: three LPs authorize and ship covered-call ranges sequentially, then
/// two independent buy/sell round trips run against two of those ranges —
/// each buy and each sell performed by a DIFFERENT wallet, modeling a real
/// secondary market where option holders resell to a third party rather than
/// closing their own position.
///
/// Flow:
///   1. lp1, lp2, lp3 sequentially authorizeRange + Aqua.ship a covered-call
///      range (lp3's liquidity is left unmatched, showing idle depth).
///   2. buyer1 buys 2 CALL-2900 units against lp1's range.
///   3. buyer1 transfers 1 unit to seller1, who sells it back (closes)
///      against lp1's range at the live Bid — a wallet that never bought
///      anything is the one that sells.
///   4. buyer2 buys 2 CALL-3100 units against lp2's range.
///   5. buyer2 transfers 1 unit to seller2, who sells it back against lp2's
///      range at the live Bid.
contract MultiActorMarketFlowTest is Test {
    Aqua aqua;
    SmileSwapVMRouter router;
    AquaCollateralVault vault;
    AquaOptionSettlement settlement;
    OptionPricingEngine engine;
    MockV3Aggregator oracle;
    MockERC20 usdc;
    MockERC20 weth;

    address owner   = address(this);
    address lp1     = address(0x1001);
    address lp2     = address(0x1002);
    address lp3     = address(0x1003);
    address buyer1  = address(0x2001);
    address seller1 = address(0x2002);
    address buyer2  = address(0x2003);
    address seller2 = address(0x2004);

    uint256 constant SPOT = 3000e18;
    uint256 expiry;

    function setUp() public {
        usdc   = new MockERC20("USD Coin", "USDC", 6);
        weth   = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua   = new Aqua();
        router = new SmileSwapVMRouter(address(aqua), address(weth), owner);
        engine = new OptionPricingEngine();
        oracle = new MockV3Aggregator(8, 3000e8);
        vault  = new AquaCollateralVault(address(aqua), payable(address(router)), address(oracle), owner);
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(vault));
        vault.setSettlement(address(settlement));
        expiry = block.timestamp + 30 days;

        // Buyers need USDC to pay premiums; sellers need none up front — they
        // acquire OptionToken units via transfer, not by buying themselves.
        usdc.mint(buyer1, 1_000_000e6);
        usdc.mint(buyer2, 1_000_000e6);
        vm.prank(buyer1);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(buyer2);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev LP authorizes a covered-call range then ships it to the official
    /// Aqua registry — collateral stays in the LP's own wallet until matched.
    function _lpProvidesLiquidity(address lp, uint256 strikeMin, uint256 strikeMax, uint256 maxCollateral)
        internal
        returns (uint256 authId)
    {
        weth.mint(lp, maxCollateral);
        vm.startPrank(lp);
        authId = vault.authorizeRange(strikeMin, strikeMax, expiry, maxCollateral, address(weth), address(usdc), true);
        weth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max); // funds Bid pulls on sellbacks
        vm.stopPrank();

        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            vault.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);

        console.log("LP %s shipped range [%s - %s]", lp, strikeMin / 1e18, strikeMax / 1e18);
        console.log("  authId=%s", authId);
    }

    function test_threeLps_thenTwoIndependentBuySellRoundTrips() public {
        // ── Step 1: three LPs sequentially provide liquidity ────────────────
        uint256 authId1 = _lpProvidesLiquidity(lp1, 2800e18, 3000e18, 5e18);
        uint256 authId2 = _lpProvidesLiquidity(lp2, 3000e18, 3200e18, 5e18);
        uint256 authId3 = _lpProvidesLiquidity(lp3, 3200e18, 3400e18, 5e18); // unmatched, idle depth

        assertEq(weth.balanceOf(lp1), 5e18, "lp1 collateral stays in wallet pre-match");
        assertEq(weth.balanceOf(lp2), 5e18, "lp2 collateral stays in wallet pre-match");
        assertEq(weth.balanceOf(lp3), 5e18, "lp3 collateral stays in wallet, never matched");

        // ── Step 2: buyer1 buys 2 CALL-2900 against lp1's range ─────────────
        uint256 strike1 = 2900e18;
        vm.prank(buyer1);
        (address optionToken1, uint256 premium1) = vault.buy(authId1, strike1, 2e18, type(uint256).max);
        console.log("buyer1 bought 2 CALL-2900, premium (USDC 6-dec): %s", premium1);

        assertEq(OptionToken(optionToken1).balanceOf(buyer1), 2e18);
        assertEq(usdc.balanceOf(lp1), premium1, "lp1 received the premium in-wallet");
        assertEq(weth.balanceOf(address(vault)), 2e18, "vault escrows the JIT-pulled collateral");
        assertEq(weth.balanceOf(lp1), 5e18 - 2e18, "lp1 collateral pulled JIT");

        // ── Step 3: buyer1 transfers 1 unit to seller1, who sells it back ───
        vm.prank(buyer1);
        OptionToken(optionToken1).transfer(seller1, 1e18);
        assertEq(OptionToken(optionToken1).balanceOf(buyer1), 1e18);
        assertEq(OptionToken(optionToken1).balanceOf(seller1), 1e18);

        uint256 seller1UsdcBefore = usdc.balanceOf(seller1);
        vm.prank(seller1);
        uint256 bid1 = vault.close(optionToken1, lp1, 1e18, 0);
        console.log("seller1 sold 1 CALL-2900 back, received (USDC 6-dec): %s", bid1);

        assertGt(bid1, 0, "seller1 received a positive Bid");
        assertLe(bid1, premium1 / 2, "sellback Bid never exceeds half the original Ask paid");
        assertEq(usdc.balanceOf(seller1), seller1UsdcBefore + bid1);
        assertEq(OptionToken(optionToken1).balanceOf(seller1), 0, "seller1's unit burned");
        assertEq(OptionToken(optionToken1).balanceOf(buyer1), 1e18, "buyer1 still holds their remaining unit");
        assertEq(weth.balanceOf(address(vault)), 1e18, "vault escrow reduced by the closed unit");
        assertEq(weth.balanceOf(lp1), 5e18 - 1e18, "lp1 collateral capacity partially restored");

        // ── Step 4: buyer2 buys 2 CALL-3100 against lp2's range ─────────────
        uint256 strike2 = 3100e18;
        vm.prank(buyer2);
        (address optionToken2, uint256 premium2) = vault.buy(authId2, strike2, 2e18, type(uint256).max);
        console.log("buyer2 bought 2 CALL-3100, premium (USDC 6-dec): %s", premium2);

        assertEq(OptionToken(optionToken2).balanceOf(buyer2), 2e18);
        assertEq(usdc.balanceOf(lp2), premium2, "lp2 received the premium in-wallet");
        assertEq(weth.balanceOf(lp2), 5e18 - 2e18, "lp2 collateral pulled JIT");

        // ── Step 5: buyer2 transfers 1 unit to seller2, who sells it back ───
        vm.prank(buyer2);
        OptionToken(optionToken2).transfer(seller2, 1e18);
        assertEq(OptionToken(optionToken2).balanceOf(seller2), 1e18);

        uint256 seller2UsdcBefore = usdc.balanceOf(seller2);
        vm.prank(seller2);
        uint256 bid2 = vault.close(optionToken2, lp2, 1e18, 0);
        console.log("seller2 sold 1 CALL-3100 back, received (USDC 6-dec): %s", bid2);

        assertGt(bid2, 0, "seller2 received a positive Bid");
        assertLe(bid2, premium2 / 2, "sellback Bid never exceeds half the original Ask paid");
        assertEq(usdc.balanceOf(seller2), seller2UsdcBefore + bid2);
        assertEq(OptionToken(optionToken2).balanceOf(seller2), 0, "seller2's unit burned");
        assertEq(OptionToken(optionToken2).balanceOf(buyer2), 1e18, "buyer2 still holds their remaining unit");
        assertEq(weth.balanceOf(lp2), 5e18 - 1e18, "lp2 collateral capacity partially restored");

        // ── lp3's liquidity was never touched ────────────────────────────────
        assertEq(weth.balanceOf(lp3), 5e18, "lp3's range stayed idle the whole scenario");
        (,,,,,,,,bool active3,,,,,,,,) = vault.authorizations(authId3);
        assertTrue(active3, "lp3's authorization is still live, ready to be matched");
    }
}
