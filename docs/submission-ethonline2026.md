# Smile — EthOnline 2026 submission notes

Continuation-track entry. Repo: https://github.com/oslinin/Smile, branch
`EthOnline2026_continuation_track`. Everything on `main` at `5b4cc63` predates
the event (September 5, 2026); everything after is event work — 63 commits,
~22,800 lines added across 99 files, one task per commit so the history
reads as the build log.

The protocol itself — on-chain ETH options where LP collateral stays in the
LP's wallet until a buyer matches, pulled just-in-time through 1inch Aqua,
priced by a custom SwapVM opcode with a Uniswap v4 hook feeding the vol
surface — is described in the [README](../README.md). This page is the
per-bounty pitch and the audit trail a judge can follow.

## What was already there, what the event added

| Pre-existing (`main` @ `5b4cc63`) | Built at EthOnline 2026 |
|---|---|
| `AquaCollateralVault` (single-leg calls and puts, JIT pull through Aqua) | Three sibling Aqua apps: `SpreadVault` (defined-risk netting), `MarginVault` + `MarginBackstop` (opt-in margined puts with a liquidation waterfall), `RfqVault` (LP-signed EIP-712 quotes) |
| `SmileSwapVMRouter` + `OptionPremiumInstruction` (opcode 33), `OptionPricingHook` | `SmilePremiumLib` — the vault's premium math as a library with an `isCall` flag, shared by the new vaults |
| `AquaOptionSettlement` (Chainlink round-verified, CRE keeper) | reused unchanged — one instance per new vault |
| Next.js app: option matrix, LP range authorization, payoff builder, LP dashboard, vol surface, AI copilot | **Overview** (live ladder, receipts), **Spreads / Margin / RFQ / Risk Monitor** tabs, a TradingView-engine price chart with the strategy overlaid, an OptionStrat-grade builder (heat map, three curves, per-vault collateral), one build for Anvil / Sepolia / Arc, tabs in user language; LP dashboard + copilot read from The Graph with RPC fallback; OpenRouter provider; a User Guide the copilot reads |
| A stale v1 Sepolia deployment | The full current stack redeployed on Sepolia (Circle USDC, canonical WETH, Chainlink) with real fills; the full stack on Arc testnet on Circle's native USDC with real fills on every vault |
| 82 Foundry tests | 200 Foundry tests |
| — | `subgraph/` — The Graph subgraph, live on Studio as `smile-sepolia` with real data |
| — | `script/*-lifecycle.sh`, `script/arc-*.sh`, `keeper/margin.mjs`, `deployments/` (every broadcast log) |
| Help site (README, limitations, solutions, reference table) | Continuation Track tracker page, User Guide, copilot help page, S12/S13/L13/R6 entries, submission notes, video walkthrough instructions |

## 1inch — Build an Aqua App: `SpreadVault`

**Pitch.** Smile's core user sells spreads and condors, and the existing vault
margins each leg as if naked: a 3000/3200 call credit spread locks 1 WETH,
its put twin locks 3,200 USDC. `SpreadVault` is a sibling Aqua app in which
the writer's strategy is the spread itself and the escrow pulled through
`Aqua.pull` is the structure's true maximum loss — **0.0625 WETH instead of
1 WETH (16×)** and **200 USDC instead of 3,200**. Collateral still stays in
the writer's wallet until a taker fills; settlement is one price through one
floored formula whose maximum over the settlement price is exactly the
escrow, so the cap never binds and `holder payout + writer reclaim == escrow`
to the wei.

**Qualification checklist.**

- *Official Aqua contracts* — `lib/aqua` vendored unmodified; `SpreadVault`
  extends `AquaApp`, ships with `app = address(this)` and an abi-encoded
  terms blob as the strategy, pulls under `nonReentrantStrategy`.
- *On-chain execution of token transfers in the demo* —
  `script/spread-lifecycle.sh` (Anvil) and `script/arc-smoke.sh` (Arc
  testnet, hashes below) are real transactions, not simulations.
- *Proper git history* — `2b060d2` scaffold → `3bf3bba` premium lib + quote
  → `949eda0` buy pulls exactly the netted escrow → `a5c17eb` Spreads tab +
  demo → `988b329` settle/redeem/reclaim → `8e81839` lifecycle script.

**Code.** `src/periphery/SpreadVault.sol`, `SmilePremiumLib.sol`,
`SpreadToken.sol` · `test/SpreadVault.t.sol` (11) and
`test/SpreadSettlement.t.sol` (10, incl. a 256-run fuzz over the settlement
price) · `frontend/components/SpreadDesk.tsx`.

