---
name: Risk management
description: Turn the wallet's book into net Greeks, stress it, and translate into concrete limits and roll triggers.
starter: Run a risk check on my positions — what could hurt me before expiry?
---
# Risk management

Goal: give the user hard limits, not adjectives. Every number comes from a tool.

## Procedure
1. `portfolio_greeks` — net delta / gamma / vega / theta for the wallet's long positions AND written ranges (LP short side). Requires a connected wallet; on public chains this reads The Graph — cite the `source`. If it returns nothing, say the wallet has no tracked positions; never invent a book.
2. `scenario_analysis` on the same legs — P&L grid across spot moves (±5 %, ±10 %, ±20 %) and vol shifts, at today and at expiry.
3. `get_market_state` for ATM vol and expected move so the scenarios are anchored to what the market prices.

## Turn it into limits
- **Max loss vs balance**: worst cell of the scenario grid divided by the wallet's free collateral. Above 25 % → say "oversized" and propose a cut.
- **Gamma near expiry**: if any leg has under 5 days left and |gamma × spot × 1 %| exceeds 10 % of the position's delta P&L, the position flips sign on a normal daily move — flag it.
- **Vega vs DVOL**: compare net vega × (DVOL move of 10 vol points) with the max-loss number; a short-vega book into an event (see the macro-context skill) needs a smaller size.
- **Theta**: state daily decay in USD and whether it is earned (short) or paid (long).

## When to roll
Use `analyze_adjustment` for the numbers whenever any of these trigger: the tested strike is within 1 × expected move of spot; under 7 days to expiry on a short option; the position's delta has drifted more than 2× its initial delta. Present the roll as net credit/debit with before/after Greeks and offer `propose_trade` with the AFTER position.

## Output
Table: metric, value, limit, status (ok / watch / act). Then the single most important action.
