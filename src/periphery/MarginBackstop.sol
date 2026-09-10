// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Pre-funded USDC pool that adopts margin positions nobody buys at
/// auction and pays holder shortfalls at settlement (S13, Part B of
/// docs/plans/2026-09-05-ethonline2026-continuation-track.md).
///
/// B1 stub: holds USDC, reports `totalAssets`, lets the vault `draw`. The
/// share accounting, 24 h withdrawal queue and the naked-notional withdrawal
/// guard land in B5.
contract MarginBackstop {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public immutable vault;

    error OnlyVault();

    event Drawn(address indexed to, uint256 amount);

    constructor(address usdc_, address vault_) {
        usdc = IERC20(usdc_);
        vault = vault_;
    }

    /// @notice USDC the pool can absorb defaults with. The vault's naked-
    /// notional ceiling is a multiple of this.
    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Vault-only: move `amount` USDC into the vault to cover a
    /// shortfall. Draws at most what the pool holds; returns what moved.
    function draw(uint256 amount) external returns (uint256 drawn) {
        require(msg.sender == vault, OnlyVault());
        drawn = amount > totalAssets() ? totalAssets() : amount;
        if (drawn > 0) usdc.safeTransfer(vault, drawn);
        emit Drawn(vault, drawn);
    }
}
