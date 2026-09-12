# Circle: Arc, USDC and the Circle App Kits

This page describes how Smile uses Circle's products: the Arc blockchain, the USDC stablecoin on Arc and on Sepolia, and the two Circle App Kits (Gateway and Developer-Controlled Wallets) that fund the margin tier's treasury. It is written for a reader who knows what an option is but has not read the rest of the documentation. Every term of art is defined where it first appears, and a glossary closes the page.

## Summary

Smile is a non-custodial venue for European-style options on ETH. On Circle's Arc testnet, the entire Smile stack is deployed with **Circle's real Arc USDC** as the only dollar in the system. On that chain, USDC is the native gas asset, and the contract at `0x3600000000000000000000000000000000000000` is its ERC-20 view. One balance therefore pays premiums, protocol fees, put collateral, initial margin, backstop-pool deposits, insurance-fund deposits, and transaction gas.

Four vaults are live on Arc and each has executed at least one real fill: the single-leg `AquaCollateralVault`, the defined-risk `SpreadVault`, the margined-put `MarginVault` with its `MarginBackstop` pool, and the signed-quote `RfqVault`. The application serves Arc from the same build as Anvil and Sepolia, and a dedicated subgraph on The Graph indexes the Arc deployment.

Two keeper scripts added on 2026-09-11 use Circle's App Kits to fund the margin tier's safety funds without any private key for the treasury living in this repository: `keeper/insurance-gateway.mjs` moves USDC from Sepolia to Arc through Circle Gateway and deposits it into the insurance fund, and `keeper/backstop-wallet.mjs` operates a Circle developer-controlled wallet on Arc that deposits into the backstop pool.

What is deliberately mock on Arc is stated plainly throughout: wrapped ether (WETH) and the ETH/USD price feed, because Arc testnet has neither a canonical WETH nor a Chainlink-compatible price feed at the time of writing.

## Features used

| Feature | Where in the code | Pre-existing or EthOnline 2026 |
|---|---|---|
| Arc testnet chain branch in the deploy script (real USDC, mock WETH, mock oracle) | `script/Deploy.s.sol`, chain id `5042002` branch | EthOnline 2026 (`108e25d`, `7d409bc`) |
| Full stack deployed on Arc: Aqua registry, router, pricing engine and hook, `AquaCollateralVault`, `AquaOptionSettlement`, `SpreadVault` | `docs/arc-testnet-deployment.md`, `broadcast/Deploy.s.sol/5042002/` | EthOnline 2026 |
| `MarginVault`, `MarginBackstop`, `RfqVault` and their settlement contracts on Arc | `script/DeployArcSiblings.s.sol`, `docs/arc-testnet-deployment.md` | EthOnline 2026 (`588ff9f`) |
| Real-USDC demo transactions as `cast send` calls | `script/arc-smoke.sh`, `script/arc-siblings-smoke.sh` | EthOnline 2026 |
| Arc network entry in the wallet configuration and the per-chain address map | `frontend/config/wagmi.ts`, `frontend/lib/deployments.ts`, `.env.arc.example` | EthOnline 2026 |
| Circle USDC on the Sepolia redeploy (`0x1c7D…7238`) | `docs/sepolia-deployment.md`, `script/Deploy.s.sol` | EthOnline 2026 |
| Arc subgraph `smile-arc-testnet` on The Graph Studio | `subgraph/networks.json`, `frontend/lib/deployments.ts` | EthOnline 2026 (`a2bf596`) |
| Circle Gateway: Sepolia deposit, EIP-712 burn intent, attestation, mint on Arc, `fundInsurance` | `keeper/insurance-gateway.mjs` | EthOnline 2026 (`ad42071`) |
| Circle Developer-Controlled Wallets: entity secret, wallet set, Arc wallet, `approve` + `deposit` into the backstop | `keeper/backstop-wallet.mjs`, `@circle-fin/developer-controlled-wallets` | EthOnline 2026 (`ad42071`) |
| On-chain automation reused on Arc: the auto-roll keeper and the margin keeper | `keeper/roll.mjs`, `keeper/margin.mjs` | Pre-existing (`roll.mjs`); EthOnline 2026 (`margin.mjs`) |
| Yield and treasury flows reused on Arc: One-Click Income presets, the backstop pool | `frontend/components/IncomeOneClick.tsx`, `src/periphery/MarginBackstop.sol` | Pre-existing; EthOnline 2026 |

