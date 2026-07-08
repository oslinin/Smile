// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { OptionPricingEngine } from "../src/swapvm/OptionPricingEngine.sol";
import { OptionToken } from "../src/OptionToken.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice End-to-end marketplace flow on the OFFICIAL 1inch Aqua protocol:
/// authorizeRange → Aqua.ship → buy (JIT pull + premium push) → close/dock.
contract AquaCollateralVaultTest is Test {
    Aqua aqua;
    SmileSwapVMRouter router;
    AquaCollateralVault vault;
    AquaOptionSettlement settlement;
    OptionPricingEngine engine;
    MockV3Aggregator oracle;
    MockERC20 usdc;
    MockERC20 weth;

    address owner = address(this);
    address lp    = address(0x1111);
    address buyer = address(0x2222);

    uint256 constant SPOT       = 3000e18;
    uint256 constant STRIKE     = 3000e18; // $3000 WAD
    uint256 constant STRIKE_MIN = 2500e18;
    uint256 constant STRIKE_MAX = 3500e18;
    uint256 constant SIGMA      = 0.8e18;
    uint256 expiry;

    function setUp() public {
        usdc   = new MockERC20("USD Coin", "USDC", 6);
        weth   = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua   = new Aqua();
        router = new SmileSwapVMRouter(address(aqua), address(weth), owner);
        engine = new OptionPricingEngine();
        oracle = new MockV3Aggregator(8, 3000e8);
        vault  = new AquaCollateralVault(address(aqua), payable(address(router)), address(oracle), owner);
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(vault));
        vault.setSettlement(address(settlement));
        expiry = block.timestamp + 30 days;

        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _authorizeCall(uint256 maxCollateral) internal returns (uint256 authId) {
        weth.mint(lp, maxCollateral);
        vm.startPrank(lp);
        authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(weth), address(usdc), true);
        // Allowance covers CUMULATIVE pulls (capacity restored by sellbacks can
        // be pulled again), so approve above maxCollateral — max here.
        weth.approve(address(aqua), type(uint256).max);
        // Premium-token allowance lets Aqua pull the Bid on sellbacks (close()).
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        _ship(authId);
    }

    function _authorizePut(uint256 maxCollateral) internal returns (uint256 authId) {
        usdc.mint(lp, maxCollateral);
        vm.startPrank(lp);
        authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(usdc), address(usdc), false);
        usdc.approve(address(aqua), maxCollateral);
        vm.stopPrank();
        _ship(authId);
    }

    /// @dev The LP activates a registered range on the official Aqua registry.
    function _ship(uint256 authId) internal {
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            vault.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);
    }

    /// @dev Expected Ask premium in USDC 6-dec — mirrors the VM instruction:
    /// engine per-unit quote (WAD) → ceil across amount → ceil to 6 decimals.
    function _expectedCallAskUsdc(uint256 strike, uint256 amount) internal view returns (uint256) {
        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: SPOT,
            strike: strike,
            expiry: expiry,
            sigmaGlobal: SIGMA,
            alpha: vault.ALPHA(),
            isBuy: true
        });
        uint256 costWad = Math.ceilDiv(amount * engine.quote(p), 1e18);
        return Math.ceilDiv(costWad, 1e12);
    }

    // ── authorizeRange ────────────────────────────────────────────────────────

    function test_authorizeRange_storesAuthorization() public {
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), address(usdc), true);

        (address storedLp, uint256 sMin, uint256 sMax, uint256 exp,,,, bool isCall, bool active,,,,,,,,) =
            vault.authorizations(authId);

        assertEq(storedLp, lp);
        assertEq(sMin, STRIKE_MIN);
        assertEq(sMax, STRIKE_MAX);
        assertEq(exp, expiry);
        assertTrue(isCall);
        assertTrue(active);
    }

    function test_authorizeRange_strategyHashMatchesOfficialOrderHash() public {
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), address(usdc), true);

        (,,,,,,,,,,,, bytes32 strategyHash,,,,) = vault.authorizations(authId);
        // The vault-stored hash IS the official SwapVM order hash for Aqua orders,
        // and matches the hash Aqua derives from the shipped strategy bytes.
        assertEq(strategyHash, router.hash(vault.buildOrder(authId)));
        (, bytes memory strategy,,) = vault.getShipParams(authId);
        assertEq(strategyHash, keccak256(strategy));
    }

    function test_authorizeRange_invalidRangeReverts() public {
        vm.prank(lp);
        vm.expectRevert("invalid range");
        vault.authorizeRange(STRIKE_MAX, STRIKE_MIN, expiry, 1e18, address(weth), address(usdc), true);
    }

    function test_authorizeRange_singleStrike() public {
        weth.mint(lp, 1e18);
        vm.startPrank(lp);
        uint256 authId = vault.authorizeRange(STRIKE, STRIKE, expiry, 1e18, address(weth), address(usdc), true);
        weth.approve(address(aqua), 1e18);
        vm.stopPrank();
        _ship(authId);

        vm.prank(buyer);
        vault.buy(authId, STRIKE, 1e18, type(uint256).max);
        assertEq(OptionToken(vault.optionTokens(authId, STRIKE)).balanceOf(buyer), 1e18);
    }

    function test_revokeAuthorization() public {
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), address(usdc), true);

        vm.prank(lp);
        vault.revokeAuthorization(authId);

        (,,,,,,,, bool active,,,,,,,,) = vault.authorizations(authId);
        assertFalse(active);
    }

    // ── buy (covered calls through official SwapVM) ──────────────────────────

    function test_buy_jitPullMintAndPremiumPush() public {
        uint256 maxCollateral = 5e18;
        uint256 authId = _authorizeCall(maxCollateral);
        uint256 amount = 1e18;

        // Before the match: collateral still sits in the LP wallet.
        assertEq(weth.balanceOf(lp), maxCollateral);
        assertEq(weth.balanceOf(address(vault)), 0);

        vm.prank(buyer);
        (address optionToken, uint256 premiumPaid) = vault.buy(authId, STRIKE, amount, type(uint256).max);

        // Premium: buyer → LP wallet (via official Aqua.push), VM-priced.
        assertEq(premiumPaid, _expectedCallAskUsdc(STRIKE, amount));
        assertEq(usdc.balanceOf(lp), premiumPaid);

        // Collateral: pulled JIT from LP wallet into the vault (official Aqua.pull).
        assertEq(weth.balanceOf(lp), maxCollateral - amount);
        assertEq(weth.balanceOf(address(vault)), amount);

        // Aqua virtual balances mirror the strategy state.
        (,,,,,,,,,,,, bytes32 strategyHash,,,,) = vault.authorizations(authId);
        (uint248 wethBal,) = aqua.rawBalances(lp, address(router), strategyHash, address(weth));
        assertEq(uint256(wethBal), maxCollateral - amount);

        // OptionToken deployed and minted to the buyer; position locked for LP.
        assertEq(OptionToken(optionToken).balanceOf(buyer), amount);
        (uint256 locked,) = vault.positions(optionToken, lp);
        assertEq(locked, amount);
    }

    function test_buy_strikeOutOfRangeReverts() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        vm.expectRevert("strike out of range");
        vault.buy(authId, 5000e18, 1e18, type(uint256).max);
    }

    function test_buy_capacityEnforcedByAqua() public {
        uint256 authId = _authorizeCall(1e18); // only 1 WETH shipped

        vm.prank(buyer);
        vm.expectRevert(stdError.arithmeticError);
        vault.buy(authId, STRIKE, 2e18, type(uint256).max);
    }

    function test_buy_unshippedRangeReverts() public {
        weth.mint(lp, 5e18);
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), address(usdc), true);
        // LP never called Aqua.ship → official registry knows nothing about it.
        vm.prank(buyer);
        vm.expectRevert();
        vault.buy(authId, STRIKE, 1e18, type(uint256).max);
    }

    function test_buy_premiumAboveMaxReverts() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        vm.expectRevert();
        vault.buy(authId, STRIKE, 1e18, 1); // absurdly tight premium bound
    }

    function test_buy_deploysNewTokenPerStrike() public {
        uint256 authId = _authorizeCall(10e18);

        vm.prank(buyer);
        vault.buy(authId, 2800e18, 1e18, type(uint256).max);
        vm.prank(buyer);
        vault.buy(authId, 3200e18, 1e18, type(uint256).max);

        // One shipped Aqua strategy backs the whole chain of strikes.
        address token2800 = vault.optionTokens(authId, 2800e18);
        address token3200 = vault.optionTokens(authId, 3200e18);
        assertTrue(token2800 != address(0));
        assertTrue(token3200 != address(0));
        assertTrue(token2800 != token3200);
    }

    function test_buy_afterDockReverts() public {
        uint256 authId = _authorizeCall(5e18);

        (address app, bytes32 strategyHash, address[] memory tokens) = vault.getDockParams(authId);
        vm.prank(lp);
        aqua.dock(app, strategyHash, tokens);

        vm.prank(buyer);
        vm.expectRevert();
        vault.buy(authId, STRIKE, 1e18, type(uint256).max);
    }

    // ── buy (cash-secured puts, vault as official AquaApp) ───────────────────

    function test_buyPut_jitPullFromVaultApp() public {
        uint256 maxCollateral = 10_000e6; // 10k USDC cash security
        uint256 authId = _authorizePut(maxCollateral);
        uint256 amount = 1e18;
        uint256 strike = 2800e18;
        uint256 expectedCollateral = (strike * amount) / 1e30; // 2800e6

        uint256 lpUsdcBefore = usdc.balanceOf(lp);
        vm.prank(buyer);
        (address optionToken, uint256 premiumPaid) = vault.buy(authId, strike, amount, type(uint256).max);

        assertGt(premiumPaid, 0);
        // Premium buyer → LP wallet; collateral pulled JIT from LP into vault.
        assertEq(usdc.balanceOf(lp), lpUsdcBefore - expectedCollateral + premiumPaid);
        assertEq(usdc.balanceOf(address(vault)), expectedCollateral);

        (,,,,,,,,,,,, bytes32 strategyHash,,,,) = vault.authorizations(authId);
        (uint248 bal,) = aqua.rawBalances(lp, address(vault), strategyHash, address(usdc));
        assertEq(uint256(bal), maxCollateral - expectedCollateral);

        assertEq(OptionToken(optionToken).balanceOf(buyer), amount);
        (uint256 locked,) = vault.positions(optionToken, lp);
        assertEq(locked, expectedCollateral);
    }

    function test_buyPut_capacityEnforcedByAqua() public {
        uint256 authId = _authorizePut(2000e6); // less than one 2800-strike put

        vm.prank(buyer);
        vm.expectRevert(stdError.arithmeticError);
        vault.buy(authId, 2800e18, 1e18, type(uint256).max);
    }

    // ── close (sellback at Bid) ───────────────────────────────────────────────

    function test_close_holderReceivesBid_capacityRestored() public {
        uint256 maxCollateral = 5e18;
        uint256 authId = _authorizeCall(maxCollateral);

        vm.prank(buyer);
        (address optionToken, uint256 askPaid) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        uint256 bidReceived = vault.close(optionToken, lp, 1e18, 0);

        // Holder sold back at Bid: paid, positive, and never above the Ask.
        assertGt(bidReceived, 0);
        assertLe(bidReceived, askPaid);
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + bidReceived);
        assertEq(OptionToken(optionToken).balanceOf(buyer), 0);

        // Collateral round-tripped to the LP wallet; escrow empty; position cleared.
        assertEq(weth.balanceOf(lp), maxCollateral);
        assertEq(weth.balanceOf(address(vault)), 0);
        (uint256 locked,) = vault.positions(optionToken, lp);
        assertEq(locked, 0);

        // Official Aqua virtual balance shows the range's JIT capacity restored.
        (,,,,,,,,,,,, bytes32 strategyHash,,,,) = vault.authorizations(authId);
        (uint248 wethBal,) = aqua.rawBalances(lp, address(router), strategyHash, address(weth));
        assertEq(uint256(wethBal), maxCollateral);
    }

    function test_close_thenBuyAgainstRestoredCapacity() public {
        // Capacity 1 WETH: buy 1 → close → buy 1 again must succeed because
        // the sellback restored the strategy's virtual balance.
        uint256 authId = _authorizeCall(1e18);

        vm.startPrank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);
        vault.close(optionToken, lp, 1e18, 0);
        vault.buy(authId, STRIKE, 1e18, type(uint256).max);
        vm.stopPrank();

        assertEq(OptionToken(optionToken).balanceOf(buyer), 1e18);
    }

    function test_close_minPayoutSlippageReverts() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        vm.prank(buyer);
        vm.expectRevert();
        vault.close(optionToken, lp, 1e18, type(uint256).max);
    }

    function test_close_lpCannotFundBuyback_reverts() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        (address optionToken, uint256 premiumPaid) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        // LP spends the earned premium elsewhere — the Bid pull has nothing to take.
        vm.prank(lp);
        usdc.transfer(address(0xDEAD), premiumPaid);

        vm.prank(buyer);
        vm.expectRevert();
        vault.close(optionToken, lp, 1e18, 0);
    }

    function test_closePut_holderPaid_capacityRestored() public {
        uint256 maxCollateral = 10_000e6;
        uint256 authId = _authorizePut(maxCollateral);
        uint256 strike = 2800e18;
        uint256 collateral = (strike * 1e18) / 1e30;

        vm.prank(buyer);
        (address optionToken, uint256 askPaid) = vault.buy(authId, strike, 1e18, type(uint256).max);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        uint256 bidReceived = vault.close(optionToken, lp, 1e18, 0);

        assertGt(bidReceived, 0);
        assertLe(bidReceived, askPaid);
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + bidReceived);
        assertEq(usdc.balanceOf(address(vault)), 0); // escrow returned

        // Virtual balance: -collateral (buy pull) -bid (close pull) +collateral (close push)
        (,,,,,,,,,,,, bytes32 strategyHash,,,,) = vault.authorizations(authId);
        (uint248 bal,) = aqua.rawBalances(lp, address(vault), strategyHash, address(usdc));
        assertEq(uint256(bal), maxCollateral - bidReceived);
        assertLt(bidReceived, collateral); // sanity: bid ≪ cash security
    }

    // ── settlement: register on buy → permissionless settle → redeem/reclaim ──

    function test_buy_registersSeries() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        (address regToken, uint256 regExpiry, uint256 regStrike, bool regIsCall, bool settled,) =
            settlement.series(vault.seriesId(authId, STRIKE));
        assertEq(regToken, optionToken);
        assertEq(regExpiry, expiry);
        assertEq(regStrike, STRIKE);
        assertTrue(regIsCall);
        assertFalse(settled);
    }

    function test_redeem_beforeSettlementReverts() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        vm.prank(buyer);
        vm.expectRevert("not settled");
        vault.redeem(optionToken, 1e18);
    }

    /// ITM call, settled permissionlessly at $3600: holder redeems the cash
    /// intrinsic in WETH, LP reclaims the exact remainder — full conservation.
    function test_settleRedeemReclaim_itmCall_conserved() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        // Expiry passes; the feed prints its first post-expiry round at $3600.
        vm.warp(expiry + 10);
        oracle.setAnswer(3600e8); // round 2
        vm.prank(address(0xA22)); // anyone can settle — no trusted role
        settlement.settleWithChainlinkRound(vault.seriesId(authId, STRIKE), 2);

        // Holder: (S-K)/S = 600/3600 of 1 WETH per unit.
        uint256 expectedPayout = (1e18 * (3600e18 - STRIKE)) / 3600e18;
        vm.prank(buyer);
        uint256 payout = vault.redeem(optionToken, 1e18);
        assertEq(payout, expectedPayout);
        assertEq(weth.balanceOf(buyer), expectedPayout);

        // LP: exactly the rest of the escrowed collateral. Zero residue.
        uint256 lpBefore = weth.balanceOf(lp);
        vm.prank(lp);
        uint256 reclaimed = vault.reclaimCollateral(optionToken);
        assertEq(reclaimed, 1e18 - expectedPayout);
        assertEq(weth.balanceOf(lp), lpBefore + reclaimed);
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    /// OTM call: holder redeems for zero, LP reclaims 100%.
    function test_settleRedeemReclaim_otmCall() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        vm.warp(expiry + 10);
        oracle.setAnswer(2500e8);
        settlement.settleWithChainlinkRound(vault.seriesId(authId, STRIKE), 2);

        vm.prank(buyer);
        uint256 payout = vault.redeem(optionToken, 1e18);
        assertEq(payout, 0);
        assertEq(OptionToken(optionToken).balanceOf(buyer), 0);

        vm.prank(lp);
        assertEq(vault.reclaimCollateral(optionToken), 1e18);
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    /// LP reclaiming FIRST must leave the holders' worst-case owed in escrow.
    function test_reclaimBeforeRedeem_reservesHolderClaim() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        vm.warp(expiry + 10);
        oracle.setAnswer(3600e8);
        settlement.settleWithChainlinkRound(vault.seriesId(authId, STRIKE), 2);

        uint256 owed = (1e18 * (3600e18 - STRIKE)) / 3600e18;
        vm.prank(lp);
        assertEq(vault.reclaimCollateral(optionToken), 1e18 - owed);

        // The holder's redemption is still fully payable afterwards.
        vm.prank(buyer);
        assertEq(vault.redeem(optionToken, 1e18), owed);
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    /// ITM put: intrinsic paid in USDC at fixed 6-dec scaling.
    function test_settleRedeem_itmPut() public {
        uint256 authId = _authorizePut(10_000e6);
        uint256 strike = 2800e18;
        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, strike, 1e18, type(uint256).max);

        vm.warp(expiry + 10);
        oracle.setAnswer(2500e8);
        settlement.settleWithChainlinkRound(vault.seriesId(authId, strike), 2);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.prank(buyer);
        uint256 payout = vault.redeem(optionToken, 1e18);
        assertEq(payout, 300e6); // (2800 - 2500) USD per unit, 6-dec
        assertEq(usdc.balanceOf(buyer), buyerBefore + 300e6);

        vm.prank(lp);
        assertEq(vault.reclaimCollateral(optionToken), 2800e6 - 300e6);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ── protocol fee (official SwapVM fee opcode → DAO revenue) ───────────────

    address dao = address(0xDA0);
    uint32 constant FEE_BPS = 0.01e9; // 1% (scale 1e9 = 100%)

    function _authorizeCallWithFee(uint256 maxCollateral) internal returns (uint256 authId) {
        vault.setProtocolFee(FEE_BPS, dao);
        authId = _authorizeCall(maxCollateral);
        // The official fee opcode pulls the fee BEFORE the buyer's premium
        // push lands, so the LP wallet needs a small float on the first trade.
        usdc.mint(lp, 100e6);
    }

    function test_setProtocolFee_guards() public {
        vm.expectRevert("fee too high");
        vault.setProtocolFee(0.06e9, dao); // > 5% cap

        vm.expectRevert("no recipient");
        vault.setProtocolFee(FEE_BPS, address(0));

        vm.prank(buyer);
        vm.expectRevert();
        vault.setProtocolFee(FEE_BPS, dao); // not owner
    }

    function test_shipParams_feeSeedOnlyWhenFeeEnabled() public {
        vm.prank(lp);
        uint256 noFeeAuth = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), address(usdc), true);
        (,,, uint256[] memory amountsNoFee) = vault.getShipParams(noFeeAuth);
        assertEq(amountsNoFee[1], 0);

        vault.setProtocolFee(FEE_BPS, dao);
        vm.prank(lp);
        uint256 feeAuth = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), address(usdc), true);
        (,,, uint256[] memory amountsFee) = vault.getShipParams(feeAuth);
        assertEq(amountsFee[1], 25e6); // $25 headroom for the first fee pulls
    }

    function test_buyWithFee_daoAccrues_lpNetsFullAsk() public {
        uint256 authId = _authorizeCallWithFee(5e18);
        uint256 lpUsdcBefore = usdc.balanceOf(lp);

        uint256 ask = _expectedCallAskUsdc(STRIKE, 1e18);
        uint256 expectedFee = (ask * FEE_BPS) / (1e9 - FEE_BPS); // official gross-up, floor

        vm.prank(buyer);
        (, uint256 premiumPaid) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        // Buyer paid Ask + fee; DAO accrued the fee; LP netted the FULL Ask.
        assertEq(premiumPaid, ask + expectedFee);
        assertEq(usdc.balanceOf(dao), expectedFee);
        assertEq(usdc.balanceOf(lp), lpUsdcBefore + ask);

        // Strategy virtual balance: seed + push(ask+fee) - fee pull = seed + ask.
        (,,,,,,,,,,,, bytes32 strategyHash,,,,) = vault.authorizations(authId);
        (uint248 usdcBal,) = aqua.rawBalances(lp, address(router), strategyHash, address(usdc));
        assertEq(uint256(usdcBal), 25e6 + ask);
    }

    function test_sellbackWithFee_reverseDirectionIsFeeFree() public {
        uint256 authId = _authorizeCallWithFee(5e18);
        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        uint256 daoAfterBuy = usdc.balanceOf(dao);
        vm.prank(buyer);
        uint256 bidReceived = vault.close(optionToken, lp, 1e18, 0);

        // jumpIfTokenIn skipped the fee opcode on the reverse (collateral-in) leg.
        assertGt(bidReceived, 0);
        assertEq(usdc.balanceOf(dao), daoAfterBuy);
    }

    function test_buyPutWithFee_sameGrossUp() public {
        vault.setProtocolFee(FEE_BPS, dao);
        uint256 authId = _authorizePut(10_000e6);
        uint256 lpUsdcBefore = usdc.balanceOf(lp);

        vm.prank(buyer);
        (, uint256 premiumPaid) = vault.buy(authId, 2800e18, 1e18, type(uint256).max);

        uint256 fee = usdc.balanceOf(dao);
        assertGt(fee, 0);
        // Buyer paid LP-premium + fee; LP netted premium minus the collateral pull.
        uint256 collateral = (2800e18 * 1e18) / 1e30;
        assertEq(usdc.balanceOf(lp), lpUsdcBefore + (premiumPaid - fee) - collateral);
    }
}
