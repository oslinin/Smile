// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { OptionToken } from "../src/OptionToken.sol";

/// @notice Seeds a trade tape so the price chart and the copilot's opportunity
/// finder have fills to read. Batch 0 ships three ranges from the LP (30d
/// calls, 60d calls, 30d puts around spot); every batch then has the buyer
/// hit pseudo-random strikes/sizes, selling part of a position back about one
/// time in six. script/seed-tape.sh runs the batches and moves time + the
/// mock oracle between them.
///
/// Env: PRIVATE_KEY (LP), BUYER_KEY, VAULT, AQUA, WETH, USDC,
///      SEED_TRADES (100), SEED_BATCH (0), SEED_BATCHES (1).
contract SeedTape is Script {
    uint256 private rng;

    /// @dev Knuth LCG: the tape is reproducible for a given batch number, and
    /// identical in forge's local run and the broadcast (no block-dependent input).
    function rnd(uint256 n) internal returns (uint256) {
        unchecked { rng = rng * 6364136223846793005 + 1442695040888963407; }
        return (rng >> 33) % n;
    }

    function run() external {
        uint256 lpKey    = vm.envUint("PRIVATE_KEY");
        uint256 buyerKey = vm.envUint("BUYER_KEY");
        address buyer    = vm.addr(buyerKey);
        AquaCollateralVault vault = AquaCollateralVault(vm.envAddress("VAULT"));
        IAqua aqua  = IAqua(vm.envAddress("AQUA"));
        IERC20 weth = IERC20(vm.envAddress("WETH"));
        IERC20 usdc = IERC20(vm.envAddress("USDC"));
        uint256 trades  = vm.envOr("SEED_TRADES", uint256(100));
        uint256 batch   = vm.envOr("SEED_BATCH", uint256(0));
        uint256 batches = vm.envOr("SEED_BATCHES", uint256(1));
        rng = batch + 1;

        // Strikes track the oracle so the tape stays near the money whatever
        // spot the deploy (or a previous random walk) left behind.
        (, int256 answer,,,) = vault.oracle().latestRoundData();
        uint256 spot = uint256(answer) * 1e18 / 10 ** vault.oracle().decimals();

        uint256 base;
        if (batch == 0) {
            // Caps scale with the tape so a bigger SEED_TRADES never hits
            // capacity: 100 trades → 20 WETH per call range, 60k USDC for puts.
            uint256 callCap = trades * 0.2e18;
            uint256 putCap  = trades * 600e6;
            base = vault.nextAuthId();
            vm.startBroadcast(lpKey);
            weth.approve(address(aqua), type(uint256).max);   // JIT collateral pulls
            usdc.approve(address(aqua), type(uint256).max);   // put collateral + Bid pulls on sellbacks
            weth.approve(address(vault), type(uint256).max);  // firmness bonds are taken at authorize time
            usdc.approve(address(vault), type(uint256).max);
            vault.authorizeRange(grid(spot * 95 / 100), grid(spot * 125 / 100), block.timestamp + 30 days, callCap, address(weth), address(usdc), true);
            vault.authorizeRange(grid(spot * 95 / 100), grid(spot * 125 / 100), block.timestamp + 60 days, callCap, address(weth), address(usdc), true);
            vault.authorizeRange(grid(spot * 75 / 100), grid(spot * 105 / 100), block.timestamp + 30 days, putCap, address(usdc), address(usdc), false);
            for (uint256 i = 0; i < 3; i++) {
                (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) = vault.getShipParams(base + i);
                aqua.ship(app, strategy, tokens, amounts);
            }
            vm.stopBroadcast();
        } else {
            // Later batches assume the seed ranges are the last three authorized.
            base = vault.nextAuthId() - 3;
        }

        uint256 n = trades / batches + (batch == batches - 1 ? trades % batches : 0);
        address[] memory bought = new address[](n);
        uint256 nBought; uint256 buys; uint256 sells;

        vm.startBroadcast(buyerKey);
        usdc.approve(address(vault), type(uint256).max);
        for (uint256 i = 0; i < n; i++) {
            if (nBought > 0 && rnd(6) == 0) {
                address tok = bought[rnd(nBought)];
                uint256 bal = OptionToken(tok).balanceOf(buyer);
                if (bal > 0) {
                    vault.close(tok, vm.addr(lpKey), bal * (25 + rnd(51)) / 100, 0);
                    sells++;
                    continue;
                }
            }
            uint256 authId = base + rnd(3);
            (,uint256 lo, uint256 hi,,,,,,,,,,,,,,) = vault.authorizations(authId);
            uint256 strike = lo + rnd((hi - lo) / 50e18 + 1) * 50e18;
            (address tok,) = vault.buy(authId, strike, (10 + rnd(291)) * 1e15, type(uint256).max);
            if (tok != address(0)) { bought[nBought++] = tok; buys++; }
        }
        vm.stopBroadcast();

        console.log("seed: %s buys, %s sellbacks, spot $%s", buys, sells, spot / 1e18);
    }

    function grid(uint256 x) internal pure returns (uint256) { return x / 50e18 * 50e18; }
}
