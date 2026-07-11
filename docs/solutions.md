# Solutions Plan: Making Smile Viable

Companion to [limitations.md](./limitations.md). That document diagnoses; this
one prescribes. It takes the five hard problems — including the ones Aqua
itself introduces — and lays out concrete solutions, what each costs, and the
order to build them in, with measurable gates between phases.

The framing question that prompted this document was *"we don't have to use
Aqua — how do we solve these problems?"* The answer reached below is that
dropping Aqua is the wrong dichotomy. Aqua's unrehypothecated model is the
protocol's genuine novelty and its best LP-acquisition funnel; its weakness
(soft, revocable liquidity) is real but priceable. The design that follows
keeps Aqua as the **soft tier** of a two-tier liquidity system, adds a **firm
tier** whose lockup cost is engineered to ~zero with yield-bearing collateral,
and lets takers and routers price the difference. Markets already work this
way: firm central-limit-order-book quotes coexist with indicative RFQ streams.

---

## The five problems

| # | Problem | Root cause | Limitations ref |
|---|---|---|---|
| P1 | **Soft liquidity / phantom depth** — quoted depth can vanish before fill because the backing balance sits in the LP's wallet | Aqua's JIT pull model | L11 |
| P2 | **Adverse selection** — stale quotes get picked off; repricing lands after the fill; one tx can drain a range | Oracle latency + post-trade feedback + no caps | L1–L5 |
| P3 | **Uncompetitive pricing** — σ comes from a crude demand-feedback loop, not vol discovery; every LP is a price-taker of one global model | No mechanism for market participants to express a vol opinion | L6 |
| P4 | **Thin demand** — on-chain vanilla options historically lose to Deribit and perps | No structural wedge exploited yet | Part 3 discussion |
| P5 | **Capital inefficiency** — full collateral caps LP return on capital | Deliberate no-liquidation design | L8 |

---

## P1 — Soft liquidity: price firmness instead of assuming it

### S1. Honest depth display (frontend only — ship first)

Quoted depth for an authorization must be
`min(maxCollateral − usedCollateral, wallet balance, Aqua allowance)`,
computed live via `staticcall` before display, not the authorized maximum.
Phantom depth becomes visible before it becomes a failed transaction. Zero
contract changes; a `useFirmDepth` hook in the frontend and the same check in
any quoting API. This doesn't *solve* softness — the balance can still move
between quote and fill — but it eliminates the routine case and the
adversarial "display depth you never intended to honor" case becomes a
one-block race instead of a standing lie.

### S2. Firmness bond (small contract change)

At `authorizeRange`, the LP escrows a small slashable bond in the vault
(e.g. `max($25, 25 bps × maxCollateral)`, owner-tunable). If a fill fails
because the JIT `Aqua.pull()` reverts — balance moved, allowance revoked —
the taker's transaction claims a fixed slice of the bond as compensation for
gas and adverse selection (they revealed their trading intention for
nothing). Bond returns in full at deauthorization. Economics: quoting stays
nearly free, but *lying* about depth now has a price. The bond also creates
the on-chain event needed for S3.

### S3. Fill-reliability score

The vault already knows when a pull fails (the S2 path). Persist a per-LP
counter `(fills, failedPulls)` and expose it. Frontends sort and badge LPs by
reliability; routers de-prioritize unreliable ones. Reputation is the cheap
complement to the bond: the bond prices a single failure, the score prices a
pattern.

### S4. Firm tier: escrowed ranges with yield-bearing collateral

The structural answer. A parallel `authorizeRangeFirm` path where collateral
is escrowed in the vault at ship time — firm by construction, `pull()` cannot
fail — but denominated in **yield-bearing collateral** so the lockup costs
~nothing:

- Calls: **wstETH** (or other LST) instead of WETH. The escrowed collateral
  keeps earning staking yield (~3%) while backing quotes.
- Puts: **sDAI / sUSDe / aUSDC** instead of USDC. The cash security earns the
  savings rate (~4–8%) while locked.

This dissolves the historical objection to escrow (dead capital in Ribbon-era
vaults) — the opportunity cost of locking yield-bearing collateral is
approximately zero, because the collateral does its other job *while locked*.
Settlement math needs an exchange-rate read (wstETH/ETH, sDAI/DAI) at payout,
which is a contained change to `redeem`/`reclaimCollateral`.

Firm quotes carry a `firm` flag; the router (S6) prefers firm liquidity at
equal price, and soft (Aqua) quotes must be *better* to win flow — softness
gets priced by competition rather than banned. LPs self-select: passive
wallets use Aqua's zero-commitment tier; serious LPs escrow yield-bearing
collateral for priority. **This is the resolution of "do we have to use
Aqua": both, tiered, with the market pricing the difference.**

