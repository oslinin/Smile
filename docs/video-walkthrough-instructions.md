# Video walkthrough — instructions

A 4–5 minute recording that shows every judged artifact working, in the
order a judge wants to see it: **what's new, that it's real, that it's
on-chain, and that it's polished**. Everything below runs from a fresh
`./local.sh` plus two browser tabs. Rehearse once; the whole run is ~15
minutes including setup.

## Before recording (10 minutes)

0. **Two stacks, pick per segment.** Anvil (`./local.sh`) for the
   crash-and-liquidation segment (it needs time warps). The live app —
   https://smile-frontend-omega.vercel.app — for the Sepolia / Arc / copilot
   segments: copilot, The Graph MCP and the gateway path are already wired
   there, nothing to configure. (The GitHub Pages build has no copilot.)

1. **Stack.** In a terminal at the repo root:
   ```bash
   ./local.sh                      # Anvil + all contracts (incl. Spread/Margin/RFQ vaults) + app on :3000
   ```
   Wait for `UI: http://localhost:3000`. Keep this terminal visible in the
   recording later — the lifecycle scripts run here.
2. **MetaMask.** Network "Anvil" (chain 31337, RPC `http://127.0.0.1:8545`)
   with Anvil accounts **#0** (writer/LP, `0xf39F…2266`) and **#1**
   (taker, `0x7099…79C8`) imported (keys are printed by Anvil; they are
   the standard dev keys). Account #0 selected.
3. **Browser.** Tab A: `http://localhost:3000` (dark theme, 1440×900 or
   wider — the ladder and the chart need width). Tab B:
   `https://thegraph.com/explorer/subgraphs/Bf9T8wuSLwvNSR9oTx2uuSjoL2P5kCagWAitFgykyes2?view=Query&chain=arbitrum-one`
   — `smile-sepolia` **published on The Graph Network** (the Explorer page
   shows the network deployment, its signal and the query URL; use this,
   not only the Studio playground, so "live data from a Graph provider"
   is on screen). Tab C: `https://thegraph.com/studio/subgraph/smile-sepolia` playground, and
   `https://testnet.arcscan.app/tx/0x0938c5be639e8daf30b88d15b82d5ec80dd5d3a68096e5b796051f00791a4d02`
   ready in a third tab (the Arc margined-put fill), and
   `https://testnet.arcscan.app/tx/0x0f23f6a1042733952f44fb54c2640085d0d816ce848a807fe1304551fc9a237b`
   in a fourth (the cash-settled call spread on Arc — 2.00 USDC of escrow, no WETH). Close everything else; hide bookmarks.
4. **Copilot.** Make sure the copilot key is in `frontend/.env.local`
   (`./local.sh` preserves it). Open the panel once so it is warm.
5. **Second terminal** (optional, for the Sepolia/Arc receipts) — not
   needed; the app links to them.
6. **Recording.** 1080p, 30 fps, system audio off, mic on. Speak the
   bold lines below; don't read the rest.

## The run (≤ 4:00 — The Graph's rule is a two-to-four-minute video; the timings below sum to 3:55)

### 0:00 — Overview (30 s)

Land on **Overview**. Point at the chain card ("You are on Anvil").

> **"Smile is on-chain options where the writer's collateral never leaves
> their wallet until a buyer shows up — 1inch Aqua pulls it just-in-time
> at the fill. This is a Continuity entry: on September 5 the repo had one
> vault, the matrix and the copilot. For EthOnline we added three sibling
> vaults, a subgraph on The Graph Network, and deployments on Sepolia and
> Arc — the pre-existing part is listed in the README and on every help
> page's feature table."**

Hover the ladder bars: naked put $3,000 → credit spread $200 → margined
put $1,500 → signed quote.

> **"Same premium surface on every rung; only the collateral rule
> changes. Blue was there before, green is the continuation track."**

### 0:30 — Trade: the chart and the builder (30 s)

Click **Trade**. The TradingView-engine chart shows real ETH candles.
Scroll to the **Strategy Builder**, click *Neutral* → *Iron Condor*.

> **"The builder is OptionStrat-grade: P&L today, halfway and at expiry,
> a price-by-date heat map, breakevens, greeks — and the Smile-specific
> panel: what a writer locks for each sell leg on each vault."**

