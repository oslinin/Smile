---
name: Delta hedging
description: Compute the wallet's net delta and the exact spot, call or put quantity that neutralizes it, with re-hedge triggers.
starter: How do I delta-hedge my current positions?
---
# Delta hedging

## The arithmetic
- Net delta (in ETH) = Σ position size × per-unit delta. Long call: +Δ; long put: −|Δ|; a written range is the SHORT side, so its delta is negated.
- USD exposure = net delta × spot. A book with net delta +0.8 and spot $3,400 moves ≈ $27 per 1 % ETH move.
- Delta-neutral means net delta ≈ 0. Reaching it costs money (spot to buy, or premium given up on the option side), so say what it costs.

## Procedure
1. `portfolio_greeks` for the current net delta (cite `source`; the wallet must be connected).
2. `hedge_suggestion` with the net delta and a candidate strike K — it returns three alternatives: spot ETH quantity, short calls at K, short puts at K, each sized to bring net delta to zero.
3. `price_strategy` on the option alternative the user prefers so the premium and its own Greeks are real numbers.
4. `propose_trade` if the hedge is an option leg; if it is spot, say the quantity and that spot is bought outside Smile.

## Worked pattern
"Short 3 puts at $3,200 (delta −0.35 each on the short side → net +1.05)" → hedge with ≈1.05 ETH sold spot, OR short calls at a strike whose delta × quantity ≈ 1.05 (e.g. 3 calls at $3,600 with delta 0.35). The call route collects premium but adds gamma and vega risk; the spot route is clean but ties up capital.

## Re-hedge triggers
- Net delta drifts past ±0.25 ETH (or ±10 % of the book's notional).
- Spot moves more than one expected daily move (`get_market_state`).
- Any leg enters its last 5 days.

## Gamma caveat
Delta is a local slope. Short-gamma books (written ranges, short options) lose delta neutrality faster on big moves and re-hedging costs increase. Say the net gamma from `portfolio_greeks` and how far spot can move before the hedge is 50 % off.