## Why it is necessary

**A stablecoin-native options venue.** The put side of an options market is a dollar business. A cash-secured put is collateralized with the strike price in dollars, its premium is quoted in dollars, and its settlement pays the holder a dollar amount. Smile already used USDC for premiums, fees and put collateral on every chain. On Arc, the chain's gas asset is also USDC, so the last non-dollar dependency disappears: a put writer or a put buyer holds one asset and needs nothing else to transact. The `MarginVault` extends the same property to the margin tier, where initial margin, the backstop pool and the insurance fund are all USDC as well. The result is a venue whose quote currency is the chain's native dollar, which is the property the phrase "stablecoin-native" is meant to name.

**Real USDC rather than a mock.** Deploying on Arc with a mock USDC would have proven nothing that Anvil does not already prove. The deploy script's Arc branch therefore points at Circle's actual USDC contract, and every recorded fill moved real testnet USDC. The two things that remain mock, WETH and the ETH/USD feed, are mock because Arc testnet does not yet provide real ones; the deploy script and the deployment notes say so explicitly rather than leaving the judge to discover it.

**Treasury custody without a key in the repository.** The margin tier depends on two pools of capital that must be funded by someone: the backstop pool, which absorbs positions nobody bought at auction, and the insurance fund, which is drawn after the backstop. A protocol treasury that funds those pools from a private key stored in a script is a liability. Circle's Developer-Controlled Wallets let the treasury be a wallet that Circle custodies and signs for; the only credential in the operator's possession is an entity secret, and the repository holds neither it nor any private key. Circle Gateway addresses the complementary problem of getting USDC onto Arc from wherever it already sits, without a bridge contract of Smile's own and without a wrapped token.

## Market value add

**For traders.** A buyer of a put on Smile-on-Arc funds one balance, pays the premium and the gas from it, and receives settlement into it. There is no second gas token to acquire and no wrapped asset to unwrap. This is the user experience of a centralized, USD-settled venue such as Deribit's USDC-margined products, delivered by a non-custodial contract on a public chain.

**For liquidity providers.** A put writer's collateral stays in their own wallet until a buyer matches, is pulled just in time through 1inch Aqua, and is denominated in the same asset that pays the writer's premium and gas. A writer on the margin tier posts initial margin instead of the full strike (1.50 USDC instead of 3.00 USDC in the recorded Arc fill), and the capital that protects holders when a writer fails is held in USDC pools funded through Circle's own tooling.

**For the protocol treasury.** The backstop pool is a yield-bearing treasury position: depositors receive shares and earn the absorbed positions' upside, and naked notional across the vault is capped at seven times the pool. Funding it from a Circle-custodied wallet and topping up the insurance fund through Gateway turn "the treasury" from a spreadsheet entry into an auditable set of on-chain transactions originating from a wallet Smile does not hold the key to.

**Compared with USD-settled centralized venues.** Deribit settles its USDC products against an index it computes and holds the customer's collateral. Smile-on-Arc settles against an on-chain price round, holds no customer funds before a match, and lets the customer verify every transfer on the explorer. The comparison is not that Smile is more liquid, which it is not, but that it delivers the same single-currency experience without custody.

## Technical details

### The deploy script's Arc branch

The deploy script selects token and oracle addresses by chain id. On Arc it deploys a mock WETH and a mock ETH/USD aggregator, then points the USDC slot at Circle's real contract.

`script/Deploy.s.sol`

```solidity
} else if (block.chainid == 5042002) {
    // ── Arc testnet: Circle's REAL USDC — the chain's native asset,
    //    6-dec ERC-20 view — for premiums, fees, and put collateral.
    //    No canonical WETH on Arc and no Chainlink-style ETH/USD feed
    //    documented there yet (docs/plans/2026-09-10-arc-bounty.md X1),
    //    so the call-side collateral and the spot oracle stay mock. ──
    vm.startBroadcast(deployerKey);
    MockERC20 arcWeth = new MockERC20("Wrapped Ether", "WETH", 18);
    arcWeth.mint(deployer, 100e18);
    MockV3Aggregator arcOracle = new MockV3Aggregator(8, 3000e8);
    vm.stopBroadcast();
    usdcAddr   = 0x3600000000000000000000000000000000000000; // Arc USDC (docs.arc.io contract addresses)
    wethAddr   = address(arcWeth);
    oracleAddr = address(arcOracle);
```

