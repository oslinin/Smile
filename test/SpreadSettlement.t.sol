// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { SpreadVault } from "../src/periphery/SpreadVault.sol";
import { SpreadToken } from "../src/periphery/SpreadToken.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice A4: settle, redeem, reclaim. The S12 property under test is
/// conservation — `holder payout + writer reclaim == escrow` to the wei,
/// with the escrow cap never binding, at OTM, ITM, and the pin at K2.
contract SpreadSettlementTest is Test {
    Aqua aqua;
    SpreadVault spread;
    AquaOptionSettlement settlement;
    MockV3Aggregator oracle;
    MockERC20 weth;
    MockERC20 usdc;

    address owner = address(this);
    address lp = address(0xA11CE);
    address buyer = address(0xB0B);

    uint256 constant K1 = 3000e18;
    uint256 constant K2 = 3200e18;
    uint256 constant UNITS = 1e18;
    uint256 constant ESCROW_WETH = (K2 - K1) * 1e18 / K2; // 0.0625 WETH for one unit
    uint256 constant ESCROW_USDC = 200e6;
    uint256 expiry;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 3000e8);

        spread = new SpreadVault(address(aqua), address(oracle), address(0), owner, address(weth), address(usdc));
        spread.setPricingDefaults(50, 25, 0.001e18);
        // The test acts as the CRE forwarder so it can write any settlement price.
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(spread));
        spread.setSettlement(address(settlement));

        expiry = block.timestamp + 30 days;
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(spread), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _openShipBuyCall() internal returns (uint256 authId, address token) {
        uint256[4] memory strikes;
        strikes[2] = K1;
        strikes[3] = K2;
        weth.mint(lp, ESCROW_WETH);
        vm.startPrank(lp);
        authId = spread.openStructure(SpreadVault.Kind.CallCredit, strikes, expiry, ESCROW_WETH);
        weth.approve(address(aqua), ESCROW_WETH);
        vm.stopPrank();
        _ship(authId);
        vm.prank(buyer);
        (token,) = spread.buy(authId, UNITS, type(uint256).max);
    }

    function _openShipBuyPut() internal returns (uint256 authId, address token) {
        uint256[4] memory strikes;
        strikes[0] = K1;
        strikes[1] = K2;
        usdc.mint(lp, ESCROW_USDC);
        vm.startPrank(lp);
        authId = spread.openStructure(SpreadVault.Kind.PutCredit, strikes, expiry, ESCROW_USDC);
        usdc.approve(address(aqua), ESCROW_USDC);
        vm.stopPrank();
        _ship(authId);
        vm.prank(buyer);
        (token,) = spread.buy(authId, UNITS, type(uint256).max);
    }

    function _ship(uint256 authId) internal {
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            spread.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);
    }

    function _settle(uint256 authId, uint256 priceWad) internal {
        vm.warp(expiry);
        settlement.settleSeries(spread.seriesId(authId), priceWad);
    }

    // ── call credit ──────────────────────────────────────────────────────────

    /// @dev Pin at K2 — the structure's max-loss point. The holder is owed
    /// exactly the escrow, with zero shortfall; the writer has nothing left.
    function test_redeem_pinAtK2_holderGetsExactlyTheEscrow() public {
        (uint256 authId, address token) = _openShipBuyCall();
        _settle(authId, K2);

        uint256 buyerBefore = weth.balanceOf(buyer);
        vm.prank(buyer);
        uint256 payout = spread.redeem(authId, UNITS);

        assertEq(payout, ESCROW_WETH, "pin at K2 pays out the full (K2-K1)/K2 escrow, to the wei");
        assertEq(weth.balanceOf(buyer) - buyerBefore, payout);
        assertEq(SpreadToken(token).balanceOf(buyer), 0, "burned");

        vm.prank(lp);
        vm.expectRevert(SpreadVault.NothingToReclaim.selector);
        spread.reclaim(authId);
    }

    /// @dev Between the strikes: writer reclaims first, holder redeems the
    /// remainder — the two must sum to the escrow exactly.
    function test_conservation_reclaimThenRedeem() public {
        (uint256 authId, address token) = _openShipBuyCall();
        _settle(authId, 3100e18);

        vm.prank(lp);
        uint256 reclaimed = spread.reclaim(authId);
        vm.prank(buyer);
        uint256 payout = spread.redeem(authId, UNITS);

        assertEq(payout + reclaimed, ESCROW_WETH, "holder payout + writer reclaim == escrow");
        assertEq(payout, (UNITS * (3100e18 - K1)) / 3100e18, "net intrinsic (S-K1)/S per unit");
        assertEq(weth.balanceOf(address(spread)), 0, "vault holds nothing after both sides settle");
        assertEq(SpreadToken(token).totalSupply(), 0);
    }

    /// @dev Same numbers in the other order.
    function test_conservation_redeemThenReclaim() public {
        (uint256 authId,) = _openShipBuyCall();
        _settle(authId, 3100e18);

        vm.prank(buyer);
        uint256 payout = spread.redeem(authId, UNITS);
        vm.prank(lp);
        uint256 reclaimed = spread.reclaim(authId);

        assertEq(payout + reclaimed, ESCROW_WETH);
        assertEq(weth.balanceOf(address(spread)), 0);
    }

    /// @dev Fuzz the settlement price across OTM, between the strikes, and
    /// far ITM: payout matches the single floored S12 expression and the
    /// escrow cap never binds.
    function test_redeem_matchesFormula(uint256 s) public {
        s = bound(s, 1500e18, 6400e18);
        (uint256 authId,) = _openShipBuyCall();
        _settle(authId, s);

        vm.prank(buyer);
        uint256 payout = spread.redeem(authId, UNITS);

        uint256 c = s < K1 ? K1 : s > K2 ? K2 : s;
        uint256 expected = (UNITS * (c - K1)) / s;
        assertEq(payout, expected, "payout == units * (clamp(S,K1,K2) - K1) / S");
        assertLe(payout, ESCROW_WETH, "escrow always covers the payout");
        if (s <= K1) assertEq(payout, 0, "OTM burns for zero");
    }

    function test_redeem_otm_writerReclaimsEverything() public {
        (uint256 authId,) = _openShipBuyCall();
        _settle(authId, 2900e18);

        vm.prank(buyer);
        assertEq(spread.redeem(authId, UNITS), 0);
        vm.prank(lp);
        assertEq(spread.reclaim(authId), ESCROW_WETH, "OTM: the whole escrow comes back");
    }

    // ── put credit ───────────────────────────────────────────────────────────

    function test_putCredit_belowK1_holderGetsTheFull200() public {
        (uint256 authId,) = _openShipBuyPut();
        _settle(authId, 2500e18);

        vm.prank(buyer);
        uint256 payout = spread.redeem(authId, UNITS);
        assertEq(payout, ESCROW_USDC, "max loss K2-K1 = 200 USDC, exactly the escrow");
    }

    function test_putCredit_betweenStrikes_conserves() public {
        (uint256 authId,) = _openShipBuyPut();
        _settle(authId, 3050e18);

        vm.prank(buyer);
        uint256 payout = spread.redeem(authId, UNITS);
        vm.prank(lp);
        uint256 reclaimed = spread.reclaim(authId);

        assertEq(payout, (UNITS * (K2 - 3050e18)) / 1e30, "K2 - S per unit, in USDC");
        assertEq(payout + reclaimed, ESCROW_USDC);
    }

    function test_putCredit_aboveK2_holderGetsZero() public {
        (uint256 authId,) = _openShipBuyPut();
        _settle(authId, 3300e18);

        vm.prank(buyer);
        assertEq(spread.redeem(authId, UNITS), 0);
        vm.prank(lp);
        assertEq(spread.reclaim(authId), ESCROW_USDC);
    }

    // ── guards ───────────────────────────────────────────────────────────────

    function test_redeem_revertsBeforeSettlement() public {
        (uint256 authId,) = _openShipBuyCall();
        vm.prank(buyer);
        vm.expectRevert(SpreadVault.NotSettled.selector);
        spread.redeem(authId, UNITS);
    }

    function test_reclaim_onlyLp() public {
        (uint256 authId,) = _openShipBuyCall();
        _settle(authId, 3100e18);
        vm.prank(buyer);
        vm.expectRevert(SpreadVault.NotLp.selector);
        spread.reclaim(authId);
    }
}
