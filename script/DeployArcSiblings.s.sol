// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Script.sol";

import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { MarginVault } from "../src/periphery/MarginVault.sol";
import { MarginBackstop } from "../src/periphery/MarginBackstop.sol";
import { RfqVault } from "../src/periphery/RfqVault.sol";

/// @notice Add MarginVault (+ backstop, + settlement) and RfqVault (+ settlement)
/// to an EXISTING deployment — used on Arc testnet, where the base stack and
/// SpreadVault were deployed earlier (docs/arc-testnet-deployment.md) and a
/// full redeploy would only burn faucet USDC. Reads the shared addresses from
/// env; seeding the backstop / insurance with real USDC is done afterwards
/// with `cast send` (forge's local simulation cannot execute Arc's native-
/// asset USDC contract).
///
///   PRIVATE_KEY=0x… AQUA=0x… ORACLE=0x… HOOK=0x… TOKEN_FACTORY=0x… WETH=0x… USDC=0x… \
///     forge script script/DeployArcSiblings.s.sol:DeployArcSiblings --rpc-url $ARC_RPC --broadcast
contract DeployArcSiblings is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(key);
        address aqua = vm.envAddress("AQUA");
        address oracle = vm.envAddress("ORACLE");
        address hook = vm.envAddress("HOOK");
        address tokenFactory = vm.envAddress("TOKEN_FACTORY");
        address weth = vm.envAddress("WETH");
        address usdc = vm.envAddress("USDC");
        address dao = vm.envOr("FEE_RECIPIENT", deployer);

        vm.startBroadcast(key);

        MarginVault mv = new MarginVault(aqua, oracle, hook, deployer, tokenFactory, usdc);
        AquaOptionSettlement marginSettlement = new AquaOptionSettlement(deployer, deployer, oracle);
        marginSettlement.setRegistrar(address(mv));
        mv.setSettlement(address(marginSettlement));
        MarginBackstop backstop = new MarginBackstop(usdc, address(mv));
        mv.setBackstop(address(backstop));
        mv.setPricingDefaults(50, 25, 0.001e18);
        mv.setProtocolFee(0.01e9);
        mv.setFeeSplit(5000, 3000, dao);
        mv.setNotionalCeiling(250_000e6);

        RfqVault rfq = new RfqVault(aqua, oracle, hook, deployer, tokenFactory, weth, usdc);
        AquaOptionSettlement rfqSettlement = new AquaOptionSettlement(deployer, deployer, oracle);
        rfqSettlement.setRegistrar(address(rfq));
        rfq.setSettlement(address(rfqSettlement));
        rfq.setPricingDefaults(50, 25, 0.001e18);
        rfq.setProtocolFee(0.01e9, dao);

        vm.stopBroadcast();

        console.log("NEXT_PUBLIC_MARGIN_VAULT=%s", address(mv));
        console.log("NEXT_PUBLIC_MARGIN_BACKSTOP=%s", address(backstop));
        console.log("NEXT_PUBLIC_MARGIN_SETTLEMENT=%s", address(marginSettlement));
        console.log("NEXT_PUBLIC_RFQ_VAULT=%s", address(rfq));
        console.log("RFQ_SETTLEMENT=%s", address(rfqSettlement));
    }
}
