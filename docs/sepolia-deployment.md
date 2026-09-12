# Sepolia deployment (EthOnline 2026)

Chain id `11155111`, explorer `https://sepolia.etherscan.io`. Deployed
2026-09-10 from `script/Deploy.s.sol`'s Sepolia branch by the throwaway
key `0x28166755D70ee84C78B6D4B716a180884f176bf1` (faucet-funded by the
maintainer), 31 transactions in blocks 11,677,088–11,677,133, 28,030,578
gas at 1.4 gwei ≈ 0.034 ETH. This is the deployment the Graph Studio
subgraph `smile-sepolia` indexes ([subgraph/README.md](../subgraph/README.md)).
It supersedes the older Sepolia addresses the README listed before the
event (that vault predated LP ranges and never emitted an event).

## What's real here

- **USDC** is Circle's Sepolia USDC, **WETH** the canonical Sepolia WETH,
  and the **spot / settlement oracle** is the real Chainlink ETH/USD feed
  — no mocks. `Aqua` is the official registry contract, deployed fresh
  (1inch has no canonical Sepolia deployment).

## Addresses

| Contract | Address | Deploy tx |
|---|---|---|
| USDC (Circle) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | — |
| WETH (canonical) | `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` | — |
| Chainlink ETH/USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` | — |
| Aqua (official registry) | `0x915Bc53936Ecb14A18dB8270A4a648E8dE248749` | `0xa065b925…ecde9d` |
| SmileSwapVMRouter | `0x44E2213838913aeC52410ec815b07D15Fcf0a72c` | `0xc28e0bce…d22c5b` |
| OptionPricingEngine | `0x681Bd7583B6612FFf1539781e8d5d7Db565994B3` | `0xa3627b12…657809` |
| OptionPricingHook | `0xCa84Df6F9317FABDE1fD21f4bee25Cb2a8ba1676` | `0xe1843706…141ed5` |
| OptionTokenFactory | `0x2779f5ea01133ab04ee772c52a8ce83a2aa4fdf1` | `0xad39e488…0b147e` |
| AquaCollateralVault | `0x82AcBBFE5E03510d5407d8C50435B08e6d2d0a4D` | `0x05da133c…e3c702` |
| AquaOptionSettlement | `0x17aAAf612cB5b7b3749Cf22b0b2e0CB1AdA77ca1` | `0xf06d30ef…f59d73` |
| FirmEscrowFactory | `0x410f2EB8a70724C3c541381c4155a2158c149559` | `0xf56143f5…c58628` |
| SmileQuoteLens | `0xad1cE2065f1588caFB6BA6176D1b87cf4Ec7B8D6` | `0x80c268fe…908eb9` |
| SpreadVault (S12) | `0x94eE3E1747e96fd643f464ae42db5899Ce878391` | `0x7d7131d7…f202c6` |
| SpreadVault's AquaOptionSettlement | `0xd4398883d17fde31fa4a31081e4f7ad82fb93cb5` | `0xa82a05ca…db87b469` |
| MarginVault (S13) | `0x23F9a08F44fBBCABe9Fdf0d458f226ABb3A84742` | `0x9393cf73…ef8f2d` |
| MarginVault's AquaOptionSettlement | `0x04D174775d651ecB467C70A31166C491aB69FDE9` | `0xf4749415…697bda` |
| MarginBackstop | `0x6eEE1ec5F1AFA7Fb8353016a50fBA9C50791FdA2` | `0x9e6666eb…310565` |

Full hashes: `broadcast/Deploy.s.sol/11155111/run-latest.json`.

## Demo transactions

Sepolia spot was $2,462.84 (Chainlink) at the time.

| Step | Tx |
|---|---|
| Wrap 0.02 ETH → WETH | `0x1bc129b0e3de453a246f168ed69832395c0701a6a65af751b4071a6b7f48920c` |
| `authorizeRange` #0 — calls $2,300–$2,800, 30 days, 0.02 WETH cap, USDC premium (the fills below are the deployer buying from this range — self-fills, see limitations L15) | `0x98e4e922e57d7fad0902089767c7b108e6485c03527c4c00f90f8e68a59d03e7` |
| `Aqua.ship` | `0x878d8bb535045acb4c20da3ae491e681c1e7c8993ac4479476168eec2a2227c1` |
| USDC approvals (vault, Aqua) — 20 USDC from Circle's faucet | `0x6030d3e3…f004e4`, `0x4f7c2e62…8fc5bf` |
| `buy` 0.01 units of the $2,500 call → OptionToken `0x4C4619A1DA2a0C5764C4E73cd68dc6415DDF4FA2` | `0x505285ff96be5a576a4c1895a163cc462d777517a8c421989b504cb3701c7bca` |

The fill pulled **0.01 WETH JIT from the LP wallet** through the official
Aqua registry at the moment of the buy — the collateral had sat in the
wallet since `ship`. Deployer = LP = buyer = fee recipient here, so the
premium circled back and the wallet's USDC did not move.

The Studio subgraph picks the `RangeAuthorized` event up as
`Authorization` `#0` and the `OptionBought` event as a `Fill`, refreshing
`usedCollateral` / `active` from the vault with a bound call.

Gotcha: the covered-call buy needs the **LP's USDC approved to Aqua** as
well as the buyer's USDC approved to the vault — the router pushes the
premium into the LP wallet via Aqua — or it reverts `SafeTransferFromFailed`.
`script/arc-smoke.sh` does both.

## Running the app against it

Copy `.env.sepolia.example` (repo root) to `frontend/.env.local`, keeping
your copilot keys, restart the frontend, and pick Sepolia in the network
menu. Set `NEXT_PUBLIC_SUBGRAPH_URL` to the Studio query URL to have the LP
dashboard and the copilot read from The Graph instead of RPC scans.

## Gotchas learned here

- Pinning `--with-gas-price` below the next block's base fee makes
  `cast send` fail with "max fee per gas less than block base fee" and
  makes gas *estimation* of the following call return a garbage revert;
  let cast use the node's suggestion on Sepolia.
- `graph build --network sepolia` rewrites `subgraph.yaml` in place;
  `git checkout subgraph/subgraph.yaml` after deploying keeps the manifest
  on `localhost` as `networks.json` intends.
