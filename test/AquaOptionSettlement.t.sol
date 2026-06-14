// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/vaults/AquaOptionSettlement.sol";
import "../src/OptionToken.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20b is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract AquaOptionSettlementTest is Test {
    AquaOptionSettlement settlement;
    OptionToken optionToken;
    MockERC20b usdc;

    address owner = address(this);
    address cre;
    address lp    = address(0x1111);
    address holder = address(0x2222);

    uint256 constant STRIKE = 2000e6;    // $2000 in USDC (6 dec)
    uint256 constant COLLATERAL = 2000e6; // 1 covered put: $2000 USDC
    bytes32 constant SID = keccak256("ETH-2000-CALL-DEC24");

    uint256 expiryTime;

    function setUp() public {
        cre = makeAddr("cre");
        vm.warp(1_000_000);
        expiryTime = block.timestamp + 30 days;

        usdc = new MockERC20b();
        settlement = new AquaOptionSettlement(cre, owner);

        optionToken = new OptionToken(
            "ETH-2000-CALL-DEC24", "oETH-C-2000",
            address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2),
            STRIKE, expiryTime, true, address(settlement)
        );

        // Give settlement the collateral and register the series
        usdc.mint(address(settlement), COLLATERAL);
        settlement.registerSeries(SID, expiryTime, STRIKE, COLLATERAL, address(usdc), address(optionToken), lp, COLLATERAL);

        // Mint option to holder (settlement is the optionToken owner)
        vm.prank(address(settlement));
        optionToken.mint(holder, 1e18);
    }

    // ── Commit 9: expiry guards ───────────────────────────────────────────────

    function test_settle_beforeExpiry_reverts() public {
        vm.prank(cre);
        vm.expectRevert("not yet expired");
        settlement.settleSeries(SID, 2500e6);
    }

    function test_settle_nonCRE_reverts() public {
        vm.warp(expiryTime + 1);
        vm.expectRevert("only CRE forwarder");
        settlement.settleSeries(SID, 2500e6);
    }

    function test_settle_doubleSettle_reverts() public {
        vm.warp(expiryTime + 1);
        vm.prank(cre);
        settlement.settleSeries(SID, 2500e6);

        vm.prank(cre);
        vm.expectRevert("already settled");
        settlement.settleSeries(SID, 2500e6);
    }

    // ── Commit 10: fully-collateralized payouts ───────────────────────────────

    // ITM: S > K → holder gets (S-K), LP gets remainder
    function test_ITM_holderPaid_LPGetsRemainder() public {
        uint256 spot = 2300e6; // $2300 > $2000 strike → ITM
        vm.warp(expiryTime + 1);
        vm.prank(cre);
        settlement.settleSeries(SID, spot);

        uint256 expectedPayout = spot - STRIKE; // $300 USDC

        vm.prank(holder);
        settlement.redeem(SID, 1e18);
        assertEq(usdc.balanceOf(holder), expectedPayout);

        vm.prank(lp);
        settlement.reclaimCollateral(SID);
        assertEq(usdc.balanceOf(lp), COLLATERAL - expectedPayout);

        // Zero contract liability
        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    // OTM: S <= K → LP reclaims 100%, holder gets 0
    function test_OTM_LPreclaims100pct() public {
        uint256 spot = 1800e6; // $1800 < $2000 strike → OTM
        vm.warp(expiryTime + 1);
        vm.prank(cre);
        settlement.settleSeries(SID, spot);

        vm.prank(holder);
        settlement.redeem(SID, 1e18);
        assertEq(usdc.balanceOf(holder), 0);

        vm.prank(lp);
        settlement.reclaimCollateral(SID);
        assertEq(usdc.balanceOf(lp), COLLATERAL);

        assertEq(usdc.balanceOf(address(settlement)), 0);
    }

    // ATM: S == K → 0 payout, LP reclaims all
    function test_ATM_LPreclaims100pct() public {
        vm.warp(expiryTime + 1);
        vm.prank(cre);
        settlement.settleSeries(SID, STRIKE);

        vm.prank(holder);
        settlement.redeem(SID, 1e18);
        assertEq(usdc.balanceOf(holder), 0);

        vm.prank(lp);
        settlement.reclaimCollateral(SID);
        assertEq(usdc.balanceOf(lp), COLLATERAL);
    }
}
