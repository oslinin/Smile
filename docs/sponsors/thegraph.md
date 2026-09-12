# The Graph in Smile

This page documents every way Smile uses The Graph, why an options venue
needs it, what it adds for traders and liquidity providers, how it is built,
what it does not do yet, and what comes next. All of the work described here
was built during EthOnline 2026 on the `EthOnline2026_continuation_track`
branch. Terms are defined at first use and collected in the glossary at the
end.

## Summary

The Graph is a decentralised indexing protocol: it watches a blockchain,
runs user-written code on every relevant event, and stores the result in a
database that can be queried with GraphQL, a query language in which the
caller names exactly the fields it wants. Smile's **subgraph** (the unit of
indexing on The Graph) turns the raw events of the `AquaCollateralVault`
contract into four tables: every liquidity range an LP has written, every
option fill, every option instrument with its open interest, and every
holder's balance. Together these tables are Smile's **tape**, the running
record of what has traded and at what price, which a centralised exchange
publishes as a matter of course and which an on-chain venue otherwise does
not have.

Two subgraphs are live on Subgraph Studio, The Graph's hosted deployment
service: `smile-sepolia` (version 0.0.4) for the Sepolia testnet and
`smile-arc-testnet` (version 0.0.1) for Circle's Arc testnet. On
2026-09-12 both were also published to The Graph Network, the
decentralised network of indexers, and the live application reads them
through the network's gateway with an API key that never leaves the
server. On those public networks the application and the AI copilot read
positions, liquidity and trade history from The Graph only; no RPC scan
exists as a fallback. The copilot is built on that tape as a trading agent: it screens
every live strike against the listed reference market, maps where
liquidity is scarce, computes the greeks of a wallet's whole book, sizes a
hedge, and prepares the range an LP might write or the quote a market
maker might sign. The user signs; the agent never holds a key. The
copilot's know-how ships as portable skill files, and it can connect to
The Graph's own Subgraph MCP server as well as any server the user adds.

## Features used

| Feature | Where in the code | Origin |
|---|---|---|
| Subgraph with `Authorization`, `Fill`, `Instrument`, `Position` entities | `subgraph/schema.graphql`, `subgraph/subgraph.yaml` | EthOnline 2026 |
| Event handlers with bound contract calls that refresh `usedCollateral` from chain state | `subgraph/src/vault.ts` | EthOnline 2026 |
| Studio deployments for Sepolia and Arc testnet | `subgraph/networks.json`; `frontend/lib/deployments.ts` | EthOnline 2026 |
| Published to The Graph Network (Arbitrum One) and served through the gateway with an API key held server-side; subgraph ids `Bf9T8wuSLwvNSR9oTx2uuSjoL2P5kCagWAitFgykyes2` (Sepolia) and `9ZcFMvnhbWygRg7oB29NL8smoVysqCbdQpqNMhWtHbmq` (Arc testnet) | `frontend/app/api/subgraph/route.ts` (`SUBGRAPH_URL_<chainId>`), `subgraph/README.md` | EthOnline 2026 (2026-09-12) |
| Browser and server GraphQL client with per-chain endpoint resolution | `frontend/lib/subgraph.ts` | EthOnline 2026 |
| Server-side proxy so a gateway API key never reaches the browser | `frontend/app/api/subgraph/route.ts` | EthOnline 2026 |
| The tape: one shape for ranges, instruments, fills and positions; chain-id gate | `frontend/lib/tape.ts` | EthOnline 2026 |
| LP dashboard and copilot position tools reading the tape (the L12a fix) | `frontend/components/LPDashboard.tsx`, `frontend/lib/copilot/chain.ts` | EthOnline 2026 |
| Copilot trading tools: `find_opportunities`, `liquidity_map`, `portfolio_greeks`, `hedge_suggestion`, `reference_market`, `macro_calendar`, `prepare_lp_range`, `prepare_rfq_quote` | `frontend/lib/copilot/graphTools.ts`, `deribit.ts`, `macro.ts`, `tools.ts` | EthOnline 2026 |
| Tab-aware briefing in the copilot prompt | `frontend/lib/copilot/systemPrompt.ts`, `tabs.ts` | EthOnline 2026 |
| Eight trader skills and a Skills menu with user-added skills | `frontend/skills/*.md`, `frontend/components/copilot/SkillsMenu.tsx` | EthOnline 2026 |
| MCP servers: operator-seeded (`COPILOT_MCP_SERVERS`) and per-user (settings gear, `x-copilot-mcp` header), opened per request; The Graph's Subgraph MCP seeded on the live deployment and verified end to end | `frontend/lib/copilot/mcp.ts`, `frontend/components/copilot/CopilotSettings.tsx`, `frontend/app/api/copilot/route.ts` | EthOnline 2026 (verified 2026-09-12) |
| The copilot itself: one server route, four providers (operator env or bring-your-own-key header), a system prompt assembled from the knowledge pack, the tab briefing and the active skills, nineteen built-in tools | `frontend/app/api/copilot/route.ts`, `frontend/lib/copilot/provider.ts`, `systemPrompt.ts`, `tools.ts`, `knowledge.ts` | Pre-existing (route, providers, docs tools); EthOnline 2026 (tape tools, tabs, skills, MCP, OpenRouter) |
| Agent-facing subgraph documentation and client configuration | `subgraph/SKILL.md`, `.mcp.json.example` | EthOnline 2026 |
| Traded premium and implied volatility per instrument on the price chart | `frontend/components/PriceChart.tsx` | EthOnline 2026 |
| A seeded tape of one hundred trades on the local chain | `script/SeedTape.s.sol`, `script/seed-tape.sh`, `local.sh` | EthOnline 2026 |

