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

/// @notice MarginVault, test-first per Part B of
/// docs/plans/2026-09-05-aqua.md.
/// B1: a range ships to Aqua under this vault's own strategy hash, wiring
/// is one-time, and the vol buffer can only ratchet up — IM at once, MM
/// after a day.
contract MarginVaultTest is Test {
    Aqua aqua;
    MarginVault mv;
    MarginBackstop backstop;
    AquaOptionSettlement settlement;
    MockV3Aggregator oracle;
    MockERC20 usdc;

    address owner = address(this);
    address lp = address(0xA11CE);
    address buyer = address(0xB0B);

    uint256 constant K = 3000e18;
    uint256 constant CAPACITY = 100_000e6;
    uint256 expiry;

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
        usdc.mint(address(backstop), 25_000e6); // ceiling = min(250k, 7 x 25k = 175k)

        expiry = block.timestamp + 30 days;
        usdc.mint(lp, CAPACITY);
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(lp);
        usdc.approve(address(aqua), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(mv), type(uint256).max);
    }

    function _openAndShip(uint256 capacity, bool autoTopUp) internal returns (uint256 authId) {
        vm.prank(lp);
        authId = mv.openRange(2500e18, 3500e18, expiry, capacity, 0, autoTopUp, 0);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            mv.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);
    }

    // ── B1 ───────────────────────────────────────────────────────────────────

    function test_openRange_shipHashMatchesAqua() public {
        uint256 authId = _openAndShip(CAPACITY, false);

        (,,,,,,,,, bytes32 strategyHash,,,) = mv.ranges(authId);
        (uint248 balance,) = aqua.rawBalances(lp, address(mv), strategyHash, address(usdc));
        assertEq(balance, CAPACITY, "Aqua virtual balance is the shipped margin capacity under this vault's hash");
        assertEq(usdc.balanceOf(address(mv)), 0, "nothing moves until a fill pulls margin");
        assertEq(usdc.balanceOf(lp), CAPACITY);
    }

    function test_wiring_isOneTime() public {
        vm.expectRevert(MarginVault.AlreadySet.selector);
        mv.setSettlement(address(1));
        vm.expectRevert(MarginVault.AlreadySet.selector);
        mv.setBackstop(address(1));
    }

    function test_scheduleVolBuffer_onlyRatchetsUpWithDelay() public {
        assertEq(mv.imBufferBps(), 5000);
        assertEq(mv.mmBufferBps(), 3000);

        // Loosening is not a thing.
        vm.expectRevert(MarginVault.BufferOnlyTightens.selector);
        mv.scheduleVolBuffer(4000, 3000);
        // One step is at most +1000 bps.
        vm.expectRevert(MarginVault.BufferStepTooLarge.selector);
        mv.scheduleVolBuffer(6500, 3000);
        // MM never above IM.
        vm.expectRevert(MarginVault.MmAboveIm.selector);
        mv.scheduleVolBuffer(5000, 5500);

        mv.scheduleVolBuffer(6000, 4000);
        assertEq(mv.imBufferBps(), 6000, "IM raise applies at once");
        assertEq(mv.mmBufferBps(), 3000, "MM raise is queued");

        vm.expectRevert(MarginVault.TooEarly.selector);
        mv.applyVolBuffer();

        vm.warp(block.timestamp + 24 hours);
        mv.applyVolBuffer();
        assertEq(mv.mmBufferBps(), 4000, "MM raise lands after the delay");

        vm.expectRevert(MarginVault.NothingPending.selector);
        mv.applyVolBuffer();

        vm.prank(lp);
        vm.expectRevert();
        mv.scheduleVolBuffer(6000, 4000);
    }

    // ── B2 ───────────────────────────────────────────────────────────────────

    function test_markSpot_isWorstOfHour() public {
        // 3000 at setUp; then 2700 and 2950 within the hour → mark 2700.
        vm.warp(block.timestamp + 20 minutes);
        oracle.setAnswer(2700e8);
        vm.warp(block.timestamp + 20 minutes);
        oracle.setAnswer(2950e8);

        (uint256 spot, uint256 latestAt, uint256 rounds) = mv.markSpot();
        assertEq(spot, 2700e18, "lowest answer in the window");
        assertEq(latestAt, block.timestamp);
        assertEq(rounds, 3);
        assertFalse(mv.isMarkStale());
    }

    function test_markSpot_ignoresRoundsOlderThanTheWindow() public {
        oracle.setAnswer(2500e8);                    // now
        vm.warp(block.timestamp + 2 hours);          // ...falls out of the window
        oracle.setAnswer(3100e8);
        vm.warp(block.timestamp + 10 minutes);
        oracle.setAnswer(3050e8);

        (uint256 spot,, uint256 rounds) = mv.markSpot();
        assertEq(spot, 3050e18, "the 2500 two hours ago does not drag the mark");
        assertEq(rounds, 2);
    }

    function test_markSpot_staleFlagButNoRevert() public {
        vm.warp(block.timestamp + 91 minutes);
        (uint256 spot,,) = mv.markSpot();
        assertEq(spot, 3000e18, "still returns the last known price");
        assertTrue(mv.isMarkStale(), "...and says so");
    }

    function test_marginRequirement_numbers() public view {
        uint256 u = 1e18;
        assertEq(mv.marginRequirement(K, u, 3000e18, true), 1500e6, "ATM IM = 50% of spot");
        assertEq(mv.marginRequirement(K, u, 3000e18, false), 900e6, "ATM MM = 30% of spot");
        assertEq(mv.marginRequirement(K, u, 2000e18, true), 2000e6, "ITM IM = intrinsic 1000 + 50% of 2000");
        assertEq(mv.marginRequirement(K, u, 2000e18, false), 1600e6, "ITM MM = intrinsic 1000 + 30% of 2000");
        assertEq(mv.marginRequirement(K, u, 0, true), 3000e6, "capped at the strike");
        assertEq(mv.marginRequirement(K, u, 0, false), 3000e6);
        assertEq(mv.marginRequirement(K, u, 10_000e18, true), 3000e6, "deep OTM buffer alone hits the cap");
        assertEq(mv.marginRequirement(K, 2e18, 3000e18, true), 3000e6, "linear in units");
    }

    // ── B3 ───────────────────────────────────────────────────────────────────

    function test_buy_pullsOnlyInitialMargin() public {
        uint256 authId = _openAndShip(CAPACITY, false);
        (uint256 lpPremium, uint256 fee) = mv.quote(authId, K, 1e18);
        assertGt(lpPremium, 0);
        assertEq(fee, (lpPremium * 0.01e9 + (1e9 - 0.01e9) - 1) / (1e9 - 0.01e9), "1% fee gross-up");

        uint256 lp0 = usdc.balanceOf(lp);
        uint256 buyer0 = usdc.balanceOf(buyer);
        vm.prank(buyer);
        (address token, uint256 paid) = mv.buy(authId, K, 1e18, type(uint256).max);

        assertEq(paid, lpPremium + fee);
        assertEq(lp0 - usdc.balanceOf(lp), 1500e6 - lpPremium, "the LP wallet drops 1500 USDC of margin (net of premium), not 3000");
        assertEq(buyer0 - usdc.balanceOf(buyer), paid);
        assertEq(usdc.balanceOf(address(mv)), 1500e6 + fee - fee * 3000 / 1e4, "IM + the non-backstop fee share held here");

        bytes32 sid = mv.seriesId(K, expiry);
        (uint256 pAuth, uint256 pUnits, uint256 pLocked,,,) = mv.positions(sid, lp);
        assertEq(pAuth, authId);
        assertEq(pUnits, 1e18);
        assertEq(pLocked, 1500e6, "locked = IM, half the strike");
        assertEq(mv.nakedNotional(), 1500e6, "the other half is naked notional");
        (,, address sToken, uint256 sUnits, uint256 sCount,,,,,,,) = mv.seriesOf(sid);
        assertEq(sToken, token);
        assertEq(sUnits, 1e18);
        assertEq(sCount, 1);
        assertEq(IERC20(token).balanceOf(buyer), 1e18);
        (address regToken, uint256 regExpiry, uint256 regStrike, bool isCall,,) = settlement.series(sid);
        assertEq(regToken, token);
        assertEq(regExpiry, expiry);
        assertEq(regStrike, K);
        assertFalse(isCall);
    }

    function test_buy_feeSplit_insuranceBackstopDao() public {
        uint256 authId = _openAndShip(CAPACITY, false);
        (, uint256 fee) = mv.quote(authId, K, 1e18);
        uint256 backstop0 = backstop.totalAssets();
        vm.prank(buyer);
        mv.buy(authId, K, 1e18, type(uint256).max);

        assertEq(mv.insuranceFund(), fee * 5000 / 1e4, "50% insurance");
        assertEq(backstop.totalAssets() - backstop0, fee * 3000 / 1e4, "30% backstop");
        uint256 daoShare = fee - fee * 5000 / 1e4 - fee * 3000 / 1e4;
        assertEq(mv.claimable(owner), daoShare, "20% DAO, pull-claimed");
        uint256 o0 = usdc.balanceOf(owner);
        mv.claim();
        assertEq(usdc.balanceOf(owner) - o0, daoShare);
        assertEq(mv.claimable(owner), 0);
        vm.expectRevert(MarginVault.NothingToClaim.selector);
        mv.claim();
    }

    function test_buy_secondWriterSharesTheSeries() public {
        uint256 a1 = _openAndShip(CAPACITY, false);
        address lp2 = address(0xA11CE2);
        usdc.mint(lp2, CAPACITY);
        vm.startPrank(lp2);
        usdc.approve(address(aqua), type(uint256).max);
        uint256 a2 = mv.openRange(2500e18, 3500e18, expiry, CAPACITY, 0, false, 0);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = mv.getShipParams(a2);
        aqua.ship(app, strategy, tokens, amounts);
        vm.stopPrank();

        vm.startPrank(buyer);
        (address t1,) = mv.buy(a1, K, 1e18, type(uint256).max);
        (address t2,) = mv.buy(a2, K, 2e18, type(uint256).max);
        vm.stopPrank();
        assertEq(t1, t2, "one OptionToken per (strike, expiry), whoever wrote it");
        (,,, uint256 sUnits, uint256 sCount,,,,,,,) = mv.seriesOf(mv.seriesId(K, expiry));
        assertEq(sUnits, 3e18);
        assertEq(sCount, 2);
        assertEq(mv.nakedNotional(), 4500e6);
    }

    function test_buy_nakedCeilingBinds() public {
        uint256 authId = _openAndShip(CAPACITY, false);
        mv.setNotionalCeiling(100_000e6); // the backstop-coupled one is 7 x 25k = 175k, so the owner's binds
        // 50 ATM units = 75k naked: fine. 100 = 150k: not.
        vm.prank(buyer);
        mv.buy(authId, K, 50e18, type(uint256).max);
        assertEq(mv.nakedNotional(), 75_000e6);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(MarginVault.NakedCeiling.selector, 150_000e6, 100_000e6));
        mv.buy(authId, K, 50e18, type(uint256).max);

        // Shrinking the backstop shrinks the ceiling under existing exposure:
        // nothing new fills until it is refilled.
        vm.prank(address(mv));
        backstop.draw(20_000e6);
        assertLt(mv.effectiveCeiling(), mv.nakedNotional(), "ceiling now sits under existing exposure");
        vm.prank(buyer);
        vm.expectRevert();
        mv.buy(authId, K, 1e18, type(uint256).max);
    }

    function test_buy_usesLpMarginBpsWhenHigher() public {
        vm.prank(lp);
        uint256 authId = mv.openRange(2500e18, 3500e18, expiry, CAPACITY, 8000, false, 0);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = mv.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);

        assertEq(mv.initialMargin(authId, K, 1e18), 2400e6, "writer opted to post 80% of notional");
        vm.prank(buyer);
        mv.buy(authId, K, 1e18, type(uint256).max);
        assertEq(mv.nakedNotional(), 600e6);
    }

    function test_buy_revertsOnStaleMark() public {
        uint256 authId = _openAndShip(CAPACITY, false);
        vm.warp(block.timestamp + 91 minutes);
        vm.prank(buyer);
        vm.expectRevert(MarginVault.StaleMark.selector);
        mv.buy(authId, K, 1e18, type(uint256).max);
    }

    function test_buy_guards() public {
        uint256 authId = _openAndShip(CAPACITY, false);
        vm.startPrank(buyer);
        vm.expectRevert(MarginVault.StrikeOutOfRange.selector);
        mv.buy(authId, 4000e18, 1e18, type(uint256).max);
        vm.expectRevert(MarginVault.PremiumAboveMax.selector);
        mv.buy(authId, K, 1e18, 1);
        vm.warp(expiry - 2 hours);
        vm.expectRevert(MarginVault.TooCloseToExpiry.selector);
        mv.buy(authId, K, 1e18, type(uint256).max);
        vm.stopPrank();

        vm.prank(lp);
        mv.closeRange(authId);
        vm.prank(buyer);
        vm.expectRevert(MarginVault.RangeInactive.selector);
        mv.buy(authId, K, 1e18, type(uint256).max);
    }

    function test_openRange_validation() public {
        vm.startPrank(lp);
        vm.expectRevert(MarginVault.InvalidRange.selector);
        mv.openRange(3500e18, 2500e18, expiry, CAPACITY, 0, false, 0);
        vm.expectRevert(MarginVault.ExpiryInPast.selector);
        mv.openRange(2500e18, 3500e18, block.timestamp, CAPACITY, 0, false, 0);
        vm.expectRevert(MarginVault.ZeroCapacity.selector);
        mv.openRange(2500e18, 3500e18, expiry, 0, 0, false, 0);
        vm.stopPrank();

        vm.prank(buyer);
        vm.expectRevert(MarginVault.NotLp.selector);
        mv.closeRange(0);
    }
}
