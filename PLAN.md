# Parametric Options Marketplace — Build Plan

A non-custodial, parametric options marketplace that solves the **low-liquidity
problem in decentralized options** by combining three primitives:

- **1inch Aqua / SwapVM** — LP capital stays in the LP's own wallet and is pulled
  **just-in-time** when (and only when) a trade matches the parametric premium.
  No fragmented, pre-deposited collateral; one balance can back many quotes.
- **Uniswap v4 Hooks** — the pool is the price-discovery and safety layer:
  `beforeSwap` vetoes trades priced outside oracle-safe bounds, `afterSwap`
  reprices implied volatility from realized demand.
- **Chainlink CRE** — the decentralized expiry clock: an off-chain workflow forms
  a consensus spot price and writes the settlement outcome **on-chain**.

The thesis: liquidity in options markets is thin because capital is locked per
strike/expiry. Aqua's just-in-time collateral lets a single LP balance quote the
entire option chain, so displayed depth is a function of *wallet balance*, not of
how cleverly an LP pre-allocated across dozens of dead strikes.

---

## Prize Alignment

| Track | Hard requirement | How this project satisfies it |
|---|---|---|
| **1inch (Aqua/SwapVM)** | Custom Aqua app powered by SwapVM with custom instructions; onchain token transfers shown in demo; clean multi-commit Git history | SwapVM stateless pricing program with a custom premium/spread instruction (Commits 3–4); Aqua JIT pull mints an OptionToken onchain (Commit 5); this 15-commit history is the deliverable |
| **Uniswap Foundation** | Integrate Uniswap v4 incl. a hook; functional code + TxID | `OptionPricingHook` with `beforeSwap` veto and `afterSwap` IV feedback (Commits 6–8), deployed via HookMiner |
| **Chainlink** | A Chainlink service must make an **on-chain state change** (reading a feed is not enough); use **CRE** (Functions/Automation are deprecated) | CRE workflow forms a consensus price and calls `settleSeries`, writing settlement state on-chain (Commits 9–11) |

---

## Feasibility Notes (MVP simplifications)

- **SwapVM as a stateless Solidity program.** Hand-writing raw SwapVM bytecode is
  out of scope for a weekend. The pricing engine is implemented as a *stateless,
  pure* Solidity contract that models the SwapVM instruction path (a custom
  premium opcode). The interface is shaped so it can later be lowered to bytecode.
- **Premium math is an integer approximation, not full Black–Scholes.** On-chain
  BS is gas-prohibitive. We use a parametric premium: `intrinsic + time-value`,
  where time-value scales with a **volatility smile** `σ(K) = σ0 + a·ln(K/S)²`
  (fixed-point, no floats). This is enough to show a realistic smile and a
  demand-driven spread.
- **Asymmetric rounding makes the spread.** BUY (`exactOut`) rounds the premium
  **up** → Ask; SELL (`exactIn`) rounds **down** → Bid. Same strike, two sides,
  one consistent spread — no separate order book needed.
- **Hedera HTS (Commit 12) is OPTIONAL / stretch.** The core 1inch + Uniswap +
  Chainlink loop is self-contained; HTS is a clean adapter to add only if time
  allows.

---

## Phase 1 — Environment & Token Foundation

### Commit 1 — Repository scaffolding & configuration
- **Files:** `foundry.toml`, `remappings.txt`, `.gitignore`
- Initialize a Foundry monorepo; install `@uniswap/v4-core`,
  `@uniswap/v4-periphery`, `@openzeppelin/contracts`, `solmate`.
- Set `evm_version = "cancun"` for v4 transient storage (TSTORE/TLOAD).
- **Verify:** `forge build` gives a clean baseline.

### Commit 2 — ERC-20 Option Wrapper (`OptionToken.sol`)
- **Files:** `src/OptionToken.sol`, `test/OptionToken.t.sol`
- ERC-20 representing an option position. Immutable metadata: `underlying`,
  `strikePrice` (K), `expiry` (T), `isCall`. Owner-only `mint`/`burn` (the vault).
- **Verify:** only the owner can mint/burn; metadata returns correct params.

## Phase 2 — Underwriting & Vault Layer (1inch Aqua + SwapVM)

### Commit 3 — SwapVM stateless pricing scaffold
- **Files:** `src/swapvm/OptionPricingEngine.sol`
- Stateless execution path taking option state (Spot S, Strike K, Expiry T,
  side BUY/SELL).
- **Verify:** compiles; interface is fixed with zero errors.

### Commit 4 — Volatility smile + asymmetric rounding (spread engine)
- **Files:** `src/swapvm/OptionPricingEngine.sol`
- Implement the parametric vol smile and the asymmetric rounding rule
  (BUY→round up→Ask, SELL→round down→Bid).