**Demo numbers (Anvil, `./script/spread-lifecycle.sh`, settlement at
$3,100).** Writer pulled for 62,500,000,000,000,000 wei; holder redeemed
32,258,064,516,129,032; writer reclaimed 30,241,935,483,870,968; sum equals
the escrow, vault balance 0, spread-token supply 0.

**Not done, on purpose.** Iron condors are strike-validated but not priced
or fillable; the optional SwapVM opcode for the call-credit leg was not
attempted.

## 1inch — Build an Aqua App, part two: `MarginVault`

**Pitch.** The other half of the capital-efficiency ladder — the half that
*can* break "a written option always pays", so it is a separate opt-in
Aqua app. A put writer ships a margined range; a fill pulls **initial
margin — 1,500 USDC for an ATM 3000 put, not 3,000** — off the lowest
Chainlink answer in the last hour, never the vol hook (400 sigma bumps
leave margin bit-identical). Below maintenance: the vault sweeps free
balance and an opt-in Aqua credit line before flagging; then a 1 h grace,
a 30-min writer-takeover auction (1→10% bonus, collateral travels with the
position, holder untouched), the backstop pool absorbing what nobody bought,
and at expiry a per-writer waterfall then a series finalization that draws
backstop, then insurance, then — loudly — a haircut with the IM buffer
ratcheting up. Naked notional is capped at 7× the backstop, Maker-style.

**Git history.** `dd687dd` scaffold + vol-buffer ratchet → `69b182e`
worst-of-hour mark + margin rule → `e3254c6` buy pulls only IM →
`927da8e` margin calls → `8e1b413` auction + backstop pool → `0b4508e`
settlement waterfall + haircut → `2de57dc` invariants → deploy/UI/keeper.

**Code.** `src/periphery/MarginVault.sol` (23.5 KB, under EIP-170 without
a split), `MarginBackstop.sol` · `test/MarginVault.t.sol`,
`MarginCall.t.sol`, `MarginAuction.t.sol`, `MarginSettlement.t.sol`
(gap-40: a writer exactly at MM who gaps 40% before settlement — holders
whole from a pool of naked/7, insurance untouched), `MarginInvariants.t.sol`
· `frontend/components/MarginDesk.tsx` · `script/margin-lifecycle.sh` ·
`keeper/margin.mjs`.

**Demo numbers (Anvil, `./script/margin-lifecycle.sh`).** Fill locks
1,500 USDC; crash to $2,000 → MM 1,600 > 1,500 → flag → grace → auction →
backstop absorbs drawing only 175 USDC (MM − what travelled) → settles at
$2,000 → holder redeems exactly 1,000 USDC of intrinsic. `MODE=takeover`:
the bidder posts 725 and holds the position at IM 2,000.

