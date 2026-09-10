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

/// @notice B4: margin calls. The vault cures on the writer's behalf before
/// it flags (free balance, then the opt-in Aqua credit line), covered
/// positions are immune, auctions are judged only on rounds posted after
/// the flag, and withdrawals keep every open position at IM.
contract MarginCallTest is Test {
    Aqua aqua;
    MarginVault mv;
    MarginBackstop backstop;
    AquaOptionSettlement settlement;
    MockV3Aggregator oracle;
    MockERC20 usdc;

    address owner = address(this);
    address lp = address(0xA11CE);
    address buyer = address(0xB0B);
    address keeper = address(0xCAFE);

    uint256 constant K = 3000e18;
    uint256 constant CAPACITY = 100_000e6;
    uint256 expiry;
    bytes32 sid;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 3000e8);
        mv = new MarginVault(
            address(aqua), address(oracle), address(0), owner, address(new OptionTokenFactory()), address(usdc)
        );
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(mv));
        mv.setSettlement(address(settlement));
        backstop = new MarginBackstop(address(usdc), address(mv));
        mv.setBackstop(address(backstop));
        mv.setPricingDefaults(50, 25, 0.001e18);
        mv.setProtocolFee(0.01e9);
        mv.setNotionalCeiling(250_000e6);
        usdc.mint(address(backstop), 25_000e6);

        expiry = block.timestamp + 30 days;
        sid = mv.seriesId(K, expiry);
        usdc.mint(lp, CAPACITY);
        usdc.mint(buyer, 1_000_000e6);
        usdc.mint(keeper, 10_000e6);
        vm.startPrank(lp);
        usdc.approve(address(aqua), type(uint256).max);
        usdc.approve(address(mv), type(uint256).max);
        vm.stopPrank();
        vm.prank(buyer);
        usdc.approve(address(mv), type(uint256).max);
        vm.prank(keeper);
        usdc.approve(address(mv), type(uint256).max);
    }

    /// @dev Writer ships and one ATM unit fills: 1500 locked against 3000 of notional.
    function _fill(bool autoTopUp) internal returns (uint256 authId) {
        vm.prank(lp);
        authId = mv.openRange(2500e18, 3500e18, expiry, CAPACITY, 0, autoTopUp, 0);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = mv.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);
        vm.prank(buyer);
        mv.buy(authId, K, 1e18, type(uint256).max);
    }

    function _crashTo(uint256 usd) internal {
        vm.warp(block.timestamp + 5 minutes);
        oracle.setAnswer(int256(usd * 1e8));
    }

    function _locked() internal view returns (uint256 locked) {
        (,, locked,,,) = mv.positions(sid, lp);
    }

    function _flaggedAt() internal view returns (uint64 at) {
        (,,, at,,) = mv.positions(sid, lp);
    }

    // ── flag ─────────────────────────────────────────────────────────────────

    function test_flag_autoAnswersFromAquaCreditLine() public {
        _fill(true);
        assertEq(_locked(), 1500e6);
        _crashTo(2000); // MM = 1000 + 600 = 1600 > 1500 locked; IM = 2000

        uint256 lp0 = usdc.balanceOf(lp);
        vm.prank(keeper);
        mv.flag(sid, lp);

        assertEq(_locked(), 2000e6, "cured to IM from the writer's own shipped allowance");
        assertEq(lp0 - usdc.balanceOf(lp), 500e6, "exactly the deficit left the wallet");
        assertEq(_flaggedAt(), 0, "not flagged");
        assertEq(mv.nakedNotional(), 1000e6, "naked notional shrank by the top-up");
    }

    function test_flag_marksWhenNoCreditLine() public {
        _fill(false);
        _crashTo(2000);

        vm.prank(keeper);
        mv.flag(sid, lp);
        assertEq(_flaggedAt(), block.timestamp, "flagged");
        assertEq(_locked(), 1500e6, "nothing was pulled without opt-in");
        assertEq(mv.flaggedCount(lp), 1);

        vm.expectRevert(MarginVault.AlreadyFlagged.selector);
        mv.flag(sid, lp);
        vm.prank(lp);
        vm.expectRevert(MarginVault.WhileFlagged.selector);
        mv.withdraw(0);
    }

    function test_flag_sweepsFreeFirst() public {
        _fill(false);
        vm.prank(lp);
        mv.deposit(300e6);
        _crashTo(2000);

        mv.flag(sid, lp);
        (uint256 free,) = mv.accounts(lp);
        assertEq(free, 0, "free swept");
        assertEq(_locked(), 1800e6, "1500 + 300 >= MM 1600");
        assertEq(_flaggedAt(), 0, "back above maintenance, no flag");
    }

    function test_flag_revertsWhenHealthyOrCovered() public {
        _fill(false);
        vm.expectRevert(MarginVault.Healthy.selector);
        mv.flag(sid, lp);

        // Top up to the full strike value: a cash-secured put, unflaggable at any price.
        vm.prank(keeper);
        mv.topUp(sid, lp, 1500e6);
        assertTrue(mv.isCovered(sid, lp));
        _crashTo(100);
        vm.expectRevert(MarginVault.Covered.selector);
        mv.flag(sid, lp);

        // Anything past full cover is free balance, not margin.
        vm.prank(keeper);
        mv.topUp(sid, lp, 50e6);
        (uint256 free,) = mv.accounts(lp);
        assertEq(free, 50e6);
        assertEq(_locked(), 3000e6);
    }

    function test_topUp_clearsFlagAtIM() public {
        _fill(false);
        _crashTo(2000);
        mv.flag(sid, lp);
        assertGt(_flaggedAt(), 0);

        vm.prank(lp);
        mv.topUp(sid, lp, 400e6); // 1900 < IM 2000: still flagged
        assertGt(_flaggedAt(), 0, "a cure requires IM, not MM");
        vm.prank(lp);
        mv.topUp(sid, lp, 100e6);
        assertEq(_flaggedAt(), 0, "at IM the flag clears");
        assertEq(mv.flaggedCount(lp), 0);
    }

    // ── auction start ────────────────────────────────────────────────────────

    function test_startAuction_ignoresRoundsBeforeFlag() public {
        _fill(false);
        _crashTo(2000);
        mv.flag(sid, lp);

        vm.expectRevert(MarginVault.GraceNotOver.selector);
        mv.startAuction(sid, lp);

        // The dip recovers after the flag: the only post-flag round is 3000.
        vm.warp(block.timestamp + 61 minutes);
        oracle.setAnswer(3000e8);
        mv.startAuction(sid, lp);
        assertEq(_flaggedAt(), 0, "judged on post-flag rounds only: healthy, unflagged");
        (,,,, uint64 auctionStart,) = mv.positions(sid, lp);
        assertEq(auctionStart, 0);
    }

    function test_startAuction_needsARoundAfterTheFlag() public {
        _fill(false);
        _crashTo(2000);
        mv.flag(sid, lp);
        vm.warp(block.timestamp + 61 minutes);
        vm.expectRevert(MarginVault.NoRoundSinceFlag.selector);
        mv.startAuction(sid, lp);
    }

    function test_startAuction_opensWhenStillUnderMM() public {
        _fill(false);
        _crashTo(2000);
        mv.flag(sid, lp);
        vm.warp(block.timestamp + 61 minutes);
        oracle.setAnswer(2100e8); // MM = 900 + 630 = 1530 > 1500
        mv.startAuction(sid, lp);
        (,,,, uint64 auctionStart,) = mv.positions(sid, lp);
        assertEq(auctionStart, block.timestamp);
        vm.expectRevert(MarginVault.AuctionAlreadyStarted.selector);
        mv.startAuction(sid, lp);
    }

    // ── withdraw ─────────────────────────────────────────────────────────────

    function test_withdraw_keepsEveryPositionAtIM() public {
        _fill(false);
        vm.prank(lp);
        mv.deposit(1000e6);
        _crashTo(2500); // IM = 500 + 1250 = 1750; have = 1500 locked + 1000 free = 2500

        vm.startPrank(lp);
        vm.expectRevert(abi.encodeWithSelector(MarginVault.WithdrawBelowIM.selector, 1700e6, 1750e6));
        mv.withdraw(800e6);
        uint256 lp0 = usdc.balanceOf(lp);
        mv.withdraw(750e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(lp) - lp0, 750e6);
        (uint256 free,) = mv.accounts(lp);
        assertEq(free, 250e6);

        vm.warp(block.timestamp + 91 minutes);
        vm.prank(lp);
        vm.expectRevert(MarginVault.StaleMark.selector);
        mv.withdraw(1);
    }

    function test_buy_usesFreeBalanceFirst() public {
        vm.prank(lp);
        mv.deposit(1000e6);
        uint256 lp0 = usdc.balanceOf(lp);
        uint256 authId = _fill(false);
        (uint256 lpPremium,) = mv.quote(authId, K, 1e18);
        // 1500 IM: 1000 from free, 500 pulled — premium comes back to the wallet.
        assertEq(lp0 + lpPremium - usdc.balanceOf(lp), 500e6, "only the remainder is pulled");
        (uint256 free,) = mv.accounts(lp);
        assertEq(free, 0);
        assertEq(_locked(), 1500e6);
    }

    // ── cover ────────────────────────────────────────────────────────────────

    function test_coverShort_burnsOwnLongsAgainstShort() public {
        _fill(false);
        (,, address token,,,,,,,,,) = mv.seriesOf(sid);
        vm.prank(buyer);
        IERC20(token).transfer(lp, 1e18);

        vm.prank(lp);
        mv.coverShort(sid, 1e18);

        (, uint256 units, uint256 locked,,,) = mv.positions(sid, lp);
        assertEq(units, 0);
        assertEq(locked, 0);
        (uint256 free,) = mv.accounts(lp);
        assertEq(free, 1500e6, "the margin behind the netted short is free again");
        assertEq(IERC20(token).totalSupply(), 0);
        assertEq(mv.nakedNotional(), 0);
        (,,, uint256 sUnits, uint256 sCount,,,,,,,) = mv.seriesOf(sid);
        assertEq(sUnits, 0);
        assertEq(sCount, 0);

        vm.prank(lp);
        mv.withdraw(1500e6);
        assertGe(usdc.balanceOf(lp), CAPACITY, "wallet whole again, plus the premium earned");
    }
}
