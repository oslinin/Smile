# Arc Bounty: Implementation Plan

**Goal:** Ship a stablecoin-native FX options market (USDC/EURC) on Circle's Arc
chain, backed by the exact same vault/settlement engine Smile already runs
for ETH options — plus Circle Gateway for cross-chain liquidity onboarding.
Targets [EthOnline2026's "Best DeFi or Agentic Application" bounty with
Arc](https://ethglobal.com/events/ethonline2026/prizes/arc) — DeFi track,
Continuity pool, $3,000 total ($2,000 of it gated on an Arc **mainnet**
deployment by **September 30**; Arc mainnet itself launches **September
16**).

**Branch:** `EthOnline2026_continuation_track` (current).

**Why DeFi track, not Agentic:** the Agentic track wants agents that hold
wallets and autonomously spend/settle USDC via Circle's Agent Stack. Smile's
Copilot is advisory today (proposes trades, the user executes) — a real fit
would need new Agent Stack integration work that hasn't been scoped or
researched. The DeFi track fits what already exists: USDC-native collateral,
a multi-step settlement waterfall, an autonomous auto-roll keeper. Revisit
Agentic only if there's spare time after the DeFi submission is solid.

**Why FX, not another ETH-options deploy:** already proven on testnet (see
"What's already verified" below) that the exact same contracts run
unmodified on Arc. Redeploying the ETH product alone isn't a competitive
argument — the bounty explicitly wants "why stablecoin-native infra changes
what's possible," and ETH options are a crowded market (Deribit, Panoptic,
...). FX options are nearly nonexistent in DeFi, and on a USDC/EURC pair
**every leg of every trade — calls and puts alike — is stablecoin-collateralized**,
not just puts (EURC is Circle's own euro stablecoin; there's no
WETH-equivalent volatile asset in this pair at all). Mechanically it's the
identical engine pointed at a different oracle and a different token pair —
that's a feature (proves the engine is asset-agnostic), not a shortcut.

## What's already verified (2026-09-10, this session)

No plan risk here — this actually happened, not "should work":

- Arc testnet is live: RPC `https://rpc.testnet.arc.network`, chain ID
  `5042002`, fully EVM-compatible (Reth execution layer), Foundry/Hardhat
  work unmodified.
- `script/Deploy.s.sol:89-91` already self-deploys a fresh `Aqua` instance on
  any non-mainnet chain — Arc needs no official 1inch Aqua deployment.
- Deployed the **entire** existing stack (Aqua, router, pricing engine,
  hook, vault, settlement, quote lens, firm escrow factory — 11 contracts,
  one `forge script --broadcast` run, zero code changes) to Arc testnet.
  Total gas cost: **~0.41 USDC**.
- Ran a real trade end to end as broadcast transactions: `authorizeRange` →
  `aqua.ship` → `buy()`. A real `OptionToken` got minted
  (`0x546D721a0AF8145Eb0E16Cf042A233052a3843A6`), holder balance confirmed
  1.0 unit, premium paid **698.99 USDC** for a 1-ETH-notional call at
  strike $3,000 — sane numbers from the live pricing engine.
- Gotcha for future test scripts: Arc's RPC returns `"Blocked address"` for
  at least one well-known Anvil/Hardhat default private key. Always generate
  fresh throwaway keys for Arc work (`cast wallet new`), never reuse the
  standard local dev keys.
- Deployer/contract addresses from this session's testnet run are in
  `broadcast/Deploy.s.sol/5042002/run-latest.json` and
  `broadcast/ArcSmokeTest.s.sol/5042002/run-latest.json` — throwaway keys,
  not to be reused for the real submission deploy.

## Architecture

