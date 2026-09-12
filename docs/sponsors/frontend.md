# The Smile Frontend

This page describes the Smile web application: what it is, where it runs, what was added to it at EthOnline 2026, and how the TradingView-engine price chart works. It is written for a reader who has used a trading application before but has not read the rest of the documentation. Every term of art is defined where it first appears, and a glossary closes the page.

## Summary

The frontend is a Next.js application in `frontend/` that puts every Smile vault on one screen: buying options from the on-chain price surface, writing ranges as a liquidity provider (LP), the three sibling vaults built at the event (Spreads, Margin, RFQ), a risk monitor for the margin tier, a strategy builder, a vol-surface view, and an AI copilot. One build serves three networks: the local Anvil chain, Ethereum Sepolia, and Circle's Arc testnet. The application reads its contract addresses from the connected chain (`frontend/lib/deployments.ts` and `frontend/config/wagmi.ts`), so switching networks in the wallet switches the whole app.

The same code ships in two shapes. The **static export** at `https://oslinin.github.io/Smile/` is built by GitHub Actions with a base path and has no server, so it carries no copilot. The **server build** at `https://smile-frontend-omega.vercel.app` runs on Vercel and adds the copilot route (`/api/copilot`) and the subgraph proxy (`/api/subgraph`), through which the application reads The Graph with a gateway key that never reaches the browser. Locally, `./local.sh` starts Anvil, deploys every contract, seeds a 100-trade tape, and runs the server build against it.

Before EthOnline 2026 the app had the option matrix, range authorization, a payoff builder, an LP dashboard, the vol surface, and the copilot. The event added the Overview landing tab, the Spreads, Margin, RFQ and Risk Monitor tabs, a TradingView-engine price chart with the strategy and the traded tape drawn on it, an OptionStrat-grade builder, recorded testnet receipts, the multi-chain address map, a User Guide, the sponsor help pages, and a copilot that trades off The Graph with skills, MCP servers and preparation cards.

## Features used

