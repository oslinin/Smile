---
name: Macro context
description: Upcoming scheduled macro events and event-vol heuristics, combined with the opportunity screener. Heuristics, not advice.
starter: What macro events are coming up and how should that change how I trade vol this week?
---
# Macro context

Everything in this skill is a heuristic. Label it as such every time; never present a heuristic as a forecast.

## Procedure
1. `macro_calendar` — upcoming FOMC, CPI, NFP, options expiries and similar within N days, plus the event-vol heuristics table it returns.
2. `get_market_state` and `reference_market` — current ATM vol and DVOL, so you can say whether the market already prices the event (DVOL elevated relative to its recent range).
3. `find_opportunities` — with the event view in mind: ahead of an event, long-vol structures on instruments the screener flags cheap; after it, short-vol on instruments flagged expensive.

## Heuristics (say "heuristic" each time)
- IV tends to rise into FOMC and CPI and crush after the print; the crush is usually larger than the rise.
- ETH beta to BTC is > 1 on down moves; ETH beta to Nasdaq is positive and rises in risk-off weeks, so a heavy US-macro week matters more for ETH than for BTC.
- Weekend and holiday theta: option time decays on calendar days but the market moves less, so short-dated premium sold Friday is theta-rich; the reverse for buyers.
- Big scheduled expiries (Deribit monthly/quarterly) pin spot near large open-interest strikes into the expiry and release after.

## Combine with sizing
Refer to the risk-management skill: short-vega size into an event should be cut proportionally to the expected vol jump; `scenario_analysis` with a +10 vol-point shift shows the cost.

## Output
Table of events (date, type, typical vol behaviour), then a one-paragraph read of "priced / not priced" using the live numbers, then at most two concrete ideas each confirmed with `price_strategy` and offered via `propose_trade`. Close with the not-financial-advice note.
