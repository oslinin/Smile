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


### Tools over the tape — The Graph as the copilot's chain data (EthOnline 2026)

The second set reads **the tape**: every range, instrument, fill and
position, from The Graph on Sepolia and Arc (`subgraph/`, Studio
`smile-sepolia` / `smile-arc-testnet`) and, only on the local Anvil chain,
from the vault's event log rebuilt into the same shape (`frontend/lib/tape.ts`).
On a public network there is no RPC path: a missing subgraph is an error,
not a capped scan. Every result carries `source: "subgraph" | "anvil-logs"`
and the copilot is instructed to say where the numbers came from.

| Tool | Does | Source |
|---|---|---|
| `find_opportunities` | Screens every live strike on every active range: Smile's ask as an implied vol vs the nearest listed **Deribit** instrument's IV, and vs the last fill of the same instrument; free capacity and open interest per row; ranked cheap / expensive. | Graph + Deribit |
| `liquidity_map` | Every active range with capacity, used %, open interest, fills, days since last trade — flags **scarce** (≥80% used), **empty**, **stale** (>3 d), **expiring** — plus a per-strike heat map and the strikes near spot nobody quotes. "Expensive liquidity" is a query. | Graph |
| `portfolio_greeks` | The wallet's whole book: long positions (the `Position` entity, cost basis from its own fills) **and** the written side (open interest on its ranges), net delta/gamma/theta/vega, marks, and `legs` ready for the next two tools. | Graph |
| `hedge_suggestion` | How much spot ETH, or how many calls/puts at a strike, brings a book to a target delta ("hedge my 3 short puts with short calls"); before/after greeks. | math |
| `reference_market` | Deribit public API: ETH index, the DVOL 30-day vol index, ATM IV at the nearest listed expiry, nearest instrument to a strike/expiry with its mark IV. No key, 60 s cache. | Deribit |
| `macro_calendar` | Upcoming FOMC / US CPI / monthly and quarterly listed expiries (a hardcoded 2026 table) with the event-vol heuristic for each, plus the general ones (event-vol crush, ETH beta, weekend theta, max-pain pinning). | static |
| `prepare_lp_range` | A card proposing a range to write (band, expiry, size, expected premium) whose button prefills **Earn · Write a Range**; the user signs `authorizeRange` + `Aqua.ship`. | UI |
| `prepare_rfq_quote` | A card proposing an RFQ quote (range, strike, size, premium inside the formula ask, ttl) whose button prefills the **RFQ** signer; the user signs the EIP-712 message in the wallet. | UI |

The agent prepares; the user signs. No key ever leaves the wallet, and the
copilot cannot send a transaction.

`get_positions` and `portfolio_risk` read the same tape now: the
`MAX_AUTHS = 50` cap and the per-strike `N+1` RPC scan that used to blind
them past 50 ranges ([L12a](limitations.md)) are gone on public networks.

## Skills

The copilot's behaviour is packaged as **skills** — `frontend/skills/*.md`
in the `SKILL.md` convention (frontmatter `name`, `description`,
`starter`; the body is what the model follows). The **Skills** button in
the panel header lists them with a toggle and a one-click starter prompt,
and lets you **add your own** (a name and a markdown body, kept in this
browser only) — so "calendar spreads", which the strategy catalog does not
have, is just a skill, and so is anything you want the copilot to do your
way. Enabled skills ride each request and are appended to the system
prompt as "Active skills".

| Skill | What it teaches the copilot |
|---|---|
| `trading-opportunities` | screen with `find_opportunities` + `reference_market`, confirm with `price_strategy`, present with `propose_trade`; what "cheap" means; sanity checks |
| `risk-management` | `portfolio_greeks` → `scenario_analysis` → limits (max loss vs balance, gamma near expiry, vega vs DVOL); when to roll |
| `delta-hedging` | net delta × spot, `hedge_suggestion` with spot or options, re-hedge triggers, the gamma caveat |
| `explain-margin` | the margin tier, the liquidation waterfall, what the Risk Monitor shows, "why was I liquidated" |
| `lp-market-making` | `liquidity_map` → empty/scarce bands → size vs collateral → expected premium → `prepare_lp_range`; adverse-selection risks |
| `rfq-quoting` | recent fills and IV for an instrument → a quote inside the formula ask → `prepare_rfq_quote`; ttl/nonce hygiene |
| `macro-context` | `macro_calendar` + heuristics, combined with `find_opportunities`; labelled as heuristics |
| `calendar-spreads` | same strike, two expiries with per-leg `expiryDays`; term structure; theta/vega reading |

## MCP servers

The settings gear has an **MCP servers** list (name, URL, bearer token —
kept in this browser, sent per request in a header the same way the BYOK
key is). The copilot opens each server for the request and merges its
tools with the built-ins. One preset: **The Graph Subgraph MCP**
(`https://subgraphs.mcp.thegraph.com/sse`, token = a Gateway API key from
Studio → API Keys) — with it the copilot can query any of The Graph's
indexed subgraphs in natural language, not only Smile's own. The operator
can seed the same list server-side with `COPILOT_MCP_SERVERS` (JSON) for a
hosted demo.

For developers working on the repo, the same server is a one-file client
config: `.mcp.json.example` at the repo root (Claude Code / Cursor), and
`subgraph/SKILL.md` is the agent-facing description of Smile's subgraph —
entities, canonical queries, endpoints, units — so an AI environment can
query `smile-sepolia` without reading the schema.

## Where the data comes from

| Data | Source | Fallback |
|---|---|---|
| Spot, smile parameters, per-leg pricing | the same code as the UI (`lib/options.ts`) and the deployed pricing engine (`get_onchain_quote`) | — |
| Ranges, instruments, fills, positions | **The Graph** — `smile-sepolia` on Sepolia, `smile-arc-testnet` on Arc (recorded per chain in `lib/deployments.ts`; `SUBGRAPH_URL` server-side overrides with a gateway URL carrying an API key, proxied through `/api/subgraph` so the key never reaches the browser) | Anvil only: the vault's event log rebuilt into the same entities |
| Listed reference vol | Deribit public API | tool reports "unreachable"; edge is then measured against the protocol's flat ATM vol |
| Macro dates | hardcoded 2026 table | — |
| Anything else | MCP servers you add | — |