| Feature | Where in the code | Pre-existing or EthOnline 2026 |
|---|---|---|
| Wallet stack: wagmi + viem, injected connector, WalletConnect when a project id is set; no Privy, no embedded wallets | `frontend/config/wagmi.ts`, `frontend/app/providers.tsx` | Pre-existing |
| One build for Anvil / Sepolia / Arc: recorded addresses per chain, env addresses as the Anvil fallback, `CONTRACTS` follows the connected chain | `frontend/config/wagmi.ts` (`DEPLOYED_ADDRESSES`, `contractsFor`, `CONTRACTS` proxy), `frontend/lib/deployments.ts` | EthOnline 2026 (`33cb2d3`) |
| Arc Testnet network entry and `wallet_addEthereumChain` payload | `frontend/config/wagmi.ts` (`arcTestnet`), `frontend/app/page.tsx` (`ADDABLE_CHAINS`) | EthOnline 2026 (`108e25d`) |
| Overview tab: capital-efficiency ladder as live bars, live counters across vaults, recorded testnet receipts | `frontend/components/Story.tsx` | EthOnline 2026 (`33cb2d3`) |
| Tabs in user language: Overview · Trade · Earn · One-Click · Earn · Write a Range · Spreads · Margin · Risk Monitor · RFQ · My Positions · Vol Surface · Receipts | `frontend/app/page.tsx` (`TABS`) | EthOnline 2026 (`33cb2d3`) |
| Spreads tab: open, ship and fill a credit spread on `SpreadVault` | `frontend/components/SpreadDesk.tsx` | EthOnline 2026 (`a5c17eb`) |
| Margin tab: margined put ranges, pool and fund dials, and the Circle App Kits receipts | `frontend/components/MarginDesk.tsx` | EthOnline 2026 (`1cfcc39`, `a412b5f`) |
| RFQ tab: LP signs EIP-712 quotes in the wallet, taker fills | `frontend/components/RfqDesk.tsx` (`useSignTypedData`) | EthOnline 2026 (`1006a2d`) |
| Risk Monitor: health bars per position, vault risk dials, liquidation timeline rebuilt from events, "Explain with the copilot" | `frontend/components/RiskMonitor.tsx` | EthOnline 2026 (`de5b3c2`) |
| Strategy builder: today / halfway / expiry curves, price × date P&L heat map, breakevens, greeks, per-vault writer collateral | `frontend/components/PayoffBuilder.tsx`, `frontend/lib/options.ts` (`pnlSeries`, `pnlMatrix`, `writerCollateral`, `strategyStats`) | Pre-existing builder; EthOnline 2026 upgrade (`0c35e99`) |
| Price chart: TradingView Lightweight Charts 5.2.1, ETH/USD hourly candles (Coinbase, Kraken fallback), strategy overlay, per-instrument premium and implied vol from the tape | `frontend/components/PriceChart.tsx` | EthOnline 2026 (`5098a25`, `9235276`) |
| The tape: ranges, instruments, fills and positions from The Graph on public chains, from event logs on Anvil | `frontend/lib/tape.ts`, `frontend/lib/subgraph.ts` | EthOnline 2026 (`38f8922`) |
| Subgraph proxy so a gateway key stays server-side; per-chain gateway URLs | `frontend/app/api/subgraph/route.ts` | EthOnline 2026 (`38f8922`, `e9feda6`) |
| LP Dashboard shows the connected wallet's own active range, read from the subgraph | `frontend/components/LPDashboard.tsx` | EthOnline 2026 fix (`dfc964a`, `b818634`) |
| Copilot panel: tab-aware context, per-tab starter prompts, Skills menu, MCP servers with The Graph preset, preparation cards | `frontend/components/copilot/CopilotPanel.tsx`, `SkillsMenu.tsx`, `CopilotSettings.tsx`, `PrepareCard.tsx`, `frontend/lib/copilot/tabs.ts` | EthOnline 2026 (`5f1b9b5`, `39e9a41`, `00cbbe3`, `16ad3f5`) |
| OpenRouter as a fourth copilot provider | `frontend/lib/copilot/provider.ts` | EthOnline 2026 (`ede13fd`) |
| Live spot: Uniswap Trading API when a key is set, Chainlink feed read otherwise, static fallback last | `frontend/hooks/useUniswapSpot.ts` | Pre-existing |
| Help site generator with a Sponsors group; knowledge pack for the copilot | `frontend/scripts/gen-help.mjs`, `frontend/scripts/gen-knowledge.mjs` | Pre-existing generators; Sponsors group and pages 2026-09-12 (`1cb0cae`) |
| User Guide in the help sidebar and in the copilot's knowledge | `docs/guide.md` | EthOnline 2026 (`0c35e99`) |
| GitHub Pages static export and the Vercel server build | `.github/workflows/pages.yml`, `frontend/next.config.ts` | Pages pre-existing; continuation-branch deploys and Vercel 2026-09-12 |

## Why it is necessary

**Judges see three minutes.** The numbers that make Smile's case are concrete: a 3000/3200 call credit spread escrows 0.0625 WETH instead of 1 WETH, a margined put locks 1,500 USDC instead of 3,000, and holders stay whole after a 40% gap. A README can state those numbers; only a screen can show them being true on the connected chain. The Overview tab exists to put the ladder on screen as live bars, with the vault counters and the recorded receipts beside it, before the viewer clicks anything.

**A venue needs a tape and a chart.** An options venue whose trades are only visible as transaction hashes has no market. The subgraph gives Smile a tape (every range, instrument, fill and position), and the price chart draws that tape as premium and implied volatility over time next to the underlying's candles. Without the chart, the σ feedback loop and the price history are invisible; with it, a viewer can watch a fill move the surface.

**A margin tier needs a monitor.** `MarginVault` is the one place a written option can fail to pay in full. A liquidation waterfall (margin call, grace period, takeover auction, backstop pool, insurance fund, haircut) that runs only in a shell script is not something a writer can trust. The Risk Monitor shows each position's health against the live mark and replays the waterfall as it happens.

**Three new vaults need three new desks.** Each sibling vault has a different write path (a two-leg structure, a margined range, a signed quote) and a different number to show (netted escrow, initial margin, price improvement). A single "Trade" form cannot express them; the Spreads, Margin and RFQ tabs each exist to show their one number next to the action that produces it.

## Market value add

