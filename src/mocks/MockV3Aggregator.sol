// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Chainlink AggregatorV3 mock — the settable spot-price
/// source for local Anvil runs and Foundry tests. Keeps full round history so
/// permissionless round-bracketed settlement can be exercised. On forks /
/// testnets the real Chainlink ETH/USD feed address is used instead.
contract MockV3Aggregator {
    uint8 public immutable decimals;
    string public constant description = "Mock ETH / USD";
    uint256 public constant version = 1;

    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint80 public latestRound;
    mapping(uint80 => Round) public rounds;

    constructor(uint8 decimals_, int256 initialAnswer) {
        decimals = decimals_;
        latestRound = 1;
        rounds[1] = Round({answer: initialAnswer, updatedAt: block.timestamp});
    }

    function setAnswer(int256 newAnswer) external {
        latestRound += 1;
        rounds[latestRound] = Round({answer: newAnswer, updatedAt: block.timestamp});
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        Round memory r = rounds[latestRound];
        return (latestRound, r.answer, r.updatedAt, r.updatedAt, latestRound);
    }

    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        Round memory r = rounds[roundId];
        require(r.updatedAt != 0, "No data present"); // mirrors the Chainlink proxy
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}
