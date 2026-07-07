// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IPriceOracle } from "@1inch/swap-vm/src/instructions/interfaces/IPriceOracle.sol";

import { SmileMath } from "../swapvm/SmileMath.sol";

/// @notice Expiry-price REGISTRY for option series. Collateral custody and
/// payouts live in the vault (`AquaCollateralVault.redeem/reclaimCollateral`);
/// this contract records — immutably, once per series — the price a series
/// settled at, through either of two paths:
///
///  - `settleSeries` (CRE): the Chainlink CRE forwarder writes the DON's
///    consensus price in WAD. Kept as the scheduled/demo path.
///  - `settleWithChainlinkRound`: PERMISSIONLESS. Anyone — a keeper, the CRE,
///    the holder themselves — supplies the Chainlink roundId covering expiry
///    and the contract verifies on-chain that it is the first round at/after
///    expiry. No trusted writer: settlement liveness reduces to the feed's.
contract AquaOptionSettlement is Ownable {
    /// @dev Address of the Chainlink CRE forwarder (set at deploy time).
    address public immutable creForwarder;
    /// @dev Canonical Chainlink price feed used for permissionless settlement.
    IPriceOracle public immutable feed;
    /// @dev The vault allowed to register series (set once by owner).
    address public registrar;

    struct Series {
        address optionToken;
        uint256 expiry;
        uint256 strike;          // WAD USD
        bool isCall;
        bool settled;
        uint256 settlementPrice; // WAD USD, written exactly once
    }

    mapping(bytes32 => Series) public series;

    event SeriesRegistered(bytes32 indexed seriesId, address indexed optionToken, uint256 expiry, uint256 strike, bool isCall);
    event SeriesSettled(bytes32 indexed seriesId, uint256 settlementPrice, address indexed settler);

    modifier onlyCRE() {
        require(msg.sender == creForwarder, "only CRE forwarder");
        _;
    }

    constructor(address creForwarder_, address owner_, address feed_) Ownable(owner_) {
        creForwarder = creForwarder_;
        feed = IPriceOracle(feed_);
    }

    /// @notice One-time wiring of the vault that registers series on mint.
    function setRegistrar(address registrar_) external onlyOwner {
        require(registrar == address(0), "already set");
        registrar = registrar_;
    }

    /// @notice Called by the vault on the first mint of each (range, strike) series.
    function registerSeries(
        bytes32 seriesId,
        address optionToken,
        uint256 expiry,
        uint256 strike,
        bool isCall
    ) external {
        require(msg.sender == registrar, "only registrar");
        require(series[seriesId].expiry == 0, "already registered");
        series[seriesId] = Series({
            optionToken: optionToken,
            expiry: expiry,
            strike: strike,
            isCall: isCall,
            settled: false,
            settlementPrice: 0
        });
        emit SeriesRegistered(seriesId, optionToken, expiry, strike, isCall);
    }

    /// @notice CRE path: the forwarder writes the DON's consensus price (WAD).
    function settleSeries(bytes32 seriesId, uint256 settlementPriceWad) external onlyCRE {
        Series storage s = _pendingSeries(seriesId);
        s.settled = true;
        s.settlementPrice = settlementPriceWad;
        emit SeriesSettled(seriesId, settlementPriceWad, msg.sender);
    }

    /// @notice Permissionless path: settle with the Chainlink round that covers
    /// expiry. The caller supplies `roundId`; the contract verifies that the
    /// round was updated at/after expiry AND that its predecessor was updated
    /// before expiry (i.e. it is the FIRST post-expiry round, so callers can't
    /// cherry-pick a later, more favorable price).
    /// @dev Predecessor check assumes `roundId - 1` is in the same proxy phase;
    /// at a phase boundary the predecessor lookup reverts and is skipped.
    function settleWithChainlinkRound(bytes32 seriesId, uint80 roundId) external {
        Series storage s = _pendingSeries(seriesId);

        (, int256 answer,, uint256 updatedAt,) = feed.getRoundData(roundId);
        require(answer > 0, "bad round answer");
        require(updatedAt >= s.expiry, "round before expiry");

        if (roundId > 0) {
            try feed.getRoundData(roundId - 1) returns (uint80, int256, uint256, uint256 prevUpdatedAt, uint80) {
                require(prevUpdatedAt == 0 || prevUpdatedAt < s.expiry, "not first round after expiry");
            } catch {
                // phase boundary / missing predecessor — accept the round
            }
        }

        uint256 priceWad = SmileMath.scaleToWad(uint256(answer), feed.decimals());
        s.settled = true;
        s.settlementPrice = priceWad;
        emit SeriesSettled(seriesId, priceWad, msg.sender);
    }

    function _pendingSeries(bytes32 seriesId) internal view returns (Series storage s) {
        s = series[seriesId];
        require(s.expiry > 0, "unknown series");
        require(block.timestamp >= s.expiry, "not yet expired");
        require(!s.settled, "already settled");
    }
}