**For a trader**, the application is the OptionStrat and Deribit workflow on a non-custodial venue. The builder shows a strategy's payoff at expiry, its value today and halfway to expiry, a price × date profit-and-loss heat map, the breakevens, and the greeks, with the premium quoted from Smile's own surface rather than a guess. The chart draws the strikes and breakevens over real candles so a trade is placed against the market's actual history. The tape shows what the last fill paid and what implied volatility it implied.

**For a liquidity provider**, the Earn tabs and the Spreads, Margin and RFQ desks show the capital each tier locks for the same trade, and the LP Dashboard and Risk Monitor show what happens to that capital afterwards. A writer can compare a naked put, a credit spread, and a margined put on one screen before choosing a rung.

**For a judge or an integrator**, the Overview tab's receipts and the Receipts tab link every recorded testnet transaction to its explorer, per chain. The Vercel build carries the copilot, so the AI trading agent described on The Graph page can be tried without any setup.

## Technical details

### The chart: TradingView Lightweight Charts

**What it is.** Lightweight Charts is TradingView's open-source charting engine, published as the `lightweight-charts` npm package under the Apache-2.0 licence. It is the renderer behind TradingView's charts, not the TradingView website or its embeddable widget: it draws candles, lines and price lines on a canvas from data the application supplies, with no account, no data feed and no network calls of its own. Smile pins version 5.2.1 (`frontend/package.json`).

**Why this library.** The submission notes record the search: there is no open-source OptionStrat, and the nearest React project draws expiry payoffs only, so the builder stayed in-house. For charting, a component was needed rather than a product; OpenCharts, an MIT-licensed terminal built on the same engine, is a full standalone application, not a component to embed. Using TradingView's engine directly gives a trader the chart they already know, in a component the page controls.

**What is drawn.** Hourly ETH/USD candles from Coinbase Exchange's public candles endpoint, with Kraken's OHLC endpoint as the fallback; the protocol's spot as a dotted line; every leg's strike as a solid line, green for long and red for short; each breakeven as a dashed yellow line; and, in the lower third, one selected instrument's traded premium per unit and the implied volatility that premium means, computed in the browser by inverting Black-Scholes against the candle close at that hour. Market data is context for the trade; the protocol prices off its oracle, not off these candles.

`frontend/components/PriceChart.tsx`

```ts
async function fetchCandles(): Promise<{ candles: Candle[]; source: string }> {
  try {
    const r = await fetch("https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=3600");
    if (!r.ok) throw new Error(String(r.status));
    const rows = (await r.json()) as number[][]; // [time, low, high, open, close, volume], newest first
    const candles = rows.map((c) => ({ time: c[0] as UTCTimestamp, low: c[1], high: c[2], open: c[3], close: c[4] })).sort((a, b) => a.time - b.time);
    return { candles, source: "Coinbase ETH-USD · 1h" };
  } catch {
    const r = await fetch("https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=60");
    const j = (await r.json()) as { result: Record<string, (string | number)[][]> };
    const key = Object.keys(j.result).find((k) => k !== "last") ?? "";
    const candles = (j.result[key] ?? []).map((c) => ({ time: Number(c[0]) as UTCTimestamp, open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]) }));
    return { candles, source: "Kraken ETH/USD · 1h" };
  }
}
```

The chart is created once, with the candles on the right price scale and the two tape lines on their own scales in the lower third of the canvas:

```ts
    const s = c.addSeries(CandlestickSeries, { upColor: "#22c55e", downColor: "#ef4444", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#ef4444" });
    // Tape lines live in the lower third: premium on the (left) price axis,
    // IV on an overlay scale with the same margins.
    premSeries.current = c.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 2, priceScaleId: "left", priceFormat: { type: "price", precision: 2, minMove: 0.01 }, title: "premium" });
    ivSeries.current = c.addSeries(LineSeries, { color: "#f472b6", lineWidth: 2, priceScaleId: "iv", priceFormat: { type: "percent", precision: 1, minMove: 0.1 }, title: "IV" });
    c.priceScale("iv").applyOptions({ scaleMargins: { top: 0.68, bottom: 0.02 } });
```

The strategy overlay is redrawn whenever the builder's legs or the spot change, using the engine's price lines:

```ts
    const add = (price: number, color: string, title: string, style = LineStyle.Solid, width: 1 | 2 = 1) =>
      lines.current.push(s.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
    add(spot, "#60a5fa", "Smile spot", LineStyle.Dotted, 1);
    for (const leg of legs) {
      add(leg.strike, leg.direction === "buy" ? "#22c55e" : "#ef4444", `${leg.direction === "buy" ? "long" : "short"} ${leg.isCall ? "call" : "put"} ${leg.amount}×`, LineStyle.Solid, 2);
    }
    if (legs.length > 0) {
      for (const be of findBreakevens(pnlSeries(legs, spot))) add(Math.round(be), "#fbbf24", "breakeven", LineStyle.Dashed, 1);
    }
```

Implied volatility is recovered from each fill by bisection, since the Black-Scholes price is monotone in volatility; a premium below intrinsic value yields `null` and is left off the line:

```ts
function impliedVol(premium: number, spot: number, strike: number, tYears: number, isCall: boolean): number | null {
  const type = isCall ? "call" : "put";
  let lo = 0.01, hi = 5;
  if (blackScholes(spot, strike, tYears, lo, RISK_FREE_RATE, type) > premium) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (blackScholes(spot, strike, tYears, mid, RISK_FREE_RATE, type) > premium) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
```

The legend names the tape's source ("The Graph" or "Anvil event log") so a viewer knows where the fills came from.

### One build, three chains

Recorded testnet addresses live in `DEPLOYED_ADDRESSES`; the environment supplies the Anvil addresses that `./local.sh` writes. `CONTRACTS` is a proxy that resolves each key against the chain the page has set, so every component reads the right vault without knowing which chain it is on:

`frontend/config/wagmi.ts`

```ts
let activeChainId = 0;
export function setActiveChainId(id: number) { activeChainId = id; }
export function contractsFor(chainId: number): ContractMap { return DEPLOYED_ADDRESSES[chainId] ?? ENV_CONTRACTS; }

export const CONTRACTS = new Proxy(ENV_CONTRACTS, {
  get(target, key: string) {
    const table = DEPLOYED_ADDRESSES[activeChainId];
    return (table ?? target)[key as ContractKey];
  },
}) as Omit<ContractMap, "usdc" | "weth"> & { usdc: Addr; weth: Addr };
```

`frontend/lib/deployments.ts` holds the same chains' explorer URLs, contract lists, subgraph endpoints, a one-line "what is real money here" note, and the demo receipts. The Overview and Receipts tabs render the receipts, and the Margin tab filters the ones whose label begins with "Treasury ·" into its "Funded through Circle App Kits" block:

`frontend/lib/deployments.ts`

```ts
export type DemoTx = { label: string; hash: string; note?: string };
export type Deployment = {
  chainId: number;
  name: string;
  explorer: string;
  contracts: { label: string; address: string }[];
  demo: DemoTx[];
  subgraph?: string;
  realMoney: string;
};
```

`frontend/components/MarginDesk.tsx`

```tsx
  const dep = chainId ? DEPLOYMENTS[chainId] : undefined;
  const treasury = dep?.demo.filter((t) => t.label.startsWith("Treasury ·")) ?? [];
```

### The Overview ladder

The landing tab computes the at-the-money strike from the live spot and reads `MarginVault.marginRequirement` for it, then draws four rungs whose bar widths are the collateral each tier locks for the same trade:

`frontend/components/Story.tsx`

```ts
  const ladder = [
    { title: "Naked put", sub: "the main vault · cash-secured", value: k, note: `${usd0(k)} USDC locked per unit`, color: "bg-blue-700", cta: "Trade", tab: "chain" as TabId, tone: "old" as const },
    { title: "Credit spread", sub: `SpreadVault · ${usd0(k)}/${usd0(k2)}`, value: k2 - k, note: `${usd0(k2 - k)} USDC — the true max loss, ${(k / (k2 - k)).toFixed(0)}× less`, color: "bg-green-600", cta: "Spreads", tab: "spreads" as TabId, tone: "new" as const },
    { title: "Margined put", sub: "MarginVault · opt-in, IM off the worst-of-hour mark", value: imUsd, note: `${usd0(imUsd)} USDC initial margin — ${(k / Math.max(imUsd, 1)).toFixed(1)}× less, liquidation-backed`, color: "bg-emerald-600", cta: "Margin", tab: "margin" as TabId, tone: "new" as const },
    { title: "Signed quote", sub: "RfqVault · LP-signed price, same collateral rules", value: k, note: "any price the LP signs — the custody model never changes", color: "bg-teal-700", cta: "RFQ", tab: "rfq" as TabId, tone: "new" as const },
  ];
```

