// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../OptionToken.sol";

/// @notice Manages option expiry and settlement.
/// Only the authorized Chainlink CRE forwarder may write the final spot price.
/// Commit 9: expiry guards + CRE-only access.
/// Commit 10: fully-collateralized OTM/ITM payouts.
contract AquaOptionSettlement is Ownable {
    using SafeERC20 for IERC20;

    /// @dev Address of the Chainlink CRE forwarder (set at deploy time).
    address public immutable creForwarder;

    struct Series {
        uint256 expiry;
        uint256 strikePrice;      // K in USDC 6-dec
        uint256 collateralPerUnit; // collateral locked per 1e18 option units
        address collateralToken;
        address optionToken;
        address lp;
        uint256 totalCollateral;
        bool settled;
        uint256 settlementPrice; // final spot price from CRE
    }

    mapping(bytes32 => Series) public series;

    event SeriesRegistered(bytes32 indexed seriesId);
    event SeriesSettled(bytes32 indexed seriesId, uint256 settlementPrice);
    event HolderPaid(bytes32 indexed seriesId, address holder, uint256 payout);
    event CollateralReturned(bytes32 indexed seriesId, address lp, uint256 amount);

    modifier onlyCRE() {
        require(msg.sender == creForwarder, "only CRE forwarder");
        _;
    }

    constructor(address creForwarder_, address owner_) Ownable(owner_) {
        creForwarder = creForwarder_;
    }

    /// @notice Register a series before expiry. Called by vault when collateral is locked.
    function registerSeries(
        bytes32 seriesId,
        uint256 expiry,
        uint256 strikePrice,
        uint256 collateralPerUnit,
        address collateralToken,
        address optionToken,
        address lp,
        uint256 totalCollateral
    ) external onlyOwner {
        require(series[seriesId].expiry == 0, "already registered");
        series[seriesId] = Series({
            expiry: expiry,
            strikePrice: strikePrice,
            collateralPerUnit: collateralPerUnit,
            collateralToken: collateralToken,
            optionToken: optionToken,
            lp: lp,
            totalCollateral: totalCollateral,
            settled: false,
            settlementPrice: 0
        });
        emit SeriesRegistered(seriesId);
    }

    /// @notice Called by Chainlink CRE forwarder with consensus spot price at expiry.
    /// This is the required on-chain state change (Commit 11 wires the off-chain workflow).
    function settleSeries(bytes32 seriesId, uint256 spotPrice) external onlyCRE {
        Series storage s = series[seriesId];
        require(s.expiry > 0, "unknown series");
        require(block.timestamp >= s.expiry, "not yet expired");
        require(!s.settled, "already settled");

        s.settled = true;
        s.settlementPrice = spotPrice;
        emit SeriesSettled(seriesId, spotPrice);
    }

    /// @notice Holder redeems their option tokens for payout.
    /// ITM: payout = max(S - K, 0) per unit. OTM: 0 (collateral stays with LP).
    function redeem(bytes32 seriesId, uint256 amount) external {
        Series storage s = series[seriesId];
        require(s.settled, "not settled");
        require(amount > 0, "zero amount");

        OptionToken(s.optionToken).burn(msg.sender, amount);

        uint256 payout = 0;
        if (s.settlementPrice > s.strikePrice) {
            // ITM: pay (S - K) per unit, scaled by amount/1e18
            uint256 intrinsic = s.settlementPrice - s.strikePrice;
            payout = (intrinsic * amount) / 1e18;
            // Cap at available collateral per unit
            uint256 maxPayout = (s.collateralPerUnit * amount) / 1e18;
            if (payout > maxPayout) payout = maxPayout;
        }

        if (payout > 0) {
            s.totalCollateral -= payout;
            IERC20(s.collateralToken).safeTransfer(msg.sender, payout);
            emit HolderPaid(seriesId, msg.sender, payout);
        }
    }

    /// @notice LP reclaims remaining collateral after settlement (OTM: 100%, ITM: remainder).
    function reclaimCollateral(bytes32 seriesId) external {
        Series storage s = series[seriesId];
        require(s.settled, "not settled");
        require(msg.sender == s.lp, "not lp");
        require(s.totalCollateral > 0, "nothing to reclaim");

        uint256 amount = s.totalCollateral;
        s.totalCollateral = 0;
        IERC20(s.collateralToken).safeTransfer(s.lp, amount);
        emit CollateralReturned(seriesId, s.lp, amount);
    }
}
