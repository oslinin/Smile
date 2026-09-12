# Arc mainnet — launch-day runbook

Arc's public mainnet launches on **2026-09-16**. The Arc bounty's extra
$2,000 is for a mainnet deployment, with a grace window to **2026-09-30**
(`docs/plans/2026-09-10-ethonline26-bounties.md`). Everything mainnet-specific
in the repo is env-driven and blank until launch day — this page is the
order of operations. Treat it as a real-money deploy, not a testnet rerun.

Prepared on 2026-09-12: the env-driven branch in `script/Deploy.s.sol`
(`ARC_MAINNET_CHAIN_ID` gate), the env-gated `arcMainnet` chain in
`frontend/config/wagmi.ts` (network picker + wallet add), and
`.env.arc-mainnet.example`.

## 1. Confirm the network facts (do not guess)

- Chain id, RPC URL, explorer: the mainnet row of
  https://docs.arc.io/arc/references/connect-to-arc. As of 2026-09-12 that
  page lists only testnet (`5042002`, `https://rpc.testnet.arc.io`,
  `https://testnet.arcscan.app`). Third-party sites already claim a mainnet
  chain id; ignore them until the official page shows it.
- USDC: Circle's USDC contract-address list. On testnet USDC is the native
  asset's 6-dec ERC-20 view at `0x3600000000000000000000000000000000000000`;
  `Deploy.s.sol` defaults to that and `ARC_MAINNET_USDC` overrides it.
- Canonical WETH on Arc mainnet: docs.arc.io contract addresses; Uniswap Labs
  is named as a day-one protocol in Circle's launch announcement, so a WETH
  may exist. If it does, set `ARC_MAINNET_WETH` — calls become a real market
  instead of a mock demo.
- Chainlink ETH/USD on Arc mainnet: data.chain.link, network list. If a feed
  exists, set `ARC_MAINNET_ETH_USD_FEED` — quoting and permissionless
  settlement then run on a real feed. Testnet had none (only Stork, a pull
  oracle that would need an adapter like `PythSpotAdapter`).
- Official 1inch Aqua on Arc: the 1inch deployments list. If present, set
  `ARC_MAINNET_AQUA`; otherwise the script deploys our copy of the registry,
  as on testnet.
- Decide about mocks. With a real-money chain the default is **no mocks**:
  the script reverts unless `ARC_MAINNET_ALLOW_MOCKS=true`. Setting it is a
  deliberate choice to ship a demo-grade call side / oracle on mainnet; if
  you do, say so in `docs/arc-mainnet-deployment.md` the way the testnet doc
  does.

## 2. Fund the deployer

- Real USDC on Arc mainnet for gas plus premiums. The testnet full-stack
  deploy cost ~0.46 USDC of gas; the sibling vaults ~0.58 USDC more; budget
  a few USDC for fills. Use a fresh key if the testnet key was ever shared.
- Arc's RPC blocked well-known dev keys on testnet; expect the same.

## 3. Deploy

```bash
cp .env.arc-mainnet.example .env.arc-mainnet   # fill it in
set -a; . ./.env.arc-mainnet; set +a
forge script script/Deploy.s.sol --rpc-url "$NEXT_PUBLIC_ARC_MAINNET_RPC" --broadcast --legacy
```

- Known gotcha (testnet, `docs/arc-testnet-deployment.md`): `forge script`
  cannot simulate calls to Arc's native-asset USDC (`StackUnderflow` in
  revm). The deploy itself does not call USDC unless seeding, so it should
  broadcast; anything that touches USDC afterwards goes through
  `cast send`, as `script/arc-smoke.sh` and `script/arc-siblings-smoke.sh` do.
- The script prints `NEXT_PUBLIC_*` lines; paste them into `.env.arc-mainnet`
  (frontend half) and later into `frontend/config/wagmi.ts`
  `DEPLOYED_ADDRESSES` under the mainnet chain id.

## 4. One real fill per vault, small size

Repeat the testnet smoke path with mainnet addresses: `authorizeRange` →
`Aqua.ship` → `buy` on the main vault; `openStructure` → ship → `buy` on
`SpreadVault`; a margined put on `MarginVault` (seed the backstop and the
insurance fund first); an LP-signed quote on `RfqVault`. Use `cast send`
(see the two smoke scripts). Keep sizes tiny: this is real USDC. Note that
these will be deployer self-fills (limitations L15) — label them as such.

## 5. Record it

- `docs/arc-mainnet-deployment.md` (new; copy the structure of
  `docs/arc-testnet-deployment.md`: what is real and what is mock, address
  table, transaction table, gotchas).
- `frontend/config/wagmi.ts` `DEPLOYED_ADDRESSES[<mainnet id>]` and
  `frontend/lib/deployments.ts` (name, explorer, contracts, demo receipts,
  `realMoney` line) so the Overview and Receipts tabs show the mainnet run.
- `frontend/app/page.tsx` `ADDABLE_CHAINS` / `NETWORKS` already pick the chain
  up from env; once addresses are recorded, the env fallback is no longer
  needed for the frontend.

## 6. Subgraph

- Studio: create `smile-arc` (or `smile-arc-mainnet`) — needs the wallet in
  the web UI. `subgraph/networks.json` uses the Studio network name
  `arc-testnet` for testnet; the mainnet name is whatever Studio's network
  picker shows for Arc mainnet on launch day — confirm there before running
  `graph deploy --network <name>`. Add the vault address and start block to
  `networks.json`.
- Publish to The Graph Network (Arbitrum One publish tx) and add the gateway
  URL as `SUBGRAPH_URL_<mainnet chain id>` on Vercel and in
  `frontend/.env.local`; add the Studio dev URL to `lib/deployments.ts`.
  Without a subgraph, the app's tape on that chain throws
  `SubgraphRequiredError` (there is no RPC path on public networks).

## 7. Vercel

- Env: `NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID`, `NEXT_PUBLIC_ARC_MAINNET_RPC`,
  `NEXT_PUBLIC_ARC_MAINNET_EXPLORER`, `SUBGRAPH_URL_<id>`; redeploy. The
  "Arc" entry then appears in the network picker on the live app.

## 8. Circle App Kits on mainnet

Both keepers are testnet-wired today and would need these edits:
- `keeper/insurance-gateway.mjs`: `GATEWAY_API` is
  `gateway-api-testnet.circle.com` → the production Gateway API; `ARC`
  domain/RPC/explorer are testnet values; the source chain would be a
  mainnet (Ethereum or Base) with real USDC; the Gateway wallet/minter
  addresses are the testnet ones ("same on every EVM testnet") — take the
  mainnet ones from Circle's Gateway docs.
- `keeper/backstop-wallet.mjs`: `ARC_RPC`/`EXPLORER` are testnet; the wallet
  set is created on blockchain `ARC-TESTNET` → the mainnet blockchain
  identifier from Circle's Wallets docs; a **production** Circle API key and a
  new entity secret (the current ones are `TEST_API_KEY`-scoped).
Optional for the bonus; the base mainnet deploy does not need them.

## 9. Bounty paperwork

Update `docs/submission-ethonline2026.md` (Arc section), the README
Continuation Track table and `docs/sponsors/arc.md` (Plans → done) with the
mainnet addresses and hashes, then submit the mainnet proof through
whatever channel the Arc bounty specifies for the $2,000 bonus before
2026-09-30. Commit message per the plan: `chore(arc): deploy to Arc mainnet`.