**Not done, on purpose.** Calls (a WETH shortfall has no USDC waterfall
yet), partial-unit takeover, per-range block caps, `close()` (a
sigma-priced buyback paid from margin is exactly L7's attack), a full
liquidation run on a live chain (no time warps there — the fill is on Arc
and Sepolia, the crash → auction → settle path is the Anvil script).
[L13](limitations.md) lists what the tier does not promise.

## 1inch — Build an Aqua App, part three: `RfqVault`

**Pitch.** Tradfi's "NBBO + price improvement" on Aqua. Tier 1 is the
formula surface — permissionless, always live, the fallback. Tier 2: an LP
ships the same kind of range to `RfqVault`, signs EIP-712 quotes in their
wallet (no gas, any pricing model), and a taker fills one; the vault
recovers the signer, checks ttl / size / nonce, and pulls the collateral
JIT through Aqua exactly as tier 1 does — a signed quote changes the
price, never the custody model. Quotes are single-use and cancellable;
no `close()` so holders are never captive to a market maker's uptime.

**Code.** `src/periphery/RfqVault.sol` (12.7 KB) · `test/RfqVault.t.sol`
(8 tests: improved quote fills with 1 WETH pulled JIT, puts cash-secure the
strike, partial fill spends the nonce, wrong signer / oversize / off-range
/ cancelled / expired / tampered revert, ITM call settles with conservation)
· `frontend/components/RfqDesk.tsx` (`useSignTypedData`) ·
`script/rfq-lifecycle.sh` (`cast wallet sign --data` for the typed data).
Commits `6e3a913`, then the wiring commit.

**Demo numbers (Anvil).** Formula Ask 691.93 USDC; signed quote 685.01
(100 bps inside); taker paid 691.93 incl. the 1% fee vs 698.92 on tier 1;
1 WETH left the LP wallet at the fill; the second fill of the same nonce
reverted `QuoteUsed`.

## The Graph — AI tooling / agents on live chain data: `subgraph/`

**Pitch.** The LP dashboard and the AI copilot used to discover LP
authorizations by brute-force `getLogs` + per-id RPC calls, capped at 50 —
past that, both went blind ([L12a](limitations.md)). The subgraph indexes
every `Authorized` / `OptionBought` event into `Authorization` and `Fill`
entities, refreshing live fields (`filled`, `active`) with bound
`authorizations()` calls, so the copilot answers "which ranges are active
and how full are they" from one query.

**Code.** `subgraph/` (schema, `src/vault.ts`, matchstick tests, README) ·
`frontend/lib/subgraph.ts` · `components/LPDashboard.tsx` and
`lib/copilot/chain.ts` read the subgraph when `NEXT_PUBLIC_SUBGRAPH_URL` is
set and fall back to RPC otherwise. Commits `476cb30`, `b818634`.

**Live.** `smile-sepolia` on Graph Studio —
https://thegraph.com/studio/subgraph/smile-sepolia, query endpoint
`https://api.studio.thegraph.com/query/44448/smile-sepolia/v0.0.2` —
indexing the EthOnline 2026 Sepolia deployment of the full stack
([`sepolia-deployment.md`](sepolia-deployment.md): real Circle USDC,
canonical WETH, Chainlink ETH/USD). Authorization #0 (calls $2,300–$2,800,
tx `0x98e4e922…`) was queryable within a minute of `Aqua.ship`
(`0x878d8bb5…`); the `Fill` for a real 0.01-unit $2,500 call
(`0x505285ff…`, 0.01 WETH pulled JIT from the LP wallet, premium 5.636405
USDC) appeared one block after the buy with `usedCollateral` refreshed
through the bound `authorizations()` call; `hasIndexingErrors: false`. A local graph-node was
attempted and abandoned: no arm64 image exists and qemu emulation
segfaults on the build machine — documented in `subgraph/README.md`.

## Arc — Best DeFi Application

**Pitch.** The whole stack, `SpreadVault` included, on Circle's Arc testnet
with **Circle's real Arc USDC** (`0x3600…0000`, the ERC-20 view of the
native asset) as premium, fee, put-collateral and gas token. A DeFi
options venue whose quote currency *is* the chain's native dollar.

**Deployment.** [`arc-testnet-deployment.md`](arc-testnet-deployment.md)
lists every address (Aqua `0x6419…bb7d`, vault `0xE37E…C789`, SpreadVault
`0x70E2…227e`, …). Deploy cost ~0.46 USDC. Commits `108e25d`, `7d409bc`.

**On-chain transactions (2026-09-10, explorer `https://testnet.arcscan.app`).**

| Step | Tx |
|---|---|
| `authorizeRange` calls $2,800–$3,200, real-USDC premium | `0x586eb3a4…aa6aae` |
| `Aqua.ship` | `0xf2d8c6b5…55ab7d9` |
| `buy` 0.01 units → `OptionToken` `0x9b12…e128` | `0x3563dc09…45989a` |
| `SpreadVault.openStructure` 3000/3200 call credit | `0xfda949cd…dcb920` |
| `Aqua.ship` (spread) | `0x1e6f39cd…471e98` |
| `SpreadVault.buy` 0.01 units → `SpreadToken` `0xFAEe…ea70` | `0x73a8e488…e0996a5` |

Full hashes in `arc-testnet-deployment.md`. The spread fill pulled 0.000625
WETH where a naked leg would have locked 0.01 — the same 16× on Arc.

**Added the same evening — MarginVault + RfqVault on Arc** (`0x98AE8EA4…`,
`0x269E7008…`, backstop `0x65e3aeDD…`): the backstop pool and insurance
fund seeded in real USDC, a USDC-margined put fill locking **1.50 USDC
instead of the 3.00 USDC strike** (`0x0938c5be…`), and an LP-signed RFQ
quote filled at 0.688860 vs a 0.695819 formula Ask with 0.001 WETH pulled
JIT (`0x257a8fd1…`). The whole capital-efficiency ladder now settles in
Circle's native dollar on Arc.

**Gotchas that became docs.** `forge script` cannot simulate calls to Arc's
native-asset USDC (`StackUnderflow` in revm) → `cast send` only; Arc's RPC
blocks well-known dev keys; faucet USDC is both gas and premium balance.

