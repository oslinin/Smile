---
name: Explain margin
description: Read the margin tier docs and the liquidation waterfall to explain a margin call or a liquidation.
starter: Why was I liquidated, and how does the margin system decide?
---
# Explain margin

Always ground this in the docs — margin rules are protocol facts, not intuition.

## Read first
- `read_docs` on the User Guide "Margin" sections (ids beginning `guide-…margin`), the "Risk Monitor" section, and `limitations/l13-…` (margin limitations). Cite the ids you read.
- If the user asks about auctions or the backstop, also read the guide sections on margin call / auction / backstop.

## The waterfall (confirm against the docs before stating)
1. Margined ranges post less than full collateral; a health factor tracks collateral vs the marked short exposure.
2. Below the maintenance tier the position gets a **margin call**: a grace window in which the LP can top up.
3. Unresolved → **auction**: the short exposure is closed against liquidity, the LP pays the mark plus a penalty.
4. If the auction cannot cover it, the **backstop** absorbs the loss.

## What the Risk Monitor shows
Health factor per range, distance to the maintenance tier in spot terms, the pending margin-call timer, and the "Explain" button that sends the current state to this copilot. When the user arrives via that button, the message already contains the numbers — start from them.

## Answering "why was I liquidated"
1. `get_positions` / `portfolio_greeks` for what the wallet holds now (cite `source`).
2. `get_market_state` for the spot and vol path — a vol spike can breach maintenance without spot moving.
3. Reconstruct: collateral posted, mark at the time (use `price_strategy` at the spot the user gives), health factor vs the tier. Show the arithmetic in a table.
4. Prevention: which tier they were in, how much extra collateral would have kept them above maintenance, and the alerts the Risk Monitor provides.

Never state a tier percentage from memory — read it.
