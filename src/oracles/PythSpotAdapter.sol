// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal interface of the Pyth pull oracle (pyth-sdk-solidity's
/// IPyth), declared locally to avoid vendoring the SDK for three functions.
interface IPyth {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory price);
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
}

/// @title PythSpotAdapter — Chainlink-shaped facade over a Pyth price feed
/// @notice R5 (docs/solutions.md): sub-second quoting freshness. Pyth is a
/// PULL oracle — prices are signed off-chain roughly every 400ms and the
/// TAKER posts the update in their own transaction (via {refresh} or directly
/// on Pyth), then trades against a near-live spot. This adapter exposes the
/// result through `latestRoundData()` so the option-premium instruction and
/// the vault read it unchanged: `updatedAt` maps to Pyth's `publishTime`,
/// which makes the per-strategy `maxStaleness` a seconds-tight freshness
/// bound — THE security parameter of a pull oracle, since the taker chooses
/// which signed update to post and must not be allowed to shop a stale one.
///
/// Scope: QUOTING only. Settlement stays on Chainlink rounds, whose on-chain
/// round history is what makes permissionless expiry bracketing verifiable.
contract PythSpotAdapter {
    IPyth public immutable pyth;
    bytes32 public immutable priceId;
    /// @dev Pyth quotes crypto/USD with a fixed exponent per feed (ETH/USD:
    /// expo = -8). Pinned at deploy and enforced on every read so a feed
    /// reconfiguration can never silently rescale premiums.
    uint8 public immutable priceDecimals;

    error BadPythPrice(int64 price);
    error UnexpectedExponent(int32 expo, uint8 expected);
    error RefundFailed();

    constructor(address pyth_, bytes32 priceId_, uint8 priceDecimals_) {
        pyth = IPyth(pyth_);
        priceId = priceId_;
        priceDecimals = priceDecimals_;
    }

    function decimals() external view returns (uint8) {
        return priceDecimals;
    }

    /// @notice Chainlink-compatible read of the freshest posted Pyth price.
    /// Round ids are meaningless for a pull oracle and returned as zero;
    /// consumers key their staleness checks off `updatedAt` (= publishTime).
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        IPyth.Price memory p = pyth.getPriceUnsafe(priceId);
        require(p.price > 0, BadPythPrice(p.price));
        require(p.expo == -int32(uint32(priceDecimals)), UnexpectedExponent(p.expo, priceDecimals));
        return (0, int256(p.price), 0, p.publishTime, 0);
    }

    /// @notice Convenience for takers: post a signed Hermes update (paying
    /// Pyth's fee from msg.value, refunding the excess) so the very next call
    /// in the same transaction quotes against a ~400ms-fresh spot.
    function refresh(bytes[] calldata updateData) external payable {
        uint256 fee = pyth.getUpdateFee(updateData);
        pyth.updatePriceFeeds{ value: fee }(updateData);
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{ value: msg.value - fee }("");
            require(ok, RefundFailed());
        }
    }
}