**Cut.** USDC/EURC FX options — no Chainlink-compatible FX feed on Arc
testnet (only Stork's pull oracle, which would need an adapter). Arc
mainnet launches Sept 16, so the $2,000 mainnet bonus is a follow-up.

## Third-party services and libraries, in one place

| Layer | Service / library | Role | Pre-existing or event |
|---|---|---|---|
| Liquidity | 1inch **Aqua** (official registry, vendored) | JIT-pull collateral for every vault | pre-existing; three new apps on it |
| Pricing | 1inch **SwapVM** (custom opcode 33) | on-chain premium instruction | pre-existing |
| Vol surface | **Uniswap v4** hook; Uniswap Trading API for live spot in the app | demand-driven sigma; spot readout | pre-existing |
| Oracle | **Chainlink** ETH/USD feed + **Chainlink CRE** keeper | spot, permissionless round-verified settlement, scheduled settlement | pre-existing |
| Oracle (opt-in) | **Pyth** pull oracle (`PythSpotAdapter`) | sub-second spot for quoting | pre-existing |
| Stablecoin | **Circle USDC** (Sepolia), **Circle Arc** testnet + faucet | premium, collateral, margin, backstop; native gas on Arc | Arc: event |
| Indexing | **The Graph** Studio (`smile-sepolia`) | authorizations + fills for the app and the copilot | event |
| AI | Vercel AI SDK with **Anthropic / OpenAI / Google / OpenRouter** | the copilot; OpenRouter added at the event | OpenRouter: event |
| Charting | **TradingView Lightweight Charts** 5.2 (Apache-2.0) | ETH/USD candles with the strategy overlaid | event |
| Market data | **Coinbase** Exchange public candles, **Kraken** OHLC fallback | context for the chart only | event |
| Strategy math | `black-scholes`, `greeks` (MIT), recharts | builder curves, heat map, greeks | pre-existing, extended |

Two things we looked for and did not find worth adopting, so the judges
do not wonder: there is **no open-source OptionStrat** — the closest React
project ([option-payoff](https://github.com/anshuthopsee/option-payoff))
draws expiry payoffs only, and the capable projects
([optionlab](https://github.com/rgaveiga/optionlab),
[opstrat](https://github.com/hashABCD/opstrat)) are Python analytics
without a UI — so the builder stayed in-house and was upgraded instead.
For charting, TradingView's own open-source engine was the right answer;
[OpenCharts](https://github.com/dylanpersonguy/OpenCharts) (MIT) is a
full standalone terminal built on it, not a component.

## Where to look

- Status page: **Help → Continuation Track** in the app
  (`docs/continuation-track-reference.html`), one row per task, flipped as
  they landed.
- Plans and scope decisions: [`plans/2026-09-10-ethonline26-bounties.md`](plans/2026-09-10-ethonline26-bounties.md)
  → [SpreadVault/MarginVault](plans/2026-09-05-ethonline2026-continuation-track.md),
  [The Graph](plans/2026-09-09-theGraph.md), [Arc](plans/2026-09-10-arc-bounty.md).
- Run it: `./local.sh` then `./script/spread-lifecycle.sh`; Arc:
  `cp .env.arc.example frontend/.env.local`, `PRIVATE_KEY=… ./script/arc-smoke.sh`.

## Video storyboard (≈3 min) — superseded by [video-walkthrough-instructions.md](video-walkthrough-instructions.md)

1. **0:00 — the problem (20 s).** README's ladder table: a credit spread
   margined per leg locks 1 WETH for a 0.0625 WETH max loss.
2. **0:20 — Spreads tab (60 s).** `./local.sh`; writer opens and ships a
   3000/3200 call credit spread — point at the "netted vs naked" escrow
   line; taker buys; MetaMask shows 0.0625 WETH leaving the writer.
3. **1:20 — lifecycle in one command (40 s).** `./script/spread-lifecycle.sh`
   in a terminal: expiry, oracle round, permissionless settle, redeem,
   reclaim, "conservation ✓".
4. **2:00 — Arc (30 s).** Switch network to Arc Testnet; show the real-USDC
   balance and one of the tx hashes on arcscan.
5. **2:30 — The Graph + copilot (30 s).** LP dashboard / copilot reading
   authorizations; the `NEXT_PUBLIC_SUBGRAPH_URL` switch and the fallback.
6. **2:55 — close.** Help → Continuation Track page scrolled top to bottom.