The full stack cost about 0.46 USDC of gas to deploy on 2026-09-10; the margin and RFQ siblings cost about 0.58 USDC more the same evening. Every address is listed in `docs/arc-testnet-deployment.md`.

### Demo transactions as `cast send`

Foundry's `forge script` simulates every transaction locally before broadcasting. Arc's USDC is a native-asset system contract, and the local simulator (revm) cannot execute it from fetched bytecode; it fails with `StackUnderflow` before anything is sent. The node itself, and MetaMask, execute it without difficulty. The demo scripts therefore use `cast send`, which skips the local simulation.

`script/arc-smoke.sh`

```bash
send() { cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --json "$@" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["transactionHash"], "status", d["status"])'; }
...
echo "authorizeRange (authId $AUTH): $(send $VAULT 'authorizeRange(uint256,uint256,uint256,uint256,address,address,bool)' 2800000000000000000000 3200000000000000000000 $EXPIRY 5000000000000000000 $WETH $USDC true)"
...
echo "buy $UNITS @ 3000: $(send $VAULT 'buy(uint256,uint256,uint256,uint256)' $AUTH 3000000000000000000000 $UNITS $MAX)"
```

The recorded run on 2026-09-10 (deployer as LP, buyer and fee recipient, 0.01 units) produced the following on-chain results, with full hashes in the deployment notes:

| Step | Result |
|---|---|
| `authorizeRange` for calls at $2,800–$3,200 with real-USDC premium | tx `0x586eb3a4…aa6aae` |
| `buy` 0.01 units at $3,000 | `OptionToken` `0x9b12…e128` minted |
| `SpreadVault.openStructure` 3000/3200 call credit, then `buy` 0.01 units | `SpreadToken` `0xFAEe…ea70` minted; 0.000625 WETH pulled where a naked leg would lock 0.01 WETH |
| `MarginBackstop.deposit` and `MarginVault.fundInsurance` seeded in USDC | pool holds 30 USDC, fund holds 4 USDC |
| `MarginVault.buy` 0.001 units of the $3,000 put | 1.50 USDC of initial margin pulled, not the 3.00 USDC strike |
| `RfqVault.fill` of an LP-signed quote at 0.688860 USDC | formula Ask was 0.695819; 0.001 WETH pulled just in time |

### The wallet configuration and address map

The application defines Arc as a chain in the wagmi configuration. The native currency is USDC, shown with 18 decimals in the native view; the ERC-20 view at `0x3600…0000` has 6 decimals.

`frontend/config/wagmi.ts`

```ts
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});
```

One build serves every chain. The connected chain id selects its own contract addresses, subgraph endpoint and explorer from `frontend/lib/deployments.ts`; the Arc entry carries the subgraph URL `https://api.studio.thegraph.com/query/44448/smile-arc-testnet/v0.0.1` and the note "Circle's native USDC — premium, collateral, margin, backstop, and gas". For local development, `.env.arc.example` holds the same addresses and is copied to `frontend/.env.local`.

### Circle Gateway: funding the insurance fund from another chain

Circle Gateway maintains a unified USDC balance: a depositor places USDC into a Gateway wallet contract on any supported chain, signs a burn intent, receives an attestation from Circle, and mints native USDC on the destination chain. The keeper script performs that sequence from Sepolia (domain 0) to Arc (domain 26) and then deposits the minted USDC into `MarginVault.fundInsurance`. No bridge contract of Smile's is involved and no wrapped token is created.

`keeper/insurance-gateway.mjs`

```js
const burnIntent = { maxBlockHeight, maxFee, spec };
const signature = await account.signTypedData({ domain: { name: "GatewayWallet", version: "1" }, types, primaryType: "BurnIntent", message: burnIntent });
const res = await fetch(`${GATEWAY_API}/v1/transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: json([{ burnIntent, signature }]) });
const transfer = await res.json();
if (!transfer.attestation) { console.error("transfer failed:", transfer); process.exit(1); }
console.log(`attestation ${transfer.transferId} · fees ${usd(transfer.fees?.total ?? 0)} USDC`);

