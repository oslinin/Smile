// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { RfqVault } from "../src/periphery/RfqVault.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice R6 hybrid RFQ tier. An LP signs an EIP-712 quote off-chain that
/// beats the formula Ask; a taker fills it and the collateral is pulled JIT
/// through Aqua exactly as in tier 1. Quotes are single-use, time-boxed,
/// size-capped, cancellable, and only the range's LP can sign them.
contract RfqVaultTest is Test {
    Aqua aqua;
    RfqVault rfq;
    AquaOptionSettlement settlement;
    MockV3Aggregator oracle;
    MockERC20 weth;
    MockERC20 usdc;

    address owner = address(this);
    uint256 lpKey = 0xA11CE;
    address lp;
    uint256 strangerKey = 0x5712A9;
    address buyer = address(0xB0B);

    uint256 constant K = 3000e18;
    uint256 expiry;

    function setUp() public {
        lp = vm.addr(lpKey);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 3000e8);
        rfq = new RfqVault(
            address(aqua), address(oracle), address(0), owner, address(new OptionTokenFactory()), address(weth), address(usdc)
        );
        rfq.setPricingDefaults(50, 25, 0.001e18);
        rfq.setProtocolFee(0.01e9, owner);
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(rfq));
        rfq.setSettlement(address(settlement));

        expiry = block.timestamp + 30 days;
        weth.mint(lp, 10e18);
        usdc.mint(lp, 100_000e6);
        usdc.mint(buyer, 1_000_000e6);
        vm.startPrank(lp);
        weth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        vm.prank(buyer);
        usdc.approve(address(rfq), type(uint256).max);
    }

    function _openAndShip(bool isCall, uint256 capacity) internal returns (uint256 authId) {
        vm.prank(lp);
        authId = rfq.openRange(2500e18, 3500e18, expiry, capacity, isCall);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = rfq.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);
    }

    function _sign(uint256 key, RfqVault.Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, rfq.quoteHash(q));
        return abi.encodePacked(r, s, v);
    }

    /// @dev A quote 1% inside the formula Ask for `amount` units.
    function _improvedQuote(uint256 authId, uint256 amount, uint256 nonce) internal view returns (RfqVault.Quote memory q) {
        (uint256 formula,) = rfq.formulaQuote(authId, K, amount);
        q = RfqVault.Quote({
            authId: authId,
            strike: K,
            maxAmount: amount,
            premiumPerUnit: (formula * 99 / 100) * 1e18 / amount,
            ttl: block.timestamp + 60,
            nonce: nonce
        });
    }

    // ── fill ─────────────────────────────────────────────────────────────────

    function test_fill_signedQuoteBeatsFormula_collateralPulledJit() public {
        uint256 authId = _openAndShip(true, 1e18);
        RfqVault.Quote memory q = _improvedQuote(authId, 1e18, 1);
        (uint256 formula, uint256 formulaFee) = rfq.formulaQuote(authId, K, 1e18);
        (uint256 lpPremium, uint256 fee) = rfq.fillCost(q, 1e18);
        assertLt(lpPremium, formula, "the signed quote is inside the formula Ask");
        assertLt(fee, formulaFee);

        uint256 lpWeth0 = weth.balanceOf(lp);
        uint256 lpUsdc0 = usdc.balanceOf(lp);
        uint256 buyer0 = usdc.balanceOf(buyer);
        bytes memory sig = _sign(lpKey, q);
        vm.prank(buyer);
        (address token, uint256 paid) = rfq.fill(q, sig, 1e18, type(uint256).max);

        assertEq(paid, lpPremium + fee);
        assertEq(buyer0 - usdc.balanceOf(buyer), paid, "taker paid the quote, not the formula");
        assertEq(usdc.balanceOf(lp) - lpUsdc0, lpPremium, "LP received the quoted premium");
        assertEq(lpWeth0 - weth.balanceOf(lp), 1e18, "1 WETH pulled JIT from the LP wallet at fill");
        assertEq(weth.balanceOf(address(rfq)), 1e18);
        assertEq(IERC20(token).balanceOf(buyer), 1e18);
        assertTrue(rfq.nonceUsed(lp, 1), "quote consumed");
        (address regToken,,,,,) = settlement.series(rfq.seriesId(authId, K));
        assertEq(regToken, token, "series registered with the vault's own settlement");
    }

    function test_fill_put_pullsFullStrikeInUsdc() public {
        uint256 authId = _openAndShip(false, 10_000e6);
        RfqVault.Quote memory q = _improvedQuote(authId, 1e18, 7);
        uint256 lp0 = usdc.balanceOf(lp);
        (uint256 lpPremium,) = rfq.fillCost(q, 1e18);
        bytes memory sig = _sign(lpKey, q);
        vm.prank(buyer);
        rfq.fill(q, sig, 1e18, type(uint256).max);
        assertEq(lp0 + lpPremium - usdc.balanceOf(lp), 3000e6, "tier-1 rules: a put is cash-secured at the strike");
    }

    function test_fill_partialOfMaxAmount_thenNonceIsSpent() public {
        uint256 authId = _openAndShip(true, 5e18);
        RfqVault.Quote memory q = _improvedQuote(authId, 5e18, 2);
        bytes memory sig = _sign(lpKey, q);
        vm.prank(buyer);
        rfq.fill(q, sig, 2e18, type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(RfqVault.QuoteUsed.selector);
        rfq.fill(q, sig, 1e18, type(uint256).max);
    }

    function test_fill_rejects_wrongSigner_expired_oversize_cancelled_offRange() public {
        uint256 authId = _openAndShip(true, 1e18);
        RfqVault.Quote memory q = _improvedQuote(authId, 1e18, 3);
        bytes memory good = _sign(lpKey, q);
        bytes memory bad = _sign(strangerKey, q);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(RfqVault.BadSigner.selector, vm.addr(strangerKey), lp));
        rfq.fill(q, bad, 1e18, type(uint256).max);

        vm.prank(buyer);
        vm.expectRevert(RfqVault.OverQuoteSize.selector);
        rfq.fill(q, good, 2e18, type(uint256).max);

        vm.prank(buyer);
        vm.expectRevert(RfqVault.PremiumAboveMax.selector);
        rfq.fill(q, good, 1e18, 1);

        RfqVault.Quote memory off = q; // memory structs alias: restore the strike afterwards
        off.strike = 4000e18;
        bytes memory offSig = _sign(lpKey, off);
        vm.prank(buyer);
        vm.expectRevert(RfqVault.StrikeOutOfRange.selector);
        rfq.fill(off, offSig, 1e18, type(uint256).max);
        q.strike = K;

        vm.prank(lp);
        rfq.cancelQuote(3);
        vm.prank(buyer);
        vm.expectRevert(RfqVault.QuoteUsed.selector);
        rfq.fill(q, good, 1e18, type(uint256).max);

        RfqVault.Quote memory fresh = _improvedQuote(authId, 1e18, 4);
        bytes memory freshSig = _sign(lpKey, fresh);
        vm.warp(fresh.ttl + 1);
        vm.prank(buyer);
        vm.expectRevert(RfqVault.QuoteExpired.selector);
        rfq.fill(fresh, freshSig, 1e18, type(uint256).max);
    }

    function test_fill_tamperedQuoteFailsSignature() public {
        uint256 authId = _openAndShip(true, 1e18);
        RfqVault.Quote memory q = _improvedQuote(authId, 1e18, 5);
        bytes memory sig = _sign(lpKey, q);
        q.premiumPerUnit = q.premiumPerUnit / 2; // taker edits the price after signing
        vm.prank(buyer);
        vm.expectRevert();
        rfq.fill(q, sig, 1e18, type(uint256).max);
    }

    function test_fill_revertsWhenAquaCapacityExhausted() public {
        uint256 authId = _openAndShip(true, 1e18);
        RfqVault.Quote memory q = _improvedQuote(authId, 2e18, 6);
        bytes memory sig = _sign(lpKey, q);
        vm.prank(buyer);
        vm.expectRevert();
        rfq.fill(q, sig, 2e18, type(uint256).max);
    }

    // ── settlement ───────────────────────────────────────────────────────────

    function test_redeem_reclaim_callItm() public {
        uint256 authId = _openAndShip(true, 1e18);
        RfqVault.Quote memory q = _improvedQuote(authId, 1e18, 8);
        bytes memory sig = _sign(lpKey, q);
        vm.prank(buyer);
        (address token,) = rfq.fill(q, sig, 1e18, type(uint256).max);

        vm.warp(expiry);
        settlement.settleSeries(rfq.seriesId(authId, K), 3300e18);

        vm.prank(buyer);
        uint256 payout = rfq.redeem(authId, K, 1e18);
        assertEq(payout, uint256(1e18 * 300e18) / uint256(3300e18), "call intrinsic (S-K)/S in WETH");
        vm.prank(lp);
        uint256 back = rfq.reclaim(authId, K);
        assertEq(payout + back, 1e18, "conservation");
        assertEq(IERC20(token).totalSupply(), 0);
        assertEq(weth.balanceOf(address(rfq)), 0);
    }

    function test_wiring_isOneTime() public {
        vm.expectRevert(RfqVault.AlreadySet.selector);
        rfq.setSettlement(address(1));
    }
}
