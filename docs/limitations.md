# Known Limitations, Risks, and Recommendations

This document is the honest record of Smile's design trade-offs. It captures a
series of design discussions from development so the reasoning survives the
sessions that produced it. It is written for three audiences:

- **LPs** deciding whether to ship a range — Part 1 explains, in plain
  language, the risk you are actually taking.
- **Integrators and auditors** — Part 2 enumerates the known limitations with
  code references.
- **Future contributors** — Part 3 is the sequenced roadmap of mitigations,
  with the rationale for the ordering.

Nothing here is a bug. Every limitation below is a *trade* the protocol made
deliberately, usually exchanging some market-making efficiency for
trustlessness. The point of this document is that you should know the price.

---

## Part 1 — The concepts, in plain language

### What an LP on Smile actually is

When you authorize a strike range, you are not "depositing into a pool." You
are becoming a **market maker**: someone who posts standing prices and waits
for other people to trade against them. The protocol quotes two prices on your
behalf for every strike in your range:

- the **Ask** — what a buyer pays you for an option;
- the **Bid** — what you pay a holder who sells the option back
  (`close()`).

The Ask is always higher than the Bid. That gap is the **bid-ask spread**, and
it is your compensation for standing in the market. Every round trip (someone
buys at the Ask, later sells at the Bid) pays you the spread.

The natural question is: why does the spread need to exist at all? Why not
quote one fair price? The answer is the single most important concept in this
document.

### Adverse selection, from zero

Start away from finance. You're selling a used car for a fixed, posted,
non-negotiable price of $10,000. Two kinds of buyers show up:

1. People who just need a car. Some think it's worth $9,500 and walk away;
   some think it's worth $10,500 and buy. Their errors are random — on
   average, you get a fair price from them.
2. A mechanic who inspects the engine and knows something you don't. The
   mechanic **only buys if the car is secretly worth more than $10,000**. If
   it's worth less, they walk away.

Notice the asymmetry: the mechanic never loses to you, and you never win
against the mechanic. You can't tell the two kinds of buyers apart — they
both just hand you $10,000. But the *composition of who chooses to trade with
you* is skewed against you. The trades you actually receive are **selected
adversely**. That is adverse selection: when the other side gets to decide
whether to trade at your fixed price, the ones who say yes are
disproportionately the ones who know your price is wrong.

Now translate to Smile, with real numbers:

- ETH trades at $3,000. The on-chain Chainlink feed says $3,000, and the
  vol surface prices a 3,100-strike call at **$68**.
- News hits. On Binance, ETH jumps to $3,020 within one second. Chainlink
  only publishes a new price when the change exceeds its **deviation
  threshold** (0.5% for ETH/USD) or a heartbeat timer expires — so on-chain,
  ETH is still "$3,000" and the call still costs $68.
- A fast trader (a **sniper**) sees both prices. The call is now genuinely
  worth about $74. They buy as many as your range allows at $68.
- Chainlink updates. Your quote catches up. The sniper is up ~$6 per option,
  and that money came out of your collateral's expected value.

