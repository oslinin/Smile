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

/// @notice B5: after the grace period, a flagged position is auctioned to
/// another writer (collateral travels with it, the holder is untouched) or,
/// unsold, absorbed by the backstop pool which draws only the shortfall.
/// The pool's withdrawals are delayed, floored, and frozen around expiry;
/// a full draw voids every share.
contract MarginAuctionTest is Test {
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
    address bidder = address(0xB1D);
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
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(mv));
        mv.setSettlement(address(settlement));
        backstop = new MarginBackstop(address(usdc), address(mv));
        mv.setBackstop(address(backstop));
        mv.setPricingDefaults(50, 25, 0.001e18);
        mv.setProtocolFee(0.01e9);
        mv.setNotionalCeiling(250_000e6);

        usdc.mint(depositor, 25_000e6);
        vm.startPrank(depositor);
        usdc.approve(address(backstop), type(uint256).max);
        backstop.deposit(25_000e6);
        vm.stopPrank();

        expiry = block.timestamp + 30 days;
        sid = mv.seriesId(K, expiry);
        usdc.mint(lp, CAPACITY);
        usdc.mint(buyer, 1_000_000e6);
        usdc.mint(bidder, 10_000e6);
        vm.startPrank(lp);
        usdc.approve(address(aqua), type(uint256).max);
        usdc.approve(address(mv), type(uint256).max);
        vm.stopPrank();
        vm.prank(buyer);
        usdc.approve(address(mv), type(uint256).max);
        vm.prank(bidder);
        usdc.approve(address(mv), type(uint256).max);
    }

    /// @dev Fill one ATM unit (1500 locked), crash to 2000, flag, wait out
    /// the grace, confirm with a post-flag round at 2000, open the auction.
    function _fillAndAuction() internal {
        vm.prank(lp);
        uint256 authId = mv.openRange(2500e18, 3500e18, expiry, CAPACITY, 0, false, 0);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = mv.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);
        vm.prank(buyer);
        (token,) = mv.buy(authId, K, 1e18, type(uint256).max);

        vm.warp(block.timestamp + 5 minutes);
        oracle.setAnswer(2000e8);
        vm.prank(keeper);
        mv.flag(sid, lp);
        vm.warp(block.timestamp + 61 minutes);
        oracle.setAnswer(2000e8);
        mv.startAuction(sid, lp);
    }

    function _pos(address who) internal view returns (uint256 units, uint256 locked, uint64 flaggedAt) {
        (, units, locked, flaggedAt,,) = mv.positions(sid, who);
    }

    function _free(address who) internal view returns (uint256 free) {
        (free,) = mv.accounts(who);
    }

    /// @dev Every USDC the vault holds is somebody's: locked, free, insurance, or claimable.
    function _assertVaultBooksBalance() internal view {
        (, uint256 lpLocked,) = _pos(lp);
        (, uint256 bidLocked,) = _pos(bidder);
        (, uint256 bsLocked,) = _pos(address(backstop));
        uint256 booked = lpLocked + bidLocked + bsLocked + _free(lp) + _free(bidder) + _free(keeper)
            + _free(address(backstop)) + mv.insuranceFund() + mv.claimable(owner);
        assertEq(usdc.balanceOf(address(mv)), booked, "vault USDC == sum of every book entry");
    }

    // ── takeover ─────────────────────────────────────────────────────────────

    function test_takeOver_collateralTravelsWithPosition() public {
        _fillAndAuction();
        uint256 supply0 = IERC20(token).totalSupply();
        uint256 holder0 = IERC20(token).balanceOf(buyer);

        vm.warp(block.timestamp + 15 minutes); // halfway: bonus 5.5% of 3000 = 165
        assertEq(mv.takeoverBonusBps(sid, lp), 550);
        // Mark 2000 → MM 1600, IM 2000. Old writer locked 1500 < MM+bonus+penalty, so all 1500 moves:
        // bonus 165 to bidder, penalty 60 (7.5 to flagger, 52.5 insurance), 1275 seeds the bidder,
        // who posts IM − 1275 = 725.
        uint256 bidder0 = usdc.balanceOf(bidder);
        uint256 insurance0 = mv.insuranceFund();
        vm.prank(bidder);
        uint256 posted = mv.takeOver(sid, lp);

        assertEq(posted, 725e6, "bidder posts only IM minus what travelled");
        assertEq(bidder0 - usdc.balanceOf(bidder), 725e6);
        (uint256 bu, uint256 bl,) = _pos(bidder);
        assertEq(bu, 1e18);
        assertEq(bl, 2000e6, "bidder holds the position at IM");
        assertEq(_free(bidder), 165e6, "bonus");
        assertEq(_free(keeper), 7.5e6, "flagger slice of the penalty");
        assertEq(mv.insuranceFund() - insurance0, 52.5e6, "rest of the penalty to insurance");

        (uint256 lu, uint256 ll, uint64 lf) = _pos(lp);
        assertEq(lu, 0);
        assertEq(ll, 0);
        assertEq(lf, 0, "old writer unflagged and out");
        assertEq(mv.flaggedCount(lp), 0);
        assertEq(_free(lp), 0, "nothing exceeded the liability, nothing came back");

        assertEq(IERC20(token).totalSupply(), supply0, "holder's token untouched");
        assertEq(IERC20(token).balanceOf(buyer), holder0);
        (,,,, uint256 count,,,,,,,) = mv.seriesOf(sid);
        assertEq(count, 1, "one writer, still");
        assertEq(mv.nakedNotional(), 1000e6, "3000 notional - 2000 locked");
        _assertVaultBooksBalance();
    }

    function test_takeOver_excessOverLiabilityReturnsToWriter() public {
        _fillAndAuction();
        // The writer tops up to 1900 during the auction: above MM 1600 but under the
        // IM 2000 a cure needs, so the auction stands. Liability at the open is
        // MM + 1% bonus + 2% penalty = 1600 + 30 + 60 = 1690; the 210 above it is the writer's.
        vm.prank(lp);
        mv.topUp(sid, lp, 400e6);
        vm.prank(bidder);
        uint256 posted = mv.takeOver(sid, lp);

        assertEq(_free(lp), 210e6, "excess over the liability comes back as free balance");
        assertEq(_free(bidder), 30e6);
        // seed = 1690 - 30 - 60 = 1600; IM 2000 -> posts 400.
        assertEq(posted, 400e6);
        (, uint256 bl,) = _pos(bidder);
        assertEq(bl, 2000e6);
        _assertVaultBooksBalance();

        vm.prank(lp);
        mv.withdraw(210e6);
    }

    function test_topUp_duringAuctionClearsIt() public {
        _fillAndAuction();
        vm.prank(lp);
        mv.topUp(sid, lp, 500e6); // 2000 = IM at the 2000 mark
        (,, uint64 flaggedAt) = _pos(lp);
        assertEq(flaggedAt, 0, "topping up to IM clears the flag and the auction");
        vm.prank(bidder);
        vm.expectRevert(MarginVault.AuctionNotStarted.selector);
        mv.takeOver(sid, lp);
    }

    function test_takeOver_guards() public {
        _fillAndAuction();
        vm.prank(lp);
        vm.expectRevert(MarginVault.SelfTakeover.selector);
        mv.takeOver(sid, lp);

        vm.warp(block.timestamp + 31 minutes);
        vm.prank(bidder);
        vm.expectRevert(MarginVault.AuctionOver.selector);
        mv.takeOver(sid, lp);
    }

    // ── absorb ───────────────────────────────────────────────────────────────

    function test_absorb_backstopDrawsOnlyShortfall() public {
        _fillAndAuction();
        vm.prank(keeper);
        vm.expectRevert(MarginVault.AuctionNotOver.selector);
        mv.absorb(sid, lp);

        vm.warp(block.timestamp + 31 minutes);
        uint256 pool0 = backstop.totalAssets();
        // 1500 moves: tip 15 to keeper, penalty 60 (7.5 flagger, 52.5 insurance), 1425 seeds; MM 1600 → draw 175.
        vm.prank(keeper);
        uint256 drawn = mv.absorb(sid, lp);

        assertEq(drawn, 175e6, "the pool pays only MM minus what travelled");
        assertEq(pool0 - backstop.totalAssets(), 175e6);
        (uint256 bu, uint256 bl,) = _pos(address(backstop));
        assertEq(bu, 1e18);
        assertEq(bl, 1600e6, "pool holds the position at MM");
        assertEq(_free(keeper), 15e6 + 7.5e6, "keeper tip plus its flagger slice");
        assertEq(backstop.poolRequirement(), 3000e6, "pool now stands behind 3000 of notional");
        (,,,,,,,, uint256 bsDrawn,,,) = mv.seriesOf(sid);
        assertEq(bsDrawn, 175e6);
        (uint256 lu,,) = _pos(lp);
        assertEq(lu, 0);
        assertEq(mv.nakedNotional(), 1400e6);
        _assertVaultBooksBalance();
    }

    // ── backstop pool ────────────────────────────────────────────────────────

    function test_backstop_withdrawGuards() public {
        uint256 shares = backstop.sharesOf(0, depositor);
        assertEq(shares, 25_000e6 - 1000, "dead shares burned once");

        vm.startPrank(depositor);
        backstop.requestWithdraw(shares);
        vm.expectRevert(MarginBackstop.TooEarly.selector);
        backstop.withdraw();
        vm.stopPrank();

        _fillAndAuction();
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(keeper);
        mv.absorb(sid, lp);

        // 24 h are long past; the floor is max(poolRequirement 3000, naked/10).
        vm.startPrank(depositor);
        vm.expectRevert();
        backstop.withdraw();
        // Ask for less: leave exactly the requirement behind.
        uint256 keep = backstop.poolRequirement();
        uint256 canTake = backstop.totalAssets() - keep;
        uint256 okShares = (canTake * backstop.totalShares()) / backstop.totalAssets();
        backstop.requestWithdraw(okShares);
        vm.warp(block.timestamp + 24 hours);
        uint256 got = backstop.withdraw();
        vm.stopPrank();
        assertLe(got, canTake);
        assertGe(backstop.totalAssets(), keep, "never below what absorbed positions could owe");

        // Frozen while an expired series is unfinalized.
        vm.startPrank(depositor);
        backstop.requestWithdraw(1);
        vm.warp(expiry + 1 days);
        vm.expectRevert(MarginBackstop.Frozen.selector);
        backstop.withdraw();
        vm.stopPrank();
    }

    function test_backstop_epochAfterFullDraw() public {
        uint256 shares = backstop.sharesOf(0, depositor);
        vm.prank(address(mv));
        backstop.draw(type(uint256).max);
        assertEq(backstop.totalAssets(), 0);
        assertEq(backstop.epoch(), 1, "a full draw rolls the epoch");
        assertEq(backstop.totalShares(), 0);
        assertEq(backstop.sharesOf(1, depositor), 0, "old shares are void");
        assertEq(backstop.assetsOf(shares), 0);

        address late = address(0x1A7E);
        usdc.mint(late, 1_000e6);
        vm.startPrank(late);
        usdc.approve(address(backstop), type(uint256).max);
        uint256 s2 = backstop.deposit(1_000e6);
        vm.stopPrank();
        assertEq(s2, 1_000e6 - 1000, "fresh cap table");
        assertEq(backstop.assetsOf(s2), 1_000e6 - 1000, "and the new depositor owns it, less the dead sliver");
    }
}
