// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { MarginVault } from "../src/periphery/MarginVault.sol";
import { MarginBackstop } from "../src/periphery/MarginBackstop.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice B6: two-step settlement. Each writer settles through a fixed
/// waterfall (locked, free, then bad debt + penalty junior to the holder),
/// the series finalizes by drawing backstop then insurance, and only when
/// both are dry do holders take a haircut — loudly, with the IM buffer
/// ratcheting up. The gap-40 test is the plan's definition of solvency.
contract MarginSettlementTest is Test {
    Aqua aqua;
    MarginVault mv;
    MarginBackstop backstop;
    AquaOptionSettlement settlement;
    MockV3Aggregator oracle;
    MockERC20 usdc;

    address owner = address(this);
    address lp = address(0xA11CE);
    address lp2 = address(0xA11CE2);
    address buyer = address(0xB0B);
    address keeper = address(0xCAFE);
    address depositor = address(0xDE9);

    uint256 constant K = 3000e18;
    uint256 constant CAPACITY = 100_000e6;
    uint256 expiry;
    bytes32 sid;
    address token;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 3000e8);
        mv = new MarginVault(
            address(aqua), address(oracle), address(0), owner, address(new OptionTokenFactory()), address(usdc)
        );
        settlement = new AquaOptionSettlement(owner, owner, address(oracle)); // this test is the CRE forwarder
        settlement.setRegistrar(address(mv));
        mv.setSettlement(address(settlement));
        backstop = new MarginBackstop(address(usdc), address(mv));
        mv.setBackstop(address(backstop));
        mv.setPricingDefaults(50, 25, 0.001e18);
        mv.setProtocolFee(0.01e9);
        mv.setNotionalCeiling(250_000e6);

        expiry = block.timestamp + 30 days;
        sid = mv.seriesId(K, expiry);
        usdc.mint(depositor, 100_000e6);
        vm.prank(depositor);
        usdc.approve(address(backstop), type(uint256).max);
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(mv), type(uint256).max);
        _fund(lp);
        _fund(lp2);
    }

    function _fund(address who) internal {
        usdc.mint(who, CAPACITY);
        vm.startPrank(who);
        usdc.approve(address(aqua), type(uint256).max);
        usdc.approve(address(mv), type(uint256).max);
        vm.stopPrank();
    }

    function _seedBackstop(uint256 amount) internal {
        vm.prank(depositor);
        backstop.deposit(amount);
    }

    function _fill(address who, uint16 lpMarginBps, uint256 units) internal {
        vm.prank(who);
        uint256 authId = mv.openRange(2500e18, 3500e18, expiry, CAPACITY, lpMarginBps, false, 0);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = mv.getShipParams(authId);
        vm.prank(who);
        aqua.ship(app, strategy, tokens, amounts);
        vm.prank(buyer);
        (token,) = mv.buy(authId, K, units, type(uint256).max);
    }

    function _settleAt(uint256 priceWad) internal {
        vm.warp(expiry);
        settlement.settleSeries(sid, priceWad);
    }

    function _free(address who) internal view returns (uint256 free) {
        (free,) = mv.accounts(who);
    }

    function _badDebt(address who) internal view returns (uint256 debt) {
        (, debt) = mv.accounts(who);
    }

    function _pot() internal view returns (uint256 pot) {
        (,,,,,,, pot,,,,) = mv.seriesOf(sid);
    }

    /// @dev Every USDC the vault holds is booked somewhere.
    function _assertBooksBalance() internal view {
        uint256 booked = _pot() + _free(lp) + _free(lp2) + _free(keeper) + mv.insuranceFund() + mv.claimable(owner);
        (, , uint256 l1,,,) = mv.positions(sid, lp);
        (, , uint256 l2,,,) = mv.positions(sid, lp2);
        (, , uint256 lb,,,) = mv.positions(sid, address(backstop));
        assertEq(usdc.balanceOf(address(mv)), booked + l1 + l2 + lb, "vault USDC == books");
    }

    // ── waterfall ────────────────────────────────────────────────────────────

    function test_settle_waterfallConservation() public {
        _seedBackstop(10_000e6);
        _fill(lp, 0, 1e18);      // 1500 locked
        _fill(lp2, 8000, 1e18);  // 2400 locked
        vm.prank(lp);
        mv.deposit(200e6);       // free, swept second

        uint256 supply0 = usdc.totalSupply();
        _settleAt(1200e18);      // owed 1800 per unit
        uint256 pool0 = backstop.totalAssets();

        mv.settlePosition(sid, lp);
        // 1500 locked + 200 free = 1700 paid, 100 short → bad debt 100 + 2% penalty 60.
        assertEq(_free(lp), 0);
        assertEq(_badDebt(lp), 160e6, "shortfall plus the default penalty, junior to the holder");
        mv.settlePosition(sid, lp2);
        assertEq(_free(lp2), 600e6, "the fully margined writer gets the rest of the margin back");
        assertEq(_pot(), 1700e6 + 1800e6);

        mv.finalizeSeries(sid);
        assertEq(pool0 - backstop.totalAssets(), 100e6, "backstop covers exactly the remaining shortfall");
        (,,,,,, uint256 owedTotal, uint256 pot, uint256 drawn, bool finalized, uint256 perUnit, uint16 haircut) =
            mv.seriesOf(sid);
        assertEq(owedTotal, 3600e6);
        assertEq(pot, 3600e6);
        assertEq(drawn, 100e6);
        assertTrue(finalized);
        assertEq(perUnit, 1800e6);
        assertEq(haircut, 0);

        uint256 b0 = usdc.balanceOf(buyer);
        vm.prank(buyer);
        uint256 payout = mv.redeem(sid, 2e18);
        assertEq(payout, 3600e6, "holders whole");
        assertEq(usdc.balanceOf(buyer) - b0, 3600e6);
        assertEq(IERC20(token).totalSupply(), 0);
        assertEq(_pot(), 0);
        assertEq(mv.nakedNotional(), 0);
        assertEq(usdc.totalSupply(), supply0, "nothing minted or burned: pure redistribution");
        _assertBooksBalance();

        // The defaulter's next deposit repays the debt before it becomes free balance.
        vm.prank(lp);
        mv.deposit(200e6);
        assertEq(_badDebt(lp), 0);
        assertEq(_free(lp), 40e6);
    }

    /// @dev The plan's solvency bar: a writer sitting exactly at MM, no
    /// credit line, a backstop at 1/BACKSTOP_MULTIPLE of naked notional,
    /// and a 40% gap before settlement — holders still get 100%.
    function test_gap40_holdersWhole() public {
        _seedBackstop(215e6); // ≥ 1500 / 7 so the fill clears the ceiling
        _fill(lp, 0, 1e18);   // 1500 locked = IM at 3000
        assertEq(mv.nakedNotional(), 1500e6);
        assertEq(backstop.totalAssets(), 215e6 + _backstopFee());

        // The price drifts to the point where 1500 is exactly MM: K − 0.7·S = 1500 → S = 2142.857…
        vm.warp(block.timestamp + 1 hours);
        oracle.setAnswer(214285714300);
        (uint256 locked, uint256 mm,) = mv.health(sid, lp);
        assertGe(locked, mm, "exactly at maintenance, unflaggable");
        assertLe(mm, locked);
        vm.expectRevert(MarginVault.Healthy.selector);
        mv.flag(sid, lp);

        // Then gaps 40% into settlement: S = 1285.71 → owed 1714.29, shortfall 214.29.
        uint256 insurance0 = mv.insuranceFund();
        _settleAt(1285714285800000000000);
        mv.settlePosition(sid, lp);
        mv.finalizeSeries(sid);

        (,,,,,, uint256 owed, uint256 pot,,, uint256 perUnit, uint16 haircut) = mv.seriesOf(sid);
        assertEq(pot, owed, "the pot covers every unit");
        assertEq(haircut, 0, "no haircut");
        assertEq(mv.insuranceFund(), insurance0, "insurance untouched: the backstop alone absorbed the gap");
        vm.prank(buyer);
        uint256 payout = mv.redeem(sid, 1e18);
        assertEq(payout, perUnit);
        assertEq(payout, 1714285714, "100% of intrinsic, to the unit");
    }

    function test_haircut_isLastResortAndRatchets() public {
        _seedBackstop(215e6);
        _fill(lp, 0, 1e18);
        uint16 im0 = mv.imBufferBps();
        uint256 pool0 = backstop.totalAssets();
        _settleAt(500e18); // owed 2500 against 1500 locked; backstop ~217, insurance ~0.2

        mv.settlePosition(sid, lp);
        assertEq(_badDebt(lp), 1000e6 + 60e6);

        vm.expectEmit(true, false, false, false, address(mv));
        emit MarginVault.HolderHaircut(sid, 0, 0, 0, 0);
        mv.finalizeSeries(sid);

        (,,,,,, uint256 owed, uint256 pot, uint256 drawn,, uint256 perUnit, uint16 haircut) = mv.seriesOf(sid);
        assertEq(owed, 2500e6);
        assertEq(backstop.totalAssets(), 0, "backstop drained first");
        assertEq(mv.insuranceFund(), 0, "then insurance");
        assertEq(drawn, pool0, "every USDC the pool had");
        assertLt(pot, owed, "and only then a haircut");
        assertEq(haircut, uint16(((owed - pot) * 1e4) / owed));
        assertEq(mv.imBufferBps(), im0 + 500, "IM ratchets up for the next series");
        assertEq(backstop.epoch(), 1, "the pool's shares are void after the full draw");

        vm.prank(buyer);
        uint256 payout = mv.redeem(sid, 1e18);
        assertEq(payout, perUnit);
        assertEq(payout, pot);
    }

    function test_lateSettlement_repaysBackstopFirst() public {
        _seedBackstop(10_000e6);
        _fill(lp, 0, 1e18);
        _fill(lp2, 8000, 1e18); // 2400 locked
        _settleAt(1200e18);     // owed 1800 each

        // Only lp settles; lp2 never shows up. Six hours on, the series finalizes anyway.
        mv.settlePosition(sid, lp); // 1500 paid, 300 bad debt (+60 penalty)
        vm.expectRevert(MarginVault.NotAllSettled.selector);
        mv.finalizeSeries(sid);
        vm.warp(expiry + 6 hours);
        uint256 pool0 = backstop.totalAssets();
        mv.finalizeSeries(sid);
        assertEq(pool0 - backstop.totalAssets(), 2100e6, "backstop fronts lp2's whole share plus lp's shortfall");

        vm.prank(buyer);
        assertEq(mv.redeem(sid, 2e18), 3600e6, "holders whole");

        // lp2 finally settles: its 2400 repays the backstop first, the 300 left is lp2's.
        mv.settlePosition(sid, lp2);
        assertEq(backstop.totalAssets(), pool0, "the pool is made whole");
        assertEq(_free(lp2), 300e6);
        _assertBooksBalance();
    }

    function test_redeem_requiresFinalized() public {
        _seedBackstop(10_000e6);
        _fill(lp, 0, 1e18);
        vm.prank(buyer);
        vm.expectRevert(MarginVault.NotFinalized.selector);
        mv.redeem(sid, 1e18);
        vm.expectRevert(MarginVault.NotSettled.selector);
        mv.settlePosition(sid, lp);
    }

    /// @dev The 30% fee share the fill sent to the pool on top of the seed.
    function _backstopFee() internal view returns (uint256) {
        return usdc.balanceOf(address(backstop)) > 215e6 ? usdc.balanceOf(address(backstop)) - 215e6 : 0;
    }
}
