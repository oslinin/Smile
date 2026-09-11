---
name: Smile subgraph
description: Query the Smile options marketplace tape (ranges, fills, instruments, positions) on The Graph — endpoints, entities, canonical queries, unit conventions, and the Anvil dev-tape caveat.
---
# Smile subgraph

The Graph indexes `AquaCollateralVault` events into four entities. Every copilot number about positions, open interest, liquidity or last trades on a public network comes from here — there is no RPC fallback on Sepolia / Arc.

## Endpoints

| Network | Endpoint |
|---|---|
| Sepolia (Studio) | `https://api.studio.thegraph.com/query/44448/smile-sepolia/v0.0.4` |
| Arc testnet | `smile-arc-testnet` — `https://api.studio.thegraph.com/query/44448/smile-arc-testnet/v0.0.1` (same schema) |
| Anvil (31337 / 1337) | **no subgraph.** The app rebuilds the same entities from `eth_getLogs` (`frontend/lib/tape.ts`, tagged `source: "anvil-logs"`); subgraph results are tagged `source: "subgraph"`. |

Studio endpoints are rate-limited dev endpoints. For production use publish to the network and query the gateway with a Gateway API key (thegraph.com/studio → API Keys); the app keeps that URL server-side (`SUBGRAPH_URL`, proxied by `/api/subgraph`).

## Entities (`schema.graphql`)

Plural query names: `authorizations`, `fills`, `instruments`, `positions`.

- **Authorization** — one per LP range. `id` = authId (decimal string), `authId`, `lp`, `strikeMin`, `strikeMax`, `expiry`, `isCall`, `collateralToken`, `maxCollateral`, `usedCollateral`, `active`, `fillCount`, `fills`, `instruments`, `createdAtBlock`, `createdAtTimestamp`, `revokedAtBlock`.
- **Fill** (immutable) — one per `OptionBought`. `id` = txHash-logIndex, `authorization`, `instrument`, `lp`, `buyer`, `optionToken`, `strike`, `amount`, `premium`, `isCall`, `expiry`, `blockNumber`, `timestamp`.
- **Instrument** — one per OptionToken (one strike of one range). `id` = optionToken address (lowercase), `optionToken`, `authorization`, `lp`, `strike`, `expiry`, `isCall`, `openInterest` (bought − closed − redeemed), `volume`, `fillCount`, `lastPremiumPerUnit`, `lastTradeAt`, `fills`, `positions`.
- **Position** — one per (instrument, holder). `id` = optionToken-holder, `holder`, `instrument`, `optionToken`, `balance`, `updatedAt`. Credited on `OptionBought`, debited on `OptionClosed` / `Redeemed`. ERC-20 transfers of option tokens between wallets are not tracked.

## Units

- Strikes, `amount`, `openInterest`, `volume`, `balance`, `maxCollateral`/`usedCollateral` for WETH: WAD (1e18). Divide by 1e18.
- `premium` and `lastPremiumPerUnit`: premium-token units — USDC, 6 decimals, fee included. `lastPremiumPerUnit` is per 1e18 option units.
- Collateral token: WETH for calls, USDC (6 dec) for puts.
- `expiry`, `timestamp`, `lastTradeAt`, `updatedAt`: unix seconds. Addresses are lowercase `Bytes`.

## Canonical queries

Active ranges by LP:
```graphql
query ActiveRanges($lp: Bytes!) {
  authorizations(where: { lp: $lp, active: true }, orderBy: createdAtTimestamp, orderDirection: desc) {
    id strikeMin strikeMax expiry isCall collateralToken maxCollateral usedCollateral fillCount
  }
}
```
Open interest by strike (live instruments only):
```graphql
query OpenInterest($now: BigInt!) {
  instruments(where: { openInterest_gt: 0, expiry_gt: $now }, orderBy: strike, first: 500) {
    id strike expiry isCall openInterest volume lastPremiumPerUnit lastTradeAt
  }
}
```
Last trades for an instrument:
```graphql
query LastTrades($instrument: String!, $n: Int = 20) {
  fills(where: { instrument: $instrument }, orderBy: timestamp, orderDirection: desc, first: $n) {
    id buyer amount premium timestamp blockNumber
  }
}
```
A holder's positions:
```graphql
query Positions($holder: Bytes!) {
  positions(where: { holder: $holder, balance_gt: 0 }) {
    balance updatedAt instrument { id strike expiry isCall lastPremiumPerUnit openInterest }
  }
}
```
Liquidity by band (client-side: bucket `strikeMin..strikeMax` into $50 bands, capacity = `maxCollateral - usedCollateral`):
```graphql
query Liquidity($now: BigInt!) {
  authorizations(where: { active: true, expiry_gt: $now }, first: 1000) {
    id lp strikeMin strikeMax expiry isCall maxCollateral usedCollateral
    instruments { strike openInterest lastTradeAt }
  }
}
```

## From an agent

- **Claude Code / Cursor via The Graph's Subgraph MCP**: copy `.mcp.json.example` (repo root) to `.mcp.json`, put a Gateway API key in the `Authorization` header, then ask the agent to search for `smile-sepolia` and run the queries above. The Smile web copilot can use the same server: Copilot → ⚙ → "Add The Graph Subgraph MCP".
- **curl**:
```sh
curl -s https://api.studio.thegraph.com/query/44448/smile-sepolia/v0.0.4 \
  -H 'content-type: application/json' \
  -d '{"query":"{ instruments(first: 5, orderBy: lastTradeAt, orderDirection: desc) { id strike openInterest lastPremiumPerUnit } }"}'
```
