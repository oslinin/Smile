// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../OptionToken.sol";
import "../swapvm/OptionPricingEngine.sol";

/// @notice JIT collateral vault modelling Aqua's virtual-wallet layer.
/// On a matched trade the vault pulls collateral from the LP and mints an OptionToken.
/// Covered call: LP provides 1 unit of underlying.
/// Cash-secured put: LP provides strikePrice units of USDC.
contract AquaCollateralVault is Ownable {
    using SafeERC20 for IERC20;

    OptionPricingEngine public immutable pricingEngine;

    struct LPPosition {
        uint256 lockedCollateral; // amount currently locked
        address collateralToken;  // underlying or USDC
    }

    // optionToken → LP address → position
    mapping(address => mapping(address => LPPosition)) public positions;

    event CollateralLocked(address indexed optionToken, address indexed lp, uint256 amount);
    event OptionMinted(address indexed optionToken, address indexed buyer, uint256 amount);

    constructor(address pricingEngine_, address owner_) Ownable(owner_) {
        pricingEngine = OptionPricingEngine(pricingEngine_);
    }

    /// @notice JIT pull: on a matched trade, pull collateral from LP and mint to buyer.
    /// @param optionToken  The OptionToken contract to mint.
    /// @param lp           LP whose wallet is pulled (must have approved this vault).
    /// @param buyer        Receives the minted OptionToken.
    /// @param amount       Number of option units (in OptionToken decimals).
    /// @param collateralToken  ERC-20 token used as collateral (underlying or USDC).
    /// @param collateralAmount Total collateral required (amount * 1e18 for covered call).
    function pull(
        address optionToken,
        address lp,
        address buyer,
        uint256 amount,
        address collateralToken,
        uint256 collateralAmount
    ) external onlyOwner {
        require(amount > 0, "zero amount");
        require(buyer != address(0), "zero buyer");

        // Pull collateral from LP just-in-time
        IERC20(collateralToken).safeTransferFrom(lp, address(this), collateralAmount);

        // Track the locked position
        LPPosition storage pos = positions[optionToken][lp];
        pos.lockedCollateral += collateralAmount;
        pos.collateralToken = collateralToken;

        // Mint option tokens to buyer
        OptionToken(optionToken).mint(buyer, amount);

        emit CollateralLocked(optionToken, lp, collateralAmount);
        emit OptionMinted(optionToken, buyer, amount);
    }

    /// @notice Release locked collateral back to LP (called by settlement contract).
    function releaseCollateral(address optionToken, address lp, uint256 amount) external onlyOwner {
        LPPosition storage pos = positions[optionToken][lp];
        require(pos.lockedCollateral >= amount, "insufficient locked");
        pos.lockedCollateral -= amount;
        IERC20(pos.collateralToken).safeTransfer(lp, amount);
    }
}