Scroll back up: the four strikes and the breakevens are now drawn on the
chart. Then click the bars in the builder's collateral panel and say:

> **"Short call 3,200 with a long above it: 1 ETH on the main vault,
> 0.06 ETH on SpreadVault. That's the whole thesis in one row."**

### 1:00 — Spreads: a real fill (30 s)

Click **Spreads**. Account #0: *Call Credit*, K1 3000 / K2 3200, 1 unit,
**Approve Aqua & Open Spread → Open Structure → Ship to Aqua** (three
MetaMask confirms).

> **"The writer ships 0.0625 WETH of allowance — sixteen times less than a
> naked leg — and it stays in their wallet."**

Switch MetaMask to account #1, **Buy 1 unit**. Show MetaMask's balance
change / the "You hold 1 unit" line.

> **"The taker paid the net premium; exactly 0.0625 WETH left the writer's
> wallet at that block. Nothing was deposited in advance."**

### 1:30 — Margin: crash, margin call, backstop (60 s) — the wow moment

Click **Risk Monitor** and leave it on screen. In the terminal:

```bash
./script/margin-lifecycle.sh
```

Narrate as the timeline fills (it takes ~20 s):

> **"A margined put: the writer locks 1,500 USDC of initial margin, not
> the 3,000 strike. ETH crashes to 2,000 — maintenance is now above what's
> locked, the keeper flags, an hour of grace, a post-flag round confirms,
> the auction opens, nobody bids, the backstop pool absorbs it and draws
> only the 175 USDC shortfall. Expiry, permissionless settlement, the
> holder redeems exactly 1,000 USDC of intrinsic. Every step is a real
> transaction; the position card went red, then to the pool, then
> settled."**

Click **Explain with the copilot →**. Let it narrate for ~10 s (cut in
the edit if long).

> **"The copilot reads the same events and the docs; ask it anything on
> the Risk Monitor."**

Optional second take: `MODE=takeover ./script/margin-lifecycle.sh` — a
second writer takes the position over instead.

### 2:30 — RFQ: a signed quote (25 s)

Click **RFQ**. Account #0: ship a call range (capacity 1), then in card 2
set *100 bps inside the formula*, **Sign Quote** (MetaMask signature, no
gas). Switch to account #1, the quote is already in card 3, **Fill**.

> **"Tier two: the LP signs a price off-chain — any model they like — and
> the taker fills it. The vault recovers the signer, checks the nonce and
> the expiry, and pulls the collateral through the identical Aqua
> allowance. A signed quote changes the price, never the custody model."**

### 2:55 — It's real: Sepolia, The Graph, Arc (50 s) — the load-bearing Graph and Arc minute

Switch MetaMask to **Sepolia**. The app follows: **Overview** now shows the
Sepolia receipts and the line **"● indexed by The Graph — no range cap,
the copilot trades off it"**. Click the `buy` tx → Etherscan. Tab B: the
**Explorer page of the published subgraph** (network, not Studio) — three
seconds on it, then its Query tab; or Tab C, the Studio playground — run

```graphql
{ fills(first: 3) { buyer strike amount premium blockNumber } }
```

> **"Deployed on Sepolia with Circle USDC and the Chainlink feed; The
> Graph indexed the fill one block after the buy — on Sepolia and Arc the
> app and the copilot read only from it. Both subgraphs are published to
> The Graph Network and served through the gateway; the live app's server
> queries them with an API key the browser never sees."**

(Optional 5 s, Tab B: the gateway URL from `docs/submission-ethonline2026.md`
in the playground — same data, decentralized network. Or record this
whole segment on the live app, https://smile-frontend-omega.vercel.app,
where the copilot and the gateway path are already wired — no `.env` to
show.)

Then the copilot, on the tape (Sepolia or Anvil with the seeded 100
trades): open it, click **Skills** (show the list and the "add a skill"
box for two seconds), then the **gear → MCP servers** (The Graph Subgraph
MCP is already there on the live app — two seconds), then type
**"what's cheap right now?"** — it calls
`find_opportunities`, cites *The Graph* as the source and Deribit as the
reference, and proposes a trade card. Follow with **"where is liquidity
thin?"** → the liquidity map and a **Write a Range** card; click its
button: the Earn form opens prefilled. Last, **"hedge my book"** →
`portfolio_greeks` then `hedge_suggestion`. If there is time, one more:
**"search subgraphs for uniswap"** — the copilot calls
`search_subgraphs_by_keyword` on The Graph's own Subgraph MCP and names
one (verified on the live app). On the Trade tab point at the price chart:
the premium and IV lines of the most-traded instrument under the ETH
candles (TradingView Lightweight Charts).