### The tape and its chain-id gate

Every read of ranges, instruments, fills or positions goes through `readTape`. On a chain with a subgraph endpoint the tape comes from The Graph; on the local Anvil chain, where no graph-node runs on this project's arm64 host, the same entities are rebuilt from `eth_getLogs`; on any other chain without a subgraph the call throws rather than falling back to a capped scan:

`frontend/lib/tape.ts`

```ts
export class SubgraphRequiredError extends Error {
  constructor(chainId?: number) {
    super(`No subgraph configured for chain ${chainId ?? "unknown"} — on public networks The Graph is the only position source (no RPC scan exists).`);
  }
}

/** Ranges, instruments and fills for the chain. Subgraph on public chains, event logs on Anvil. */
export async function readTape(opts: TapeOpts): Promise<Tape> {
  const url = subgraphUrlFor(opts.chainId);
  if (url) return tapeFromSubgraph(url, opts.since ?? 0);
  if (isLocalChain(opts.chainId) && opts.client && opts.vault) return (await stateFromLogs(opts.client, opts.vault)).tape;
  throw new SubgraphRequiredError(opts.chainId);
}
```

In the browser on the server build, `subgraphUrlFor` returns the proxy path `/api/subgraph/?chainId=…`; the route resolves a per-chain gateway URL (`SUBGRAPH_URL_11155111`, `SUBGRAPH_URL_5042002`) or a global one from server-side environment variables and otherwise forwards to the recorded Studio endpoint. The static export has no route and calls the Studio endpoint directly.

### The builder's heat map

The strategy builder draws three profit-and-loss curves with Recharts and a price × date heat map as a table whose cell colour scales with the profit or loss at that price on that day. The matrix comes from `pnlMatrix` in `frontend/lib/options.ts` (fifteen prices by eight dates by default):

`frontend/components/PayoffBuilder.tsx`

```tsx
function HeatMap({ legs, spot }: { legs: Leg[]; spot: number }) {
  const m = useMemo(() => pnlMatrix(legs, spot), [legs, spot]);
  const scale = useMemo(() => Math.max(1, ...m.pnl.flat().map((v) => Math.abs(v))), [m]);
  const cell = (v: number) => {
    const a = Math.min(1, Math.abs(v) / scale) * 0.85 + 0.08;
    return v >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`;
  };
```

The builder's greeks (delta, gamma, theta per day, vega) come from `strategyStats`, which uses the `black-scholes` and `greeks` npm packages; the per-leg "what the writer locks on each vault" panel comes from `writerCollateral`, which reports the naked, netted and margined collateral for every leg.

### The Risk Monitor

The monitor reads every `MarginVault` event (`MarginLocked`, `Flagged`, `AuctionStarted`, `TakenOver`, `Absorbed`, `PositionSettled`, `SeriesFinalized`, `HolderHaircut`, and others) every five seconds, derives the set of positions from them, and reads each position's `health` from the vault. A bar shows the locked margin against the maintenance and initial thresholds:

`frontend/components/RiskMonitor.tsx`

```tsx
        <div className={`absolute inset-y-0 left-0 ${healthy ? (locked >= im ? "bg-green-600" : "bg-yellow-600") : "bg-red-600"} transition-all duration-700`} style={{ width: pct(locked) }} />
        <div className="absolute inset-y-0 w-0.5 bg-white/70" style={{ left: pct(mm) }} title="maintenance" />
        <div className="absolute inset-y-0 w-0.5 bg-white/30" style={{ left: pct(im) }} title="initial" />
```

The timeline renders each event as a sentence a writer can act on; the "Explain with the copilot" button, shown only when the copilot is enabled, hands the recent events to the chat.

### The RFQ desk

The LP signs a quote as EIP-712 typed data in the wallet, with no gas, through wagmi's `useSignTypedData`; the taker's fill is an ordinary contract call:

`frontend/components/RfqDesk.tsx`

```ts
  const { signTypedDataAsync, isPending: signing, error: signError } = useSignTypedData();
