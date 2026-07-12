# S12 — Defined-Risk Netting: Design

> Status: **DESIGN, not implemented.** Rung 2 of the V2 capital-efficiency
> ladder (README § Collateralization Model). No liquidation machinery is
> introduced at any point in this document — that constraint is load-bearing
> and non-negotiable: every structure below stays fully collateralized at its
> **true maximum loss**, so "an option, once written, can always pay" survives.

## The problem

Full collateralization is per-option today: writing one leg of a call spread
locks 1 WETH exactly as if it were naked, even though the spread's worst case
is a fraction of that. The thetagang structures Smile targets — put credit
spreads, call credit spreads, iron condors — are therefore expressible but
capital-hungry: strictly worse than a Reg-T broker, Deribit portfolio margin,
or Panoptic's partial-collateral spreads. S12 closes that gap with *position
accounting*, not margin.

## The core insight: cash-settled European payoffs make netting exact

Everything settles at ONE terminal price `S` per expiry, with no early
exercise. Net liability of a two-leg structure is therefore a deterministic
function of `S`, and its maximum over all `S` is computable in closed form at
mint time. Pre-fund that maximum and solvency is *identical* to V1 — the worst
case is already in escrow.

Payout conventions (per unit, from the vault's settlement math):

- Call, collateral WETH: holder receives `max(S−K, 0)/S` WETH.
- Put, collateral USDC: holder receives `max(K−S, 0)` USDC.

### Collateral requirements per structure (K₁ < K₂, same expiry, same size)

| Structure | Legs (writer's view) | Net liability at `S` | Max over S | Required collateral | vs today |
|---|---|---|---|---|---|
| Call **debit** spread | long K₁ call, short K₂ call | `[max(S−K₂,0) − max(S−K₁,0)]/S ≤ 0` | **0** | none — the long leg *dominates* | 1 WETH → 0 |
| Call **credit** spread | short K₁ call, long K₂ call | `[max(S−K₁,0) − max(S−K₂,0)]/S` | at `S = K₂`: `(K₂−K₁)/K₂` | `(K₂−K₁)/K₂` WETH | 1 WETH → e.g. 0.0625 WETH for 3000/3200 (**16×**) |
| Put **debit** spread | long K₂ put, short K₁ put | dominated | **0** | none | K₁ USDC → 0 |
| Put **credit** spread | short K₂ put, long K₁ put | `max(K₂−S,0) − max(K₁−S,0)` | at `S ≤ K₁`: `K₂−K₁` | `K₂−K₁` USDC | K₂ USDC → e.g. 200 vs 3200 (**16×**) |
| Iron condor | put credit + call credit | one terminal `S` → only ONE side can finish ITM | — | **max**(put-side req, call-side req), *not* the sum | ~32× vs two naked legs |

Two subtleties the table encodes:

1. **Dominance** — a long lower-strike call's payout exceeds a short
   higher-strike call's at every `S`, so a debit spread's short leg needs the
   long *option token itself* as collateral and nothing else. The option
   becomes a collateral asset class.
2. **Condor max-not-sum** — European settlement at a single price means the
   two credit spreads of a condor can never both lose. Netting recognizes
   this; per-leg collateralization cannot.

## Architecture

The constraint that shapes everything: **the JIT pull amount is set by the
vault's collateralization rule.** A periphery contract cannot make
`Aqua.pull()` take less than the vault demands — netting must live at the
custody layer. Three options were considered:

### Option A — new paths in `AquaCollateralVault` ❌
Blocked physically: the vault is at 24,364 bytes with **212 bytes** of EIP-170
headroom. Even with another extraction pass (settlement math → external
library) this crowds the highest-risk contract in the system with its most
complex new logic. Rejected.

### Option B — post-mint netting (`netDown()` in the vault) ❌
Write both legs fully collateralized, then release the excess against
depositing the long token. Minimal UX change, but it is still vault bytecode
(see A) and it doubles peak capital (full collateral must exist momentarily
before netting). Rejected for the same size reason.

### Option C — a sibling `SpreadVault` AquaApp ✅ (recommended)
A separate, self-contained vault — the same pattern that worked for
`FirmEscrow` and `SmileQuoteLens`: extend at the periphery, never squeeze the
core.

- **Mint**: taker requests a named two-leg structure at (K₁, K₂, expiry).
  The SpreadVault runs its own Aqua strategy; `Aqua.pull()` takes only the
  table's net requirement from the LP wallet. One `SpreadToken` (ERC-20 per
  series) is minted — the structure trades as a unit.
- **Pricing**: the two legs are quoted off the SAME `OptionPremiumInstruction`
  surface (long leg at Bid, short leg at Ask from the taker's perspective —
  the spread's natural credit/debit), so no new pricing model exists; S12 is
  purely a collateral-accounting layer.
- **Settlement**: reuses `AquaOptionSettlement` unchanged — same
  `settleWithChainlinkRound`, same registrar pattern. At redemption the
  SpreadVault pays `net intrinsic(S)` to the holder and the remainder to the
  writer; by construction of the table, escrow always covers it.
- **What it does NOT do**: no cross-position netting (each SpreadToken is
  self-contained), no netting against positions in the main vault, no
  unwinding one leg alone. Those need portfolio accounting — that's rung 4
  territory, not this.

Costs, stated honestly: a second custody contract to audit (~S4-full-sized
effort); spread liquidity is fragmented from single-leg liquidity (a spread
series is its own token); and LP-side UX needs a "write spreads" surface in
the frontend.

## What stays true

- **No liquidations, no margin oracle, no insurance fund.** The net max loss
  is escrowed at mint; nothing can become undercollateralized later.
- **Settlement trust unchanged** — same permissionless Chainlink-round path.
- **The main vault is untouched** — zero new bytes, zero new attack surface
  on existing custody.

## Test plan (when built)

1. Dominance: debit spreads mint with zero pulled collateral; redemption pays
   net intrinsic exactly at S below/at/between/above both strikes.
2. Conservation per series: `holder payouts + writer reclaim == escrowed net
   collateral` to the wei, for ITM/OTM/pin-at-K₂ cases.
3. Condor max-not-sum: requirement equals the larger side; both-sides-OTM
   expiry returns 100% to the writer.
4. Adversarial: attempt to redeem legs separately; attempt to mint with
   K₁ ≥ K₂; pin risk exactly at K₂ (the max-loss point) — escrow must cover
   with zero shortfall.
5. Gas: SpreadToken mint ≤ single-leg first-fill (one deploy, one pull).

## Gate

Build when there is demand evidence for defined-risk structures: strategy-
builder usage showing spread/condor construction attempts, or LP feedback
that per-leg collateral is the blocker (S8 markout + S3 data being healthy is
a precondition — netting capital 16× tighter multiplies whatever edge or
bleed the pricing already has).
