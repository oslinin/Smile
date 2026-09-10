# AI Copilot

Smile ships an in-app AI chat assistant — the **Copilot**. It is not
mentioned in the README; this page is its documentation.

## Where it lives

A floating chat button, bottom-right corner of every tab in the app
(`frontend/components/copilot/CopilotPanel.tsx`). Click it to open a
slide-over chat panel with a few starter prompts:

- "Explain the volatility smile in this protocol"
- "I'm bullish on ETH — show me trade ideas"
- "How does Smile compare to Panoptic?"
- "Quiz me on the Greeks"

It sends `{spot, chainId, address}` with every message, so its pricing and
on-chain answers always match what's visibly on screen — the server prices
with the same code the payoff builder uses, and reads the same connected
wallet address wagmi has.

## Turning it on

The Copilot is hidden unless `NEXT_PUBLIC_COPILOT=1` is set (it's absent on
the static GitHub Pages export, which has no API server to talk to). Even
with the flag on, the backend (`app/api/copilot/route.ts`) needs an LLM
provider key to actually answer — set one of these in `frontend/.env.local`
(`local.sh` preserves them across restarts):

```
NEXT_PUBLIC_COPILOT=1
COPILOT_PROVIDER=anthropic   # or openai / google / openrouter
# the provider's own API key env var, e.g. ANTHROPIC_API_KEY=...
COPILOT_MODEL=               # optional override; defaults to claude-opus-4-8 / gpt-5-mini / gemini-2.5-pro / openrouter/auto
```

`openrouter` is a fourth option: one key, hundreds of models across every
major provider, OpenAI-API-compatible so it reuses the same client under the
hood (`frontend/lib/copilot/provider.ts`) pointed at
`https://openrouter.ai/api/v1`. Its default model is `openrouter/auto`,
which lets OpenRouter itself pick a model per-prompt — set `COPILOT_MODEL`
to pin a specific one instead (e.g. `anthropic/claude-3.5-sonnet`).

**Bring-your-own-key** is also supported without touching `.env.local`: the
panel's settings gear lets a visitor paste their own Anthropic/OpenAI/Google/
OpenRouter key, stored only in that browser's `localStorage` and sent
per-request via headers — never persisted server-side.

## What it can actually do

The Copilot is tool-calling, not free-floating chat — every substantive
answer comes from one of these (`frontend/lib/copilot/tools.ts`):

| Tool | Does |
|---|---|
| `read_docs` | Reads a full section of the README/limitations/solutions docs and cites it. |
| `get_market_state` | Live ETH spot, smile parameters, ATM vol, expected move, 25-delta risk reversal/butterfly. |
| `price_strategy` | Prices a multi-leg strategy at the protocol's smile — cost, max P/L, PoP, breakevens, net Greeks; renders a payoff chart. |
| `suggest_strategies` | Candidate strategies from the catalog for a stated market view, with live-priced strikes. |
| `scenario_analysis` | Stress-tests a strategy across spot/vol shifts, optionally rolled forward in time. |
| `analyze_adjustment` | Economics of rolling/modifying an existing position — before/after risk and cash flow. |
| `get_onchain_quote` | Cross-checks a quote against the deployed pricing engine contract directly (a real `eth_call`, not the frontend model). |
| `get_positions` | The connected wallet's balances, LP range authorizations, and long option positions. |
| `portfolio_risk` | Aggregate Greeks/risk across the connected wallet's long positions, with a stress grid. |
| `propose_trade` | Renders an interactive trade card with a "Load into Payoff Builder" button — the Copilot never executes trades itself. |
| `quiz_question` | Asks one interactive multiple-choice question, scored against a real pricing-tool answer. |

`get_positions` and `portfolio_risk` currently read on-chain state directly
(`frontend/lib/copilot/chain.ts`) with a hard cap of 50 authorizations ever
created (`MAX_AUTHS`) — see `docs/limitations.md` L12a and
`docs/plans/2026-09-09-theGraph.md` for the subgraph work replacing that
scan.
