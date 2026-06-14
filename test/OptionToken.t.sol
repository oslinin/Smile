// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/OptionToken.sol";

contract OptionTokenTest is Test {
    OptionToken token;
    address owner = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        token = new OptionToken(
            "ETH-3500-CALL-DEC24",
            "oETH-C-3500",
            address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2), // WETH mainnet
            3500e6,
            block.timestamp + 30 days,
            true,
            owner
        );
    }

    function test_metadata() public view {
        assertEq(token.strikePrice(), 3500e6);
        assertEq(token.isCall(), true);
        assertTrue(token.expiry() > block.timestamp);
    }

    function test_ownerCanMint() public {
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
    }

    function test_ownerCanBurn() public {
        token.mint(alice, 1e18);
        token.burn(alice, 1e18);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_nonOwnerCannotMint() public {
        vm.prank(bob);
        vm.expectRevert();
        token.mint(alice, 1e18);
    }

    function test_nonOwnerCannotBurn() public {
        token.mint(alice, 1e18);
        vm.prank(bob);
        vm.expectRevert();
        token.burn(alice, 1e18);
    }
}