// ── 3. mint on Arc, fund the insurance pool ──────────────────────────────────
const before = await arcPub.readContract({ address: ARC.usdc, abi: ERC20, functionName: "balanceOf", args: [account.address] });
const mintHash = await arcWal.writeContract({ address: GATEWAY_MINTER, abi: MINTER, functionName: "gatewayMint", args: [transfer.attestation, transfer.signature], chain: null });
```

Recorded run (2026-09-12): a 5 USDC Gateway balance already on the Sepolia domain carried a 3 USDC burn intent (Gateway requires value plus fee to fit the balance); Circle returned attestation `ee4b1e71-…` with a 0.000001 USDC fee, `GatewayMinter.gatewayMint` credited 2.997032 native USDC on Arc (`0xa5baa3e5…`) and `MarginVault.fundInsurance` took the fund from 4.003514 to 7.000546 USDC (`0xc5493a8e…`).

The script is idempotent in the sense that a Gateway balance already credited on the source domain is spent before a new deposit is made, and it waits for source-chain finality (about nineteen minutes on Sepolia) by polling Circle's balance endpoint. It is run with `PRIVATE_KEY=0x… AMOUNT=5 node insurance-gateway.mjs` from the `keeper` directory.

### Circle Developer-Controlled Wallets: the treasury that funds the backstop

A developer-controlled wallet is an account whose key Circle generates and holds; the developer authorizes transactions through Circle's API using an entity secret that Circle encrypts with the entity's public key. The keeper script registers that secret once, creates a wallet set named "Smile treasury" with one externally owned account on `ARC-TESTNET`, and then submits ordinary contract executions: `USDC.approve(backstop)` followed by `MarginBackstop.deposit`.

`keeper/backstop-wallet.mjs`

```js
// A contract call through Circle: they build, sign and broadcast it; we poll
// until it is on chain and return the hash.
async function exec(walletId, contractAddress, abiFunctionSignature, abiParameters) {
  const { data } = await client.createContractExecutionTransaction({
    walletId, contractAddress, abiFunctionSignature, abiParameters,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  ...
}
...
if (cmd === "deposit") {
  if (balance < amount + 200_000n) { console.error(`wallet holds ${usd(balance)} USDC; needs ${usd(amount)} + gas`); process.exit(1); }
  const before = await pub.readContract({ address: BACKSTOP, abi: POOL, functionName: "totalAssets" });
  const a = await exec(w.walletId, USDC, "approve(address,uint256)", [BACKSTOP, amount.toString()]);
  console.log(`USDC.approve(backstop) → ${EXPLORER}${a}`);
  const d = await exec(w.walletId, BACKSTOP, "deposit(uint256)", [amount.toString()]);
```

Recorded run (2026-09-12): the treasury wallet `0x61bd6c481248f2e5bfd6d0aadf5215f353dc3368`, funded with 1.5 USDC by the deployer (`0x2c25a967…`), submitted `USDC.approve` (`0x95005ec6…`) and `MarginBackstop.deposit` of 1 USDC (`0xbfd2db0a…`), taking the pool from 30.002108 to 31.002108 USDC; both transactions were built, signed and broadcast by Circle. The Margin tab lists them under "Funded through Circle App Kits".

The script has four commands: `setup` (generate and register the entity secret; a recovery file is written next to the script), `wallet` (create or show the Arc wallet), `deposit` (approve and deposit `AMOUNT` USDC into the backstop pool) and `withdraw` (request withdrawal of all shares; `withdraw()` opens after the pool's 24-hour delay). Wallet state lives in `keeper/.circle-wallet.json`; that file, the recovery file and the `.env` holding the API key and entity secret are all ignored by git. The treasury wallet created on 2026-09-12 is `0x61bd6c481248f2e5bfd6d0aadf5215f353dc3368`.

### Arc in the bounty's own vocabulary

The Arc bounty asks for programmable money flows, automation, yield and treasury. Each is an existing Smile flow that runs on Arc unchanged:

- **Conditional payments.** An option is a conditional payment instrument: premium now, payout contingent on the settlement price. Aqua's just-in-time pull is itself conditional: collateral leaves the writer's wallet only when a buyer matches.
- **Multi-step settlement.** Buy, expiry, permissionless `settleWithChainlinkRound`, `redeem`, `reclaimCollateral`, all as Arc transactions paid in USDC.
- **On-chain automation.** `keeper/roll.mjs` settles, reclaims, revokes and re-ships a writer's range at the new spot with no human in the loop; `keeper/margin.mjs` drives margin calls, auctions, absorptions and settlement for the margin tier.
- **Yield and treasury.** One-Click Income presets (covered calls and cash-secured puts with an estimated premium APR) are the yield product; the backstop pool and insurance fund, funded through Circle's App Kits, are the treasury.

### The Arc subgraph

The Graph Studio subgraph `smile-arc-testnet` indexes `AquaCollateralVault` at `0xE37ED711F7D1dc5aC045206b4A6367C55229C789` from block 61,227,750 (`subgraph/networks.json`). On Arc, as on Sepolia, the application and the AI copilot read positions only from The Graph; there is no RPC scan on public networks. The Graph page in this sidebar covers the subgraph in detail.

## Limitations

- **WETH is a mock on Arc.** Arc testnet has no canonical wrapped ether, so the call side's collateral is a freely mintable `MockERC20`. Calls on Arc are therefore demonstrations of the mechanism, not of a market.
- **The ETH/USD price feed is a mock on Arc.** No Chainlink-compatible feed is documented on Arc testnet (Pyth does not list Arc; Chainlink and RedStone show nothing; Arc's contract page lists no oracles). Quoting and settlement both read a `MockV3Aggregator` fixed at $3,000. The mock does not tick, so `MarginVault.buy` (90-minute mark staleness) and `RfqVault.formulaQuote` (one-hour spot staleness) revert a few hours after the last `setAnswer`; anyone may post a fresh round first.
- **`forge script` cannot simulate Arc's USDC.** Deploys that do not call USDC work through `forge script`; anything that calls USDC must be sent with `cast send`. The frontend is unaffected because MetaMask does not simulate locally.
- **No liquidation run on a live chain.** The margined put fill is on Arc, but the crash-to-auction-to-settlement path relies on time warps and lives in the Anvil script `script/margin-lifecycle.sh`.
- **Arc's RPC blocks well-known development keys.** At least one default Anvil/Hardhat key returns `"Blocked address"`; a fresh key is required.
- **Faucet USDC is both gas and balance.** The faucet grants 20 USDC per address every two hours; spending premium reduces the gas balance and the reverse.
- **Both App Kit flows have exactly one recorded run each (2026-09-12).** Gateway moved 2.997032 USDC from a Sepolia deposit into `MarginVault.fundInsurance` (mint `0xa5baa3e5…`, fund `0xc5493a8e…`) and the Circle-custodied treasury wallet `0x61bd…3368` deposited 1 USDC into the backstop (`0xbfd2db0a…`); `docs/arc-testnet-deployment.md` lists every hash. Two details learned on that run are now in the keeper: Circle's Gateway API returns amounts as decimal strings, and a transfer requires value plus fee to fit the Gateway balance, so the 5 USDC balance carried a 3 USDC intent. The treasury wallet holds about 0.5 USDC after the deposit; further deposits need a top-up from the faucet or the deployer.
- **`RfqVault` is on Arc but not on Sepolia.** The Sepolia address map leaves `rfqVault` empty.
- **The gas floor is Arc's to set (L12).** Every first fill in a series pays roughly 1,040,000 gas to deploy the series token and every repeat fill roughly 198,000; on Arc that gas is denominated in USDC, so the minimum economical trade size is a direct function of Arc's gas price. The ~0.46 USDC full-stack deploy suggests the floor is small on testnet; mainnet pricing is unknown until 2026-09-16.
- **Arc mainnet is not live.** Arc mainnet launches on 2026-09-16; every figure on this page is testnet.

## Plans

- **FX options on Arc (USDC/EURC).** Mechanically the same engine pointed at a EUR/USD feed with EURC in the call-collateral slot. Task X1 of the Arc plan found the only oracle with a documented Arc testnet deployment to be Stork (`0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62`), a pull-model oracle that requires an adapter in the shape of the existing `PythSpotAdapter`, an update-posting flow and an API key. It is recorded as the lead for the 2026-09-16 to 2026-09-30 window.
- **Arc mainnet.** Task X6 of the plan is the mainnet deploy of the same script against Arc's mainnet RPC once Circle publishes it, treated with the care of a real-money deploy. The bounty's additional $2,000 for a mainnet deployment is a post-submission follow-up because mainnet launches after the submission deadline.
- **Keep the treasury funded and automate the top-ups.** Both keepers have run once (2026-09-12; hashes in `docs/arc-testnet-deployment.md` and on the Margin tab). The next step is scheduling them: a cron or CRE trigger that tops up the backstop from the Circle wallet when `totalAssets` falls below a floor and refills the insurance fund through Gateway when a haircut draws it down, so the treasury is an automated money flow rather than a manual keeper run.
- **A real feed and real WETH when Arc provides them.** Replacing the two mocks is a one-branch change in `script/Deploy.s.sol`.
- **Gateway onboarding in the application.** Task X4 scopes a frontend flow that lets a user with USDC on another chain act on Smile-on-Arc through Gateway's unified balance rather than a manual bridge step.

## Glossary

- **Arc.** Circle's EVM-compatible blockchain, on which USDC is the native gas asset. The testnet has chain id 5042002, RPC `https://rpc.testnet.arc.network` and explorer `https://testnet.arcscan.app`. Mainnet launches on 2026-09-16.
- **Native USDC (on Arc).** The chain's gas asset. The system contract at `0x3600000000000000000000000000000000000000` exposes it as a 6-decimal ERC-20 token; the native view used by wallets shows 18 decimals.
- **USDC.** Circle's dollar stablecoin. On Sepolia, Smile uses Circle's Sepolia USDC at `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`.
- **EURC.** Circle's euro stablecoin, the intended call-collateral asset for a future FX options product on Arc.
- **Chain id 5042002.** The numeric identifier of Arc testnet, used by the deploy script's branch, the wagmi chain definition and the address map.
- **Faucet.** Circle's testnet faucet at `https://faucet.circle.com`, which grants 20 USDC per address every two hours on Arc testnet.
- **Gateway.** Circle's cross-chain USDC service: a unified balance funded by deposits into a Gateway wallet contract on any supported chain and spent by minting native USDC on a destination chain. Chains are identified by numeric domains; Sepolia is domain 0 and Arc is domain 26 in the keeper script.
- **Gateway wallet and Gateway minter.** The two Gateway contracts: `GatewayWallet` (`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`) receives deposits on the source chain and `GatewayMinter` (`0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`) mints on the destination chain.
- **BurnIntent.** The EIP-712 typed message a depositor signs to authorize Gateway to burn a deposited amount on the source domain and mint it on the destination domain. It carries a transfer specification, a maximum fee and a maximum block height.
- **Attestation.** Circle's signed confirmation, returned by the Gateway API's transfer endpoint, that a burn intent is valid; the attestation and its signature are the arguments to `gatewayMint`.
- **EIP-712.** The Ethereum standard for signing structured, human-readable typed data. Smile uses it for Gateway burn intents and for the RFQ vault's signed quotes.
- **Developer-controlled wallet.** A wallet in Circle's Wallets product whose private key Circle generates and custodies; the developer authorizes transactions through Circle's API.
- **Entity secret.** The 32-byte credential a developer registers with Circle, encrypted with the entity's public key, that authorizes transactions from developer-controlled wallets. Smile keeps it in an ignored `.env` file and never in the repository.
- **Wallet set.** Circle's grouping of developer-controlled wallets under one entity; Smile's is named "Smile treasury".
- **Recovery file.** The file Circle returns when an entity secret is registered, used to recover access if the secret is lost; it is written next to the keeper script and ignored by git.
- **Initial margin.** The amount a put writer on the margin tier must post at fill, computed from the lowest Chainlink answer of the last hour; 1.50 USDC for the recorded Arc fill against a 3.00 USDC strike.
- **Backstop pool.** `MarginBackstop`, a share-based USDC pool that absorbs margined positions nobody bought at auction; naked notional across the vault is capped at seven times its assets.
- **Insurance fund.** A USDC reserve inside `MarginVault`, drawn after the backstop pool and before any haircut, funded through `fundInsurance`.
- **Just-in-time (JIT) pull.** 1inch Aqua's custody model, in which a writer's collateral stays in their wallet until a buyer matches and is then pulled by the vault in the same transaction.
- **cast.** Foundry's command-line tool for sending transactions and calling contracts directly against a node, without local simulation.
- **forge script.** Foundry's scripting runner, which simulates transactions locally in revm before broadcasting them; it cannot execute Arc's native-asset USDC contract.
- **revm.** The Rust EVM implementation Foundry uses for local simulation.
- **Subgraph.** An indexed view of contract events served by The Graph; `smile-arc-testnet` is the one for Arc.
- **One-Click Income.** Smile's covered-call and cash-secured-put presets with an estimated premium APR, the yield product.
- **Keeper.** A script that performs permissionless or self-custodial maintenance transactions on a schedule; Smile ships `roll.mjs`, `margin.mjs`, `insurance-gateway.mjs` and `backstop-wallet.mjs`.
