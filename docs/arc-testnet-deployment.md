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

### Added 2026-09-10 evening — MarginVault and RfqVault (`script/DeployArcSiblings.s.sol`)

Deployed against the existing Aqua / oracle / hook / token factory above,
≈0.58 USDC of gas:

| Contract | Address |
|---|---|
| MarginVault (S13) | `0x98AE8EA40e1DB38360a7DE4e547F1Ccb516415Ce` |
| MarginBackstop | `0x65e3aeDD095b5735C5eeF046AFe107B3552f19a6` |
| MarginVault's AquaOptionSettlement | `0x92e66758Fdd79A592aF2443e7A9Ce299743419aD` |
| RfqVault (R6) | `0x269E7008951A01C38FF46e38f2f51009AC4e1879` |
| RfqVault's AquaOptionSettlement | `0x5a9bA09D24cE39B97B036e5526340a2A66209Ba9` |

With these, the whole capital-efficiency ladder settles in Circle's native
dollar: single-leg puts cash-secured in USDC, spreads, USDC-margined puts
with a USDC backstop pool and insurance fund, and USDC-priced signed quotes.

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
| `buy` 0.01 units @ $3,000 → OptionToken `0x9b12225DF5455D7DAb5AA91b6625297B4BE3e128` (deployer buying from its own range — a self-fill, limitations L15) | `0x3563dc099723ccd01d7953160a598e8a5a82fdd3cbbae6840593f2caf245989a` |
| `SpreadVault.openStructure` (3000/3200 call credit) | `0xfda949cd1fee67410ac441edeaebed9c96519d732e0a91efc61b1fc12fdcb920` |
| `Aqua.ship` (spread) | `0x1e6f39cd55134b8399eef27771588874c63b24f1cfccbd24705c2354471a4e98` |
| `SpreadVault.buy` 0.01 units → SpreadToken `0xFAEed3C80eC8e8A353F19785C9673d4aC124ea70` | `0x73a8e48888b4fe77969fdcc05b6cb51c529d0ab80c4f40ff6f2f1991fe0996a5` |

The spread fill pulled **0.000625 WETH** from the writer; a naked short
leg would have locked 0.01 WETH — the S12 16× on Arc. Its quoted premium
was the vault's 1 USDC floor (0.01 units of a ~45 USDC/unit spread is
below it), fee 0.010102 USDC. The whole run cost about 0.07 USDC net
because premium and fee circle back to the same address; only gas is
consumed.

### Margin + RFQ demo (`script/arc-siblings-smoke.sh`, 2026-09-10, `UNITS=1e15`)

Deployer as LP, taker, keeper and fee recipient; every amount is real USDC.

| Step | Tx |
|---|---|
| Mock oracle fresh round at $3,000 (both vaults refuse a stale mark) | `0x626d16fa6e537090b1744f818fd5da21cf5cd780078494a780298e74855601a1` |
| `MarginBackstop.deposit` 15 USDC (×2 — a retry seeded it twice, pool holds 30) | `0x03325072c0bc846c608ca350ece1d23a783f2b994cdc54b0e757e6f4e609921a` |
| `MarginVault.fundInsurance` 2 USDC (×2, fund holds 4) | `0x7f7078ca5d93c4e2b45bc6f7bb7cf3c78e917c373e071b5c4dbcde0bd51ce351` |
| `MarginVault.openRange` #2 (puts $2,500–$3,500, 20 USDC margin capacity, credit line on) | `0xee51f3ef1c3c4b8dca4dd14fcd8ec276d2eefa15fd9cd917ddf1a02996266b51` |
| `Aqua.ship` (margin) | `0x5c7f04b85b088439cb2c438ca0f8759208c843a68bb272715e6d9cd900562910` |
| `MarginVault.buy` 0.001 units of the $3,000 put → **1.50 USDC of initial margin pulled, not the 3.00 USDC strike** | `0x0938c5be639e8daf30b88d15b82d5ec80dd5d3a68096e5b796051f00791a4d02` |
| `RfqVault.openRange` #2 (calls $2,500–$3,500, 0.001 WETH) | `0x5530984206e05c0941ded25090cbe9b583f0bcd350c746771c6b170b085b79cb` |
| `Aqua.ship` (RFQ) | `0xbbc25b0de20abcfb74af777749a5f0f96a87be3d2b5eff2fb682dac675f2f9c0` |
| `RfqVault.fill` — LP-signed EIP-712 quote 0.688860 USDC vs formula Ask 0.695819; 0.001 WETH pulled JIT → OptionToken `0xff01Be9ff3255d46D2A097E375D5F64469cDB155` | `0x257a8fd1c638dc8590dac048abc12ef85ce78249a3f3df7a6a36d725b89bad29` |

The naked-notional ceiling is `7 × backstop` = 210 USDC; the fill's 1.50 USDC
of naked notional sits well under it. Sizes are faucet-sized: the deployer
had 39 USDC at the start (half of it the first, mis-routed faucet drop) and
3.17 after seeding, gas and fills.

### Circle App Kits fund the margin tier (2026-09-12)

Two keepers, no treasury private key in the repo (`keeper/backstop-wallet.mjs`,
`keeper/insurance-gateway.mjs`; see `docs/sponsors/arc.md`).

| Step | Tx |
|---|---|
| Deployer → Circle developer-controlled wallet `0x61bd6c48…dc3368`, 1.5 USDC (native transfer, gas + deposit) | `0x2c25a9677d539c1053e419312be679bc85bd470562177c0f7c2ccb223dddcaa4` |
| Wallets kit: `USDC.approve(MarginBackstop)` signed by Circle | `0x95005ec62e608ac6bcf04444409623d9be6b32b7ae33401baf310bc431abc84f` |
| Wallets kit: `MarginBackstop.deposit` 1 USDC — pool 30.002108 → 31.002108 | `0xbfd2db0a0b5f3be1bd8b0bd240859fe95608ee5656420ff5b1312a35706a4d95` |
| Gateway: `GatewayMinter.gatewayMint` on Arc, +2.997032 USDC (3 USDC burn intent from a 5 USDC Gateway balance on the Sepolia domain, attestation `ee4b1e71-…`, fee 0.000001) | `0xa5baa3e5880b59b68c4561298cbf8f107d40591ee8cf9b3d0ec71aadf35fc057` |
| Gateway: `MarginVault.fundInsurance` 2.997032 — fund 4.003514 → 7.000546 | `0xc5493a8e121b52b7e9c6c52ef894ce96cc5a1b3d42e343bfd687b872ec6ac61b` |

Gotcha: Circle's Gateway API reports amounts as decimal strings
(`"5.000000"`), and `/v1/transfer` requires `value + fee ≤ balance`
(a 5 USDC balance could not carry a 5 USDC intent: "required 6"). The
keeper now parses both forms and the run used `AMOUNT=3`.

## Gotchas learned here

- Arc's RPC returns `"Blocked address"` for at least one well-known
  Anvil/Hardhat default key. Always use a fresh key on Arc.
- `forge script` against Arc works for deploys that don't call USDC, and
  fails in local simulation for anything that does — use `cast send`.
- The faucet's 20 USDC is the native balance *and* the ERC-20 balance;
  spending premium reduces the gas balance and vice versa.
- The mock ETH/USD feed does not tick: `MarginVault.buy` (90-minute mark
  staleness) and `RfqVault.formulaQuote` (1-hour spot staleness) both revert
  a few hours after the last `setAnswer`. Post a round first — anyone can.
