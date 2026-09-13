// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { SmileQuoteLens } from "../src/periphery/SmileQuoteLens.sol";
import { OptionToken } from "../src/OptionToken.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Reproduces the "address A provides liquidity, does address B see
/// it?" question at the contract layer, independent of any frontend wallet
/// or RPC state. `authorizations` is public chain state and `bestQuote` has
/// no `msg.sender` gating, so a wallet that never touched the vault before
/// must be able to read A's authorization and fill against it in the same
/// way A's own wallet could.
contract CrossAddressVisibilityTest is Test {
    Aqua aqua;
    SmileSwapVMRouter router;
    AquaCollateralVault vault;
    AquaOptionSettlement settlement;
    SmileQuoteLens lens;
    MockV3Aggregator oracle;
    MockERC20 usdc;
    MockERC20 weth;

    address owner  = address(this);
    address lpA    = address(0xA11CE);
    address addrB  = address(0xB0B);

    uint256 constant SPOT = 3000e18;
    uint256 expiry;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua = new Aqua();
        router = new SmileSwapVMRouter(address(aqua), address(weth), owner);
        oracle = new MockV3Aggregator(8, 3000e8);
        vault = new AquaCollateralVault(address(aqua), payable(address(router)), address(oracle), owner, address(new OptionTokenFactory()));
        settlement = new AquaOptionSettlement(owner, owner, address(oracle));
        settlement.setRegistrar(address(vault));
        vault.setSettlement(address(settlement));
        lens = new SmileQuoteLens(address(vault), payable(address(router)), address(aqua), address(0));
        expiry = block.timestamp + 30 days;
    }

    /// @dev lpA authorizes and ships a covered-call range; collateral stays
    /// in lpA's own wallet (JIT pull model) until a buyer matches it.
    function _lpShipsCallRange(uint256 strikeMin, uint256 strikeMax, uint256 maxCollateral)
        internal
        returns (uint256 authId)
    {
        weth.mint(lpA, maxCollateral);
        vm.startPrank(lpA);
        authId = vault.authorizeRange(strikeMin, strikeMax, expiry, maxCollateral, address(weth), address(usdc), true);
        weth.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            vault.getShipParams(authId);
        vm.prank(lpA);
        aqua.ship(app, strategy, tokens, amounts);
    }

    /// @notice B never called authorizeRange or ship — it should still read
    /// lpA's authorization back verbatim via the public `authorizations` getter.
    function test_authorizationVisibleToAnyCaller() public {
        uint256 authId = _lpShipsCallRange(2800e18, 3200e18, 5e18);

        vm.prank(addrB);
        (
            address lp,
            uint256 strikeMin,
            uint256 strikeMax,
            uint256 authExpiry,
            uint256 maxCollateral,
            ,
            address collateralToken,
            bool isCall,
            bool active,
            ,,,,,,,
        ) = vault.authorizations(authId);

        assertEq(lp, lpA, "authorization attributes to lpA regardless of who reads it");
        assertEq(strikeMin, 2800e18);
        assertEq(strikeMax, 3200e18);
        assertEq(authExpiry, expiry);
        assertEq(maxCollateral, 5e18);
        assertEq(collateralToken, address(weth));
        assertTrue(isCall);
        assertTrue(active);
    }

    /// @notice B (who never provided liquidity) must see lpA's range as the
    /// best executable ask through the quote lens — no caller-based filter.
    function test_bestQuote_seesOtherAddressLiquidity() public {
        uint256 authId = _lpShipsCallRange(2800e18, 3200e18, 5e18);
        uint256 strike = 3000e18;

        vm.prank(addrB);
        (uint256 bestAuthId, uint256 bestPremium) = lens.bestQuote(strike, expiry, true, 1e18);

        assertEq(bestAuthId, authId, "B discovers A's authorization as the best (only) quote");
        assertLt(bestPremium, type(uint256).max, "B gets an executable premium, not NO_QUOTE");
    }

    /// @notice B can fill directly against lpA's authorization with a plain
    /// `buy()` call — proving there is no per-address gate anywhere in the
    /// fill path, only the strike/expiry/capacity checks already covered by
    /// the main vault test suite.
    function test_buy_fillsAcrossAddressesWithNoPermissioning() public {
        uint256 authId = _lpShipsCallRange(2800e18, 3200e18, 5e18);
        uint256 strike = 3000e18;

        usdc.mint(addrB, 1_000_000e6);
        vm.startPrank(addrB);
        usdc.approve(address(vault), type(uint256).max);
        (address optionToken, uint256 premiumPaid) = vault.buy(authId, strike, 1e18, type(uint256).max);
        vm.stopPrank();

        assertGt(premiumPaid, 0);
        assertEq(OptionToken(optionToken).balanceOf(addrB), 1e18, "B holds the option it just bought from A's range");
        assertEq(usdc.balanceOf(lpA), premiumPaid, "A receives the premium despite never interacting with B");
    }
}