> **"The subgraph is Smile's tape. The copilot screens every strike
> against Deribit, maps liquidity, reads the whole book, and prepares the
> range or the quote — I sign. No cap, no RPC scan. Its know-how ships as
> skills, and it talks to The Graph's Subgraph MCP — or any MCP server you
> add."**

Switch MetaMask to **Arc Testnet**; Overview flips to the Arc receipts
(the spot badge now reads *mock feed* — Arc's oracle is mirrored from
Sepolia's Chainlink every 30 minutes, so it is the real price); click the
SpreadVault fill → arcscan (2.00 USDC pulled: K₂−K₁ per unit, cash-settled
— Arc has no ether, so ETH is only the reference price here), then the
MarginVault fill → arcscan. Then the **Margin** tab: scroll to
the pool panel — **"Funded through Circle App Kits"** lists three
receipts (Wallets-kit deposit into the backstop, Gateway mint, Gateway →
insurance fund); click one → arcscan.

> **"And on Circle's Arc, with native USDC as premium, collateral, margin,
> backstop and gas — ETH is only the price being traded: a call spread
> escrowing two dollars of USDC, a margined put locking 1.50 USDC instead
> of 3.00, and a signed RFQ fill. One USDC balance does everything a user
> needs — nobody ever holds ETH to trade ETH options. The money flows you
> just saw on Anvil are deployed here: collateral that moves only when a
> buyer fills, and the flag → grace → auction → backstop → settlement
> waterfall. The safety pools
> are funded by Circle's App Kits — a developer-controlled wallet Circle
> signs for, and Gateway bringing USDC in from Sepolia — no treasury key
> in the repo."**

### 3:45 — Close (10 s)

Back to **Overview**; open **Help ↗** — it lands on the Screens section
for the tab you were on, with the page's sections listed under it in the
sidebar. Type `cash-settled` in the sidebar search box (results across
every page, click one), then open **Continuation Track** and scroll it;
flick past the **Integrations** group (1inch Aqua, Chainlink, Uniswap,
The Graph, Circle · Arc, Frontend — one page each: features, why, value,
code, limitations, plans).

> **"Two hundred Foundry tests, one task per commit, every milestone in
> the plan reached except the ones that needed hardware we don't have.
> Repo, subgraph, deployments and this tracker are in the submission."**

## If something goes wrong on camera

- **A fill reverts with `StaleMark` / `StaleOraclePrice`** (only after the
  stack sat idle > 1 h): run `cast send <ORACLE> "setAnswer(int256)"
  300000000000 --private-key <anvil key 0> --rpc-url http://localhost:8545`
  — or just re-run `./local.sh`.
- **The chart shows "market data unavailable"**: the Coinbase/Kraken
  public APIs are blocked on your network; everything else still works —
  skip the candle line and talk over the builder.
- **The copilot is slow**: cut the explain segment; the timeline itself is
  the demo.
- **Risk Monitor is empty after the script**: you are on the wrong chain
  in MetaMask — switch back to Anvil.
- **Spread/RFQ ship fails** with an allowance error: the "Approve Aqua"
  step was skipped — reset the card and start from step 1.

## What must be said out loud (bounty checklists)

- **1inch**: "official Aqua contracts, unmodified", "JIT pull at the
  fill", "three Aqua apps: SpreadVault, MarginVault, RfqVault", "one task
  per commit".
- **The Graph**: "subgraphs smile-sepolia and smile-arc-testnet,
  published to The Graph Network, served through the gateway", "indexed
  the fill one block later", "the app and the AI copilot read only from
  it on public networks — no RPC scan", "skills + The Graph's Subgraph
  MCP in the copilot".
- **Circle / Arc**: "Arc testnet", "native USDC as gas, premium,
  collateral, margin, backstop", "Sepolia with Circle USDC too", "Circle
  Gateway and a developer-controlled wallet funded the insurance fund and
  the backstop — no treasury key in the repo"; be honest that FX/EURC was
  cut because Arc testnet has no EUR/USD feed, that the Arc price feed is
  a mock (mirrored from Sepolia's Chainlink by a keeper), and that the
  main vault's covered calls use a WETH stand-in on Arc — spreads are
  cash-settled in USDC, puts/margin/RFQ-puts were USDC from the start.
- **Wording to avoid**: don't call the surface's σ an "80% implied vol" —
  say "the surface's σ parameter". It prices about 2.5× a Black-Scholes IV
  at the money (Overview §2 says so); the chart's IV line is the
  back-solved Black-Scholes number.

## The Graph requirements → where they are on screen

| Requirement | Where in the run | What proves it |
|---|---|---|
| The Graph is load-bearing: the app/agent uses Subgraphs / the Subgraph MCP as its blockchain data source | 3:00 | Overview's "● indexed by The Graph" line; the narration "on Sepolia and Arc the app and the copilot read **only** from it — no RPC scan"; the copilot's answers cite *The Graph* as source; the ⚙ → MCP servers menu with The Graph's Subgraph MCP preset and the `search subgraphs for uniswap` call |
| Live data from a Graph provider (Studio API key / gateway), not mocked or local | 3:00 | The Explorer page of `smile-sepolia` published on The Graph Network (Tab B); the narration "published to The Graph Network, served through the gateway with an API key the browser never sees"; the fill indexed one block after the Sepolia buy |
| Meaningful work with the data: reasoning, decisions, automation, natural language | 3:00 and 1:35 | `find_opportunities` (Smile IV vs Deribit vs last fill → a trade card), `liquidity_map` → a prefilled Write-a-Range card, `portfolio_greeks` → `hedge_suggestion`; "Explain with the copilot" on the Risk Monitor |
| Open source, README / SKILL.md a judge can run | 3:45 | Help ↗ (README = Overview; the subgraph's own skill file and the eight trader skills are mentioned in the Skills menu at 3:00); the end card's repo URL |
| Two-to-four-minute video | whole run | timings above sum to 3:55 — cut, don't overrun |

## Arc's requirements → where they are on screen

| Requirement | Where in the run | What proves it |
|---|---|---|
| Meaningful use of Arc and USDC | 2:55 | Overview on Arc: receipts for every vault; the "real money" line ("Circle's native USDC — premium, collateral, spreads, margin, backstop, and gas; ETH is the reference price only"); the cash-settled call spread (2.00 USDC escrow) and the margined put (1.50 USDC) on arcscan |
| Advanced programmable money flows: conditional payments, on-chain automation, multi-step settlement | 1:30 (shown on Anvil) + 2:55 (deployed on Arc) | Conditional payment = the JIT Aqua pull: collateral moves only at a fill; multi-step settlement = flag → grace → post-flag round → auction → backstop absorb → permissionless settlement → redeem; automation = the keeper that drives it (`keeper/margin.mjs`) and the oracle mirror keeper on Arc; say the sentence "the money flows you just saw on Anvil are deployed here" |
| Payment, liquidity or treasury workflows using App Kits | 2:55 | Margin tab → "Funded through Circle App Kits": developer-controlled wallet (Circle signs) deposits into the backstop; Gateway moves USDC from Sepolia and funds the insurance fund — three receipts, click one → arcscan; say "no treasury key in the repo" |
| Why stablecoin-native infrastructure changes what is possible | 2:55 | The sentence "one USDC balance does everything — premium, collateral, margin, gas; nobody holds ETH to trade ETH options"; cash-settled spreads exist *because* Arc has no ether |
| Core products used | — | Arc ✓, USDC ✓, App Kits ✓ (Gateway, Developer-Controlled Wallets). Not used, and say so if asked: CCTP (Gateway covers the cross-chain leg), StableFX (FX cut — no EUR/USD feed on testnet), Circle Contracts |
| Continuity pool: pre-existing work documented | 0:00 | the opening line names what existed on September 5; the README's Continuation Track section and every help page's "Pre-existing or EthOnline 2026" column list it |

## Editing notes

- Cut MetaMask confirmation waits to ~1 s each.
- Keep the terminal and the Risk Monitor side by side for the margin
  segment (it is the strongest 60 seconds).
- Title card: "Smile — EthOnline 2026 Continuation Track". End card: repo
  URL, subgraph URL, `docs/submission-ethonline2026.md`.
