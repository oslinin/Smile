// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
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
        weth.approve(address(aqua), maxCollateral);
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

        (address storedLp, uint256 sMin, uint256 sMax, uint256 exp,,,, bool isCall, bool active,,,,) =
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

        (,,,,,,,,,,,, bytes32 strategyHash) = vault.authorizations(authId);
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

        (,,,,,,,, bool active,,,,) = vault.authorizations(authId);
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
        (,,,,,,,,,,,, bytes32 strategyHash) = vault.authorizations(authId);
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

        (,,,,,,,,,,,, bytes32 strategyHash) = vault.authorizations(authId);
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

    // ── close ─────────────────────────────────────────────────────────────────

    function test_close_burnsTokenAndReleasesCollateral() public {
        uint256 authId = _authorizeCall(5e18);
        vm.prank(buyer);
        vault.buy(authId, STRIKE, 1e18, type(uint256).max);

        address optionToken = vault.optionTokens(authId, STRIKE);
        uint256 lpWethBefore = weth.balanceOf(lp);

        vm.prank(buyer);
        vault.close(optionToken, lp, 1e18);

        assertEq(OptionToken(optionToken).balanceOf(buyer), 0);
        assertGt(weth.balanceOf(lp), lpWethBefore); // LP got collateral back
    }
}
