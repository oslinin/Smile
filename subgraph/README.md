# Smile subgraph

Indexes `AquaCollateralVault` — every LP range authorization, every fill,
every instrument's open interest and every holder's balance — so the app
and the AI copilot read the market as one query instead of a capped,
brute-force RPC scan (`docs/limitations.md` L12a). On Sepolia and Arc this
is the **only** position source: the app has no RPC path there
(`frontend/lib/tape.ts`). The copilot's trading tools (opportunities,
liquidity map, portfolio greeks, hedging, LP/RFQ preparation) run on it —
`docs/copilot.md`. Agent-facing description of the entities and queries:
[`SKILL.md`](SKILL.md). Plan: `docs/plans/2026-09-09-theGraph.md`.

## Entities

- **Authorization** — one per `authorizeRange`, keyed by `authId`, with the
  LP's address indexed. `usedCollateral`, `collateralToken`, and `active`
  are refreshed by a bound `authorizations(authId)` call on every fill,
  sellback, reclaim, and pull failure — the vault's JIT-pull accounting is
  read from chain state, never re-implemented in AssemblyScript.
- **Fill** — one per `OptionBought`: buyer, instrument, strike, size,
  premium (fee included), block and timestamp.
- **Instrument** — one per option token (a strike of a range): open
  interest (bought − closed − redeemed), volume, fill count, last premium
  per unit, last trade time. "Open interest by strike" and an LP's live
  short exposure are one query. (Named `Instrument`, not `Series`:
  graph-node pluralises `Series` as `series_collection`.)
- **Position** — one per (instrument, holder): the holder's balance,
  credited on `OptionBought`, debited on `OptionClosed` and `Redeemed`,
  clamped at zero. ERC-20 transfers between wallets are not tracked
  (needs a data-source template per token — plan G6).

```graphql
{
  authorizations(where: { lp: "0xf39f...2266", active: true }, orderBy: createdAtBlock, orderDirection: desc) {
    id strikeMin strikeMax expiry isCall maxCollateral usedCollateral fillCount
  }
  instruments(orderBy: openInterest, orderDirection: desc, first: 10) { strike isCall expiry openInterest lastPremiumPerUnit lastTradeAt lp }
  positions(where: { holder: "0x7099...79c8", balance_gt: "0" }) { instrument { strike isCall expiry } balance }
  fills(where: { buyer: "0x7099...79c8" }) { optionToken strike amount premium timestamp }
}
```

## Graph Studio: `smile-sepolia` (the judged deployment)

Deployed 2026-09-10 with graph-cli 0.98 (`graph auth <deploy key>`, then
`graph deploy smile-sepolia --network sepolia --version-label vX.Y.Z`;
`networks.json` carries the per-network address + startBlock so
`subgraph.yaml` stays on `localhost`):

| | |
|---|---|
| Studio | https://thegraph.com/studio/subgraph/smile-sepolia |
| Query (HTTP) | `https://api.studio.thegraph.com/query/44448/smile-sepolia/<version>` |
| v0.0.1 | IPFS `QmQX7gssM4VG1ez7AAjFdYkJbnsDNvo1Se6jgczWMER2JC`, indexed the README's older Sepolia vault `0x5115fbdb810D1dB316034fF670c65c45d875f887` — synced, no errors, no data: that vault predates ranges and never emitted an event |
| v0.0.2 | indexes the EthOnline 2026 Sepolia deployment's `AquaCollateralVault` `0x82AcBBFE5E03510d5407d8C50435B08e6d2d0a4D` from its deploy block 11,677,088 ([docs/sepolia-deployment.md](../docs/sepolia-deployment.md)); returned Authorization `#0` (calls $2,300–$2,800, 0.02 WETH) within a minute of `Aqua.ship`, and the `Fill` for the 0.01-unit $2,500 call (premium 5.636405 USDC, `usedCollateral` refreshed to 0.01 WETH via the bound call) one block after the buy — `https://api.studio.thegraph.com/query/44448/smile-sepolia/v0.0.2` |

| **v0.0.4** (current) | adds `Instrument` and `Position` entities and the `Redeemed` handler (2026-09-11). The one Sepolia fill shows as instrument `0x4c46…4fa2` with `openInterest` 0.01, `lastPremiumPerUnit` 563.64 USDC, and a `Position` for the buyer — `https://api.studio.thegraph.com/query/44448/smile-sepolia/v0.0.4` |

## Graph Studio: `smile-arc-testnet`

The Graph's network registry lists `arc-testnet` (eip155:5042002) with
subgraph support, so the same manifest deploys to Arc:
`graph deploy smile-arc-testnet --network arc-testnet --version-label v0.0.1`
(`networks.json` carries the Arc vault `0xE37ED711F7D1dc5aC045206b4A6367C55229C789`
from block 61,227,750). Studio: https://thegraph.com/studio/subgraph/smile-arc-testnet,
query `https://api.studio.thegraph.com/query/44448/smile-arc-testnet/v0.0.1` —
indexes the Arc deployment's real-USDC fill (`Instrument` $3,000 call,
open interest 0.01).