## Why it is necessary

**An on-chain options venue has no public tape.** On a centralised
exchange the order book, the last trade and the open interest of every
instrument are published continuously. On a blockchain those facts exist
only as events scattered across blocks. A wallet that wants to know "what
did the 3,000 call last trade at?" or "how much of this range is already
used?" must either walk the chain's event log from the deployment block or
call the contract once per candidate strike. Neither scales, and neither
is queryable by an outside program in a reasonable time.

**The capped scan went blind.** Before the subgraph existed, the copilot's
position reader looped over every authorisation identifier up to a hard
limit of fifty (`MAX_AUTHS = 50` in `frontend/lib/copilot/chain.ts`), then
walked a forty-strike grid per range with one RPC call per strike. Past
fifty ranges ever created it silently stopped seeing new ones, including
the connected wallet's own. The LP dashboard used a `getLogs` scan from
block zero as a stopgap and showed only one range per LP. Both are recorded
as limitation L12a in `docs/limitations.md`. The subgraph is the correct
fix rather than a bounty add-on: it replaces a bounded, brute-force scan
with an indexed query, and on public networks the scan no longer exists at
all.

**An agent needs indexed data.** An AI copilot that reasons about a
market must be able to ask "every active range", "open interest by
strike", "this wallet's positions" and "the last twenty fills of this
instrument" as single, cheap questions. Those are precisely the queries a
subgraph answers. Without one, every copilot answer about positions or
liquidity would rest on the same capped scan, and every answer would be
suspect past the cap.

## Market value add

**A trading coach on live data.** The copilot's second tool set reads the
tape and behaves like a desk analyst. `find_opportunities` prices every
live strike on every active range at the vault's own current volatility,
converts that ask to an implied volatility, and compares it with the
nearest listed instrument on Deribit, the largest crypto options exchange,
and with the last fill of the same instrument on Smile; the result is
ranked cheap to expensive. `liquidity_map` reports capacity, utilisation,
open interest and staleness per range, flags bands that are scarce, empty,
stale or expiring, and draws a per-strike heat map so that "where is
liquidity thin?" is a one-line question. `portfolio_greeks` reads a
wallet's long positions from the `Position` entity and its written
exposure from the open interest on its own ranges, and returns net delta,
gamma, theta and vega with marks and profit and loss. `hedge_suggestion`
turns that book into a quantity of spot ETH, or of calls or puts at a
strike, that brings it to a target delta.

**The agent prepares; the user signs.** `prepare_lp_range` and
`prepare_rfq_quote` render cards whose buttons prefill the Write a Range
form and the RFQ signer respectively. The copilot cannot send a
transaction and never holds a key. This keeps the non-custodial property
of the protocol intact while removing the spreadsheet work from market
making.

**Portable know-how.** The copilot's behaviour is packaged as eight skill
files in the `SKILL.md` convention (a markdown file with a name, a
description, a starter prompt and a procedure). A trader can read them,
toggle them, and add their own without a rebuild. `subgraph/SKILL.md`
describes Smile's subgraph to any AI environment, and `.mcp.json.example`
is a one-file client configuration for The Graph's Subgraph MCP server, so
the same data is reachable from Claude Code or Cursor without reading the
schema.

**A chart with a tape under it.** The price chart draws the traded premium
per unit and the implied volatility of each fill for a chosen instrument,
so a trader sees whether the vault's volatility feedback loop has moved
the price of a strike, not only the price of the underlying.

## Technical details

### Entities

The schema defines four entities. `Instrument` is one strike of one range,
identified by its `OptionToken` address; open interest is bought minus
closed minus redeemed.

`subgraph/schema.graphql`:

