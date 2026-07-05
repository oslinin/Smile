// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { OptionToken } from "../src/OptionToken.sol";

/// @notice Demo of the full official-Aqua trade loop against a running node:
///   LP:    approve Aqua → authorizeRange → Aqua.ship (collateral stays in wallet)
///   Buyer: approve vault → buy (SwapVM prices premium, Aqua pushes premium
///          into the LP wallet and pulls collateral JIT into the vault)
///
/// Env: PRIVATE_KEY (LP/deployer), BUYER_KEY, VAULT, AQUA, WETH, USDC.
contract DemoTrade is Script {
    function run() external {
        uint256 lpKey     = vm.envUint("PRIVATE_KEY");
        uint256 buyerKey  = vm.envUint("BUYER_KEY");
        address lp        = vm.addr(lpKey);
        address buyer     = vm.addr(buyerKey);

        AquaCollateralVault vault = AquaCollateralVault(vm.envAddress("VAULT"));
        IAqua aqua  = IAqua(vm.envAddress("AQUA"));
        IERC20 weth = IERC20(vm.envAddress("WETH"));
        IERC20 usdc = IERC20(vm.envAddress("USDC"));

        uint256 maxCollateral = 5e18;
        uint256 expiry = block.timestamp + 30 days;

        // ── LP: authorize a $2500–$3500 covered-call range and ship it ───────
        vm.startBroadcast(lpKey);
        weth.approve(address(aqua), maxCollateral);
        uint256 authId = vault.authorizeRange(
            2500e18, 3500e18, expiry, maxCollateral, address(weth), address(usdc), true
        );
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            vault.getShipParams(authId);
        aqua.ship(app, strategy, tokens, amounts);
        vm.stopBroadcast();

        console.log("LP shipped range authId=%s to official Aqua app=%s", authId, app);
        console.log("  LP WETH (still in wallet): %s", weth.balanceOf(lp));

        // ── Buyer: purchase a 3000-strike call, priced by the SwapVM opcode ──
        vm.startBroadcast(buyerKey);
        usdc.approve(address(vault), type(uint256).max);
        (address optionToken, uint256 premiumPaid) = vault.buy(authId, 3000e18, 1e18, type(uint256).max);
        vm.stopBroadcast();

        console.log("Buyer bought 1 CALL-3000, premium (USDC 6-dec): %s", premiumPaid);
        console.log("  optionToken: %s", optionToken);
        console.log("  buyer option balance:  %s", OptionToken(optionToken).balanceOf(buyer));
        console.log("  vault WETH escrow:     %s", weth.balanceOf(address(vault)));
        console.log("  LP WETH after JIT pull:%s", weth.balanceOf(lp));
        console.log("  LP USDC premium:       %s", usdc.balanceOf(lp));
    }
}
