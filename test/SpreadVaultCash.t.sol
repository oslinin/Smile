// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { SpreadVault } from "../src/periphery/SpreadVault.sol";
import { SpreadToken } from "../src/periphery/SpreadToken.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";
import { MockERC20 } from "./SpreadVault.t.sol";

/// @notice Cash-settled call credit spreads: a SpreadVault deployed with no
/// WETH (Arc — a USDC-native chain with no ether) escrows K2−K1 USDC per
/// unit for a call credit and settles the intrinsic in USDC. Max loss is the
/// same dollar amount as the WETH form; only the numéraire changes.
contract SpreadVaultCashTest is Test {
    Aqua aqua;
    SpreadVault spread;
    AquaOptionSettlement settlement;
    MockV3Aggregator oracle;
    MockERC20 usdc;

    address owner = address(this);
    address lp = address(0xA11CE);
    address buyer = address(0xB0B);

    uint256 constant K1 = 3000e18;
    uint256 constant K2 = 3200e18;
    uint256 constant UNITS = 1e18;
    uint256 constant ESCROW_USDC = 200e6; // K2-K1 dollars per unit
    uint256 expiry;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 3000e8);

        spread = new SpreadVault(address(aqua), address(oracle), address(0), owner, address(0), address(usdc));
        spread.setPricingDefaults(50, 25, 0.001e18);
        spread.setProtocolFee(0.01e9, owner);
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(spread));
        spread.setSettlement(address(settlement));

        expiry = block.timestamp + 30 days;
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(spread), type(uint256).max);
    }

    function _openShipBuyCall() internal returns (uint256 authId, address token) {
        uint256[4] memory strikes;
        strikes[2] = K1;
        strikes[3] = K2;
        usdc.mint(lp, ESCROW_USDC);
        vm.startPrank(lp);
        authId = spread.openStructure(SpreadVault.Kind.CallCredit, strikes, expiry, ESCROW_USDC);
        usdc.approve(address(aqua), ESCROW_USDC);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            spread.getShipParams(authId);
        assertEq(tokens[0], address(usdc), "the shipped strategy is denominated in USDC");
        aqua.ship(app, strategy, tokens, amounts);
        vm.stopPrank();
        vm.prank(buyer);
        (token,) = spread.buy(authId, UNITS, type(uint256).max);
    }

    function test_cashCalls_flagFollowsMissingWeth() public view {
        assertTrue(spread.cashSettledCalls());
    }

    function test_buy_callCreditPullsK2minusK1Usdc() public {
        (uint256 authId, address token) = _openShipBuyCall();
        (,, uint256 escrow) = spread.quote(authId, UNITS);
        assertEq(escrow, ESCROW_USDC, "quote escrows K2-K1 USDC per unit");
        // LP was minted exactly 200 USDC: all of it pulled, only the net premium remains.
        (uint256 premium,,) = spread.quote(authId, UNITS);
        assertEq(usdc.balanceOf(lp), premium, "exactly 200 USDC pulled from the writer");
        (uint256 booked, address collateralToken) = spread.positions(token, lp);
        assertEq(booked, ESCROW_USDC);
        assertEq(collateralToken, address(usdc));
    }

    function test_redeem_betweenStrikes_paysIntrinsicInUsdc() public {
        (uint256 authId,) = _openShipBuyCall();
        vm.warp(expiry);
        settlement.settleSeries(spread.seriesId(authId), 3100e18);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        uint256 payout = spread.redeem(authId, UNITS);
        assertEq(payout, 100e6, "S=3100: holder gets (3100-3000) USDC");
        assertEq(usdc.balanceOf(buyer) - buyerBefore, payout);

        uint256 lpBefore = usdc.balanceOf(lp);
        vm.prank(lp);
        uint256 back = spread.reclaim(authId);
        assertEq(back, 100e6, "writer reclaims the other half");
        assertEq(usdc.balanceOf(lp) - lpBefore, back);
    }

    function test_redeem_pinAtK2_holderGetsTheWholeEscrow() public {
        (uint256 authId,) = _openShipBuyCall();
        vm.warp(expiry);
        settlement.settleSeries(spread.seriesId(authId), 5000e18);
        vm.prank(buyer);
        assertEq(spread.redeem(authId, UNITS), ESCROW_USDC, "capped at K2-K1: max loss is the escrow, no more");
    }
}