```graphql
type Instrument @entity(immutable: false) {
  id: ID!                      # optionToken address, lowercase hex
  optionToken: Bytes!
  authorization: Authorization!
  lp: Bytes!
  strike: BigInt!              # WAD USD
  expiry: BigInt!
  isCall: Boolean!
  openInterest: BigInt!        # WAD option units outstanding
  volume: BigInt!              # WAD option units ever bought
  fillCount: Int!
  lastPremiumPerUnit: BigInt!  # premium-token units per 1e18 option units, fee included
  lastTradeAt: BigInt!
  fills: [Fill!]! @derivedFrom(field: "instrument")
  positions: [Position!]! @derivedFrom(field: "instrument")
}
```

`Authorization` is one LP range with `strikeMin`, `strikeMax`, `expiry`,
`isCall`, `collateralToken`, `maxCollateral`, `usedCollateral`, `active`
and `fillCount`. `Fill` is one `OptionBought` event, immutable, keyed by
transaction hash and log index. `Position` is one holder's balance in one
instrument, credited on `OptionBought` and debited on `OptionClosed` and
`Redeemed`.

### Handlers and the bound-call refresh

The `RangeAuthorized` event does not carry the collateral token or a live
`usedCollateral`, and the vault's just-in-time pull accounting is not
something to re-implement in AssemblyScript. Instead, one bound contract
call per relevant event overwrites those fields from chain state.

`subgraph/src/vault.ts`:

```typescript
function refreshFromChain(auth: Authorization, vaultAddress: Address): void {
  let vault = AquaCollateralVault.bind(vaultAddress);
  let res = vault.try_authorizations(auth.authId);
  if (res.reverted) return;
  auth.maxCollateral = res.value.value4;
  auth.usedCollateral = res.value.value5;
  auth.collateralToken = res.value.value6;
  auth.active = res.value.value8;
}
```

The `OptionBought` handler updates the instrument, the buyer's position,
writes the fill, and refreshes the authorisation:

```typescript
export function handleOptionBought(event: OptionBought): void {
  let id = event.params.authId.toString();
  let auth = Authorization.load(id);
  if (auth == null) return;

  let inst = loadOrCreateInstrument(event.params.optionToken, auth, event.params.strike);
  inst.openInterest = inst.openInterest.plus(event.params.amount);
  inst.volume = inst.volume.plus(event.params.amount);
  inst.fillCount = inst.fillCount + 1;
  if (event.params.amount.gt(BigInt.zero())) {
    inst.lastPremiumPerUnit = event.params.premium.times(WAD).div(event.params.amount);
  }
  inst.lastTradeAt = event.block.timestamp;
  inst.save();
  ...
```

Seven events are handled: `RangeAuthorized`, `AuthorizationRevoked`,
`OptionBought`, `OptionClosed`, `Redeemed`, `CollateralReleased` and
`PullFailed` (a dishonoured just-in-time pull deactivates the range
on-chain, and the handler mirrors it).

### Deployments

| Network | Vault address | Start block | Studio endpoint |
|---|---|---|---|
| Sepolia | `0x82AcBBFE5E03510d5407d8C50435B08e6d2d0a4D` | 11677088 | `https://api.studio.thegraph.com/query/44448/smile-sepolia/v0.0.4` |
| Arc testnet | `0xE37ED711F7D1dc5aC045206b4A6367C55229C789` | 61227750 | `https://api.studio.thegraph.com/query/44448/smile-arc-testnet/v0.0.1` |

Both endpoints are recorded per chain in `frontend/lib/deployments.ts` and
report `hasIndexingErrors: false` with the testnets' real fills.

### The tape query

The frontend client defines the queries once as strings and mirrors the
entities as TypeScript interfaces.

`frontend/lib/subgraph.ts`:

```typescript
export const INSTRUMENTS = `query Instruments($first: Int!) {
  instruments(orderBy: lastTradeAt, orderDirection: desc, first: $first) { ${INSTRUMENT_FIELDS} }
}`;
export const POSITIONS_BY_HOLDER = `query PositionsByHolder($holder: Bytes!) {
  positions(where: { holder: $holder, balance_gt: "0" }, first: 1000) { ${POSITION_FIELDS} }
}`;
```

### The chain-id gate

`readTape` is the single entry point for ranges, instruments, fills and
positions. A subgraph endpoint is used whenever one resolves for the chain.
Only the local Anvil chain (chain id 31337 or 1337) may rebuild the same
entities from the event log; on a public network with no endpoint the
call throws rather than scanning.

`frontend/lib/tape.ts`:

```typescript
export async function readTape(opts: TapeOpts): Promise<Tape> {
  const url = subgraphUrlFor(opts.chainId);
  if (url) return tapeFromSubgraph(url, opts.since ?? 0);
  if (isLocalChain(opts.chainId) && opts.client && opts.vault) return (await stateFromLogs(opts.client, opts.vault)).tape;
  throw new SubgraphRequiredError(opts.chainId);
}
```

