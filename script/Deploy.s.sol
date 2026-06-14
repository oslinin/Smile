// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/swapvm/OptionPricingEngine.sol";
import "../src/OptionToken.sol";
import "../src/vaults/AquaCollateralVault.sol";
import "../src/vaults/AquaOptionSettlement.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address creForwarder = vm.envOr("CRE_FORWARDER", deployer); // default to deployer for local testing

        vm.startBroadcast(deployerKey);

        // 1. Pricing engine (stateless — no owner needed)
        OptionPricingEngine engine = new OptionPricingEngine();

        // 2. Aqua collateral vault
        AquaCollateralVault vault = new AquaCollateralVault(address(engine), deployer);

        // 3. Settlement contract (CRE forwarder writes final price)
        AquaOptionSettlement settlement = new AquaOptionSettlement(creForwarder, deployer);

        // 4. Example option: ETH $3500 CALL, 30 days from now
        OptionToken exampleOption = new OptionToken(
            "ETH-3500-CALL-30D",
            "oETH-C-3500",
            vm.envOr("WETH_ADDRESS", address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2)),
            3500e6,                         // strike: $3500 USDC (6 dec)
            block.timestamp + 30 days,
            true,                           // isCall
            address(vault)                  // vault is the owner → can mint/burn
        );

        vm.stopBroadcast();

        // Print addresses for .env.local
        console.log("NEXT_PUBLIC_PRICING_ENGINE=%s", address(engine));
        console.log("NEXT_PUBLIC_AQUA_VAULT=%s", address(vault));
        console.log("NEXT_PUBLIC_SETTLEMENT=%s", address(settlement));
        console.log("EXAMPLE_OPTION_TOKEN=%s", address(exampleOption));
    }
}
