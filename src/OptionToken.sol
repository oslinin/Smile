// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice ERC-20 representing a single option position.
/// Immutable metadata is set at construction; only the owner (vault) may mint/burn.
contract OptionToken is ERC20, Ownable {
    address public immutable underlying;
    uint256 public immutable strikePrice;
    uint256 public immutable expiry;
    bool public immutable isCall;

    constructor(
        string memory name_,
        string memory symbol_,
        address underlying_,
        uint256 strikePrice_,
        uint256 expiry_,
        bool isCall_,
        address owner_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        underlying = underlying_;
        strikePrice = strikePrice_;
        expiry = expiry_;
        isCall = isCall_;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
