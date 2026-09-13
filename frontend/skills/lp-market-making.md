---
name: LP market making
description: Find empty or scarce liquidity bands, size a range against collateral, estimate premium, and prefill the Write a Range form.
starter: Where is liquidity missing on the book, and what range should I write?
---
# LP market making

Goal: a range the user can write in one click, chosen where the book needs it.

## Procedure
1. `liquidity_map` — per $50 band × call/put × expiry: capacity, used %, open interest, days since last trade. Flags per range: `scarce` (≥ 80 % used), `empty` (no fills yet), `stale` (no trade in > 3 days), `expiring` (< 3 days); `summary.uncoveredStrikesNearSpot` lists strikes no range quotes. Cite the `source`.
2. Pick bands that are `empty` or `scarce` AND near demand — bands with recent fills next door, or within 1× the expected move (`get_market_state`). An empty band nobody trades is not an opportunity.
3. Size vs collateral: calls need WETH collateral, puts need USDC. Max size = collateral / (per-unit collateral requirement for that tier). Keep at least 30 % of collateral free for margin drift; on a full-collateral range, no margin risk.
4. Expected premium: `price_strategy` on a representative strike in the band, short side, for the chosen size and expiry. Report premium per unit and the annualized yield on collateral; say it assumes full fill.
5. `prepare_lp_range` — the card with strikeMin/strikeMax, expiry, size, collateral token and amount, expected premium. "Open in Write a Range" prefills the form; the user reviews and signs.

## The JIT-pull idea
Authorizing a range does not move funds. Collateral stays in the wallet under a 1inch Aqua approval and is pulled just-in-time when a buyer matches. So an LP can authorize wide and let the book decide; the only cost of an unfilled range is the approval.

## Risks to state
- Adverse selection: buyers pick the strike where the formula is most wrong (`read_docs` limitations L1–L5 for the specifics; cite them).
- A written range is short vol and short gamma — see the risk-management skill.
- Margined ranges add liquidation risk (explain-margin skill).

End with the not-financial-advice note once.
