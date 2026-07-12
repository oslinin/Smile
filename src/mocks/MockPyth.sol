// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IPyth } from "../oracles/PythSpotAdapter.sol";

/// @notice Test double for the Pyth pull oracle. `updatePriceFeeds` accepts
/// updates encoded as `abi.encode(bytes32 id, int64 price, int32 expo,
/// uint256 publishTime)` — enough to exercise the post-then-quote flow the
/// real integration uses (Hermes signature verification is out of scope).
contract MockPyth {
    mapping(bytes32 => IPyth.Price) private _prices;
    uint256 public updateFee = 1 wei;

    function setPrice(bytes32 id, int64 price, int32 expo, uint256 publishTime) public {
        _prices[id] = IPyth.Price({ price: price, conf: 0, expo: expo, publishTime: publishTime });
    }

    function getPriceUnsafe(bytes32 id) external view returns (IPyth.Price memory) {
        return _prices[id];
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return updateFee * updateData.length;
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        require(msg.value >= updateFee * updateData.length, "insufficient fee");
        for (uint256 i = 0; i < updateData.length; i++) {
            (bytes32 id, int64 price, int32 expo, uint256 publishTime) =
                abi.decode(updateData[i], (bytes32, int64, int32, uint256));
            setPrice(id, price, expo, publishTime);
        }
    }
}