FX options are **a second, separate deployment of the existing stack** on
Arc — the main vault contract is never modified, same principle as the
Continuation Track plan's SpreadVault/MarginVault siblings
(`docs/plans/2026-09-05-aqua.md`). Concretely:
a fresh `AquaCollateralVault` instance constructed with an FX price oracle
instead of ETH/USD, and `collateralToken`/`premiumToken` set to EURC/USDC
per authorization instead of WETH/USDC. `AquaCollateralVault` already takes
these as constructor/authorization args — no Solidity changes needed for
the core FX product, only deploy configuration.

**Stack:** existing Solidity/Foundry contracts unmodified; Next.js frontend
gets a new network entry + FX product surface; Circle Gateway integration
is a new, separate piece scoped in X4 once its Arc availability is confirmed.

## Ground rules

- `src/vaults/AquaCollateralVault.sol` stays untouched — FX is a deploy
  config, not a contract change. If FX genuinely needs a contract change,
  stop and re-scope; that's a signal the "same engine, new market" premise
  broke down.
- Every Arc testnet script uses a **freshly generated** throwaway key
  (`cast wallet new`), funded via `faucet.circle.com` — never a hardcoded
  Anvil/Hardhat default (see the "Blocked address" gotcha above).
- `forge build && forge test` green before every commit (unchanged — this
  plan shouldn't touch contract logic at all). Frontend changes also pass
  `cd frontend && npx tsc --noEmit`.
- Don't hand-roll ABI-encoded calldata in shell scripts for anything beyond
  one-off exploration — this session lost time to exactly that (a corrupted
  `amounts` array from parsing `cast call`'s pretty-printed output). Use a
  Foundry script (`forge script --broadcast`) for anything that needs to be
  reliable or repeated.

## X1: Confirm a live FX oracle feed on Arc testnet

**Files:** none yet — pure verification task, blocks everything else.

**Do:**
- Arc's own docs list five oracle providers: Chainlink, Chronicle, Pyth,
  RedStone, Stork. RedStone explicitly advertises FX-pair coverage; Pyth is
  also listed and Smile already has a working adapter
  (`src/oracles/PythSpotAdapter.sol`, built for R5) that could be reused
  directly if Pyth has the right feed.
- Check each provider's Arc-testnet contract addresses/feed IDs for a
  USDC/EURC-relevant rate (EUR/USD is the natural proxy — both USDC and
  EURC are pegged 1:1 to their fiat, so an EUR/USD feed prices the pair
  directly). Confirm: feed format (`latestRoundData()`-compatible or needs
  an adapter like Pyth does), decimals, and update frequency/staleness
  characteristics.
- If nothing suitable is live on Arc testnet yet, this whole plan's FX
  angle is blocked — fall back to keeping the ETH product as the sole Arc
  entry (still real, still proven) and lean harder on Gateway + the "same
  engine on Arc" story instead.
**Verify:** an actual `cast call ... latestRoundData()` (or provider
equivalent) against the live Arc testnet feed returns a sane, recent EUR/USD
price — same bar as the Aqua compatibility check, a real call, not docs.
**Commit:** none (research task); note the chosen feed address in X2.

**Result, 2026-09-10 — no Chainlink-compatible feed; FX cut for Sept 13.**
Pyth's EVM address list does not include Arc at all. Chainlink's and
RedStone's published feed lists show nothing for Arc, and Arc's own
contract-address page lists no oracle contracts. The one oracle with a
documented Arc testnet deployment is **Stork**
(`0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62`, per docs.stork.network) —
a pull model like Pyth: values land on-chain only when someone posts a
signed update, so quoting off it needs an adapter contract (the
`PythSpotAdapter` shape), an update-posting flow, and a Stork API key.
That is not the "one `Deploy.s.sol` branch" pivot this task was gating,
so per the rule above the FX product is out of the Sept 13 submission.
Recorded as the lead for the Sept 16–30 window. What shipped instead is
X2's real-USDC variant: Arc's actual USDC (`0x3600…0000`) as the
premium / fee / put-collateral token, with WETH and the ETH/USD spot
oracle mocked and stated as such — the stablecoin-native flows become
literal on-chain without depending on a feed that isn't there.

## X2: Arc deploy branch — FX vault, EURC/USDC, chosen oracle

**Files:** modify `script/Deploy.s.sol`.

**Do:**
- Add a `block.chainid == 5042002` branch alongside the existing Sepolia
  branch (`:52`) supplying: Arc's real USDC address
  (`0x3600000000000000000000000000000000000000` per Arc's own docs — confirm
  this is unchanged on testnet vs. mainnet before hardcoding), a EURC
  address (find Arc's canonical EURC deployment — Circle's own token,
  should exist given StableFX's USDC/EURC pairing), and the oracle address
  chosen in X1.
- Everything else in `Deploy.s.sol` — Aqua self-deploy, router, engine,
  hook, vault, settlement, lens, firm escrow factory — already runs
  unmodified for any chain that isn't mainnet/Sepolia; the Arc branch only
  needs to supply the three real addresses instead of falling through to
  the mock-token branch.
**Verify:** `forge script script/Deploy.s.sol --rpc-url <arc-testnet>
--broadcast` succeeds, prints real (non-mock) EURC/USDC addresses.
**Commit:** `feat(arc): deploy branch for Arc testnet with EURC/USDC and FX oracle`

**Result, 2026-09-10 — shipped as the real-USDC variant (`7d409bc`).**
Since X1 found no usable FX oracle, the Arc branch uses Circle's real
USDC (`0x3600…0000`) with a mock WETH and a mock ETH/USD feed, documented
in `docs/arc-testnet-deployment.md` with every address. Deploy cost ~0.46
USDC. EURC (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` on testnet, from
Arc's docs) is recorded for the FX follow-up. Gotcha: `forge script`'s
local simulation cannot execute Arc's native-asset USDC contract, so
anything that *calls* USDC must go through `cast send` —
`script/arc-smoke.sh` — while deploys that only store the address work.

## X3: Frontend — Arc network entry + FX product surface

**Files:** modify `frontend/config/wagmi.ts`, `frontend/app/page.tsx`,
`.env.example`; likely a small addition to `OptionMatrix.tsx`/`AuthorizeRange.tsx`
for an asset-pair selector if the frontend is to support both the ETH and
FX products from one deployment.

**Do:**
- Add Arc (testnet first, mainnet once X6 lands) to the `chains`/`transports`
  list in `wagmi.ts`, same pattern as the existing `hardhat`/`localhost1337`
  entries. `NEXT_PUBLIC_CHAIN_ID`/contract addresses come from X2's deploy
  output, same as every other network today.
- Decide scope here: does the frontend need to visibly support switching
  between "ETH options" and "FX options," or is a single Arc deployment
  running only the FX product sufficient for the submission? The lighter
  option (FX-only on Arc, ETH-only on Sepolia/mainnet-fork, no in-app
  switcher) is probably right for the bounty timeline — revisit if there's
  spare time.
**Verify:** `npx tsc --noEmit` clean; connecting a wallet to Arc testnet in
the running app shows real FX quotes and a working buy flow.
**Commit:** `feat(arc): frontend network entry and FX product surface`

## X4: Circle Gateway — cross-chain USDC onboarding (confirm scope before building)

**Files:** TBD, pending research.

**Do first:** confirm Gateway is actually live on Arc — Circle's own blog
said "Arc planned next" as of the research done in this session (Gateway
was live on Arbitrum/Avalanche/Base/Ethereum/OP/Polygon/Unichain since
August 2025). If it's not live on Arc testnet yet, this task is blocked;
don't build against an unavailable product. If it is live: scope a frontend
flow (or, minimum viable, clear documentation + a manual how-to) letting an
LP or buyer with USDC already on another chain use Gateway's unified balance
to act on Smile-on-Arc without a separate manual bridge step first.
**Verify:** a real Gateway-sourced deposit shows up as usable balance for an
Arc-side `authorizeRange` or `buy()` call.
**Commit:** `feat(arc): Circle Gateway onboarding flow` (or a docs-only
commit if the scope turns out to be "document the manual flow," not code).

## X5: Real FX trade on Arc testnet (repeat of today's proof, FX pair)

**Files:** clean up/rename the session's throwaway
`script/ArcSmokeTest.s.sol` into a real, committed test script (or fold its
logic into a proper `test/ArcFx.t.sol` if a fork-test is more appropriate
than a broadcast script at this stage).

**Do:** authorize an FX range, ship it, buy against it — same sequence
already proven for ETH earlier today, now against the real X2 deployment
with the real oracle and EURC/USDC.
**Verify:** a real OptionToken mints, premium is a sane EUR/USD-implied
number, confirmed via `cast call` against Arc testnet, not just a green
test locally.
**Commit:** `test(arc): end-to-end FX trade smoke test on Arc testnet`

## X6: Deploy to Arc mainnet — the $2,000-gated task, cannot cut

> **Status 2026-09-12: scaffolded, blocked on the launch.** Mainnet is not
> public until 2026-09-16 and its chain id / RPC are not in Circle's docs
> yet, so nothing is hardcoded. `script/Deploy.s.sol` has an env-driven Arc
> mainnet branch (`ARC_MAINNET_CHAIN_ID`, `_USDC`, `_WETH`, `_ETH_USD_FEED`,
> `_AQUA`, `_ALLOW_MOCKS` — mocks only by explicit opt-in), the frontend adds
> an "Arc" network when `NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID` / `_RPC` are set,
> `.env.arc-mainnet.example` lists every variable, and
> `docs/arc-mainnet-checklist.md` is the launch-day runbook (facts to confirm,
> fund, deploy, fills, record, subgraph, Vercel, App Kits, paperwork).

**Files:** none new; runs X2's deploy script against Arc mainnet once it's
live (September 16).

**Do:** same deploy, same verification bar as X2/X5, against
`mainnet.arc.network` (or whatever the real mainnet RPC turns out to be —
confirm from Circle's docs when mainnet actually launches, don't guess the
URL in advance). This is the one task in the whole plan that cannot be cut
— without it, only $1,000 of the $3,000 is reachable regardless of how good
everything else is.
**Verify:** real mainnet transactions, real (non-test) USDC/EURC — treat
this deploy with the same care as any real-money mainnet deploy, not like
the throwaway testnet experiments from today.
**Commit:** `chore(arc): deploy to Arc mainnet`

## X7 (stretch): R6 hybrid RFQ tier, Derive-inspired

> **Built 2026-09-10 — and re-homed under 1inch.** Shipped as
> `src/periphery/RfqVault.sol` (a sibling Aqua app, not the SwapVM
> instruction sketched below — nonce replay protection needs state). Since
> nothing in it is Arc-specific it is tracked as A6 in
> `docs/continuation-track-reference.html` and as "Part C — RfqVault" in the
> 1inch section of `2026-09-10-ethonline26-bounties.md`; this section stays
> as the record of where the idea came from. Not deployed to Arc.

Already fully speced in `docs/limitations.md`/`docs/solutions.md` R6 — a
`signedPremium` SwapVM instruction verifying an LP's EIP-712 quote
`(strike, expiry, premium, maxAmount, ttl, nonce)`, settling through the
same Aqua pull/push, with the existing formula-based Tier 1 kept as the
permanent fallback (`close()` always routes through it, so holders are
never captive to a market maker's uptime). This bounty's "advanced
programmable money flows" ask is real justification to finally build it,
but it's a genuine new contract surface, not deploy config — only pursue if
X1-X6 land with time to spare. Full task breakdown deferred until/unless
this gets greenlit; don't scope it in detail speculatively.

## X8: Submission materials

**Files:** new architecture diagram (format TBD — the bounty just says
"architecture diagram," not a specific tool); demo video; README section.

**Do:** the bounty's own qualification checklist, verbatim:
- Working frontend + backend, demonstrated live (not just claimed)
- Architecture diagram
- Video demonstration + presentation, clear about Circle tooling used
  (specifically call out: Arc deployment, USDC/EURC as collateral, and
  whichever of the oracle/Gateway pieces actually shipped)
- Link to the GitHub repo
- Confirm registration as a Continuity Project under the Continuity Track
  (this branch already exists for that purpose — verify actual EthGlobal
  registration status separately, that's not something checkable from the
  repo)
**Verify:** re-read the bounty's qualification list one more time right
before submitting; it explicitly says "be clear what bounty you are
submitting for."
**Commit:** docs only; no code.

## Milestones

**Corrected 2026-09-10:** the hackathon submission deadline is **September
13, 12:00 PM** — not Sept 30. Sept 30 is only the grace window for Arc's
extra $2,000 mainnet bonus, and Arc mainnet doesn't launch until Sept 16,
so X6 is necessarily a post-submission follow-up. Arc is third in the
cross-bounty execution order (after SpreadVault and The Graph — see
`2026-09-10-ethonline26-bounties.md`), so the rows below are what the Arc
slot can realistically hold, not a full week of runway.

| | Demoable | Tasks | Target |
|---|---|---|---|
| M1 | Frontend connects to Arc testnet and the already-deployed ETH product is demoable in the real UI | X3 (network entry only) | Sept 12 |
| M2 | Architecture diagram + video naming the existing flows (JIT pulls, permissionless settlement, auto-roll keeper, One-Click Income) in the bounty's own vocabulary | X8 | Sept 13, before noon |
| M3 (research-gated) | A real, live EUR/USD-relevant price read from an Arc testnet oracle via `cast call` — ~30 min; decides whether M4 exists | X1 | Sept 12 |
| M4 (only if M3 says yes) | FX vault deployed to Arc testnet with real EURC/USDC and one real FX trade | X2, X5 | Sept 13, before noon |
| M5 | Submitted | X8 | **Sept 13, 12:00 PM** |
| M6 (post-submission) | Deployed to Arc **mainnet** for the $2,000 bonus | X6 | Sept 16-30 |

Cut for the Sept 13 submission outright: X4 (Gateway). X7 (RFQ) was cut
here and then built as a 1inch piece instead (see the note in X7).

**Cut order if time compresses:** X4 (Gateway) and X7 (RFQ) are already
cut for Sept 13. Next to go: X2/X5 (the FX deploy + trade) — but only on a
"no feed" answer from X1, never preemptively; the 30-minute check is
always worth doing. Never cut: X3 (the network entry — without it there's
no UI demo) and X8 (diagram, video, submission). X6 (mainnet) is
post-submission and can't be cut from Sept 13 because it can't happen
before Sept 16 anyway.

## Definition of done

- **For Sept 13 (the submission):** X3 + X8 — the already-verified ETH
  product demoable in the real UI on Arc testnet, plus diagram, video, and
  the submission itself, with the existing flows framed in the bounty's
  vocabulary. X2/X5 (FX) included if and only if X1's check said yes.
- X4 (Gateway) explicitly, honestly marked as cut in the submission —
  never silently dropped.
- **For Sept 30 (the bonus):** X6 — the same project on Arc **mainnet**,
  same verification bar as the testnet proof (a real trade, not just a
  deploy).
- X8's checklist satisfied item-for-item against the bounty's own qualification list.

## Docs to update on completion

- `docs/limitations.md` / `docs/solutions.md`: note the FX deployment as a
  concrete instance of "the engine is asset-agnostic" — doesn't need a new
  L/S number, it's a deployment of existing solutions, not a new one.
- `README.md`: new section on the Arc/FX deployment, network info, and
  (if X7 ever ships) R6's status flips from "gated" to "implemented."
- `docs/continuation-track-reference.html`: add a Part D (Arc) if this plan
  gets its own task-tracker treatment like Parts A-C did — ask before doing
  this automatically, given how much back-and-forth shaped this plan's
  actual scope compared to the other two.