Every `Tape` carries a `source` field, `"subgraph"` or `"anvil-logs"`, and
the copilot is instructed to state where its numbers came from.

### The proxy and the per-chain gateway URL

A gateway URL carries the API key in its path, so it must never reach a
browser. It is configured server-side, per chain, and the browser reaches
it through `/api/subgraph`, which forwards the request body unchanged.
Resolution order in the route: an explicit `NEXT_PUBLIC_SUBGRAPH_URL`
override, then `SUBGRAPH_URL_<chainId>`, then a chain-agnostic
`SUBGRAPH_URL`, then the recorded Studio endpoint for the chain. The live
deployment sets `SUBGRAPH_URL_11155111` and `SUBGRAPH_URL_5042002`, so
Sepolia and Arc reads go through the network while Anvil has no entry.

`frontend/app/api/subgraph/route.ts`:

```typescript
export async function POST(req: Request) {
  const chainId = Number(new URL(req.url).searchParams.get("chainId") ?? "0");
  const url =
    process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
    process.env[`SUBGRAPH_URL_${chainId}`] ||
    process.env.SUBGRAPH_URL ||
    DEPLOYMENTS[chainId]?.subgraph ||
    "";
  if (!url) return Response.json({ errors: [{ message: `no subgraph for chain ${chainId}` }] }, { status: 404 });
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
```

The same resolution lives in `subgraphUrlFor` in `frontend/lib/subgraph.ts`
for server-side callers such as the copilot's tape tools; in the browser
that function returns the proxy path when the build has a server, and the
Studio endpoint directly on the static GitHub Pages export, which has no
server and therefore no key.

### Published to The Graph Network

A subgraph on The Graph exists in two places with different guarantees. A
**Studio deployment** is served by The Graph's own upgrade indexer from a
rate-limited development endpoint with no key. **Publishing** records the
subgraph on the protocol's contracts, which live on Arbitrum One
regardless of the chain the subgraph indexes, and makes it available
through the **gateway**, the query endpoint that routes each request to an
indexer and bills it to an **API key**. No curation signal is required:
the upgrade indexer keeps serving a published subgraph until independent
indexers pick it up.

Both subgraphs were published on 2026-09-12. The publish transaction is a
wallet step in Studio; the API key is created under Studio → API Keys.

| Network | Subgraph id (network) | Deployment id (IPFS hash) |
|---|---|---|
| Sepolia | `Bf9T8wuSLwvNSR9oTx2uuSjoL2P5kCagWAitFgykyes2` | `QmRkbvKcWtMShTSDGXJhEUYkjahWGvKsWU1EcTM3wDHEua` |
| Arc testnet | `9ZcFMvnhbWygRg7oB29NL8smoVysqCbdQpqNMhWtHbmq` | `QmTA9unF8d66AwATQz6MYxM6zvEW6LAj3kned4E48txoc3` |

