// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { OptionToken } from "./OptionToken.sol";

/// @notice Deploys OptionToken series for the vault. Split out so the
/// OptionToken initcode is embedded HERE instead of inside the (EIP-170
/// size-constrained) vault — `new OptionToken` inlines ~3.7KB of creation
/// code wherever it appears.
contract OptionTokenFactory {
    function deployOption(
        address collateralToken,
        uint256 strike,
        uint256 expiry,
        bool isCall,
        address vault
    ) external returns (address) {
        return address(new OptionToken(
            string(abi.encodePacked(isCall ? "CALL-" : "PUT-", _uint2str(strike / 1e18))),
            isCall ? "CALL" : "PUT",
            collateralToken,
            strike,
            expiry,
            isCall,
            vault
        ));
    }

    function _uint2str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 digits;
        while (tmp != 0) { digits++; tmp /= 10; }
        bytes memory b = new bytes(digits);
        while (v != 0) { digits--; b[digits] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