You were **picked off**: filled at a **stale quote** — a posted price that no
longer reflects reality. The sniper is **informed flow** (they traded because
they knew something the price didn't reflect). The ordinary trader who buys a
call to hedge or speculate is **uninformed flow** — not stupid, just not
trading *against your error* specifically; their trades are roughly fair for
you and they pay you the spread. Flow that is systematically informed is
called **toxic flow**, because filling it systematically loses money.

The punchline, due to Glosten and Milgrom (1985): since you cannot tell the
mechanic from the ordinary buyer, your only defense is to charge *everyone*
a spread wide enough that your winnings from the uninformed cover your losses
to the informed. **The spread is an insurance premium against your own
ignorance of who you're trading with.** A market with more snipers needs wider
spreads; a market that could magically exclude snipers could quote nearly
zero spread. Every limitation in Part 2 is a variation on this theme, and
every recommendation in Part 3 is an attempt to shrink the insurance premium
honest users have to pay.

### The Greeks, briefly

The **Greeks** measure how an option position's value moves when market
conditions move. For a Smile LP the relevant four are:

| Greek | Measures sensitivity to… | A short-option LP has… | Plain meaning |
|---|---|---|---|
| **Delta (Δ)** | spot price | negative (short calls) | You lose as ETH rises past your strikes |
| **Gamma (Γ)** | *speed* of spot moves | negative | Big moves in either direction hurt more than proportionally |
| **Vega** | implied volatility | negative | You lose when the market gets more volatile |
| **Theta (Θ)** | passage of time | positive | You earn a little every calm day |

Short gamma + short vega + long theta is the classic market-maker profile:
**you are paid steadily for absorbing the risk of sudden moves.** Writing
options over a whole strike range makes this precise: by a classical result
(Carr–Madan static replication), a portfolio of options spread across all
strikes replicates a **variance swap** — a bet on realized volatility itself.
An LP whose range fills broadly is therefore, to first order, **short
volatility as an asset class**: profitable in calm markets, hit hardest in
turbulent ones. If that risk profile isn't what you want, don't ship a wide
range.

---

## Part 2 — The limitations

> **Status update:** since this document was written, the Phase 1–2
> mitigations have been implemented: L3 (post-trade-only repricing) is
> addressed by size-convex intra-trade pricing, L4 (unbounded per-block
> drain) by per-authorization block caps, L1/L2 partially by the
> staleness-scaled spread plus the optional Pyth quoting adapter, and L11
> (soft liquidity) by the firmness bond, reliability counters, and
> phantom-depth-aware `bestQuote` routing. The sections below describe the
> UNMITIGATED design so the reasoning stays legible; see
> [solutions.md](./solutions.md) for what is now in place.

### L1. Stale-quote sniping — the oracle latency gap

The premium is computed from Chainlink's last published price
(`OptionPremiumInstruction.sol` reads `latestRoundData()`). Between real-world
price changes and the next Chainlink update, every quote is stale, and stale
quotes are free money for whoever notices first (Part 1). The
`maxStalenessSec` guard (`OptionPremiumInstruction.sol:190-194`, and
`AquaCollateralVault.sol:725-728` for the vault's put pricing) rejects quotes
against an *old* round — but it cannot reject quotes against a *fresh round
that is already wrong*.

### L2. The invisible window — sub-threshold drift is undetectable

Chainlink ETH/USD publishes on a 0.5% deviation or a heartbeat. Inside that
threshold the off-chain price can drift up to 0.5% with **no on-chain signal
of any kind**. No contract check can detect what the chain has never been
told; this window is invisible *by definition*, not by implementation. The
only defense is pricing: the LP's edge per trade must exceed the expected
adverse move within the threshold — roughly **Δ × 0.5% × spot** of premium per
option. The current spread (asymmetric Ask/Bid rounding plus the smile
markup) is not explicitly calibrated to this floor.

### L3. Repricing happens after the trade, not during it

Demand feedback exists — every buy bumps the tenor bucket's σ by
`GAMMA = 0.005e18` (0.5 vol points) and every sellback bumps it down
(`OptionPricingHook.sol:90-105`, called from `AquaCollateralVault.sol:405` and
`:558`) — but the bump lands **after** the fill. The trader always executes at
the pre-bump price. A market maker who repriced only after each fill would be
run over; the on-chain analog is that a sniper pays no price impact on the
trade where it matters.

### L4. One transaction can drain a whole range

There is no per-block or per-trade size limit — a single `buy()` may consume
an authorization's entire remaining `maxCollateral` at one price. Combined
with L1–L3, the worst case is: oracle goes stale → sniper drains the full
range in one transaction at one wrong price → σ bump fires too late to matter.
The loss per staleness event is bounded by `maxCollateral`, not by anything
smaller.

### L5. On-chain rules cannot reject informed traders

It is tempting to ask the contract (or the v4 hook) to "reject malicious
trades." It can't, for a structural reason: **every on-chain rule is public.**
A sniper simulates your rejection logic before submitting and only sends
transactions that pass. Rules can filter mechanically definable *patterns* —
staleness, size, rate — but never *information*, because informedness is not
observable on-chain. (If you could identify informed traders, Part 1 says you
wouldn't need a spread at all.) Rejection is therefore the wrong frame;
**pricing is the right one** — make toxic flow pay for its toxicity (see R1–R4).

### L6. Passive LPs inherit the protocol's pricing model

The LP delegates pricing entirely to on-chain state: the σ tenor buckets, the
smile curvature α, and the skew β. This creates a second-order exposure beyond
the ordinary Greeks — **parameter risk**: ∂P/∂α ∝ vega·ln²(K/S) and
∂P/∂β ∝ vega·ln(K/S) (the smile-space analogs of volga and vanna). If
governance moves α/β, or the demand-feedback loop walks a σ bucket away from
fair, every open quote in every affected range marks against the LP with no
action on their part. There is currently no dashboard surfacing this exposure.

### L7. The demand-feedback loop is nudgeable

σ bumps are triggered by trades, and trades can be manufactured. Buying bumps
σ up; selling back bumps it down. An attacker who wants a cheaper entry could
sell back options to walk σ down before buying size. The attack is *costly* —
each round trip pays the full bid-ask spread, and the protocol fee (1% on the
Ask, none on sellbacks) taxes re-entry — and `GAMMA` is small, so moving σ
materially takes many paid round trips. It is a bounded nuisance rather than a
free lunch, but the loop is not manipulation-proof.

### L8. Full collateralization is capital-inefficient — on purpose

Every call locks 1 WETH per unit regardless of strike
(`AquaCollateralVault.sol:395`); every put locks the full strike value in USDC
(`:398`). A margin system would let the same capital write 5–20× the notional.
Smile chose full collateralization because it eliminates liquidation
machinery, margin oracles, and insolvency risk — an option, once written, can
*always* pay out. The cost is that LP returns on capital are structurally
lower than a margined venue's. Aqua softens this (collateral stays in the LP's
wallet, unrehypothecated, until the moment of sale) but does not remove it.

### L9. Settlement still depends on one oracle

`settleWithChainlinkRound` is permissionless and verifies that the supplied
round actually brackets expiry — nobody can cherry-pick a favorable round —
but the *value* settled is still whatever Chainlink published. A wrong or
manipulated feed settles wrong, trustlessly. This is oracle risk, distinct
from the latency risk of L1/L2, and it is shared with essentially every
oracle-settled derivative on-chain.

### L10. The off-chain alternative has its own price

The known cure for L1–L5 is moving pricing off-chain (an RFQ model: the LP
runs a server that streams live vol, reprices in milliseconds, scores
counterparty toxicity, and signs short-lived quotes; the chain only verifies
signatures and settles). This works — it is how Hashflow, Paradigm, and
professional desks operate — but it trades away exactly what Smile is for:

- **The passive-LP thesis dies.** "Ship one balance and walk away" becomes
  "operate a quoting server 24/7, or trust someone who does."
- **Composability breaks.** Other contracts can't atomically request a signed
  quote; the on-chain surface is a lego, an RFQ endpoint is not.
- **The risk relocates rather than disappearing.** A signed quote is frozen
  for its TTL (time-to-live) while the market moves; snipers attack the TTL
  window (**quote fading**), makers respond with shorter TTLs and **last
  look** (the right to reject a trade after seeing it) — each a worse version
  of the fairness problem the chain solved.
- **Toxicity scoring is discrimination.** Refusing to quote addresses you
  dislike is precisely the permission the protocol promised not to require.

See R6 for the hybrid that captures most of the benefit without giving up the
on-chain floor.

### L11. Aqua liquidity is soft — quoted depth can be phantom

The flip side of unrehypothecation (L8's virtue): because the balance backing
a quote sits in the LP's own wallet, it can be spent, transferred, or
de-approved at any moment. A displayed quote is an unfunded intention until
the block it executes — the JIT `Aqua.pull()` simply reverts at fill time if
the collateral left. At small scale this is a UX annoyance (failed
transactions); at scale it is a market-quality problem: takers and
integrators cannot rely on displayed depth, and an adversarial LP could
display size they never intend to honor, learning takers' intentions for
free. Contrast: an order on Deribit's book is firm; an escrowed-vault quote
is firm; an Aqua quote is indicative. Mitigations — honest depth display,
slashable firmness bonds, fill-reliability scores, and a parallel firm tier
with yield-bearing escrowed collateral — are specified in
[solutions.md](./solutions.md) (S1–S4).

---

## Part 3 — Recommendations

> **Note:** these recommendations are expanded into a full sequenced build
> plan — with the soft-liquidity solutions, the LP-quoted-vol competitive
> pricing design, demand strategy, and phase gates — in
> [solutions.md](./solutions.md).

Ordered by benefit-to-complexity. Phases 1–2 are contained contract changes;
each is testable in isolation. The guiding principle, from L5: **stop trying
to reject bad flow; price it.**

### Phase 1 — On-chain hardening (cheap, high value)

**R1. Per-block notional cap per authorization.** Track
`(lastTradeBlock, blockNotional)` per auth and cap fills per block at an
LP-chosen fraction of `maxCollateral`. Converts the L4 worst case from "lose
the whole range at one stale price" to "lose one block's cap," and forces a
sniper into multiple blocks — across which σ bumps and oracle updates catch
up. Small change to `AquaCollateralVault.buy()`.

**R2. Size-convex pricing (intra-trade impact).** Apply the σ bump *inside*
the premium calculation, proportional to trade size, so a trade of `n` units
pays the average of a σ that rises as it fills — the options analog of an AMM
curve, or of Kyle's lambda (price impact per unit of flow). Fixes L3: large
informed trades eat their own impact at execution time rather than gifting
the pre-bump price. Change to `SmileMath` + `OptionPremiumInstruction`.

**R3. Staleness-scaled spread.** Widen the Ask−Bid spread as a function of
`block.timestamp − updatedAt`, instead of the current cliff at
`maxStalenessSec`. A quote against a 2-second-old round is tight; against a
50-minute-old round, wide. Prices L1 continuously.

**R4. Spread floor calibrated to the deviation threshold.** Enforce
`spread ≥ Δ × deviationThreshold × spot` per option (with the 0.5% threshold
as an instruction arg). This is the L2 insurance premium made explicit — the
minimum edge at which quoting inside the invisible window is
positive-expected-value.

### Phase 2 — Shrink the staleness window itself

**R5. Pyth pull-oracle integration.** Pyth delivers ~400ms-fresh prices *in
the taker's own transaction* (the taker submits the signed price update
alongside the trade; the contract verifies and prices against it). This
closes most of the L1 latency gap and shrinks the L2 window from "0.5%
deviation" to "sub-second drift," while remaining fully composable and
deterministic — no LP server, no signatures from the LP, no last look.
Contained change to the instruction's oracle read plus a freshness check.
**Phases 1+2 together likely capture ~80% of the RFQ benefit at ~10% of its
complexity — ship these before considering R6.**

### Phase 3 — Hybrid RFQ, only if flow data demands it

**R6. Signed-quote tier on top of the on-chain floor.** Two tiers, tradfi's
"NBBO + price improvement" structure: tier 1 is the existing on-chain surface
— permissionless, composable, always live, and the guaranteed fallback for
`close()` so holders are never captive to a server. Tier 2 is a new
`signedPremium` instruction verifying an LP's EIP-712 quote
`(strike, expiry, premium, maxAmount, ttl, nonce)`, settling through the
identical Aqua pull/push. Takers query both and take the better price.
Sophisticated LPs run fast repricing and toxicity models off-chain and win
flow with tighter quotes; passive LPs keep the tier-1 spread. Build this only
if, after Phases 1–2, realized LP markouts (P&L measured a few minutes after
each fill) show flow is still systematically toxic.

### Phase 4 — LP risk tooling

**R7. Range-Greeks panel in the LP dashboard.** Show, per authorization:
ex-post Greeks of actually-sold series; ex-ante expected Greeks under an
assumed fill distribution over `[strikeMin, strikeMax]`; worst-case Greeks
(full `maxCollateral` at the most adverse strike); and the parameter
sensitivities ∂P/∂α, ∂P/∂β from L6. An LP should be able to see "shipping
this range ≈ short X vega, worst case Y" *before* signing.

**R8. Markout monitoring.** Off-chain analytics job: for every fill, record
the surface's own re-quote 1/5/30 minutes later. Persistent negative markouts
are the empirical signature of adverse selection and the trigger condition
for R6. Without this measurement, the Phase-3 decision is a guess.

---

## Glossary

| Term | Meaning |
|---|---|
| **Adverse selection** | When counterparties choose whether to trade at your posted price, those who accept are disproportionately those who know the price is wrong. |
| **Informed / uninformed flow** | Trades motivated by knowledge your price doesn't reflect yet / trades motivated by hedging or opinion, fair to you on average. |
| **Toxic flow** | Order flow that is systematically informed; filling it loses money on average. |
| **Picked off / sniped** | Filled at a stale quote by a faster, informed trader. |
| **Stale quote** | A posted price that no longer reflects current information. |
| **Bid-ask spread** | Gap between the price you sell at (Ask) and buy back at (Bid); the market maker's compensation, and (Glosten–Milgrom) the insurance premium against informed flow. |
| **Glosten–Milgrom (1985)** | Model showing spreads exist *because* makers can't distinguish informed from uninformed traders. |
| **Kyle's lambda** | Price impact per unit of order flow; large trades move the price against themselves. |
| **Markout** | A fill's P&L measured against the market price some minutes later; the standard empirical test for toxic flow. |
| **Deviation threshold / heartbeat** | Chainlink publishes only when price moves >0.5% or a timer expires; between updates the chain is blind. |
| **RFQ (request-for-quote)** | Off-chain model where a maker signs short-lived quotes and the chain only verifies and settles. |
| **TTL / quote fading / last look** | A signed quote's validity window / attacking the maker within that window / the maker's right to reject after seeing the trade. |
| **Delta, Gamma, Vega, Theta** | Sensitivity of option value to spot, to speed of spot moves, to implied volatility, to time (see Part 1 table). |
| **Vanna / volga** | Second-order Greeks: sensitivity of vega to spot / to vol. Here: the LP's exposure to the surface parameters β and α. |
| **Variance swap** | A contract paying realized variance; replicable by holding options across all strikes (Carr–Madan), which is why a broadly-filled range LP is "short volatility." |
| **Static replication (Carr–Madan)** | Result that any smooth payoff — including a variance exposure — decomposes into a strike-weighted portfolio of vanilla options. |
| **JIT / unrehypothecated** | Collateral stays in the LP's own wallet, unlent and unreused, and is pulled only at the moment an option is actually sold. |
| **NBBO + price improvement** | Tradfi structure where a public best price is the floor and competitive makers may beat it; the model for the R6 hybrid. |
