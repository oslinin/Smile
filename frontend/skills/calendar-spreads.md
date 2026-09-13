---
name: Calendar spreads
description: Build and price a calendar (same strike, two expiries) using per-leg expiryDays — a strategy the catalog does not have, added purely as a skill.
starter: Build me a $3,400 call calendar — sell the 14-day, buy the 45-day — and show me the Greeks.
---
# Calendar spreads

A calendar is the same strike in two expiries: short the near leg, long the far leg. `suggest_strategies` does not know it; this skill is how the copilot builds one anyway.

## Build it
`price_strategy` with two legs at the same strike and same type, each with its own `expiryDays`:
- leg 1: short, expiryDays = near (7–21)
- leg 2: long, expiryDays = far (30–60)
Net debit = far premium − near premium (calendars are almost always a debit). Report per-leg premium and the net.

## When it works
- Term structure: the near expiry's implied vol is higher than the far one's (or the smile's sqrt(T) time-value scaling overprices the near leg) — check `get_market_state` and `reference_market` at both expiries.
- Spot sits near the strike at the near expiry: max profit is at K when the short leg expires worthless and the long leg still has time value.
- Event calendars: sell the expiry that contains an event (macro-context skill) if its vol is bid, buy the one after.

## Reading the Greeks
- Delta ≈ 0 at the strike; grows as spot drifts. Same-strike calendars are a bet on time and vol, not direction.
- Theta positive: the near leg decays faster than the far leg. State it in USD/day.
- Vega positive (long vol): the far leg has more vega. A vol crush after an event hurts even if spot is pinned — say this explicitly.
- Gamma negative near the strike into the near expiry: a large move past K before the short leg expires is the loss case.

## Present
`scenario_analysis` on both legs at the near expiry date, then `propose_trade` with both legs so the card loads into the Payoff Builder (the builder renders the P&L at the near expiry as the payoff). Not financial advice, once.