New trust surface, stated honestly: the firm tier inherits the yield source's
risk (Lido, Maker/Sky, Aave). Cap the accepted collateral list and keep plain
WETH/USDC escrow as the conservative option.

---

## P2 — Adverse selection: the hardening set

Specified in [limitations.md Part 3](./limitations.md) as R1–R5; summarized
here because Phases below reference them:

- **R1** Per-block notional cap per authorization — bounds loss per staleness
  event to one block's cap instead of `maxCollateral`.
- **R2** Size-convex intra-trade pricing — the σ bump applies *inside* the
  premium integral, so large trades pay their own impact at execution.
- **R3** Staleness-scaled spread — Ask−Bid widens continuously with oracle
  age instead of cliff-rejecting at `maxStalenessSec`.
- **R4** Spread floor ≥ Δ × deviationThreshold × spot — the minimum edge at
  which quoting inside Chainlink's blind window is positive-EV.
- **R5** Pyth (or Chainlink Data Streams) pull-oracle for quoting, with a
  seconds-tight freshness bound; Chainlink rounds stay for settlement.

---

## P3 — Vol discovery: let LPs quote vol, route to the best

This is the deepest change and the one that most directly answers "can the
pricing ever be competitive."

### S5. Per-range LP-quoted vol

Today every LP is a price-taker of one global surface (σ buckets + α + β set
by the protocol). Add an LP-chosen `sigmaBps` multiplier (or absolute σ
override) to each authorization, serialized into the strategy's instruction
args like the existing parameters. The protocol surface becomes the *default*
for passive LPs; opinionated LPs quote their own vol — exactly how
professional options markets quote (in vol, not price). An LP who thinks the
surface is rich undercuts it and wins the flow; one who thinks it's cheap
quotes higher and only fills when they're happy to.

### S6. Best-quote routing across ranges

`buy(authId, …)` currently targets one explicit authorization
(`AquaCollateralVault.sol:381`) — the frontend auto-picks the latest one.
Add a router view `bestQuote(strike, expiry, isCall, amount)` that scans
active authorizations covering the strike (an enumerable index per
(asset, isCall) is needed), applies the S1 firmness check, and returns the
best executable Ask/Bid; and `buyBest(...)` that routes to it. **S5 + S6
together create competitive vol discovery**: overlapping ranges with
different σ opinions form an order book in vol space, and the touch — the
best bid/ask across LPs — *is* the discovered market vol. No oracle for IV
needed; discovery emerges from the same mechanism as every other market:
competition.

### S7. Optional external IV anchor

If range competition stays thin early on, anchor the *default* surface's σ
buckets to an external implied-vol reference (e.g. a curated feed of
Deribit ATM IV, or an on-chain vol index) with the demand-feedback loop
reduced to a bounded, mean-reverting deviation around the anchor. Passive
LPs then inherit approximately-fair vol instead of a random walk. This is a
pragmatic bridge, not the destination — S5/S6 is the trust-minimized
endgame — and it adds an oracle dependency, so gate it on evidence that the
default surface is drifting (persistent negative markouts on the passive
tier).

### S8. Markout instrumentation (R8 — decision infrastructure)

Off-chain job: for every fill, record the surface's own re-quote at +1/+5/+30
minutes. Every phase gate below reads this data. Build it first; it is the
protocol's profit-and-loss telescope and every argument about "is pricing
fair" is a guess without it.

---

## P4 — Demand: sell the wedge, not the option

### S9. One-click covered-call / cash-secured-put product

The LP-first product: pick an asset and a yield target → the app ships a
sensible OTM range (e.g. 10-delta to 25-delta calls, 30 days) → auto-rolls
at expiry, harvesting premium. Ribbon proved retail wants this UX and locked
nine figures for it *with* custody risk; Smile's version is self-custodial
(Aqua tier) or yield-stacked (S4 firm tier: staking yield + premium yield).
Pure frontend + a keeper for rolls; no new contract surface beyond what
exists.

### S10. Distribution through the 1inch ecosystem

The Aqua/SwapVM integration isn't just plumbing — it's a distribution
channel. Options premiums are quoted by a SwapVM strategy, so 1inch
aggregation/Fusion can route into them like any other liquidity source, and
option tokens are plain ERC-20s tradable anywhere. Pursue: listing in the
1inch ecosystem registry, the Aqua Revenue Stream Incubator grant (proposal
already in `docs/aqua-incubator-proposal.md`), and resolver integrations.
Demand-side flow arrives through integrators, not a standalone venue's UI.

### S11. Long-tail listings

