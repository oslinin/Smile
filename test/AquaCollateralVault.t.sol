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
    OptionToken optionToken;
    OptionPricingEngine engine;
    MockERC20 usdc;

    address owner = address(this);
    address lp = address(0x1111);
    address buyer = address(0x2222);

    uint256 constant STRIKE = 2000e6;  // $2000 USDC (6 dec)
    uint256 constant EXPIRY_OFFSET = 30 days;

    function setUp() public {
        engine = new OptionPricingEngine();
        vault = new AquaCollateralVault(address(engine), owner);
        usdc = new MockERC20("USD Coin", "USDC");

        optionToken = new OptionToken(
            "ETH-2000-CALL-DEC24", "oETH-C-2000",
            address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2),
            STRIKE,
            block.timestamp + EXPIRY_OFFSET,
            true,
            address(vault)  // vault is owner → can mint/burn
        );
    }

    function test_pull_mintsOptionAndLocksCollateral() public {
        uint256 collateral = 2000e6; // 1 covered call @ $2000 strike
        usdc.mint(lp, collateral);

        vm.prank(lp);
        usdc.approve(address(vault), collateral);

        vault.pull(address(optionToken), lp, buyer, 1e18, address(usdc), collateral);

        assertEq(optionToken.balanceOf(buyer), 1e18);

        (uint256 locked,) = vault.positions(address(optionToken), lp);
        assertEq(locked, collateral);
        assertEq(usdc.balanceOf(address(vault)), collateral);
    }

    function test_pull_zeroAmountReverts() public {
        vm.expectRevert("zero amount");
        vault.pull(address(optionToken), lp, buyer, 0, address(usdc), 0);
    }

    function test_pull_zeroBuyerReverts() public {
        vm.expectRevert("zero buyer");
        vault.pull(address(optionToken), lp, address(0), 1e18, address(usdc), 0);
    }

    function test_releaseCollateral() public {
        uint256 collateral = 2000e6;
        usdc.mint(lp, collateral);
        vm.prank(lp);
        usdc.approve(address(vault), collateral);
        vault.pull(address(optionToken), lp, buyer, 1e18, address(usdc), collateral);

        vault.releaseCollateral(address(optionToken), lp, collateral);

        (uint256 locked,) = vault.positions(address(optionToken), lp);
        assertEq(locked, 0);
        assertEq(usdc.balanceOf(lp), collateral);
    }

    function test_nonOwnerCannotPull() public {
        vm.prank(buyer);
        vm.expectRevert();
        vault.pull(address(optionToken), lp, buyer, 1e18, address(usdc), 0);
    }
}
