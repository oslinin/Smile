// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IPriceOracle } from "@1inch/swap-vm/src/instructions/interfaces/IPriceOracle.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

import { SpreadVault } from "../src/periphery/SpreadVault.sol";
import { SmilePremiumLib } from "../src/periphery/SmilePremiumLib.sol";
import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice SpreadVault, test-first per docs/plans/2026-09-05-ethonline2026-continuation-track.md.
/// A1: the shipped Aqua strategy backs exactly the true max loss, settlement
/// wires once. A2: the shared premium library agrees with the main vault to
/// the wei, and a spread quote is Ask(long leg) − Bid(short leg).
contract SpreadVaultTest is Test {
    Aqua aqua;
    SpreadVault spread;
    AquaCollateralVault vault;
    SmileSwapVMRouter router;
    MockV3Aggregator oracle;
    MockERC20 weth;
    MockERC20 usdc;

    address owner = address(this);
    address lp = address(0xA11CE);

    uint256 constant K1 = 3000e18;
    uint256 constant K2 = 3200e18;
    // S12 table: call credit escrow = (K2-K1)/K2 WETH per unit
    uint256 constant ESCROW_WETH = (K2 - K1) * 1e18 / K2;
    uint256 expiry;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 3000e8);

        spread = new SpreadVault(address(aqua), address(oracle), address(0), owner, address(weth), address(usdc));
        spread.setPricingDefaults(50, 25, 0.001e18);
        spread.setProtocolFee(0.01e9, owner);

        // The main vault, so A2 can prove the library reproduces its quotes.
        router = new SmileSwapVMRouter(address(aqua), address(weth), owner);
        vault = new AquaCollateralVault(
            address(aqua), payable(address(router)), address(oracle), owner, address(new OptionTokenFactory())
        );
        vault.setPricingDefaults(50, 25, 0.001e18);
        vault.setProtocolFee(0.01e9, owner);

        expiry = block.timestamp + 30 days;
    }

    function _openAndShip(uint256 maxCollateral) internal returns (uint256 authId) {
        uint256[4] memory strikes;
        strikes[2] = K1;
        strikes[3] = K2;

        weth.mint(lp, maxCollateral);
        vm.startPrank(lp);
        authId = spread.openStructure(SpreadVault.Kind.CallCredit, strikes, expiry, maxCollateral);
        weth.approve(address(aqua), maxCollateral);
        vm.stopPrank();

        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            spread.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);
    }

    // ── A1 ───────────────────────────────────────────────────────────────────

    function test_open_shipHashMatchesAqua() public {
        uint256 authId = _openAndShip(ESCROW_WETH);

        // Struct getters skip array members (`strikes`), so the tuple here
        // is (lp, kind, expiry, maxCollateral, active, strategyHash, feeBps, feeRecipient).
        (,,,, , bytes32 strategyHash,,) = spread.structures(authId);
        (uint248 balance,) = aqua.rawBalances(lp, address(spread), strategyHash, address(weth));
        assertEq(balance, ESCROW_WETH, "Aqua backs exactly the true max loss, not a full WETH");

        assertEq(weth.balanceOf(address(spread)), 0, "collateral stays in the LP wallet until a real pull");
    }

    function test_setSettlement_onlyOnce() public {
        AquaOptionSettlement settlement = new AquaOptionSettlement(address(0), owner, address(oracle));
        spread.setSettlement(address(settlement));
        assertEq(spread.settlement(), address(settlement));

        AquaOptionSettlement other = new AquaOptionSettlement(address(0), owner, address(oracle));
        vm.expectRevert(SpreadVault.AlreadySet.selector);
        spread.setSettlement(address(other));
    }

    function test_openStructure_revertsOnBadStrikes() public {
        uint256[4] memory strikes;
        strikes[2] = K2; // K1 > K2 — invalid
        strikes[3] = K1;
        vm.expectRevert(SpreadVault.InvalidStrikes.selector);
        spread.openStructure(SpreadVault.Kind.CallCredit, strikes, expiry, ESCROW_WETH);
    }

    // ── A2 ───────────────────────────────────────────────────────────────────

    /// @dev The library is the vault's put math lifted out verbatim. Built
    /// from the vault's own public getters, it must reproduce `putQuote` to
    /// the wei — with the R3 staleness slope and the fee gross-up both live,
    /// so every hardening layer is actually exercised, not just the base case.
    function test_quote_putLegMatchesVaultPutQuote() public {
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(2500e18, 3500e18, expiry, 100_000e6, address(usdc), address(usdc), false);
        vm.warp(block.timestamp + 20 minutes);

        (,,, uint256 exp,,,,,,, address sigmaSource, uint8 premiumDecimals,, int256 beta, uint16 spotStaleness, uint32 feeBps,) =
            vault.authorizations(authId);
        (uint16 baseSpreadBps, uint16 stalenessSpreadBpsPerHour, uint64 impactPerUnit, uint16 sigmaMulBps,,,) =
            vault.pricingOf(authId);
        (uint256 spotWad, uint256 ageSec) = SmilePremiumLib.readSpot(IPriceOracle(address(oracle)), spotStaleness);

        SmilePremiumLib.Terms memory t = SmilePremiumLib.Terms({
            spotWad: spotWad,
            ageSec: ageSec,
            strike: 3000e18,
            expiry: exp,
            sigmaSource: sigmaSource,
            beta: beta,
            sigmaMulBps: sigmaMulBps,
            baseSpreadBps: baseSpreadBps,
            stalenessSpreadBpsPerHour: stalenessSpreadBpsPerHour,
            impactPerUnit: impactPerUnit,
            isCall: false
        });

        (uint256 libPremium, uint256 libFee) = SmilePremiumLib.quote(t, 1e18, true, premiumDecimals, feeBps);
        (uint256 vaultPremium, uint256 vaultFee) = vault.putQuote(authId, 3000e18, 1e18);

        assertEq(libPremium, vaultPremium, "library Ask == vault.putQuote, to the wei");
        assertEq(libFee, vaultFee, "fee gross-up identical");
        assertGt(ageSec, 0, "staleness slope actually exercised");
        assertGt(libFee, 0, "fee path actually exercised");
    }

    function test_quote_spreadIsAskMinusBid() public {
        uint256 authId = _openAndShip(ESCROW_WETH);
        vm.warp(block.timestamp + 20 minutes);

        (uint256 premium, uint256 fee, uint256 escrow) = spread.quote(authId, 1e18);

        (uint16 baseSpreadBps, uint16 stalenessSpreadBpsPerHour, uint64 impactPerUnit, uint16 sigmaMulBps, uint16 spotStaleness, int256 beta) =
            spread.pricingOf(authId);
        (uint256 spotWad, uint256 ageSec) = SmilePremiumLib.readSpot(IPriceOracle(address(oracle)), spotStaleness);
        SmilePremiumLib.Terms memory t = SmilePremiumLib.Terms({
            spotWad: spotWad,
            ageSec: ageSec,
            strike: K1,
            expiry: expiry,
            sigmaSource: address(0),
            beta: beta,
            sigmaMulBps: sigmaMulBps,
            baseSpreadBps: baseSpreadBps,
            stalenessSpreadBpsPerHour: stalenessSpreadBpsPerHour,
            impactPerUnit: impactPerUnit,
            isCall: true
        });
        (uint256 ask,) = SmilePremiumLib.quote(t, 1e18, true, 6, 0);
        t.strike = K2;
        (uint256 bid,) = SmilePremiumLib.quote(t, 1e18, false, 6, 0);

        assertGt(ask, bid, "the lower-strike call is worth more");
        assertEq(premium, ask - bid, "taker pays Ask on the long leg, receives Bid on the short leg");
        assertEq(fee, Math.ceilDiv(premium * 0.01e9, BPS - 0.01e9), "fee is the gross-up on the net premium");
        assertEq(escrow, ESCROW_WETH, "escrow is the S12 true max loss for one unit");
    }
}
