// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/vaults/AquaCollateralVault.sol";
import "../src/OptionToken.sol";
import "../src/swapvm/OptionPricingEngine.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract AquaCollateralVaultTest is Test {
    AquaCollateralVault vault;
    OptionPricingEngine engine;
    MockERC20 usdc;
    MockERC20 weth;

    address owner = address(this);
    address lp    = address(0x1111);
    address buyer = address(0x2222);

    uint256 constant STRIKE     = 3000e18; // $3000 WAD
    uint256 constant STRIKE_MIN = 2500e18;
    uint256 constant STRIKE_MAX = 3500e18;
    uint256 expiry;

    function setUp() public {
        engine = new OptionPricingEngine();
        vault  = new AquaCollateralVault(address(engine), owner);
        usdc   = new MockERC20("USD Coin", "USDC");
        weth   = new MockERC20("Wrapped Ether", "WETH");
        expiry = block.timestamp + 30 days;
    }

    // ── authorizeRange ────────────────────────────────────────────────────────

    function test_authorizeRange_storesAuthorization() public {
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), true);

        (address storedLp, uint256 sMin, uint256 sMax, uint256 exp,,,, bool isCall, bool active) =
            vault.authorizations(authId);

        assertEq(storedLp, lp);
        assertEq(sMin, STRIKE_MIN);
        assertEq(sMax, STRIKE_MAX);
        assertEq(exp, expiry);
        assertTrue(isCall);
        assertTrue(active);
    }

    function test_authorizeRange_invalidRangeReverts() public {
        vm.prank(lp);
        vm.expectRevert("invalid range");
        // strikeMin strictly greater than strikeMax is still invalid
        vault.authorizeRange(STRIKE_MAX, STRIKE_MIN, expiry, 1e18, address(weth), true);
    }

    function test_authorizeRange_singleStrike() public {
        // K_min == K_max is valid: write a covered call at exactly one strike
        weth.mint(lp, 1e18);
        vm.prank(lp);
        weth.approve(address(vault), 1e18);
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE, STRIKE, expiry, 1e18, address(weth), true);

        (address storedLp,, uint256 sMax,,,,, bool isCall, bool active) = vault.authorizations(authId);
        assertEq(storedLp, lp);
        assertEq(sMax, STRIKE);
        assertTrue(isCall);
        assertTrue(active);

        // Can buy at exactly that strike
        usdc.mint(buyer, type(uint256).max / 2);
        vm.prank(buyer);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(buyer);
        vault.buy(authId, STRIKE, 3000e18, buyer, 1e18, address(usdc));
        assertEq(OptionToken(vault.optionTokens(authId, STRIKE)).balanceOf(buyer), 1e18);
    }

    function test_revokeAuthorization() public {
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), true);

        vm.prank(lp);
        vault.revokeAuthorization(authId);

        (,,,,,,,, bool active) = vault.authorizations(authId);
        assertFalse(active);
    }

    // ── buy ───────────────────────────────────────────────────────────────────

    function test_buy_mintsOptionAndLocksCollateral() public {
        uint256 maxCollateral = 5e18; // 5 WETH
        weth.mint(lp, maxCollateral);
        usdc.mint(buyer, type(uint256).max / 2);

        vm.prank(lp);
        weth.approve(address(vault), maxCollateral);

        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(weth), true);

        vm.prank(buyer);
        usdc.approve(address(vault), type(uint256).max);

        uint256 spot = 3000e18;
        uint256 amount = 1e18; // 1 contract

        vm.prank(buyer);
        vault.buy(authId, STRIKE, spot, buyer, amount, address(usdc));

        // OptionToken deployed and minted
        address optionToken = vault.optionTokens(authId, STRIKE);
        assertTrue(optionToken != address(0));
        assertEq(OptionToken(optionToken).balanceOf(buyer), amount);

        // Collateral locked (1 WETH for 1 call contract)
        (uint256 locked,) = vault.positions(optionToken, lp);
        assertEq(locked, amount);
    }

    function test_buy_strikeOutOfRangeReverts() public {
        weth.mint(lp, 5e18);
        vm.prank(lp);
        weth.approve(address(vault), 5e18);
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), true);

        usdc.mint(buyer, 10_000e6);
        vm.prank(buyer);
        usdc.approve(address(vault), 10_000e6);

        vm.prank(buyer);
        vm.expectRevert("strike out of range");
        vault.buy(authId, 5000e18, 3000e18, buyer, 1e18, address(usdc));
    }

    function test_buy_capacityExceededReverts() public {
        uint256 maxCollateral = 1e18; // only 1 WETH
        weth.mint(lp, maxCollateral);
        vm.prank(lp);
        weth.approve(address(vault), maxCollateral);
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(weth), true);

        usdc.mint(buyer, type(uint256).max / 2);
        vm.prank(buyer);
        usdc.approve(address(vault), type(uint256).max);

        // Try to buy 2 contracts with only 1 WETH capacity
        vm.prank(buyer);
        vm.expectRevert("capacity exceeded");
        vault.buy(authId, STRIKE, 3000e18, buyer, 2e18, address(usdc));
    }

    function test_buy_deploysNewTokenPerStrike() public {
        weth.mint(lp, 10e18);
        vm.prank(lp);
        weth.approve(address(vault), 10e18);
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 10e18, address(weth), true);

        usdc.mint(buyer, type(uint256).max / 2);
        vm.prank(buyer);
        usdc.approve(address(vault), type(uint256).max);

        vm.prank(buyer);
        vault.buy(authId, 2800e18, 3000e18, buyer, 1e18, address(usdc));
        vm.prank(buyer);
        vault.buy(authId, 3200e18, 3000e18, buyer, 1e18, address(usdc));

        address token2800 = vault.optionTokens(authId, 2800e18);
        address token3200 = vault.optionTokens(authId, 3200e18);
        assertTrue(token2800 != address(0));
        assertTrue(token3200 != address(0));
        assertTrue(token2800 != token3200);
    }

    // ── close ─────────────────────────────────────────────────────────────────

    function test_close_burnsTokenAndReleasesCollateral() public {
        weth.mint(lp, 5e18);
        vm.prank(lp);
        weth.approve(address(vault), 5e18);
        vm.prank(lp);
        uint256 authId = vault.authorizeRange(STRIKE_MIN, STRIKE_MAX, expiry, 5e18, address(weth), true);

        usdc.mint(buyer, type(uint256).max / 2);
        vm.prank(buyer);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(buyer);
        vault.buy(authId, STRIKE, 3000e18, buyer, 1e18, address(usdc));

        address optionToken = vault.optionTokens(authId, STRIKE);
        uint256 lpWethBefore = weth.balanceOf(lp);

        vm.prank(buyer);
        vault.close(optionToken, lp, 1e18);

        assertEq(OptionToken(optionToken).balanceOf(buyer), 0);
        assertGt(weth.balanceOf(lp), lpWethBefore); // LP got collateral back
    }
}
