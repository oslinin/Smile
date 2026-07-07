// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";

import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

/// @notice The settlement contract is a slim expiry-price registry with two
/// settlement paths: the CRE forwarder (trusted, scheduled) and PERMISSIONLESS
/// Chainlink-round settlement — anyone may settle with the first feed round
/// at/after expiry, verified on-chain.
contract AquaOptionSettlementTest is Test {
    AquaOptionSettlement settlement;
    MockV3Aggregator feed;

    address cre       = address(0xC4E);
    address registrar = address(this);
    address anyone    = address(0xA11);

    bytes32 constant SERIES = keccak256("series-1");
    uint256 constant STRIKE = 3000e18;
    uint256 expiry;

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockV3Aggregator(8, 3000e8); // round 1, pre-expiry
        settlement = new AquaOptionSettlement(cre, address(this), address(feed));
        settlement.setRegistrar(registrar);
        expiry = block.timestamp + 30 days;
        settlement.registerSeries(SERIES, address(0xBEEF), expiry, STRIKE, true);
    }

    // ── registration ──────────────────────────────────────────────────────────

    function test_registerSeries_onlyRegistrar() public {
        vm.prank(anyone);
        vm.expectRevert("only registrar");
        settlement.registerSeries(keccak256("x"), address(1), expiry, STRIKE, true);
    }

    function test_registerSeries_duplicateReverts() public {
        vm.expectRevert("already registered");
        settlement.registerSeries(SERIES, address(0xBEEF), expiry, STRIKE, true);
    }

    function test_setRegistrar_onlyOnce() public {
        vm.expectRevert("already set");
        settlement.setRegistrar(anyone);
    }

    // ── CRE path ──────────────────────────────────────────────────────────────

    function test_settleSeries_onlyCRE() public {
        vm.warp(expiry + 1);
        vm.expectRevert("only CRE forwarder");
        settlement.settleSeries(SERIES, 3600e18);
    }

    function test_settleSeries_beforeExpiryReverts() public {
        vm.prank(cre);
        vm.expectRevert("not yet expired");
        settlement.settleSeries(SERIES, 3600e18);
    }

    function test_settleSeries_writesWadPriceOnce() public {
        vm.warp(expiry + 1);
        vm.prank(cre);
        settlement.settleSeries(SERIES, 3600e18);

        (,,,, bool settled, uint256 price) = settlement.series(SERIES);
        assertTrue(settled);
        assertEq(price, 3600e18);

        vm.prank(cre);
        vm.expectRevert("already settled");
        settlement.settleSeries(SERIES, 1e18);
    }

    // ── permissionless Chainlink-round path ──────────────────────────────────

    function test_settleWithChainlinkRound_anyoneCanSettle() public {
        vm.warp(expiry + 10);
        feed.setAnswer(3600e8); // round 2 — first round at/after expiry

        vm.prank(anyone); // no trusted role required
        settlement.settleWithChainlinkRound(SERIES, 2);

        (,,,, bool settled, uint256 price) = settlement.series(SERIES);
        assertTrue(settled);
        assertEq(price, 3600e18); // 8-dec feed normalized to WAD
    }

    function test_settleWithChainlinkRound_preExpiryRoundRejected() public {
        vm.warp(expiry + 10);
        feed.setAnswer(3600e8); // round 2

        // Round 1 was updated before expiry — cannot settle with it.
        vm.expectRevert("round before expiry");
        settlement.settleWithChainlinkRound(SERIES, 1);
    }

    function test_settleWithChainlinkRound_laterRoundRejected() public {
        vm.warp(expiry + 10);
        feed.setAnswer(3600e8); // round 2 — the bracketing round
        vm.warp(expiry + 20);
        feed.setAnswer(4000e8); // round 3 — later, more favorable for a call holder

        // Cherry-picking round 3 fails: its predecessor is already post-expiry.
        vm.expectRevert("not first round after expiry");
        settlement.settleWithChainlinkRound(SERIES, 3);

        // The bracketing round works.
        settlement.settleWithChainlinkRound(SERIES, 2);
        (,,,, bool settled, uint256 price) = settlement.series(SERIES);
        assertTrue(settled);
        assertEq(price, 3600e18);
    }

    function test_settleWithChainlinkRound_beforeExpiryReverts() public {
        vm.expectRevert("not yet expired");
        settlement.settleWithChainlinkRound(SERIES, 1);
    }

    function test_settleWithChainlinkRound_doubleSettleReverts() public {
        vm.warp(expiry + 10);
        feed.setAnswer(3600e8);
        settlement.settleWithChainlinkRound(SERIES, 2);

        vm.expectRevert("already settled");
        settlement.settleWithChainlinkRound(SERIES, 2);
    }

    function test_settleWithChainlinkRound_unknownSeriesReverts() public {
        vm.warp(expiry + 10);
        feed.setAnswer(3600e8);
        vm.expectRevert("unknown series");
        settlement.settleWithChainlinkRound(keccak256("nope"), 2);
    }
}