## Which endpoint the app reads

`frontend/lib/deployments.ts` records the Studio endpoint per chain, so
Sepolia and Arc are always indexed from the app's point of view. Overrides:

- `NEXT_PUBLIC_SUBGRAPH_URL` — any endpoint, any chain (a local graph-node,
  a newer version).
- `SUBGRAPH_URL_<chainId>` / `SUBGRAPH_URL` (server only) — a **gateway URL carrying an API key**
  (`https://gateway.thegraph.com/api/<key>/subgraphs/id/<id>`). Browser
  queries go through `/api/subgraph`, so the key never reaches a browser.

## Publishing to the network (the production path)

> **Done for Sepolia (2026-09-12):** `smile-sepolia` is published on
> Arbitrum One — subgraph id `Bf9T8wuSLwvNSR9oTx2uuSjoL2P5kCagWAitFgykyes2`,
> gateway URL `https://gateway.thegraph.com/api/<key>/subgraphs/id/Bf9T8wuSLwvNSR9oTx2uuSjoL2P5kCagWAitFgykyes2`. The Vercel app reads Sepolia through it
> (`SUBGRAPH_URL_11155111`). `smile-arc-testnet` is published as well —
> subgraph id `9ZcFMvnhbWygRg7oB29NL8smoVysqCbdQpqNMhWtHbmq`, wired as
> `SUBGRAPH_URL_5042002`.

The Studio query endpoints above are rate-limited dev endpoints. To serve
through the decentralized network with an API key:

1. Studio → the subgraph → **Publish** → network *Arbitrum One* (the
   publish transaction only; the indexed chain stays Sepolia/Arc). Needs a
   little ETH on Arbitrum One for gas; no curation signal is required — the
   upgrade indexer serves the subgraph.
2. Studio → **API Keys** → create one; copy the query URL
   `https://gateway.thegraph.com/api/<key>/subgraphs/id/<deployment id>`.
3. Put it in `frontend/.env.local` as `SUBGRAPH_URL=…` (server-side) and
   restart; the app's browser reads go through `/api/subgraph`.
4. The same key is the bearer token for The Graph's Subgraph MCP
   (`.mcp.json.example`, and the copilot's settings gear → MCP servers).

## Local: graph-node against the `./local.sh` Anvil

**x86-64 hosts only.** `graphprotocol/graph-node` ships amd64 images
exclusively (checked v0.36–v0.38 and `latest` on 2026-09-10), and running
them under qemu user-mode emulation on an arm64 host crashes inside
graph-node's WASM JIT. On arm64 (this repo's dev VPS included), skip this
section and use Graph Studio below; the frontend and copilot fall back to
their RPC paths whenever `NEXT_PUBLIC_SUBGRAPH_URL` is unset.

Ports are remapped away from graph-node's defaults because this repo's
vol-surface renderer already serves 8000:

| Service | Host port |
|---|---|
| GraphQL (queries) | `http://localhost:8100/subgraphs/name/smile/local` |
| GraphQL playground | `http://localhost:8100/subgraphs/name/smile/local/graphql` |
| Admin / `graph deploy` | `http://localhost:8120` |
| Index status | `http://localhost:8130` |
| IPFS | `http://localhost:5001` |

`local.sh` binds Anvil to `127.0.0.1` **and** the docker bridge
(`172.17.0.1`, only when a `docker0` interface exists), so the container
reaches it via `host.docker.internal` without the dev chain being exposed on
the VPS's public interface.

```bash
./local.sh                                   # Anvil + contracts + frontend (prints NEXT_PUBLIC_AQUA_VAULT)
cd subgraph
pnpm install
pnpm node:up                                 # graph-node + ipfs + postgres (sudo docker compose — v2; the v1 `docker-compose` binary fails against current Docker engines with a `ContainerConfig` KeyError)
pnpm codegen && pnpm build
pnpm create-local && pnpm deploy-local       # subgraph.yaml's address must match the fresh deploy
curl -s localhost:8100/subgraphs/name/smile/local \
  -H 'content-type: application/json' \
  -d '{"query":"{ authorizations { id lp strikeMin strikeMax active usedCollateral } }"}'
```

`subgraph.yaml`'s `source.address` is the Anvil deployment address, which
is deterministic for a fresh `./local.sh` (`0xA51c…91C0`). If it ever
differs, update it (or use `networks.json` + `graph deploy --network`).

`pnpm node:down` tears the stack down including volumes; `pnpm node:logs`
tails graph-node.

## Unit tests (matchstick)

```bash
pnpm test
```

`tests/vault.test.ts` mocks the vault's `authorizations` getter and checks:
an authorization is created with `collateralToken` filled by the bound
call; revoke flips `active`; a fill records a `Fill` and takes
`usedCollateral` from the contract; and — the bug that started all this —
an older authorization stays visible after a newer one appears.

Matchstick ships prebuilt binaries for x86-64 Linux and macOS; on an
arm64 host `graph test` may not run, in which case the local graph-node
flow above is the integration check.
