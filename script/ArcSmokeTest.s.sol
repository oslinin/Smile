// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// One-off compatibility smoke test for Arc testnet — NOT part of the
// protocol's deploy flow. Authorizes a call range, ships it through the
// official Aqua registry, then buys against it, exactly mirroring
// CrossAddressVisibilityTest's _lpShipsCallRange but as real broadcast txs.
// Delete once the Arc port has real tests of its own.
import "forge-std/Script.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";

contract ArcSmokeTest is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(key);

        address vaultAddr = vm.envAddress("VAULT");
        address wethAddr = vm.envAddress("WETH");
        address usdcAddr = vm.envAddress("USDC");
        address aquaAddr = vm.envAddress("AQUA");

        AquaCollateralVault vault = AquaCollateralVault(vaultAddr);
        Aqua aqua = Aqua(aquaAddr);
        ERC20 usdc = ERC20(usdcAddr);

        vm.startBroadcast(key);

        // Collateral allowance for the JIT pull. Without it the buy takes the
        // S2 firmness path and returns (address(0), 0) instead of reverting —
        // easy to misread as success in a log.
        ERC20(wethAddr).approve(aquaAddr, type(uint256).max);
        // This single address plays LP, buyer, AND protocol-fee recipient in
        // this smoke test, so it needs an Aqua allowance for USDC too (the
        // fee leg pulls from the fee recipient's own Aqua-registered balance).
        usdc.approve(aquaAddr, type(uint256).max);

        uint256 authId = vault.authorizeRange(
            2800e18, 3200e18, block.timestamp + 30 days, 5e18, wethAddr, usdcAddr, true
        );
        console.log("authId:", authId);

        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            vault.getShipParams(authId);
        for (uint256 i = 0; i < amounts.length; i++) {
            console.log("ship token:", tokens[i]);
            console.log("ship amount:", amounts[i]);
        }
        aqua.ship(app, strategy, tokens, amounts);
        console.log("shipped ok");

        usdc.approve(vaultAddr, type(uint256).max);
        // UNITS lets a real-USDC chain (Arc) buy a fraction of a contract from
        // a faucet-sized balance; defaults to one whole unit.
        uint256 units = vm.envOr("UNITS", uint256(1e18));
        (address optionToken, uint256 premiumPaid) = vault.buy(authId, 3000e18, units, type(uint256).max);
        console.log("bought ok, optionToken:", optionToken);
        console.log("premiumPaid:", premiumPaid);

        vm.stopBroadcast();
    }
}
