// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

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
/// docs/plans/2026-09-05-ethonline2026-continuation-track.md.
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
