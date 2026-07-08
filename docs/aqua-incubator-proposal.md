# Smile — Aqua Revenue Stream Incubator Application

> **Program**: 1inch DAO Aqua Revenue Stream Incubator (1IP-93)
> **Ask**: up to $50,000, milestone-based, with revenue share to the 1inch DAO from the first dollar
> **Repo**: https://github.com/oslinin/Smile
> **Status at application**: working end-to-end on the official Aqua + SwapVM contracts — 82 passing Foundry tests, full lifecycle verified against a live node

---

## One-liner

**Smile is an options marketplace built as a native Aqua strategy: one shipped Aqua balance quotes an entire two-sided option chain, priced by a custom SwapVM instruction, with a protocol fee routed to the 1inch DAO through the official fee opcode.**

## The problem, and why Aqua is the answer

On-chain options liquidity is thin for a structural reason: collateral gets locked *per strike, per expiry*. An LP who wants to quote 20 strikes must fragment capital into 20 dead allocations, most of which never trade — so displayed depth is a fraction of the LP's actual capital, and the capital earns nothing while parked.

Aqua removes exactly this constraint. Smile's thesis:

- **One balance, whole chain.** The LP `Aqua.ship()`s a single strategy covering a strike *range* (e.g. "calls, $2,500–$3,500, 30 days"). The taker picks the exact strike per swap via SwapVM taker instruction args. Displayed depth becomes a function of *wallet balance*, not of how cleverly the LP pre-allocated.
- **Collateral never idles.** Funds stay in the LP wallet — earning staking/lending yield — until a buyer matches, when the official `Aqua.pull()` moves collateral just-in-time into escrow. Premiums are `Aqua.push()`ed straight back to the LP wallet.
- **Capacity self-recycles.** When a holder sells back, escrowed collateral returns through `Aqua.push()`, which restores the strategy's virtual balance — the same WETH can back quote after quote.

## What is already built (de-risking milestones 1–2)

All of the below runs on the **official, unmodified** `1inch/aqua` and `1inch/swap-vm` (release/1.2) contracts, vendored and compiled as-is:

| Component | Status |
|---|---|
| **Custom SwapVM instruction** (`_optionPremiumXD`, opcode 33) — prices options off a parametric vol surface; taker-selected strike within the maker's range | ✅ live in tests + local net |
| **Five-instruction strategy program** — `salt → deadline → jumpIfTokenIn → aquaProtocolFee → optionPremium`: four official instructions composed with the custom opcode | ✅ |
| **Two-sided market from one strategy** — forward swap direction prices the Ask, reverse prices the Bid; holders exit at mark-to-market via a reverse swap | ✅ |
| **Multiparameter vol surface** — σ per tenor bucket + skew β, demand-driven feedback (buys bump σ, sells decay it), Uniswap v4 hook integration | ✅ |
| **Trustless settlement** — permissionless: anyone supplies the Chainlink round covering expiry; on-chain bracket verification prevents price cherry-picking; CRE DON path retained as keeper | ✅ |
| **DAO revenue** — protocol fee grossed up on the Ask via the official `Fee._aquaProtocolFeeAmountInXD`, pulled to the treasury through `Aqua.pull()`; direction-aware in bytecode (sellbacks fee-free) | ✅ |
| Test suite | ✅ 82 Foundry tests |
| Live verification | ✅ full lifecycle on Anvil: buy → sellback at Bid → permissionless settle → redeem → LP reclaim, zero escrow residue |

Everything above is inspectable in the repo's commit history (a per-feature, verified-per-commit history).

## Revenue model

**Mechanism (already implemented):** every option buy carries a protocol fee — default 1%, hard-capped at 5% — grossed up *on top of* the Ask. The buyer pays `ask + fee`; the fee accrues to the fee recipient through the official `Aqua.pull()`; **the LP always nets the full premium**, so the fee never degrades maker economics. Sellbacks are fee-free (enforced in strategy bytecode via the official `jumpIfTokenIn`), so holders are never double-charged. Fee terms are snapshotted per strategy — transparent to the LP at ship time, immutable afterwards.

**DAO share:** the fee-recipient address is a constructor-level/governance-set parameter. We propose routing **[X]% of protocol-fee revenue to the 1inch DAO treasury from the first dollar**, per the program's standard terms (final split per the incubator agreement).

**Illustrative projections** (deliberately conservative; options fees are volume-driven):

| Scenario (90 days post-mainnet) | Premium volume | Protocol fee (1%) | Notes |
|---|---|---|---|
| Conservative | $250k | $2,500 | a handful of active LP ranges, organic takers |
| Base | $1.5M | $15,000 | 10–20 LP ranges, market-maker partnership, points/incentives |
| Upside | $6M+ | $60,000+ | integration into 1inch app surfaces; options premiums are high-margin volume (1% of premium ≈ 10–20 bps of notional) |

Because the fee is charged on *premium* rather than notional, revenue scales with volatility as well as volume — a countercyclical property most swap-fee strategies lack.

## The emergent market-maker flywheel: on-chain IV you can trade

Smile does not depend on professional market makers showing up — it is designed so that market making **emerges from arbitrage**, and the object being arbitraged is itself a new tradeable: an on-chain implied-volatility surface.

The surface (σ per tenor bucket, skewed per strike) is **demand-driven**: buys bump σ, sellbacks decay it. That turns σ into an on-chain price signal for volatility, and the two-sided strategy makes both directions of the trade executable against the same shipped Aqua balance:

- **σ below market IV** → options are underpriced. An arbitrageur buys at the Ask, delta-hedges on spot (Uniswap), and — as their own demand re-rates σ upward — sells back at the Bid, capturing `(σ_market − σ_entry) · vega`. Their activity *is* the correction.
- **σ above market IV** → premiums are rich. LPs shipping ranges are effectively **investors in the volatility risk premium**: they harvest overpriced time-value on capital that stays in their own wallets, fully collateralized.

In other words, participants can **bet on volatility directly** (long vol by buying the chain, short vol by writing ranges; calendar views across tenor buckets, skew views across strikes) without any new instrument — the option chain and the reflexive σ feedback are the market. The sellback-at-Bid mechanism shipped in this codebase is what closes the loop: a σ correction is monetizable round-trip, so the arbitrage is real, recurring, and self-balancing.

**Why the DAO should care:** arbitrage and vol-trading flow is *structural* volume — it arrives whenever σ diverges from consensus IV, without marketing spend, and every round trip pays the protocol fee on its buy leg. The flywheel converts pricing-model imperfection (our stated weakness) into fee-generating order flow, while simultaneously calibrating the surface.

## Milestones & budget (mapped to the program's release schedule)

| # | Program milestone | Deliverables | Release | Amount |
|---|---|---|---|---|
| M1 | **Idea verification (5%)** | This proposal; working repo with the custom instruction, two-sided strategy, and fee layer (already public) | on acceptance | $2,500 |
| M2 | **Proof of concept (10%)** | Already delivered and exceeded: 82-test suite, live-node lifecycle demo, DemoTrade script reviewers can run in minutes. Remaining: reviewer walkthrough + testnet deployment with public addresses | week 1–2 | $5,000 |
| M3 | **Mainnet deployment with verified activity (35%)** | Independent security review of the ~1,200 LoC of Smile-specific contracts (audit is the main budget item); mainnet deployment against the **production Aqua** (`0x4999…6D31`); ≥3 live LP ranges; first verified fee accruals to the DAO treasury; settlement keeper live | month 2–3 | $17,500 |
| M4 | **Full integration (50%)** | Production frontend (LP + taker flows, surface display); vol-surface calibration upgrade (per-tenor IV from realized quotes); LP onboarding docs & risk disclosures; analytics dashboard for DAO revenue tracking; **ecosystem marketing** (trading-points program for early takers, co-marketing with 1inch channels, vol-arb bounty for the first emergent market makers — all with attributable on-chain results, no generic paid ads); sustained activity report | month 4–6 | $25,000 |

Budget allocation across milestones: ~40% security review, ~30% engineering, ~15% LP/market-maker onboarding and liquidity ops, ~7.5% frontend/analytics, ~7.5% ecosystem marketing (attributable programs only).

## KPIs we commit to reporting

- Premium volume and count of trades through the strategy (on-chain, per the `Swapped` events)
- Protocol-fee revenue accrued to the DAO treasury (on-chain, per Aqua `Pulled` events to the treasury)
- Number of live LP ranges and aggregate shipped capacity (Aqua virtual balances)
- Two-sided quality: average Bid/Ask spread and sellback fill rate
- Emergent market making: round-trip (buy → sellback) volume share, and σ tracking error vs a reference IV (e.g. Deribit ATM) — a direct measure of whether the arbitrage flywheel is calibrating the surface
- Settlement health: % of expiries settled permissionlessly within 1 hour

All KPIs are verifiable directly from chain data — no self-reporting required.

## Risks & mitigations (stated up front)

- **Pricing-model risk.** The parametric smile (intrinsic + σ·√T time-value with tenor buckets and skew) is not arbitrage-free. Positions are always **fully collateralized** — covered calls / cash-secured puts — so mispricing can cost LPs edge but can never create bad debt or protocol insolvency. M4 funds the calibration upgrade.
- **Unaudited code.** The Smile-specific surface is small (~1,200 LoC on top of unmodified official contracts) and the audit is the largest single budget line in M3. No mainnet LP capital before the review.
- **Oracle risk.** Spot reads enforce Chainlink freshness bounds baked into each immutable strategy; settlement uses round-bracket verification so no single party — including us — can choose the settlement price.
- **First-trade fee headroom.** The official fee opcode pulls the fee before the premium push lands; fee-enabled ranges therefore ship with $25 of virtual headroom (an allowance number, not locked capital). Documented for LPs.

## Team

- **[Name]** — [role, background, links: GitHub/LinkedIn/prior protocols] `TODO`
- **[Name]** — [if applicable] `TODO`
- Contact: **[email / Telegram]** `TODO`
- Payout address (multisig preferred): **[address]** `TODO`

## Why this application is low-risk for the DAO

1. **The hard part is already built and public.** Reviewers can clone the repo and run the full lifecycle in under five minutes (`forge test`, then `local.sh`).
2. **Revenue is wired through 1inch's own primitives.** The DAO's share flows via the official fee opcode and `Aqua.pull()` — auditable on-chain from day one, no trust in our accounting.
3. **Milestone releases map to verifiable on-chain facts**, not reports: deployment addresses, fee `Pulled` events to the treasury, live strategy balances.
4. **It grows Aqua itself.** Every option minted routes premium flow, collateral pulls, and fee traffic through Aqua — a new asset class (options) demonstrating the shared-liquidity layer beyond spot swaps.