```

```ts
    const signature = await signTypedDataAsync({
      types: QUOTE_TYPES, primaryType: "Quote", message: quote,
```

### The copilot panel

The floating panel sends the visible spot, chain id, wallet address and the active tab with every request so the server prices exactly what the screen shows. A per-tab briefing (`frontend/lib/copilot/tabs.ts`) tells the model what is on screen, which guide sections explain it, and which tools fit; the panel shows that tab's starter prompts. The Skills menu toggles the eight built-in trader skills and accepts user-written ones; the settings gear holds a bring-your-own-key provider choice and the list of MCP servers, with a one-click preset for The Graph's Subgraph MCP:

`frontend/components/copilot/CopilotSettings.tsx`

```ts
const THEGRAPH_MCP: McpServer = { name: "thegraph", url: "https://subgraphs.mcp.thegraph.com/sse", transport: "sse" };
```

The two preparation cards (`prepare_lp_range`, `prepare_rfq_quote`) hand the agent's proposed numbers to the matching form, where the user reviews and signs; the copilot never holds a key. The Graph page documents the tools, skills and MCP in full.

### The help site and the knowledge pack

`frontend/scripts/gen-help.mjs` renders the README, the User Guide, Limitations, Solutions, the copilot page and the six sponsor pages (the Sponsors group in the sidebar) into `public/help.html`, with KaTeX for the README's formulae and Mermaid for its diagrams; the Reference Table and Continuation Track pages are embedded as standalone documents. `frontend/scripts/gen-knowledge.mjs` compiles the same documents into a token-cheap table of contents for the copilot's system prompt and full sections served on demand through its `read_docs` tool. Both run on `predev` and `prebuild`, so the site and the pack are never stale relative to the docs.

### Two builds

`frontend/next.config.ts` switches on one variable: when `NEXT_PUBLIC_BASE_PATH` is set (the GitHub Pages workflow sets it to `/Smile`), the build is a static export served from a subpath, and route handlers are excluded; when it is unset, the build is a normal server build that carries `/api/copilot` and `/api/subgraph`. The Pages workflow runs on pushes to `main` and the continuation branch and on documentation changes; the Vercel project builds the continuation branch as production with the copilot provider, model, keys and MCP seed held as server-side environment variables.

## Limitations

- **The static export has no copilot.** GitHub Pages serves files only, so the copilot button is hidden there (`NEXT_PUBLIC_COPILOT` unset) and the subgraph is read directly from the Studio endpoint. The Vercel build is the one with the agent.
- **The premium swap is key-gated and mainnet-routed.** The Uniswap Trading API is used for the displayed spot and, only when `NEXT_PUBLIC_UNISWAP_API_KEY` is set, to quote an ETH→USDC swap for the premium; that quote targets mainnet, so on Sepolia and Arc the buyer pays premium from USDC held already.
- **Market data is context, not pricing.** The candles come from Coinbase or Kraken; the protocol prices off its oracle. The two can disagree, and the chart says so in its legend.
- **Implied vol on the chart is a browser estimate.** It inverts Black-Scholes with the candle close at the fill's hour as spot and the builder's risk-free rate; the protocol's own sigma is the hook's, not this number.
- **The Risk Monitor and the Anvil tape scan logs.** On Anvil both rebuild state from `eth_getLogs` every few seconds, which is fine for a local chain and would not scale to a busy public one; on public chains the tape comes from the subgraph, but the Risk Monitor's event timeline is still a log scan of `MarginVault`.
- **Transfers of option tokens are not on the tape.** The subgraph does not index ERC-20 transfers of OptionTokens, so a position sold on to another wallet still shows on the original buyer until closed or redeemed (see The Graph page).
- **A weak default model.** The live deployment runs the copilot on `openrouter/free`; the tool-routing rules in the system prompt carry more weight than they would with a stronger model, and the settings gear lets a user bring their own key.
- **Layout is desktop-first.** The tab bar wraps on narrow screens and tables scroll horizontally, but the builder, chart and desks are designed for a wide viewport.

## Plans

- **A live secondary market on the chart.** When an OptionToken v4 pool exists (Limitations L14), its trades belong on the same chart as the primary tape.
- **Per-chain spot sources.** The Trading API quote is mainnet-only; a chain-aware spot source (a feed adapter per chain, or Pyth for quoting per R5) would let the displayed spot and the protocol's spot agree on every network.
- **Index OptionToken transfers.** A data-source template per OptionToken in the subgraph would make the tape's positions transfer-aware, and the My Positions tab correct after a resale.
- **Mobile layouts for the desks.** The Overview and Trade tabs read well on a phone; the builder's heat map and the desks would benefit from stacked layouts.
- **Recorded liquidation on a public chain.** The Risk Monitor's waterfall has been shown on Anvil only, because public testnets cannot be time-warped; a scheduled, long-dated demo on Sepolia or Arc would put a real timeline on screen.

## Glossary

- **Next.js.** The React framework the app is built with; it can produce a static site or a server that also runs API routes.
- **Static export.** A Next.js build that emits plain HTML, CSS and JavaScript with no server, deployable to GitHub Pages; API routes cannot exist in it.
- **Server build.** A Next.js build that runs on a Node.js server (here Vercel) and can serve route handlers such as `/api/copilot`.
- **Base path.** The URL prefix (`/Smile`) under which the static export is served on GitHub Pages; assets must be prefixed with it or they fail to load.
- **Route handler / proxy route.** A server-side endpoint inside the app. `/api/subgraph` forwards the browser's query to The Graph with a key the browser never sees.
- **wagmi and viem.** The React hooks library and the low-level Ethereum client the app uses to connect wallets, read contracts and send transactions.
- **Injected connector.** A wallet available as a browser extension (MetaMask and similar) that injects a provider into the page.
- **WalletConnect.** A protocol for connecting mobile wallets by QR code; enabled only when a project id is configured.
- **Lightweight Charts.** TradingView's open-source charting engine, an npm package under Apache-2.0 that draws candles, lines and price lines on a canvas from application-supplied data.
- **Candle / OHLC.** One bar of price history: the open, high, low and close over an interval, here one hour.
- **Price line.** A horizontal line the chart engine draws at a given price with a label; used for strikes, breakevens and the spot.
- **Tape.** The record of every range, instrument, fill and position on the venue, read from The Graph on public chains and rebuilt from event logs on Anvil.
- **Instrument.** One (strike, expiry, call-or-put) series, identified by its OptionToken address.
- **Premium per unit.** What one option unit cost at a fill, fee included, in USD.
- **Implied volatility (IV).** The volatility that, put into Black-Scholes, reproduces an observed premium; on the chart it is recovered by bisection.
- **Payoff diagram.** The profit or loss of a strategy as a function of the underlying's price at expiry.
- **Today / halfway curves.** The strategy's model value at the current time and at half the time to expiry, drawn with the expiry payoff.
- **Breakeven.** A price at which the strategy's profit and loss is zero.
- **Heat map.** A grid of profit or loss by price (rows) and date (columns), coloured by sign and magnitude.
- **Greeks.** Delta (sensitivity to the underlying's price), gamma (delta's sensitivity), theta (time decay per day) and vega (sensitivity to volatility).
- **Writer collateral.** What a writer locks for a leg on each vault: the naked amount on the main vault, the netted max loss on `SpreadVault`, the initial margin on `MarginVault`.
- **Ladder.** The Overview tab's four rungs, from naked collateral to a signed quote, drawn as bars sized by the collateral each locks.
- **Receipts.** The recorded testnet transactions per chain, with explorer links, on the Overview, Receipts and Margin tabs.
- **Health.** A margined position's locked margin against its maintenance and initial requirements, read from `MarginVault.health`.
- **Liquidation timeline.** The sequence of `MarginVault` events for a position: flagged, auction, taken over or absorbed, settled, finalized, and if necessary haircut.
- **EIP-712.** The standard for signing structured typed data in a wallet; the RFQ desk uses it for quotes.
- **Copilot.** The AI chat panel; on the server build it calls tools that read the tape, price strategies, and prepare ranges and quotes for the user to sign.
- **Skill.** A markdown file of trading know-how that the copilot loads into its prompt when enabled.
- **MCP (Model Context Protocol).** A standard through which the copilot connects to external tool servers, such as The Graph's Subgraph MCP.
- **Knowledge pack.** The compiled table of contents and sections of the documentation that the copilot's `read_docs` tool serves.
