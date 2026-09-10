# Smile subgraph

Indexes `AquaCollateralVault` — every LP range authorization and every fill —
so the frontend and the AI copilot can ask "which ranges does this wallet
have open?" or "open interest by strike?" as one query instead of a capped,
brute-force RPC scan (`docs/limitations.md` L12a; the copilot's
`frontend/lib/copilot/chain.ts` stops seeing anything past `MAX_AUTHS = 50`).
Plan: `docs/plans/2026-09-09-theGraph.md`.

## Entities

- **Authorization** — one per `authorizeRange`, keyed by `authId`, with the
  LP's address indexed. `usedCollateral`, `collateralToken`, and `active`
  are refreshed by a bound `authorizations(authId)` call on every fill,
  sellback, reclaim, and pull failure — the vault's JIT-pull accounting is
  read from chain state, never re-implemented in AssemblyScript.
- **Fill** — one per `OptionBought`: buyer, series token, strike, size,
  premium (fee included), block and timestamp.

```graphql
{
  authorizations(where: { lp: "0xf39f...2266", active: true }, orderBy: createdAtBlock, orderDirection: desc) {
    id strikeMin strikeMax expiry isCall maxCollateral usedCollateral fillCount
  }
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
| **v0.0.2** (current) | indexes the EthOnline 2026 Sepolia deployment's `AquaCollateralVault` `0x82AcBBFE5E03510d5407d8C50435B08e6d2d0a4D` from its deploy block 11,677,088 ([docs/sepolia-deployment.md](../docs/sepolia-deployment.md)); returned Authorization `#0` (calls $2,300–$2,800, 0.02 WETH) within a minute of `Aqua.ship` — `https://api.studio.thegraph.com/query/44448/smile-sepolia/v0.0.2` |

Set `NEXT_PUBLIC_SUBGRAPH_URL` to the query URL of the version you want the
app and copilot to read; leave it unset for the RPC fallback.

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

## Sepolia / Graph Studio

`networks.json` holds per-network addresses. Once the contracts are
deployed to Sepolia (`forge script script/Deploy.s.sol --rpc-url sepolia
--broadcast`), fill in the address + start block there, then:

```bash
graph auth <studio deploy key>
graph deploy --network sepolia --network-file networks.json smile-sepolia
```
