// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// S12 SpreadVault walkthrough as real broadcast transactions (Anvil or any
// fork): an LP opens and ships a 3000/3200 call credit spread, a taker buys
// one unit, and the script prints the number the whole design exists for —
// the WETH actually pulled from the writer's wallet versus what the main
// vault would lock for the naked short leg.
//
//   PRIVATE_KEY=<lp key> BUYER_KEY=<taker key> \
//   SPREAD_VAULT=... AQUA=... WETH=... USDC=... \
//   forge script script/SpreadDemo.s.sol:SpreadDemo --rpc-url http://localhost:8545 --broadcast
import "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { SpreadVault } from "../src/periphery/SpreadVault.sol";
import { SpreadToken } from "../src/periphery/SpreadToken.sol";

contract SpreadDemo is Script {
    uint256 constant K1 = 3000e18;
    uint256 constant K2 = 3200e18;
    function run() external {
        uint256 lpKey = vm.envUint("PRIVATE_KEY");
        uint256 buyerKey = vm.envUint("BUYER_KEY");
        address lp = vm.addr(lpKey);
        address buyer = vm.addr(buyerKey);
        // UNITS lets a real-USDC chain (Arc) buy a fraction of a contract from
        // a faucet-sized balance; defaults to one whole unit, capacity for two.
        uint256 units = vm.envOr("UNITS", uint256(1e18));

        SpreadVault spread = SpreadVault(vm.envAddress("SPREAD_VAULT"));
        Aqua aqua = Aqua(vm.envAddress("AQUA"));
        IERC20 weth = IERC20(vm.envAddress("WETH"));
        IERC20 usdc = IERC20(vm.envAddress("USDC"));

        // S12 table: (K2-K1)/K2 WETH per unit, ceil — same math as SpreadVault.quote().
        uint256 capacity = Math.mulDiv(2 * units, K2 - K1, K2, Math.Rounding.Ceil);

        // ── LP: open + ship. Collateral stays in the LP wallet. ──────────
        vm.startBroadcast(lpKey);
        uint256[4] memory strikes;
        strikes[2] = K1;
        strikes[3] = K2;
        uint256 authId = spread.openStructure(SpreadVault.Kind.CallCredit, strikes, block.timestamp + 30 days, capacity);
        weth.approve(address(aqua), capacity);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            spread.getShipParams(authId);
        aqua.ship(app, strategy, tokens, amounts);
        vm.stopBroadcast();
        console.log("opened + shipped call credit spread, authId:", authId);
        console.log("  capacity shipped to Aqua (WETH wei):", capacity);

        // ── Taker: quote + buy one unit ───────────────────────────────────
        (uint256 premium, uint256 fee, uint256 escrow) = spread.quote(authId, units);
        uint256 lpWethBefore = weth.balanceOf(lp);
        uint256 lpUsdcBefore = usdc.balanceOf(lp);

        vm.startBroadcast(buyerKey);
        usdc.approve(address(spread), premium + fee);
        (address token, uint256 paid) = spread.buy(authId, units, premium + fee);
        vm.stopBroadcast();

        console.log("bought 1 unit, SpreadToken:", token);
        console.log("  taker paid (USDC 6-dec):", paid);
        console.log("  writer received premium (USDC 6-dec):", usdc.balanceOf(lp) - lpUsdcBefore);
        console.log("  WETH pulled from writer (wei):", lpWethBefore - weth.balanceOf(lp));
        console.log("  S12 escrow per quote (wei):", escrow);
        console.log("  main vault would have locked (wei):", uint256(1e18));
        console.log("  taker SpreadToken balance:", SpreadToken(token).balanceOf(buyer));
    }
}