- **Verify:** OTM/ITM scale vol correctly; BUY/SELL on one strike yield a
  consistent spread.

### Commit 5 — Aqua collateral vault (`AquaCollateralVault.sol`)
- **Files:** `src/vaults/AquaCollateralVault.sol`, `test/AquaCollateralVault.t.sol`
- Track LP assets via Aqua's virtual-wallet layer; JIT `pull()`: on a matched
  trade, Aqua pulls 1 ETH (covered call) or K USDC (cash-secured put) from the
  LP, locks it, mints an `OptionToken`.
- **Verify:** integration test — buyer payment triggers atomic LP pull + mint.

## Phase 3 — Trading & Price Discovery (Uniswap v4 Hooks)

### Commit 6 — Scaffold v4 hook (`OptionPricingHook.sol`)
- **Files:** `src/hooks/OptionPricingHook.sol`
- `BaseHook` with `beforeSwap` + `afterSwap` flags; HookMiner deploy script.
- **Verify:** hook attaches to an initialized pool in simulation.

### Commit 7 — Hook→Engine bridge (`beforeSwap` veto)
- **Files:** `src/hooks/OptionPricingHook.sol`, `test/OptionPricingHook.t.sol`
- Fetch oracle price; compare execution price to the SwapVM premium target;
  `revert()` if outside safety bounds (flash-loan / stale-price protection).
- **Verify:** trades against a stale-price pool abort.

### Commit 8 — IV demand feedback (`afterSwap`)
- **Files:** `src/hooks/OptionPricingHook.sol`
- On buy, bump global IV `σ_global` by γ; on sell, decrease it.
- **Verify:** back-to-back buys raise the next premium.

## Phase 4 — Lifecycle, Settlement & Sponsor Integration

### Commit 9 — Settlement vault (`AquaOptionSettlement.sol`)
- **Files:** `src/vaults/AquaOptionSettlement.sol`
- On-chain expiry checks (settle only when `block.timestamp ≥ T`); only the
  authorized Chainlink CRE forwarder may write the final price.
- **Verify:** pre-expiry settle fails; only the CRE address can call `settleSeries`.

### Commit 10 — Fully-collateralized payouts
- **Files:** `src/vaults/AquaOptionSettlement.sol`
- OTM → release 100% collateral to LP. ITM → pay holder `S−K`, return remainder
  to LP.
- **Verify:** both scenarios resolve with zero leftover contract liability.

### Commit 11 — Chainlink CRE workflow
- **Files:** `cre-workflow/option-settlement.ts`
- TS workflow triggered at expiry; queries multiple price feeds (e.g. Binance,
  Coinbase) for consensus spot; tamper-proof write back to
  `AquaOptionSettlement.settleSeries`. **This is the required on-chain state change.**
- **Verify:** CRE CLI simulation updates contract state with the consensus price.

### Commit 12 — *(OPTIONAL)* Hedera HTS adapter (`HTSOptionAdapter.sol`)
- **Files:** `src/hedera/HTSOptionAdapter.sol`
- Wrap the HTS precompile (`0x167`); substitute ERC-20 mint/burn with native
  `mintToken`/`burnToken`.
- **Verify:** fork-test mints native HTS tokens at Hedera's consensus layer.

## Phase 5 — Interactive Front-End

### Commit 13 — Next.js + wallet scaffolding
- **Files:** `frontend/package.json`, `frontend/config/wagmi.ts`, `frontend/pages/_app.tsx`
- wagmi, viem, tailwindcss; RPC wired to deployed contracts.
- **Verify:** dev server runs; wallet connects.

### Commit 14 — Dynamic option matrix (parametric quotes)
- **Files:** `frontend/components/OptionMatrix.tsx`
- Async `eth_call` loop polling the SwapVM engine; live Bid/Ask across strikes.
- **Verify:** a realistic volatility smile renders.

### Commit 15 — One-click trade + LP dashboard
- **Files:** `frontend/components/TradeButton.tsx`, `frontend/components/LPDashboard.tsx`
- Buy button fires the JIT approve → Aqua-pull → mint tx; LP view shows
  "Total Value Unlocked" — assets stay self-custodied, earning until called.
- **Verify:** a mock swap updates the matrix, mints the option, logs the premium
  on the dashboard in one click.

---

## Demo checklist (deliverables)

- [ ] GitHub repo with clean per-commit history (1inch requirement)
- [ ] On-chain TxID of an Aqua JIT pull + option mint (1inch + Uniswap)
- [ ] v4 hook attached to a live pool, with a `beforeSwap` veto shown
- [ ] CRE workflow simulation writing `settleSeries` on-chain (Chainlink)
- [ ] `README.md` + ≤3-min demo video
