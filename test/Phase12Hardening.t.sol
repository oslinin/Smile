// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { SmileQuoteLens } from "../src/periphery/SmileQuoteLens.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { OptionToken } from "../src/OptionToken.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";
import { MockPyth } from "../src/mocks/MockPyth.sol";
import { PythSpotAdapter } from "../src/oracles/PythSpotAdapter.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Phase 1–2 hardening (docs/solutions.md): staleness-scaled spread
/// (R3/R4), size-convex pricing (R2), per-block caps (R1), firmness bond +
/// reliability counters (S2/S3), LP-quoted vol + best-quote routing (S5/S6),
/// and the Pyth pull-oracle quoting adapter (R5).
contract Phase12HardeningTest is Test {
    Aqua aqua;
    SmileSwapVMRouter router;
    AquaCollateralVault vault;
    OptionTokenFactory tokenFactory;
    SmileQuoteLens lens;
    MockV3Aggregator oracle;
    MockERC20 usdc;
    MockERC20 weth;

    address owner  = address(this);
    address lp     = address(0x1111);
    address lp2    = address(0x3333);
    address buyer  = address(0x2222);

    uint256 constant STRIKE     = 3000e18;
    uint256 constant STRIKE_MIN = 2500e18;
    uint256 constant STRIKE_MAX = 3500e18;
    uint256 expiry;

    function setUp() public {
        usdc   = new MockERC20("USD Coin", "USDC", 6);
        weth   = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua   = new Aqua();
        router = new SmileSwapVMRouter(address(aqua), address(weth), owner);
        oracle = new MockV3Aggregator(8, 3000e8);
        tokenFactory = new OptionTokenFactory();
        vault  = new AquaCollateralVault(address(aqua), payable(address(router)), address(oracle), owner, address(tokenFactory));
        lens   = new SmileQuoteLens(address(vault), payable(address(router)), address(aqua), address(0));
        expiry = block.timestamp + 30 days;

        usdc.mint(buyer, 10_000_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(vault), type(uint256).max);
        usdc.approve(address(lens), type(uint256).max); // buyBest routes premium via the lens
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _authorizeCallAs(address lpAddr, uint256 maxCollateral, uint128 maxBlockNotional, uint16 sigmaMulBps)
        internal
        returns (uint256 authId)
    {
        weth.mint(lpAddr, maxCollateral);
        vm.startPrank(lpAddr);
        weth.approve(address(vault), type(uint256).max); // S2 bond, if enabled
        authId = vault.authorizeRange(
            STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(weth), address(usdc), true,
            maxBlockNotional, sigmaMulBps
        );
        weth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        _ship(lpAddr, authId);
    }

    function _authorizePutAs(address lpAddr, uint256 maxCollateral, uint16 sigmaMulBps)
        internal
        returns (uint256 authId)
    {
        usdc.mint(lpAddr, maxCollateral);
        vm.startPrank(lpAddr);
        usdc.approve(address(vault), type(uint256).max);
        authId = vault.authorizeRange(
            STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(usdc), address(usdc), false,
            0, sigmaMulBps
        );
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        _ship(lpAddr, authId);
    }

    function _ship(address lpAddr, uint256 authId) internal {
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            vault.getShipParams(authId);
        vm.prank(lpAddr);
        aqua.ship(app, strategy, tokens, amounts);
    }

    /// @dev Ask quote for a call range via the router, like the vault does.
    function _askCall(uint256 authId, uint256 strike, uint256 amount) internal returns (uint256 premium) {
        (premium,,) = router.quote(
            vault.buildOrder(authId), address(usdc), address(weth), amount, _takerData(false, strike)
        );
    }

    /// @dev Bid quote (reverse direction, exactIn units).
    function _bidCall(uint256 authId, uint256 strike, uint256 amount) internal returns (uint256 premium) {
        (, premium,) = router.quote(
            vault.buildOrder(authId), address(weth), address(usdc), amount, _takerData(true, strike)
        );
    }

    function _takerData(bool isExactIn, uint256 strike) internal view returns (bytes memory) {
        TakerTraitsLib.Args memory args;
        args.taker = address(this);
        args.isExactIn = isExactIn;
        args.isFirstTransferFromTaker = true;
        args.useTransferFromAndAquaPush = true;
        args.instructionsArgs = abi.encodePacked(strike);
        return TakerTraitsLib.build(args);
    }

    // ── R3/R4: staleness-scaled spread ───────────────────────────────────────

    function test_spread_askGrowsWithOracleAge() public {
        vault.setPricingDefaults(50, 25, 0); // 0.5% floor + 0.25%/h
        vault.setMaxSpotStaleness(0);        // isolate spread from the staleness cliff
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);

        uint256 askFresh = _askCall(authId, STRIKE, 1e18);
        vm.warp(block.timestamp + 4 hours);  // oracle answer now 4h old
        uint256 askStale = _askCall(authId, STRIKE, 1e18);

        assertGt(askStale, askFresh, "ask must widen as the oracle ages");
    }

    function test_spread_bidShrinksWithOracleAge() public {
        vault.setPricingDefaults(50, 25, 0);
        vault.setMaxSpotStaleness(0);
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);

        uint256 bidFresh = _bidCall(authId, STRIKE, 1e18);
        vm.warp(block.timestamp + 4 hours);
        uint256 bidStale = _bidCall(authId, STRIKE, 1e18);

        assertLt(bidStale, bidFresh, "bid must shrink as the oracle ages");
    }

    function test_spread_bidNeverExceedsAsk() public {
        vault.setPricingDefaults(50, 25, 0);
        vault.setMaxSpotStaleness(0);
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);

        uint256[3] memory strikes = [uint256(2600e18), STRIKE, uint256(3400e18)];
        for (uint256 w = 0; w < 3; w++) {
            for (uint256 s = 0; s < 3; s++) {
                assertLe(
                    _bidCall(authId, strikes[s], 1e18),
                    _askCall(authId, strikes[s], 1e18),
                    "bid above ask"
                );
            }
            vm.warp(block.timestamp + 12 hours);
        }
    }

    function test_spread_cappedAt20Percent() public {
        vault.setPricingDefaults(2000, 2000, 0); // absurd slope — must clamp
        vault.setMaxSpotStaleness(0);
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);

        vm.warp(block.timestamp + 100 hours);
        uint256 ask = _askCall(authId, STRIKE, 1e18);

        // Re-anchor: a zero-spread twin range quotes the raw premium.
        vault.setPricingDefaults(0, 0, 0);
        uint256 authId2 = _authorizeCallAs(lp2, 10e18, 0, 0);
        uint256 raw = _askCall(authId2, STRIKE, 1e18);

        // cap = +20% on the ask, plus rounding dust
        assertLe(ask, (raw * 12000) / 10000 + 2, "half-spread must cap at 20%");
    }

    function test_spread_settersRejectAboveCap() public {
        vm.expectRevert("spread too high");
        vault.setPricingDefaults(2001, 0, 0);
        vm.expectRevert("spread too high");
        vault.setPricingDefaults(0, 2001, 0);
    }

    function test_spread_putMirrorsCall() public {
        vault.setMaxSpotStaleness(0);
        vault.setPricingDefaults(0, 0, 0);
        uint256 flatAuth = _authorizePutAs(lp, 100_000e6, 0);
        uint256 putNoSpread = _putAsk(flatAuth, 1e18);

        // Retire the tighter zero-spread range so bestQuote sees only the new one.
        vm.prank(lp);
        vault.revokeAuthorization(flatAuth);

        vault.setPricingDefaults(100, 0, 0); // 1% half-spread floor
        uint256 putSpread = _putAsk(_authorizePutAs(lp2, 100_000e6, 0), 1e18);

        assertGt(putSpread, putNoSpread, "put ask must carry the spread too");
        // ~1% wider (ceil rounding on both layers adds dust)
        assertApproxEqRel(putSpread, (putNoSpread * 10100) / 10000, 0.001e18);
    }

    /// @dev Put Ask read through bestQuote (the vault's only external put quote).
    function _putAsk(uint256 authId, uint256 amount) internal returns (uint256) {
        (uint256 id, uint256 premium) = lens.bestQuote(STRIKE, expiry, false, amount);
        assertEq(id, authId, "quoted a different range");
        return premium;
    }

    // ── R2: size-convex pricing ──────────────────────────────────────────────

    function test_impact_perUnitAskIncreasesWithSize() public {
        vault.setPricingDefaults(0, 0, 0.02e18); // 2 vol-points per unit
        uint256 authId = _authorizeCallAs(lp, 100e18, 0, 0);

        uint256 askSmall = _askCall(authId, STRIKE, 1e18);
        uint256 askBig   = _askCall(authId, STRIKE, 10e18);

        // per-unit price of the 10-lot must exceed the 1-lot's
        assertGt(askBig / 10, askSmall, "large orders must pay their own impact");
    }

    function test_impact_perUnitBidDecreasesWithSize() public {
        vault.setPricingDefaults(0, 0, 0.02e18);
        uint256 authId = _authorizeCallAs(lp, 100e18, 0, 0);

        uint256 bidSmall = _bidCall(authId, STRIKE, 1e18);
        uint256 bidBig   = _bidCall(authId, STRIKE, 10e18);

        assertLt(bidBig / 10, bidSmall, "large sellbacks must eat their own impact");
    }

    function test_impact_bidFlooredNeverZeroForItm() public {
        vault.setPricingDefaults(0, 0, 1e18); // absurd: 100 vol-points per unit
        uint256 authId = _authorizeCallAs(lp, 100e18, 0, 0);

        // Deep ITM: intrinsic dominates; σ floor keeps the bid meaningful.
        uint256 bid = _bidCall(authId, 2600e18, 50e18);
        assertGt(bid, 0, "floored sigma must keep ITM bids positive");
    }

    function test_impact_zeroCoefficientIsSizeLinear() public {
        vault.setPricingDefaults(0, 0, 0);
        uint256 authId = _authorizeCallAs(lp, 100e18, 0, 0);

        uint256 ask1  = _askCall(authId, STRIKE, 1e18);
        uint256 ask10 = _askCall(authId, STRIKE, 10e18);
        assertApproxEqAbs(ask10, ask1 * 10, 10, "zero impact must stay size-linear");
    }

    function test_impact_exactInConsistentWithExactOut() public {
        vault.setPricingDefaults(0, 0, 0.02e18);
        uint256 authId = _authorizeCallAs(lp, 100e18, 0, 0);

        // exactOut: price 5 units. exactIn with that budget must buy ≈5 (never more).
        uint256 ask5 = _askCall(authId, STRIKE, 5e18);
        (, uint256 units,) = router.quote(
            vault.buildOrder(authId), address(usdc), address(weth), ask5, _takerData(true, STRIKE)
        );
        assertLe(units, 5e18 + 1e12, "exactIn must not out-buy exactOut");
        assertApproxEqRel(units, 5e18, 0.005e18);
    }

    // ── R1: per-block notional cap ───────────────────────────────────────────

    function test_blockCap_secondBuySameBlockReverts() public {
        uint256 authId = _authorizeCallAs(lp, 10e18, 1e18, 0); // 1 WETH per block

        vm.prank(buyer);
        vault.buy(authId, STRIKE, 0.7e18, type(uint256).max);

        vm.prank(buyer);
        vm.expectRevert("block cap");
        vault.buy(authId, STRIKE, 0.5e18, type(uint256).max);
    }

    function test_blockCap_resetsNextBlock() public {
        uint256 authId = _authorizeCallAs(lp, 10e18, 1e18, 0);

        vm.prank(buyer);
        vault.buy(authId, STRIKE, 0.7e18, type(uint256).max);

        vm.roll(block.number + 1);
        vm.prank(buyer);
        (address token,) = vault.buy(authId, STRIKE, 0.5e18, type(uint256).max);
        assertEq(OptionToken(token).balanceOf(buyer), 1.2e18);
    }

    function test_blockCap_zeroMeansUncapped() public {
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);
        vm.startPrank(buyer);
        vault.buy(authId, STRIKE, 4e18, type(uint256).max);
        vault.buy(authId, STRIKE, 4e18, type(uint256).max);
        vm.stopPrank();
    }

    // ── S2/S3: firmness bond + reliability counters ──────────────────────────

    function test_bond_collectedOnAuthorize_refundedOnRevoke() public {
        vault.setFirmnessBondBps(25); // 0.25%
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);

        uint256 expectedBond = (10e18 * 25) / 1e4;
        assertEq(vault.bondOf(authId), expectedBond);
        assertEq(weth.balanceOf(address(vault)), expectedBond);
        assertEq(weth.balanceOf(lp), 10e18 - expectedBond);

        vm.prank(lp);
        vault.revokeAuthorization(authId);
        assertEq(vault.bondOf(authId), 0);
        assertEq(weth.balanceOf(lp), 10e18, "honest exit refunds the bond in full");
    }

    function test_bond_settersRejectAboveCap() public {
        vm.expectRevert("bond too high");
        vault.setFirmnessBondBps(501);
    }

    function test_pullFailure_call_buyerCompensated_rangeDeactivated() public {
        vault.setFirmnessBondBps(25);
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);
        uint256 bond = vault.bondOf(authId);

        // The LP silently revokes Aqua's allowance — displayed depth is now phantom.
        vm.prank(lp);
        weth.approve(address(aqua), 0);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        (address token, uint256 paid) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        assertEq(token, address(0), "phantom fill must not mint");
        assertEq(paid, 0);
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore, "premium must be fully refunded");
        assertEq(weth.balanceOf(buyer), bond / 2, "buyer compensated from the bond");
        assertEq(vault.failedPulls(lp), 1);
        assertEq(vault.fills(lp), 0);
        (,,,,,,,, bool active,,,,,,,,) = vault.authorizations(authId);
        assertFalse(active, "phantom range must deactivate");
        assertEq(vault.bondOf(authId), 0);
    }

    function test_pullFailure_put_symmetric() public {
        vault.setFirmnessBondBps(25);
        uint256 authId = _authorizePutAs(lp, 100_000e6, 0);

        // The LP moves the backing USDC away after shipping. (Resolve the
        // balance BEFORE pranking — argument calls would consume the prank.)
        uint256 lpBal = usdc.balanceOf(lp);
        vm.prank(lp);
        usdc.transfer(address(0xdead), lpBal);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        (address token,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        assertEq(token, address(0));
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + (100_000e6 * 25) / 1e4 / 2, "refund + half bond");
        assertEq(vault.failedPulls(lp), 1);
    }

    function test_fills_incrementOnSuccess() public {
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);
        vm.prank(buyer);
        vault.buy(authId, STRIKE, 1e18, type(uint256).max);
        assertEq(vault.fills(lp), 1);
        assertEq(vault.failedPulls(lp), 0);
    }

    function test_slippageRevertDoesNotEatBond() public {
        vault.setFirmnessBondBps(25);
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);

        vm.prank(buyer);
        vm.expectRevert(); // threshold trips inside the VM quote — must REVERT, not compensate
        vault.buy(authId, STRIKE, 1e18, 1);

        assertEq(vault.bondOf(authId), (10e18 * 25) / 1e4, "bond untouched by slippage");
        (,,,,,,,, bool active,,,,,,,,) = vault.authorizations(authId);
        assertTrue(active);
    }

    function test_oversizedBuyStillReverts() public {
        vault.setFirmnessBondBps(25);
        uint256 authId = _authorizeCallAs(lp, 10e18, 0, 0);

        // Asking for more than the shipped range is a TAKER error: it must
        // revert (Aqua capacity underflow), never slash the honest LP's bond.
        vm.prank(buyer);
        vm.expectRevert();
        vault.buy(authId, STRIKE, 11e18, type(uint256).max);
        assertEq(vault.bondOf(authId), (10e18 * 25) / 1e4);
    }

    // ── S5: LP-quoted vol ────────────────────────────────────────────────────

    function test_sigmaMul_lowerVolQuotesCheaper() public {
        uint256 authDefault = _authorizeCallAs(lp, 10e18, 0, 0);      // protocol surface
        uint256 authCheap   = _authorizeCallAs(lp2, 10e18, 0, 8000);  // quotes 0.8x vol

        uint256 askDefault = _askCall(authDefault, STRIKE, 1e18);
        uint256 askCheap   = _askCall(authCheap, STRIKE, 1e18);
        assertLt(askCheap, askDefault, "0.8x vol must quote a cheaper ATM ask");
    }

    function test_sigmaMul_boundsEnforced() public {
        vm.startPrank(lp);
        vm.expectRevert("sigma mult out of bounds");
        vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 1e18, address(weth), address(usdc), true, 0, 999);
        vm.expectRevert("sigma mult out of bounds");
        vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 1e18, address(weth), address(usdc), true, 0, 30001);
        vm.stopPrank();
    }

    function test_sigmaMul_appliesToPuts() public {
        vault.setMaxSpotStaleness(0);
        uint256 putDefault = _putAskOf(_authorizePutAs(lp, 100_000e6, 0));
        uint256 putCheap   = _putAskOf(_authorizePutAs(lp2, 100_000e6, 8000));
        assertLt(putCheap, putDefault);
    }

    function _putAskOf(uint256 authId) internal returns (uint256 premium) {
        // Quote the specific range by asking bestQuote while the other is outbid:
        // simpler — read through a 1-unit buy simulation is overkill; bestQuote
        // over a single-candidate window: temporarily revoke nothing, so use
        // the fact that cheaper wins: capture both ids.
        (uint256 id, uint256 p) = lens.bestQuote(STRIKE, expiry, false, 1e18);
        if (id == authId) return p;
        // Not the best — revoke the winner and re-quote.
        address winnerLp = id == 0 ? lp : (id == 1 ? lp : lp2);
        (address storedLp,,,,,,,,,,,,,,,,) = vault.authorizations(id);
        vm.prank(storedLp);
        vault.revokeAuthorization(id);
        (uint256 id2, uint256 p2) = lens.bestQuote(STRIKE, expiry, false, 1e18);
        assertEq(id2, authId);
        winnerLp; // silence
        return p2;
    }

    // ── S6: best-quote routing ───────────────────────────────────────────────

    function test_bestQuote_picksCheapestRange() public {
        uint256 authDefault = _authorizeCallAs(lp, 10e18, 0, 0);
        uint256 authCheap   = _authorizeCallAs(lp2, 10e18, 0, 8000);

        (uint256 bestId, uint256 bestPremium) = lens.bestQuote(STRIKE, expiry, true, 1e18);
        assertEq(bestId, authCheap, "router must find the tighter vol quote");
        assertEq(bestPremium, _askCall(authCheap, STRIKE, 1e18));
        authDefault; // silence
    }

    function test_bestQuote_skipsPhantomDepth() public {
        uint256 authHonest  = _authorizeCallAs(lp, 10e18, 0, 0);
        uint256 authPhantom = _authorizeCallAs(lp2, 10e18, 0, 8000); // cheaper but…

        // …lp2 empties the wallet backing it (S1: soft liquidity).
        uint256 lp2Bal = weth.balanceOf(lp2);
        vm.prank(lp2);
        weth.transfer(address(0xdead), lp2Bal);

        (uint256 bestId,) = lens.bestQuote(STRIKE, expiry, true, 1e18);
        assertEq(bestId, authHonest, "phantom depth must be skipped, not quoted");
        authPhantom; // silence
    }

    function test_bestQuote_skipsExhaustedBlockCap() public {
        uint256 authCapped = _authorizeCallAs(lp, 10e18, 1e18, 8000);  // cheap, capped
        uint256 authOpen   = _authorizeCallAs(lp2, 10e18, 0, 0);

        vm.prank(buyer);
        vault.buy(authCapped, STRIKE, 1e18, type(uint256).max); // cap consumed

        (uint256 bestId,) = lens.bestQuote(STRIKE, expiry, true, 1e18);
        assertEq(bestId, authOpen, "block-capped range must be skipped this block");
    }

    function test_bestQuote_noCandidatesReturnsSentinel() public {
        (uint256 bestId, uint256 bestPremium) = lens.bestQuote(STRIKE, expiry, true, 1e18);
        assertEq(bestId, type(uint256).max);
        assertEq(bestPremium, type(uint256).max);
    }

    function test_buyBest_executesOnBestRange() public {
        _authorizeCallAs(lp, 10e18, 0, 0);
        uint256 authCheap = _authorizeCallAs(lp2, 10e18, 0, 8000);
        uint256 lp2WethBefore = weth.balanceOf(lp2);

        vm.prank(buyer);
        (address token, uint256 paid) = lens.buyBest(STRIKE, expiry, true, 1e18, type(uint256).max);

        assertEq(OptionToken(token).balanceOf(buyer), 1e18);
        assertEq(weth.balanceOf(lp2), lp2WethBefore - 1e18, "cheaper LP's collateral must be pulled");
        assertEq(paid, _askOfSeries(authCheap));
    }

    function _askOfSeries(uint256 authId) internal view returns (uint256) {
        // premium actually paid was quoted pre-trade; recompute is impossible
        // post-σ-bump (no hook wired here, so re-quote matches).
        authId;
        return usdc.balanceOf(lp2); // premium was Aqua-pushed straight to lp2's wallet
    }

    function test_buyBest_revertsWhenNothingQuotes() public {
        vm.prank(buyer);
        vm.expectRevert("no executable quote");
        lens.buyBest(STRIKE, expiry, true, 1e18, type(uint256).max);
    }

    // ── R5: Pyth pull-oracle adapter ─────────────────────────────────────────

    bytes32 constant ETH_USD_ID = keccak256("ETH/USD");

    function _pythSetup() internal returns (MockPyth pyth, PythSpotAdapter adapter, AquaCollateralVault pythVault) {
        pyth = new MockPyth();
        pyth.setPrice(ETH_USD_ID, 3000e8, -8, block.timestamp);
        adapter = new PythSpotAdapter(address(pyth), ETH_USD_ID, 8);
        pythVault = new AquaCollateralVault(address(aqua), payable(address(router)), address(adapter), owner, address(tokenFactory));
        pythVault.setMaxSpotStaleness(5); // seconds-tight: THE pull-oracle security parameter
        vm.prank(buyer);
        usdc.approve(address(pythVault), type(uint256).max);
    }

    function test_pyth_quotesThroughAdapter() public {
        (,, AquaCollateralVault pythVault) = _pythSetup();
        uint256 authId = _authorizeOn(pythVault, lp, 10e18);

        vm.prank(buyer);
        (address token, uint256 paid) = pythVault.buy(authId, STRIKE, 1e18, type(uint256).max);
        assertEq(OptionToken(token).balanceOf(buyer), 1e18);
        assertGt(paid, 0);
    }

    function test_pyth_tightFreshnessBoundEnforced() public {
        (MockPyth pyth,, AquaCollateralVault pythVault) = _pythSetup();
        uint256 authId = _authorizeOn(pythVault, lp, 10e18);

        vm.warp(block.timestamp + 6); // older than the 5s bound
        vm.prank(buyer);
        vm.expectRevert(); // stale publishTime must refuse to quote
        pythVault.buy(authId, STRIKE, 1e18, type(uint256).max);

        // Taker posts a fresh signed update in their own tx, then trades.
        bytes[] memory update = new bytes[](1);
        update[0] = abi.encode(ETH_USD_ID, int64(3005e8), int32(-8), block.timestamp);
        vm.deal(buyer, 1 ether);
        vm.startPrank(buyer);
        pyth.updatePriceFeeds{ value: 1 }(update);
        (address token,) = pythVault.buy(authId, STRIKE, 1e18, type(uint256).max);
        vm.stopPrank();
        assertEq(OptionToken(token).balanceOf(buyer), 1e18);
    }

    function test_pyth_adapterRejectsBadFeedState() public {
        MockPyth pyth = new MockPyth();
        PythSpotAdapter adapter = new PythSpotAdapter(address(pyth), ETH_USD_ID, 8);

        pyth.setPrice(ETH_USD_ID, -1, -8, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(PythSpotAdapter.BadPythPrice.selector, int64(-1)));
        adapter.latestRoundData();

        pyth.setPrice(ETH_USD_ID, 3000e8, -6, block.timestamp); // reconfigured expo
        vm.expectRevert(abi.encodeWithSelector(PythSpotAdapter.UnexpectedExponent.selector, int32(-6), uint8(8)));
        adapter.latestRoundData();
    }

    function test_pyth_refreshPostsUpdateAndRefunds() public {
        (MockPyth pyth, PythSpotAdapter adapter,) = _pythSetup();

        bytes[] memory update = new bytes[](1);
        update[0] = abi.encode(ETH_USD_ID, int64(3100e8), int32(-8), block.timestamp + 1);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        adapter.refresh{ value: 0.5 ether }(update);

        (, int256 answer,, uint256 updatedAt,) = adapter.latestRoundData();
        assertEq(answer, 3100e8);
        assertEq(updatedAt, block.timestamp + 1);
        assertEq(buyer.balance, 1 ether - pyth.updateFee(), "excess fee must refund");
    }

    function _authorizeOn(AquaCollateralVault v, address lpAddr, uint256 maxCollateral)
        internal
        returns (uint256 authId)
    {
        weth.mint(lpAddr, maxCollateral);
        vm.startPrank(lpAddr);
        weth.approve(address(v), type(uint256).max);
        authId = v.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(weth), address(usdc), true);
        weth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            v.getShipParams(authId);
        vm.prank(lpAddr);
        aqua.ship(app, strategy, tokens, amounts);
    }
}
