---
name: Trading opportunities
description: Screen live Smile instruments for mispriced options versus the Deribit reference vol and recent trades, then confirm and propose.
starter: Find me the three cheapest options on the book right now and explain why they're cheap.
---
# Trading opportunities

Goal: find instruments where Smile's formula ask is cheap or expensive relative to the outside market, confirm the numbers, and hand the user a card.

## Procedure
1. `find_opportunities` — ranks every live instrument by Smile ask vs a Black-Scholes price at the Deribit reference vol, and vs the last traded premium on the tape. Read the `source` field ("subgraph" or "anvil-logs") and say where the tape came from.
2. `reference_market` for the top candidates — get the nearest Deribit IV, DVOL and index for that strike/expiry. "Cheap" means BOTH: Smile's implied vol is below the Deribit reference AND below the vol implied by recent fills. One of the two alone is a data artifact, not an edge.
3. `price_strategy` on the exact leg (strike, expiry, call/put, size 1) to get the premium, Greeks and breakeven the user will actually pay. Never quote the screener's number as the final price.
4. `propose_trade` with the confirmed leg(s) so the card loads into the Payoff Builder.

## Sanity checks before proposing
- `liquidity_map`: is there capacity in that band, or would the fill hit an empty/scarce band? A cheap price on zero depth is not tradable.
- Expiry: under 3 days to expiry the moneyness damping term dominates and "cheap" wings are usually just tiny premiums with no time value. Prefer 7–45 days.
- Fee: premium is quoted fee-included on-chain; the screener's edge must survive the fee — say so explicitly if the edge is under 5%.
- Spot: use the spot from the context, the same the UI shows.

## Presentation
A markdown table: instrument, Smile ask, BS reference, last trade, edge %, days-since-trade. Then one paragraph on why the top pick is mispriced (smile shape vs the market's skew is the usual reason — Smile's beta is 0, so skewed markets misprice puts vs calls). Finish with the not-financial-advice note once.
