# Vol-surface renderer (Python)

A tiny Flask + matplotlib service that draws the protocol's multiparameter
volatility surface as a 3-D plot and **mutates it as trades execute** — the same
feedback loop the on-chain hook applies (`OptionPricingHook.bumpSigma`):

```
σ_strike(K, T) = σ_tenor(T) · max(0.1, 1 + α·ln(K/S)² + β·ln(K/S))
```

- **Strike axis** — the smile: `α·ln(K/S)²` curvature (+ optional `β` skew).
- **DTE axis** — the term structure: one `σ_tenor` per bucket `[0,7) [7,30) [30,90) [90,∞)`.
- **Feedback** — every `buy` bumps the traded tenor bucket by `+γ`, every
  sellback decays it by `−γ` (γ = 0.5%). State lives in the process, so the
  surface genuinely evolves across trades.

## Run

The environment is managed by [uv](https://docs.astral.sh/uv/) — `run.sh` calls
`uv run`, which auto-creates `.venv` and installs the deps pinned in `uv.lock`
(from `pyproject.toml`) on first run.

```bash
./run.sh            # uv syncs deps, then serves on :8000
# or:  PORT=9000 ./run.sh
# or, directly:  uv run server.py
```

Install uv first if you don't have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

It also comes up automatically with the repo's `./local.sh`.

## Endpoints

| Method | Path           | Purpose                                                            |
| ------ | -------------- | ----------------------------------------------------------------- |
| GET    | `/surface.png` | Render the current surface. Query: `spot, alpha, beta, elev, azim`|
| POST   | `/trade`       | Body `{dte, direction:"buy"\|"sell"}` — bump/decay a tenor bucket  |
| GET    | `/state`       | Current per-bucket σ, α, β, γ, trade count                         |
| POST   | `/reset`       | Restore the default term structure                                |
| GET    | `/health`      | Liveness probe                                                     |

## Frontend wiring

The Next.js **“Vol Surface · Python”** tab (`frontend/components/VolSurface.tsx`)
embeds `/surface.png` and POSTs `/trade` on every confirmed buy/sell, then
re-fetches the freshly rendered image. The service URL is read from
`NEXT_PUBLIC_VOLSURFACE_URL` (default `http://localhost:8000`). When the service
isn't running the tab shows a hint instead of a broken image, so the static
GitHub Pages build degrades gracefully.