Deribit lists three assets. Smile can permissionlessly list options on
anything with a reliable price feed — LST/LRT tokens, majors' L2 variants,
blue-chip DeFi tokens. Long-tail is where an on-chain venue has *no*
centralized competition, and where covered-call yield on treasury/DAO
holdings (S9) is a genuinely unserved market. Constraint to respect: thin
feeds are easier to manipulate, so long-tail listings need conservative
parameters (wider spread floors, lower caps, longer staleness bounds — all
per-authorization args that already exist or arrive in Phase 1).

---

## P5 — Capital efficiency

### S4 (again). Yield-bearing collateral

Solves the largest chunk: collateral earns its native yield while escrowed,
so "full collateral" stops meaning "dead capital."

### S12. Defined-risk netting (later)

Full collateralization is per-option today: a call spread (long K₁, short K₂)
locks collateral for the short leg as if naked, though the structure's true
worst case is `K₂ − K₁`. Vault-level netting for recognized two-leg
structures held by the same LP releases the difference — substantial
efficiency for spread writers with **no liquidation machinery**, because
defined-risk structures stay fully covered at their true maximum loss. This
is real design work (position accounting, early-exercise-free European
payoffs make it tractable) and belongs after product-market signal, not
before.

---

## The plan

> **Executable task-level plan for Phases 0–1** (exact files, signatures,
> tests, commands, written for mechanical execution):
> [plans/2026-07-11-phase01-hardening.md](./plans/2026-07-11-phase01-hardening.md)
>
> **Status:** the contract side of Phases 1–2 is IMPLEMENTED — R1 (per-block
> caps), R2 (size-convex pricing), R3+R4 (staleness-scaled spread with a
> configurable floor), S2 (firmness bond, deploy-opt-in via
> `FIRMNESS_BOND_BPS`), S3 (fills/failedPulls counters), S5 (per-range
> `sigmaMulBps`), S6 (`bestQuote`/`buyBest` with S1 phantom-depth skipping),
> and R5 (`PythSpotAdapter` pull-oracle for quoting, deploy-opt-in via
> `PYTH`/`PYTH_PRICE_ID`). Phase 0 is implemented too: S1 honest depth
> (`useFirmDepth` hook — firm-depth readout, soft badge, buy gating) and S8
> markouts (`analytics/markouts.mjs`, verified live on Anvil). S6 routing
> lives in the `SmileQuoteLens` periphery so the vault stays under the
> EIP-170 size limit. Still open: Phases 3–5.

Sequenced by (value ÷ effort), with a measurable gate before each phase.
Phases 0–1 are days-to-weeks of contained work; nothing in them is wasted
even if later phases never happen.

| Phase | Contents | Effort | Gate to proceed |
|---|---|---|---|
| **0 — Measure & be honest** | S1 honest depth display · S8 markout job | Frontend + off-chain script; no contracts | — (do unconditionally) |
| **1 — Harden** ✅ | R1 per-block caps · R2 size-convex pricing · R3 staleness spread · R4 spread floor · S2 firmness bond · S3 reliability score | One contract PR: vault + instruction + tests | Markouts confirm pick-offs exist (they will) |
| **2 — Compete** ✅ (contracts) | S5 LP-quoted vol · S6 best-quote routing · R5 Pyth quoting oracle | Contract PR (router index + instruction arg) + frontend | Phase-1 markouts improved but spread still uncompetitive vs Deribit mid |
| **3 — Firm up** | S4 escrowed firm tier w/ wstETH & sDAI · router firm-first preference | New vault path + settlement FX reads + tests | S3 data shows fill-failure rate matters (>~1–2% of attempts) |
| **4 — Sell it** | S9 covered-call one-click + auto-roll keeper · S10 1inch distribution · S11 first long-tail listing | Frontend + keeper + BD, minimal contracts | Phases 1–3 metrics: LP markouts ≥ 0 over a month — i.e. the product is safe to market |
| **5 — Scale capital** | S12 defined-risk netting · S7 IV anchor if passive tier drifts | Significant contract design | Real volume; LP demand for spreads |

**Kill criteria, stated in advance** (the discipline the graveyard lacked):
if after Phases 1–2 the passive tier's 30-minute markouts stay persistently
negative at every spread level takers will accept, the passive-surface model
is wrong — pivot the protocol to S5-only (all vol LP-quoted, protocol
provides settlement + custody rails, no house model). If firm-tier
fill-reliability and covered-call retention are strong but taker flow never
arrives, pivot distribution-first (S10) before adding any further mechanism.

### What this plan deliberately does *not* do

- **Drop Aqua.** Its softness is priced (S1–S3) and competed against (S4)
  instead. The zero-commitment funnel is worth keeping.
- **Move pricing off-chain.** The RFQ tier (limitations.md R6) stays gated
  behind markout evidence; Phases 1–2 are expected to make it unnecessary.
- **Add margin/liquidations.** S12 achieves capital efficiency only where it
  requires no liquidation engine.
