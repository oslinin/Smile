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
   `https://thegraph.com/studio/subgraph/smile-sepolia` playground, and
   `https://testnet.arcscan.app/tx/0x0938c5be639e8daf30b88d15b82d5ec80dd5d3a68096e5b796051f00791a4d02`
   ready in a third tab. Close everything else; hide bookmarks.
4. **Copilot.** Make sure the copilot key is in `frontend/.env.local`
   (`./local.sh` preserves it). Open the panel once so it is warm.
5. **Second terminal** (optional, for the Sepolia/Arc receipts) — not
   needed; the app links to them.
6. **Recording.** 1080p, 30 fps, system audio off, mic on. Speak the
   bold lines below; don't read the rest.

## The run (≈4:30)

### 0:00 — Overview (30 s)

Land on **Overview**. Point at the chain card ("You are on Anvil").

> **"Smile is on-chain options where the writer's collateral never leaves
> their wallet until a buyer shows up — 1inch Aqua pulls it just-in-time
> at the fill. On September 5 this was one vault. For EthOnline we added
> three sibling vaults, a subgraph, and deployments on Sepolia and Arc."**

Hover the ladder bars: naked put $3,000 → credit spread $200 → margined
put $1,500 → signed quote.

> **"Same premium surface on every rung; only the collateral rule
> changes. Blue was there before, green is the continuation track."**

### 0:30 — Trade: the chart and the builder (45 s)

Click **Trade**. The TradingView-engine chart shows real ETH candles.
Scroll to the **Strategy Builder**, click *Neutral* → *Iron Condor*.

> **"The builder is OptionStrat-grade: P&L today, halfway and at expiry,
> a price-by-date heat map, breakevens, greeks — and the Smile-specific
> panel: what a writer locks for each sell leg on each vault."**

Scroll back up: the four strikes and the breakevens are now drawn on the
chart. Then click the bars in the builder's collateral panel and say:

> **"Short call 3,200 with a long above it: 1 ETH on the main vault,
> 0.06 ETH on SpreadVault. That's the whole thesis in one row."**

### 1:15 — Spreads: a real fill (40 s)

Click **Spreads**. Account #0: *Call Credit*, K1 3000 / K2 3200, 1 unit,
**Approve Aqua & Open Spread → Open Structure → Ship to Aqua** (three
MetaMask confirms).

> **"The writer ships 0.0625 WETH of allowance — sixteen times less than a
> naked leg — and it stays in their wallet."**

Switch MetaMask to account #1, **Buy 1 unit**. Show MetaMask's balance
change / the "You hold 1 unit" line.

> **"The taker paid the net premium; exactly 0.0625 WETH left the writer's
> wallet at that block. Nothing was deposited in advance."**

### 1:55 — Margin: crash, margin call, backstop (75 s) — the wow moment

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

### 3:10 — RFQ: a signed quote (35 s)

Click **RFQ**. Account #0: ship a call range (capacity 1), then in card 2
set *100 bps inside the formula*, **Sign Quote** (MetaMask signature, no
gas). Switch to account #1, the quote is already in card 3, **Fill**.

> **"Tier two: the LP signs a price off-chain — any model they like — and
> the taker fills it. The vault recovers the signer, checks the nonce and
> the expiry, and pulls the collateral through the identical Aqua
> allowance. A signed quote changes the price, never the custody model."**

### 3:45 — It's real: Sepolia, The Graph, Arc (35 s)

Switch MetaMask to **Sepolia**. The app follows: **Overview** now shows the
Sepolia receipts. Click the `buy` tx → Etherscan. Tab B: the Studio
playground — run

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

Switch MetaMask to **Arc Testnet**; Overview flips to the Arc receipts;
click the MarginVault fill → arcscan. Then the **Margin** tab: scroll to
the pool panel — **"Funded through Circle App Kits"** lists three
receipts (Wallets-kit deposit into the backstop, Gateway mint, Gateway →
insurance fund); click one → arcscan.

> **"And on Circle's Arc, with native USDC as premium, margin, backstop
> and gas: a margined put locking 1.50 USDC instead of 3.00, and a signed
> RFQ fill. The whole ladder settles in Circle's dollar. The safety pools
> are funded by Circle's App Kits — a developer-controlled wallet Circle
> signs for, and Gateway bringing USDC in from Sepolia — no treasury key
> in the repo."**

### 4:20 — Close (15 s)

Back to **Overview**; open **Help ↗ → Continuation Track** and scroll it;
flick past the **Sponsors** group in the sidebar (1inch Aqua, Chainlink,
Uniswap, The Graph, Circle · Arc, Frontend — one page each: features,
why, value, code, limitations, plans).

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
  cut because Arc testnet has no EUR/USD feed and that WETH and the price
  feed are mocks on Arc.

## Editing notes

- Cut MetaMask confirmation waits to ~1 s each.
- Keep the terminal and the Risk Monitor side by side for the margin
  segment (it is the strongest 60 seconds).
- Title card: "Smile — EthOnline 2026 Continuation Track". End card: repo
  URL, subgraph URL, `docs/submission-ethonline2026.md`.
