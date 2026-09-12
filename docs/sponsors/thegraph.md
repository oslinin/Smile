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
`smile-arc-testnet` (version 0.0.1) for Circle's Arc testnet. On those
public networks the application and the AI copilot read positions,
liquidity and trade history from The Graph only; no RPC scan exists as a
fallback. The copilot is built on that tape as a trading agent: it screens
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
| Published to The Graph Network (Arbitrum One) and served through the gateway with an API key held server-side; the Sepolia subgraph id is `Bf9T8wuSLwvNSR9oTx2uuSjoL2P5kCagWAitFgykyes2` | `frontend/app/api/subgraph/route.ts` (`SUBGRAPH_URL_<chainId>`), `subgraph/README.md` | EthOnline 2026 (2026-09-12) |
| Browser and server GraphQL client with per-chain endpoint resolution | `frontend/lib/subgraph.ts` | EthOnline 2026 |
| Server-side proxy so a gateway API key never reaches the browser | `frontend/app/api/subgraph/route.ts` | EthOnline 2026 |
| The tape: one shape for ranges, instruments, fills and positions; chain-id gate | `frontend/lib/tape.ts` | EthOnline 2026 |
| LP dashboard and copilot position tools reading the tape (the L12a fix) | `frontend/components/LPDashboard.tsx`, `frontend/lib/copilot/chain.ts` | EthOnline 2026 |
| Copilot trading tools: `find_opportunities`, `liquidity_map`, `portfolio_greeks`, `hedge_suggestion`, `reference_market`, `macro_calendar`, `prepare_lp_range`, `prepare_rfq_quote` | `frontend/lib/copilot/graphTools.ts`, `deribit.ts`, `macro.ts`, `tools.ts` | EthOnline 2026 |
| Tab-aware briefing in the copilot prompt | `frontend/lib/copilot/systemPrompt.ts`, `tabs.ts` | EthOnline 2026 |
| Eight trader skills and a Skills menu with user-added skills | `frontend/skills/*.md`, `frontend/components/copilot/SkillsMenu.tsx` | EthOnline 2026 |
| MCP servers per user with a preset for The Graph's Subgraph MCP | `frontend/lib/copilot/mcp.ts`, `frontend/components/copilot/CopilotSettings.tsx` | EthOnline 2026 |
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

### The proxy

A gateway URL that carries an API key is configured server-side as
`SUBGRAPH_URL`. Browser callers reach it through `/api/subgraph`, which
forwards the request body unchanged and falls back to the recorded Studio
endpoint when no server-side URL is set.

`frontend/app/api/subgraph/route.ts`:

```typescript
export async function POST(req: Request) {
  const chainId = Number(new URL(req.url).searchParams.get("chainId") ?? "0");
  const url =
    process.env.NEXT_PUBLIC_SUBGRAPH_URL || process.env.SUBGRAPH_URL || DEPLOYMENTS[chainId]?.subgraph || "";
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

### A copilot tool

`find_opportunities` loads the tape and the Deribit reference in parallel,
reads the vault's live volatility per expiry, and prices every grid strike
of every active range.

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

The other tape tools follow the same pattern. `liquidity_map` buckets
ranges into bands and flags scarce (at least eighty percent used), empty,
stale (no trade for more than three days) and expiring ranges.
`portfolio_greeks` combines `Position` rows for the holder with open
interest on the holder's own ranges. `reference_market` calls Deribit's
public API with a sixty-second cache. `macro_calendar` reads a static
table. The two `prepare_*` tools are user-interface tools that render
cards.

### Skills

Each skill is a markdown file with frontmatter. Enabled skills ride each
request and are appended to the system prompt.

`frontend/skills/trading-opportunities.md`:

```markdown
---
name: Trading opportunities
description: Screen live Smile instruments for mispriced options versus the Deribit reference vol and recent trades, then confirm and propose.
starter: Find me the three cheapest options on the book right now and explain why they're cheap.
---
```

The eight built-in skills are `trading-opportunities`, `risk-management`,
`delta-hedging`, `explain-margin`, `lp-market-making`, `rfq-quoting`,
`macro-context` and `calendar-spreads`.

### MCP

The Model Context Protocol (MCP) is an open standard by which an AI model
connects to external tool servers. The copilot opens every configured
server per request, merges its tools with the built-in ones, and closes
them when the stream ends. The settings panel offers one preset.

`frontend/components/copilot/CopilotSettings.tsx`:

```typescript
const THEGRAPH_MCP: McpServer = { name: "thegraph", url: "https://subgraphs.mcp.thegraph.com/sse", transport: "sse" };
```

`frontend/lib/copilot/mcp.ts`:

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

A server that fails to connect is logged and skipped so that a dead server
cannot break the chat. The same server is available to developers as a
client configuration:

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
- **The Graph's Subgraph MCP is untested end to end.** Connecting to it
  requires a Gateway API key from Studio, which is a wallet-side step. The
  copilot's MCP plumbing is verified against a bogus server (skipped
  without error), not against the live Graph server.
- **Studio endpoints are rate-limited development endpoints.** Production
  use requires publishing the subgraph to the decentralised network and
  querying the gateway with an API key.
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

- **Publish and key (P8).** Publish `smile-sepolia` and
  `smile-arc-testnet` from Studio to the decentralised network (the publish
  transaction is on Arbitrum One; the indexed chain is unchanged), create a
  Gateway API key, and set `SUBGRAPH_URL` server-side. A wizard for the
  two wallet steps is in `subgraph/README.md`.
- **Dynamic data sources (G6).** A data-source template per `OptionToken`
  so that ERC-20 transfers of option tokens update `Position`.
- **The sibling vaults.** The subgraph indexes `AquaCollateralVault` only.
  `SpreadVault`, `MarginVault` and `RfqVault` emit their own events and
  would need their own data sources for the tape to cover spreads, margined
  puts and signed-quote fills.
- **A live macro feed** in place of the static table.
- **Verify the Graph MCP** against the live server once a Gateway key is
  in hand.

## Glossary

- **Agent (copilot).** An AI model that answers by calling tools rather
  than from memory. Smile's copilot calls pricing, tape and preparation
  tools; it prepares transactions but never signs or sends one.
- **Bound call.** In a subgraph mapping, a read-only call to the indexed
  contract at the block being processed, used here to refresh
  `usedCollateral` and `collateralToken` from chain state.
- **Deribit.** The largest centralised crypto options exchange, used by the
  copilot as the listed reference market for implied volatility.
- **DVOL.** Deribit's thirty-day implied volatility index for ETH.
- **Entity.** A table in a subgraph's schema. Smile has four:
  `Authorization`, `Fill`, `Instrument`, `Position`.
- **Gateway.** The Graph's query endpoint for subgraphs published to the
  decentralised network, authenticated by an API key. In Smile the key
  stays server-side behind `/api/subgraph`.
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
  model to external tool servers. The Graph's Subgraph MCP exposes any
  indexed subgraph to a model.
- **Open interest.** The number of option units outstanding in an
  instrument: bought minus closed minus redeemed.
- **Range (authorisation).** An LP's standing offer to write options
  between two strikes up to one expiry, backed by a maximum collateral.
- **Skill.** A markdown file in the `SKILL.md` convention (name,
  description, starter, procedure) that teaches the copilot a workflow.
- **Subgraph.** The unit of indexing on The Graph: a manifest naming the
  contract and events, a schema of entities, and the handlers.
- **Subgraph Studio.** The Graph's hosted service for deploying and testing
  subgraphs before publishing them to the network.
- **Tape.** The running record of ranges, instruments, fills and positions.
  On public networks it is the subgraph; on the local chain it is rebuilt
  from the event log.
- **WAD.** A fixed-point number with eighteen decimals, the unit for
  strikes, option amounts and WETH collateral in the schema.
