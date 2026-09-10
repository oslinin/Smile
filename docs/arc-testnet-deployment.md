# Arc testnet deployment

Circle's Arc testnet, chain id `5042002`, RPC `https://rpc.testnet.arc.network`,
explorer `https://testnet.arcscan.app`. Plan: [plans/2026-09-10-arc-bounty.md](./plans/2026-09-10-arc-bounty.md).
Deployed 2026-09-10 from `script/Deploy.s.sol`'s Arc branch by a
throwaway faucet-funded key (`0x28166755D70ee84C78B6D4B716a180884f176bf1`);
the full stack cost ~0.46 USDC in gas.

## What's real and what's mock here

- **USDC is Circle's real Arc USDC** — `0x3600000000000000000000000000000000000000`,
  the 6-decimal ERC-20 view of the chain's native asset. Premiums,
  protocol fees, and put collateral all move in it, and gas is paid from
  the same balance. That is the point of deploying here.
- **WETH is a mock** (`MockERC20`, freely mintable): Arc has no canonical
  WETH.
- **The ETH/USD spot oracle is a mock** (`MockV3Aggregator`, set to $3,000):
  no Chainlink-compatible ETH/USD or EUR/USD feed is documented on Arc
  testnet as of this deploy (Pyth doesn't list Arc; Chainlink/RedStone show
  nothing; Stork has a pull-model contract at
  `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` that would need an adapter).
  Settlement uses the same mock feed.

## Addresses

| Contract | Address |
|---|---|
| USDC (Circle, native ERC-20 view) | `0x3600000000000000000000000000000000000000` |
| WETH (mock) | `0x9A963e6D53b70C2a6F0F90C0E98877a97B9e0abe` |
| Aqua (self-deployed official registry) | `0x641970C7D4534d983Aa7BB9E2c7700ea3007bb7d` |
| SmileSwapVMRouter | `0x8B295cfB8276b5044A95b4b8BA9eFa28b8F17cA5` |
| Spot oracle (mock ETH/USD) | `0xd525D62124874B690942cfEef78fdC44AD08Eaf4` |
| OptionPricingEngine | `0x9BaA6F9EED3C1Cb0BB50222a2Ba65edfC15eBe1C` |
| OptionPricingHook | `0xD7fa0D0adA4afBcaBD16376Ee0Bf8e37dfafDb8A` |
| AquaCollateralVault | `0xE37ED711F7D1dc5aC045206b4A6367C55229C789` |
| AquaOptionSettlement | `0xA52Dc13F4E05807bB316Bc39604cC099Cc7B29af` |
| SmileQuoteLens | `0x009d818CeBEB8a6F11d6f73912794D638bcf080b` |
| FirmEscrowFactory | `0xC59C38081bDaDd08f32F024C2588D40705953dFa` |
| SpreadVault (S12) | `0x70E2639b5F374eB023aFaaC0647b0bDee84A227e` |

Transaction hashes are in `broadcast/Deploy.s.sol/5042002/run-latest.json`.

## Running the app against it

Copy `.env.arc.example` (repo root) to `frontend/.env.local` (keeping your
copilot keys), restart the frontend, and pick "Arc Testnet" in the network
menu — MetaMask will offer to add the chain. Faucet: https://faucet.circle.com
(20 USDC per address every 2 hours; that USDC is both gas and premium
money). Mint yourself mock WETH for the LP side with
`cast send <WETH> "mint(address,uint256)" <you> 10ether`.

## Demo transactions

`script/arc-smoke.sh` runs authorize → ship → buy on the main vault and
open → ship → buy on the SpreadVault as plain `cast send` transactions.
It exists because `forge script`'s local pre-broadcast simulation cannot
execute Arc's native-asset USDC contract (`StackUnderflow` in revm), while
the node — and MetaMask — execute it fine.

Run on 2026-09-10 with `UNITS=1e16` (0.01 units, faucet-sized), deployer
as LP, buyer, and fee recipient:

| Step | Tx |
|---|---|
| `authorizeRange` (calls $2,800–$3,200, 5 WETH cap, real-USDC premium) | `0x586eb3a4e3ecefb443bc2303bf42332ab425b352be9c4398adb28a03ebaa6aae` |
| `Aqua.ship` | `0xf2d8c6b5dfc00774faef9c3019576bba80780b7005a8a6e368856e66f55ab7d9` |
| `buy` 0.01 units @ $3,000 → OptionToken `0x9b12225DF5455D7DAb5AA91b6625297B4BE3e128` | `0x3563dc099723ccd01d7953160a598e8a5a82fdd3cbbae6840593f2caf245989a` |
| `SpreadVault.openStructure` (3000/3200 call credit) | `0xfda949cd1fee67410ac441edeaebed9c96519d732e0a91efc61b1fc12fdcb920` |
| `Aqua.ship` (spread) | `0x1e6f39cd55134b8399eef27771588874c63b24f1cfccbd24705c2354471a4e98` |
| `SpreadVault.buy` 0.01 units → SpreadToken `0xFAEed3C80eC8e8A353F19785C9673d4aC124ea70` | `0x73a8e48888b4fe77969fdcc05b6cb51c529d0ab80c4f40ff6f2f1991fe0996a5` |

The spread fill pulled **0.000625 WETH** from the writer; a naked short
leg would have locked 0.01 WETH — the S12 16× on Arc. Its quoted premium
was the vault's 1 USDC floor (0.01 units of a ~45 USDC/unit spread is
below it), fee 0.010102 USDC. The whole run cost about 0.07 USDC net
because premium and fee circle back to the same address; only gas is
consumed.

## Gotchas learned here

- Arc's RPC returns `"Blocked address"` for at least one well-known
  Anvil/Hardhat default key. Always use a fresh key on Arc.
- `forge script` against Arc works for deploys that don't call USDC, and
  fails in local simulation for anything that does — use `cast send`.
- The faucet's 20 USDC is the native balance *and* the ERC-20 balance;
  spending premium reduces the gas balance and vice versa.