The gateway URL has the form
`https://gateway.thegraph.com/api/<key>/subgraphs/id/<subgraph id>`. Both
answered with the testnets' real instruments and `hasIndexingErrors:
false` within minutes of publishing (the Arc subgraph took about two
minutes to appear). A subgraph id names the subgraph across versions; a
deployment id names one built version, and the gateway can also be
addressed by it (`/deployments/id/<hash>`).

The Studio development endpoints remain recorded in `lib/deployments.ts`
as the fallback for the browser on the static export and for any
environment without the key. The same key is the bearer token for The
Graph's Subgraph MCP server (next sections), so one credential covers both
the data path and the agent path.

### The copilot

The copilot is a chat panel in the application and one server route,
`POST /api/copilot/`. The route exists only on server builds (the Vercel
deployment); the static GitHub Pages export has no server, so the widget
hides itself there (`NEXT_PUBLIC_COPILOT`). Each request carries the chat
history and a context object the client assembles from what is on screen,
so the copilot's numbers match the visible interface.

`frontend/app/api/copilot/route.ts`:

```typescript
const ctx: CopilotContext = {
  spot: typeof context?.spot === "number" && context.spot > 0 ? context.spot : 3420,
  chainId: context?.chainId,
  address: context?.address,
  tab: isTabId(context?.tab) ? context.tab : undefined,
  skills: Array.isArray(context?.skills) ? context.skills.filter((s) => typeof s === "string") : undefined,
  customSkills: Array.isArray(context?.customSkills) ? context.customSkills : undefined,
};
```

**Model providers.** `lib/copilot/provider.ts` supports four providers,
`anthropic`, `openai`, `google` and `openrouter`, with defaults
`claude-opus-4-8`, `gpt-5-mini`, `gemini-2.5-pro` and `openrouter/auto`.
The operator chooses one with `COPILOT_PROVIDER` and the matching key
variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `OPENROUTER_API_KEY`), optionally
overriding the model with `COPILOT_MODEL`. A user may instead bring their
own key: the settings gear stores provider, key and model in the browser's
local storage only, and the panel sends them per request in the
`x-copilot-provider`, `x-copilot-api-key` and `x-copilot-model` headers;
the route builds that request's model client from them and never stores
or logs them. The live deployment runs `openrouter` with
`COPILOT_MODEL=openrouter/free`, a free routed model, so judges need no
key of their own; the tool-routing rules in the prompt were written with a
weak model in mind.

**The system prompt.** `lib/copilot/systemPrompt.ts` is one auditable
template with, in order: the current context (spot, chain, wallet); the
briefing for the tab on screen; the pricing model (the smile formula, the
current sigma, alpha and beta, how the spread arises, how ranges and the
just-in-time pull work); the tool rules (never do options mathematics in
the head, which tool answers which question, that trades are never
executed); the data-source rule (say whether numbers came from the
subgraph or the local event log); the active skills, in full; rules for
rolls, output style, teach mode and quiz mode; and, from the build-time
knowledge pack, a table of contents of every documentation section and the
glossary from the limitations page. The knowledge pack
(`lib/copilot/knowledge.generated.json`, built by
`scripts/gen-knowledge.mjs` from the README, the User Guide, the
limitations, solutions and copilot pages and the five sponsor pages)
holds the full section bodies for the `read_docs` tool, capped at six
thousand characters per section.

**Tab awareness.** `lib/copilot/tabs.ts` describes every application tab:
what is on screen, which documentation sections to read first, the best
first move, and three starter prompts. The panel sends the active tab in
the context; the prompt gains a "where the user is" block so that "explain
this" means the tab on screen, and the panel shows that tab's starters.

**Skills.** The eight built-in skills are markdown files in the `SKILL.md`
convention (frontmatter `name`, `description`, `starter`, then the
procedure), bundled into the knowledge pack at build time: Trading
opportunities, Risk management, Delta hedging, Explain margin, LP market
making, RFQ quoting, Macro context and Calendar spreads. The Skills menu
in the panel header toggles them and accepts user-written skills; both
lists live in local storage and ride each request in the context (custom
skills are capped at five of four thousand characters). Enabled skill
bodies are appended to the prompt under "Active skills".

**Built-in tools.** `lib/copilot/tools.ts` defines nineteen tools; the model
may take up to ten tool steps per turn. Grouped by what they read:

| Tool | What it does and what it reads |
|---|---|
| `read_docs` | Returns one section of the documentation from the knowledge pack by section id; the model is told to cite the id. |
| `get_market_state` | Spot, the smile parameters, ATM vol, expected move, 25-delta risk reversal and butterfly from the same code as the interface (`lib/options.ts`). |
| `price_strategy`, `suggest_strategies`, `scenario_analysis`, `analyze_adjustment` | Price a multi-leg strategy at the protocol's smile (entry, max profit and loss, probability of profit, breakevens, greeks), propose strategies for a stated view, run a spot and vol stress grid, and price a roll or adjustment before and after. Client-side mathematics, no chain read. |
| `get_onchain_quote` | Calls the deployed pricing engine for a live call quote and cross-checks it against the front-end formula. |
| `get_positions`, `portfolio_risk` | The connected wallet's balances, written ranges and long positions, and their aggregate risk. Positions come from the tape (`lib/copilot/chain.ts` reads the subgraph on public networks). |
| `find_opportunities` | Every live strike on every active range priced at the vault's live volatility per expiry, expressed as implied volatility and compared with the nearest listed Deribit instrument and with the last fill of the same instrument; ranked cheap to expensive. Reads the tape and Deribit. |
| `liquidity_map` | Every active range with capacity, utilisation, open interest, fills and days since the last trade, flagged scarce, empty, stale or expiring, plus a per-strike heat map. Reads the tape. |
| `portfolio_greeks` | The wallet's whole book from the tape, long positions with cost basis from its own fills and the written side from open interest on its ranges, with net delta, gamma, theta and vega. |
| `hedge_suggestion` | The quantity of spot ETH, or of calls or puts at a strike, that brings a book to a target delta, with greeks before and after. The prompt forbids computing a hedge any other way. |
| `reference_market` | Deribit's public API: index price, the DVOL index, ATM implied volatility at the nearest listed expiry, and the nearest listed instrument to a strike and expiry. Cached for sixty seconds. |
| `macro_calendar` | Scheduled FOMC, CPI and listed-expiry dates within a horizon from a static 2026 table, with event-volatility heuristics. |
| `prepare_lp_range`, `prepare_rfq_quote`, `propose_trade` | Interface tools: each renders a card whose button prefills the Write a Range form, the RFQ signer or the Payoff Builder. The user reviews and signs in the wallet; the copilot cannot send a transaction and never holds a key. |
| `quiz_question` | Renders one multiple-choice question as clickable choices; the pick returns as the tool result. |

`find_opportunities` is representative of the tape tools:

`frontend/lib/copilot/graphTools.ts`:

```typescript
export async function findOpportunities(
  chainId: number | undefined,
  spot: number,
  opts: { side?: "cheap" | "expensive" | "both"; isCall?: boolean; maxResults?: number }
) {
  const [tape, ref] = await Promise.all([loadTape(chainId), tryReference()]);
  const vault = (chainId ? contractsFor(chainId) : CONTRACTS).aquaVault as Address;
  const sigmas = await liveSigmaByExpiry(getPublicClient(chainId), vault, [...new Set(tape.auths.map((a) => a.expiry))]);
  ...
      const ask = liveAsk(spot, k, a.isCall, t, sigmaGlobal);
      const smileIv = impliedVol(ask, spot, k, t, a.isCall);
      const near = ref ? nearestReference(ref, k, a.expiry, a.isCall) : null;
```

`liquidity_map` treats a range as scarce at eighty percent used, stale
after three days without a trade and expiring within three days.
`portfolio_greeks` combines `Position` rows for the holder with open
interest on the holder's own ranges. Every tape tool returns the tape's
`source` field, `"subgraph"` on public networks or `"anvil-logs"` on the
local chain.

### MCP servers

The Model Context Protocol (MCP) is an open standard by which an AI model
connects to external tool servers over HTTP. In Smile, MCP is how the
copilot's toolset grows without a rebuild.

**How the plumbing works.** `lib/copilot/mcp.ts` takes two lists of
servers: the operator's, from the `COPILOT_MCP_SERVERS` environment
variable, and the user's, sent from the browser in the `x-copilot-mcp`
header the same way the bring-your-own-key headers are. Both are JSON
arrays of `{ name, url, token?, transport? }`; only `https://` URLs are
accepted, the transport is `http` or `sse`, and the lists are merged by
name with the user's entry winning, capped at five servers. On every
request the route opens each server (with an eight-second handshake
timeout), asks it for its tools, and merges them after the built-in tools
so that a built-in name always wins; a colliding name between two servers
is prefixed with the server's name. The servers are closed when the stream
finishes or errors. A server that fails to connect is logged and skipped,
so a dead server cannot break the chat.

`frontend/lib/copilot/mcp.ts`:

```typescript
export function mergeMcpConfigs(env: McpServerConfig[], header: McpServerConfig[]): McpServerConfig[] {
  const byName = new Map(env.map((c) => [c.name, c]));
  for (const c of header) byName.set(c.name, c);
  return [...byName.values()].slice(0, MAX_SERVERS);
}
```

```typescript
const client = await createMCPClient({
  transport: {
    type: c.transport ?? "http",
    url: c.url,
    headers: c.token ? { Authorization: `Bearer ${c.token}` } : undefined,
  },
  // Bound the handshake so a dead server cannot stall the chat.
  initializationOptions: { timeout: 8000 },
});
```

**What it has today.** The Graph's Subgraph MCP server,
`https://subgraphs.mcp.thegraph.com/sse`, authenticated with a Gateway
API key as the bearer token. It is seeded operator-side on the live
deployment through `COPILOT_MCP_SERVERS`, so every copilot request there
carries its tools with no setup by the user; it is also the one preset in
the settings gear (the user pastes their own key). The server exposes
nine tools: `search_subgraphs_by_keyword`, `get_top_subgraph_deployments`,
`get_schema_by_subgraph_id`, `get_schema_by_deployment_id`,
`get_schema_by_ipfs_hash`, `execute_query_by_subgraph_id`,
`execute_query_by_deployment_id`, `execute_query_by_ipfs_hash` and
`get_deployment_30day_query_counts`. With them the copilot can find any
indexed subgraph on The Graph Network, read its schema and query it in
natural language, not only Smile's own. It was verified end to end on
2026-09-12: asked to search subgraphs for "uniswap", the deployed copilot
called `search_subgraphs_by_keyword` through the seeded server and
answered with a real subgraph name.

The same server is available to developers outside the application:
`.mcp.json.example` at the repository root is a one-file client
configuration for Claude Code or Cursor, and `subgraph/SKILL.md` describes
Smile's entities, canonical queries, endpoints and units so that an AI
environment can query `smile-sepolia` or `smile-arc-testnet` without
reading the schema.

`.mcp.json.example`:

```json
{
  "mcpServers": {
    "thegraph": {
      "type": "sse",
      "url": "https://subgraphs.mcp.thegraph.com/sse",
      "headers": {
        "Authorization": "Bearer <GATEWAY_API_KEY>"
      }
    }
  }
}
```

**What it can have.** Any MCP server reachable over HTTPS: the settings
gear takes a name, a URL, an optional bearer token and the transport.
Servers that fit a trading coach include a market-data server for Deribit
or another listed venue (replacing the built-in sixty-second Deribit
cache with the user's own feed), a price-oracle server for Chainlink or
Pyth rounds, a transaction-simulation server so a proposed trade can be
dry-run before the user signs, and another project's subgraph server for
cross-protocol positions. Limits: five servers per request, HTTPS only,
one merged toolset (a server tool with a built-in's name is shadowed, and
a name shared by two servers is prefixed), an eight-second connect
budget per server, and the routing quality of the model in use; the free
routed model on the live deployment follows explicit tool rules well and
open-ended tool choice less well, so a server with many similar tools
benefits from a skill that names which one to call.

### The seeded tape

A chart and a screener need trades to look at. `script/seed-tape.sh`
writes three ranges (two call expiries and one put) and one hundred trades
on the local chain. On Anvil the trades are split into ten batches about
six simulated hours apart, and the mock oracle random-walks up to 1.5
percent between batches so that premiums and implied volatility move
across the tape. `./local.sh` runs it by default (`SEED_TRADES=100`; set
`0` to skip). The resulting tape contains eighty-three buys and seventeen
sellbacks across fifty-four simulated hours.

## Limitations

- **Transfers of option tokens are not indexed.** `Position` is credited on
  `OptionBought` and debited on `OptionClosed` and `Redeemed`. An ERC-20
  transfer of an option token between wallets is not observed, so a
  transferred position shows on the original buyer until it is closed or
  redeemed. Tracking it needs a data-source template per `OptionToken`
  (plan G6, not built). Balances are clamped at zero so an unseen transfer
  cannot drive them negative.
- **The macro calendar is static.** `macro_calendar` reads a hardcoded
  2026 table of FOMC, CPI and listed-expiry dates rather than a live feed.
- **No local graph-node on arm64.** The development host has no
  `graph-node` image for its architecture, so the local Anvil chain has no
  subgraph. `lib/tape.ts` rebuilds the same entities from `eth_getLogs`
  there, gated on chain id, and that path does not exist on public
  networks. The subgraph's matchstick unit tests are written but run only
  on x86.
- **The gateway path depends on one key and one deployment.** The
  server-side gateway URLs are set on the Vercel deployment and in the
  local environment file; the static GitHub Pages export has no server and
  falls back to the Studio development endpoints, which are rate-limited.
  The key is a shared operator credential subject to The Graph's
  per-key query quota, not a per-user one.
- **The MCP toolset is only as good as the model routing it.** The Graph's
  server is verified with an explicit request; whether the free routed
  model reaches for it unprompted on an open question is not guaranteed.
  Servers are opened on every request, which adds their handshake time to
  each turn.
- **The screener is a model, not a market.** `find_opportunities` prices
  Smile's ask with the vault's own formula at the hook's live volatility
  and inverts a Black-Scholes price for the implied volatility. Deribit's
  instruments are perpetual-margined and listed at different strikes and
  expiries; the nearest match is a reference, not a like-for-like quote.
  The skills instruct the copilot to call something cheap only when both
  the reference comparison and the last-fill comparison agree.

## Plans

The phase-two status table and cut list in
`docs/plans/2026-09-09-theGraph.md` record what remains.

- **Publish and key (P8): done 2026-09-12.** Both subgraphs are published
  on Arbitrum One and served through the gateway; the live deployment reads
  them with `SUBGRAPH_URL_11155111` and `SUBGRAPH_URL_5042002`. What
  remains is operational: rotate the key, watch the query allowance, and
  add curation signal if independent indexers are wanted beyond the
  upgrade indexer.
- **Dynamic data sources (G6).** A data-source template per `OptionToken`
  so that ERC-20 transfers of option tokens update `Position`.
- **The sibling vaults.** The subgraph indexes `AquaCollateralVault` only.
  `SpreadVault`, `MarginVault` and `RfqVault` emit their own events and
  would need their own data sources for the tape to cover spreads, margined
  puts and signed-quote fills.
- **A live macro feed** in place of the static table.
- **More MCP servers as presets.** The settings gear has one preset; a
  Deribit market-data server and a transaction-simulation server are the
  natural next two, each with a skill naming when to call it.

## Glossary

- **API key (Gateway).** The credential created in Studio that authorises
  queries to the gateway and against which they are metered. In Smile it is
  embedded in the server-side gateway URL and reused as the bearer token
  for The Graph's Subgraph MCP; it never reaches a browser.
- **Agent (copilot).** An AI model that answers by calling tools rather
  than from memory. Smile's copilot calls pricing, tape and preparation
  tools; it prepares transactions but never signs or sends one.
- **Bearer token.** A credential sent in an HTTP `Authorization` header.
  The copilot's MCP client sends a server's token this way on every request.
- **Bound call.** In a subgraph mapping, a read-only call to the indexed
  contract at the block being processed, used here to refresh
  `usedCollateral` and `collateralToken` from chain state.
- **Bring your own key (BYOK).** The settings-gear option by which a user
  supplies their own model-provider key from the browser, sent per request
  in headers and never stored by the server.
- **Curation signal.** GRT staked on a published subgraph to attract
  independent indexers. Not required for Smile's subgraphs, which the
  upgrade indexer serves.
- **Deployment id.** The IPFS hash of one built version of a subgraph
  (`Qm…`). The gateway can be addressed by it as well as by the subgraph id.
- **Deribit.** The largest centralised crypto options exchange, used by the
  copilot as the listed reference market for implied volatility.
- **DVOL.** Deribit's thirty-day implied volatility index for ETH.
- **Entity.** A table in a subgraph's schema. Smile has four:
  `Authorization`, `Fill`, `Instrument`, `Position`.
- **Gateway.** The Graph's query endpoint for subgraphs published to the
  decentralised network, authenticated by an API key; it routes each query
  to an indexer. In Smile the key stays server-side behind `/api/subgraph`,
  configured per chain as `SUBGRAPH_URL_<chainId>`.
- **GraphQL.** A query language in which the client names the fields it
  wants and receives exactly those.
- **Greeks.** The sensitivities of an option's price: delta (to the
  underlying price), gamma (of delta to the underlying price), theta (to
  time) and vega (to volatility).
- **Handler (mapping).** The code, written in AssemblyScript, that a
  subgraph runs on each event to update its entities. Smile's handlers are
  in `subgraph/src/vault.ts`.
- **Hedge.** A position taken to offset the risk of another. A delta hedge
  brings a book's net delta to a target, usually zero.
- **Implied volatility (IV).** The volatility that, put into a pricing
  model, reproduces an observed option price. The copilot inverts
  Black-Scholes to obtain it from a premium.
- **Indexer.** A node on The Graph's network that runs subgraphs and serves
  queries. Studio deployments are served by an upgrade indexer without
  curation.
- **Instrument.** One strike of one range, represented by one
  `OptionToken` contract.
- **Just-in-time pull.** The 1inch Aqua mechanism by which an LP's
  collateral stays in the LP's wallet until a buyer matches and is pulled
  at that moment.
- **L12a.** The limitation entry in `docs/limitations.md` describing the
  fifty-range cap that the subgraph lifted.
- **MCP (Model Context Protocol).** An open standard for connecting an AI
  model to external tool servers over HTTP. The copilot opens the
  operator's and the user's servers on every request and merges their tools
  with its own. The Graph's Subgraph MCP exposes any indexed subgraph to a
  model through nine tools.
- **Publish.** Registering a subgraph on The Graph Network's contracts on
  Arbitrum One so that it can be served through the gateway and indexed by
  the network. The indexed chain is unchanged by publishing.
- **Open interest.** The number of option units outstanding in an
  instrument: bought minus closed minus redeemed.
- **Range (authorisation).** An LP's standing offer to write options
  between two strikes up to one expiry, backed by a maximum collateral.
- **Skill.** A markdown file in the `SKILL.md` convention (name,
  description, starter, procedure) that teaches the copilot a workflow.
- **Subgraph.** The unit of indexing on The Graph: a manifest naming the
  contract and events, a schema of entities, and the handlers.
- **Subgraph id.** The identifier of a published subgraph on the network
  (`Bf9T…` for Sepolia, `9ZcF…` for Arc testnet), stable across versions.
- **Subgraph Studio.** The Graph's hosted service for deploying and testing
  subgraphs before publishing them to the network.
- **System prompt.** The instructions the copilot receives before the
  conversation: context, the pricing model, tool rules, the tab briefing,
  active skills, the documentation table of contents and the glossary.
- **Tape.** The running record of ranges, instruments, fills and positions.
  On public networks it is the subgraph; on the local chain it is rebuilt
  from the event log.
- **Upgrade indexer.** The indexer The Graph operates to serve Studio
  deployments and newly published subgraphs that have no curation signal.
- **WAD.** A fixed-point number with eighteen decimals, the unit for
  strikes, option amounts and WETH collateral in the schema.
