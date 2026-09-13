// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { SpreadVault } from "../src/periphery/SpreadVault.sol";
import { SpreadToken } from "../src/periphery/SpreadToken.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";
import { MockERC20 } from "./SpreadVault.t.sol";

/// @notice Iron condor as a single cash-settled structure: escrow is the WIDER
/// wing, not the sum of two spreads; premium is the sum of both wings; at
/// settlement at most one wing pays, capped at the escrow.
contract SpreadCondorTest is Test {
    Aqua aqua;
    SpreadVault spread;   // cash-settled (no WETH)
    SpreadVault wethSpread; // WETH vault, to prove condors are rejected there
    AquaOptionSettlement settlement;
    MockV3Aggregator oracle;
    MockERC20 usdc;
    MockERC20 weth;

    address owner = address(this);
    address lp = address(0xA11CE);
    address buyer = address(0xB0B);

    // long put 2400 < short put 2600 <= short call 2800 < long call 3300
    // put wing = 200, call wing = 500 → escrow = max = 500 USDC per unit.
    uint256 constant K0 = 2400e18;
    uint256 constant K1 = 2600e18;
    uint256 constant K2 = 2800e18;
    uint256 constant K3 = 3300e18;
    uint256 constant UNITS = 1e18;
    uint256 constant WIDER = 500e6; // max(200, 500) USDC
    uint256 expiry;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 2700e8);

        spread = new SpreadVault(address(aqua), address(oracle), address(0), owner, address(0), address(usdc));
        spread.setPricingDefaults(50, 25, 0.001e18);
        spread.setProtocolFee(0.01e9, owner);
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(spread));
        spread.setSettlement(address(settlement));

        wethSpread = new SpreadVault(address(aqua), address(oracle), address(0), owner, address(weth), address(usdc));

        expiry = block.timestamp + 30 days;
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(spread), type(uint256).max);
    }

    function _strikes() internal pure returns (uint256[4] memory s) {
        s[0] = K0; s[1] = K1; s[2] = K2; s[3] = K3;
    }

    function _openShipBuy() internal returns (uint256 authId, address token) {
        usdc.mint(lp, WIDER);
        vm.startPrank(lp);
        authId = spread.openStructure(SpreadVault.Kind.IronCondor, _strikes(), expiry, WIDER);
        usdc.approve(address(aqua), WIDER);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = spread.getShipParams(authId);
        assertEq(tokens[0], address(usdc), "condor ships USDC");
        aqua.ship(app, strategy, tokens, amounts);
        vm.stopPrank();
        vm.prank(buyer);
        (token,) = spread.buy(authId, UNITS, type(uint256).max);
    }

    function test_condor_rejectedOnWethVault() public {
        vm.expectRevert(SpreadVault.CondorNeedsCashSettle.selector);
        wethSpread.openStructure(SpreadVault.Kind.IronCondor, _strikes(), block.timestamp + 30 days, WIDER);
    }

    function test_escrow_isWiderWingNotSum() public {
        (uint256 authId,) = _openShipBuy();
        (,, uint256 escrow) = spread.quote(authId, UNITS);
        assertEq(escrow, WIDER, "escrow is max(200,500)=500, not 700");
        (uint256 booked,) = spread.positions(spread.spreadTokens(authId), lp);
        assertEq(booked, WIDER);
        assertEq(usdc.balanceOf(address(spread)), WIDER, "exactly the wider wing pulled");
    }

    function test_premium_isSumOfWings() public {
        uint256 authId;
        vm.prank(lp);
        authId = spread.openStructure(SpreadVault.Kind.IronCondor, _strikes(), expiry, WIDER);
        (uint256 condorPrem,,) = spread.quote(authId, UNITS);
        // Both wings priced separately from the same surface must sum to it.
        vm.prank(lp);
        uint256 putId = spread.openStructure(SpreadVault.Kind.PutCredit, _strikes(), expiry, 200e6);
        (uint256 putPrem,,) = spread.quote(putId, UNITS);
        vm.prank(lp);
        uint256 callId = spread.openStructure(SpreadVault.Kind.CallCredit, _strikes(), expiry, 500e6);
        (uint256 callPrem,,) = spread.quote(callId, UNITS);
        // Sum, within the 1-USDC floor rounding (each quote floors at 1 USDC).
        assertApproxEqAbs(condorPrem, putPrem + callPrem, 1e6, "condor premium ~= put wing + call wing");
    }

    function _settle(uint256 authId, uint256 price) internal {
        vm.warp(expiry);
        settlement.settleSeries(spread.seriesId(authId), price);
    }

    function test_settle_putSideOnly() public {
        (uint256 authId,) = _openShipBuy();
        _settle(authId, 2450e18); // between K0 and K1 → put wing pays 2600-2450=150; call side 0
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        uint256 payout = spread.redeem(authId, UNITS);
        assertEq(payout, 150e6, "put wing intrinsic in USDC");
        assertEq(usdc.balanceOf(buyer) - before, payout);
    }

    function test_settle_callSideCappedAtEscrow() public {
        (uint256 authId,) = _openShipBuy();
        _settle(authId, 5000e18); // far above K3 → call wing maxes at 500, put 0
        vm.prank(buyer);
        assertEq(spread.redeem(authId, UNITS), WIDER, "call wing capped at the 500 escrow");
    }

    function test_settle_insideRange_zero_writerReclaimsAll() public {
        (uint256 authId,) = _openShipBuy();
        _settle(authId, 2700e18); // between K1 and K2 → both wings OTM
        vm.prank(buyer);
        assertEq(spread.redeem(authId, UNITS), 0, "inside the body: nothing owed");
        uint256 before = usdc.balanceOf(lp);
        vm.prank(lp);
        assertEq(spread.reclaim(authId), WIDER, "writer reclaims the whole escrow");
        assertEq(usdc.balanceOf(lp) - before, WIDER);
    }

    function test_conservation_putSide() public {
        (uint256 authId,) = _openShipBuy();
        _settle(authId, 2500e18); // put wing = 2600-2500 = 100
        vm.prank(buyer);
        uint256 holder = spread.redeem(authId, UNITS);
        vm.prank(lp);
        uint256 writer = spread.reclaim(authId);
        assertEq(holder + writer, WIDER, "holder + writer = escrow, to the wei");
    }
}
