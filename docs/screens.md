# Screens: what every number means

This page walks through the Smile application one tab at a time and explains every figure, label, badge, bar and button on each tab: what it shows, and where the value comes from (which contract read, which formula, which data source). It is written for a reader who knows what an option is but has not read the code. The **Help** link in the app opens this page at the section for the tab that is currently on screen.

Terms are defined where they first appear. A few recur everywhere:

- **Ask** is the price a buyer pays to open a position; **Bid** is the price a holder receives to sell it back. One on-chain strategy quotes both sides; the gap between them is the spread.
- **Spot** is the current ETH/USD price the app is working from. Where it comes from is explained under the header.
- **WAD** means an 18-decimal fixed-point integer, the on-chain representation of prices and unit counts. USDC amounts are 6-decimal integers. Every display in the app divides by the right power of ten; this page states the units as they are shown.
- **Anvil** is the local development chain started by `./local.sh`; **Sepolia** and **Arc Testnet** are the two public testnets the app is deployed on. Where a number behaves differently per chain, the section says so.

The mathematics behind the quotes is specified in the README's "Mathematical Specification" and is not repeated here; the User Guide (`docs/guide.md`) is the step-by-step walkthrough of the same screens.

<a id="tab-header"></a>
## Header strip (every tab)

The header is the same on every tab: the wallet controls on the top row and the spot price bar beneath it.

| Element | What it shows | Where it comes from |
|---|---|---|
| **Help ↗** | Opens this documentation site in a new tab, at the section for the current tab. | `app/page.tsx`, static link to `/help.html`. |
| **Network** dropdown | Before a wallet is connected the button reads "Network"; once connected it shows the connected chain's name (for example "Sepolia", "Arc Testnet") or "Chain N" for an unknown id, and "Switching…" while a switch is pending. The list marks the active chain with "✓ active". | `useChainId()` and `useChains()` from wagmi; switching goes through `useSwitchChain` on the connected connector, or a raw EIP-3326 request when no wallet is connected. |
| **Connect Wallet** | Opens the wallet picker when more than one connector is available, or connects directly when there is exactly one. Reads "Connecting…" while pending. Any connector error appears in red beneath it. | `useConnect()`; connectors are the injected wallet (MetaMask etc.) and WalletConnect. |
| **Open in MetaMask** | Shown only when no injected wallet exists (a phone browser). A universal link that opens the page inside MetaMask's own browser. | `https://metamask.app.link/dapp/<host><path>`. |
| Balance, e.g. `0.1436 ETH` | The connected wallet's native-token balance on the connected chain, four decimals. On Arc the native token is USDC, so this reads in USDC. | `useBalance({ address })`. |
| Address, e.g. `0x2816…6bf1` | The first six and last four characters of the connected address. | `useAccount()`. |
| **Disconnect** | Disconnects the wallet. | `useDisconnect()`. |
| Large price, e.g. `$2,536` | The spot price the app uses for every quote, chart and ladder on every tab. Shown as "$—" while loading. | `hooks/useUniswapSpot.ts`, see the three sources below. |
| `ETH/USD · 30d expiry` | Static caption: the underlying pair and the default tenor the option chain opens on. | Literal text. |
| Source badge: `● Uniswap API` (pink), `● Chainlink` (blue) or `● static` (grey) | Which of three sources produced the spot. | `useUniswapSpot` tries, in order: (1) the Uniswap Trading API `EXACT_INPUT` quote for 1 WETH → USDC on mainnet, only when `NEXT_PUBLIC_UNISWAP_API_KEY` is set; (2) the Chainlink ETH/USD feed on Sepolia (`0x694A…5306`, `latestRoundData`, 8 decimals) — this is the only chain with a feed in the table, so it is read regardless of the connected chain; (3) a static `3420`. Refreshes every 60 seconds. |

Notes. The spot shown here is a display and quoting convenience for the browser. Contracts price against their own oracle: the Chainlink feed on Sepolia, a settable mock aggregator on Anvil and Arc (fixed at $3,000 on Arc unless someone posts a new round). Rounded to whole dollars.

<a id="tab-story"></a>
## Overview

The landing tab. It states the thesis, names the chain you are on, shows the capital-efficiency ladder as live numbers from the connected chain, the protocol's live counters across every vault, and the recorded testnet receipts.

| Element | What it shows | Where it comes from |
|---|---|---|
| **You are on** | The connected chain's name ("Sepolia", "Arc Testnet", "Anvil (local)" or "chain N"). | `DEPLOYMENTS[chainId].name` in `lib/deployments.ts`; the Anvil fallback for chain ids 31337 and 1337. |
| Line under the chain name | What is real money on this chain: on Sepolia "Circle USDC · canonical WETH · Chainlink ETH/USD"; on Arc "Circle's native USDC — premium, collateral, margin, backstop, and gas"; on Anvil "mock USDC / WETH, settable oracle — the full lifecycle runs here in minutes". | `DEPLOYMENTS[chainId].realMoney`, or the literal Anvil string. |
| `● indexed by The Graph — no range cap, the copilot trades off it` | Present when the chain has a subgraph (Sepolia, Arc). | `DEPLOYMENTS[chainId].subgraph` is set. |
| `connect a wallet to trade; reading works without one` | Shown while no wallet is connected. | `useAccount().isConnected`. |
| **What a writer locks for one $K put** | The ladder's reference strike K is the spot rounded to the nearest $50 (the "at-the-money" strike). | `k = round(spot / 50) × 50`. |
| `live from the connected chain · spot $S · margin mark $M` | The spot in use and, when `MarginVault` is deployed, its margin mark (the lowest Chainlink answer of the last hour, explained under Margin). | `MarginVault.markSpot()`; the mark is omitted when the read returns zero. |
| Rung **Naked put** — `$K USDC locked per unit` | What the main vault locks per put unit: the full strike, cash-secured. Full-width bar (this is the 100% reference). | `k`. |
| Rung **Credit spread** — `$(K₂−K) USDC — the true max loss, N× less` | What `SpreadVault` locks for a put credit spread with the long strike K₂ = K + 200: the strike gap in USDC. N = K ÷ (K₂ − K), rounded to a whole number. | Formula from `SpreadVault`'s escrow rule, computed in the browser; K₂ is K + 200 by construction of the ladder. |
| Rung **Margined put** — `$IM USDC initial margin — N× less, liquidation-backed` | What `MarginVault` would lock as initial margin for one put at K, off its live mark. N = K ÷ IM to one decimal. | `MarginVault.marginRequirement(K, 1 unit, markSpot, initial = true)`, refreshed every 15 seconds; if the read is unavailable the browser estimate `min(K, max(K − spot, 0) + 0.5 × spot)` is used. |
| Rung **Signed quote** — `any price the LP signs — the custody model never changes` | The RFQ tier: the price changes, the collateral rule does not. Bar width equals the naked rung. | Literal. |
| **new** badge | Marks the three rungs built at EthOnline 2026. | Literal. |
| **Trade →**, **Spreads →**, **Margin →**, **RFQ →** | Jump to the tab that implements that rung. | Tab switch. |
| **Ranges shipped** — value and `vault a · spread b · margin c · rfq d` | The total number of ranges ever authorised across the four vaults, with the per-vault breakdown. | Sum of `nextAuthId()` on `AquaCollateralVault`, `SpreadVault`, `MarginVault`, `RfqVault`; refreshed every 15 seconds. `nextAuthId` counts authorisations, so revoked and expired ranges are included. |
| **Backstop pool** — `N USDC` | Total USDC held by the backstop pool that absorbs margined positions nobody buys at auction. | `MarginBackstop.totalAssets()`. |
| **Naked notional / ceiling** — `A USDC / B USDC` | A is the notional of margined puts currently open; B is the most the vault will allow, "ceiling = 7 × backstop" (the lower of the owner's cap and seven times the pool). | `MarginVault.nakedNotional()`, `MarginVault.effectiveCeiling()`. |
| **Insurance fund** — `N USDC` | The insurance fund drawn after the backstop and before any haircut; fed by "50% of margin fees + penalties". | `MarginVault.insuranceFund()`. |
| **Real transactions on <chain>** | The recorded demo receipts for this chain: hash (link to the explorer), label, note. Below them the deployed contract addresses and the subgraph URL. On Anvil this block is replaced by a note pointing at the lifecycle scripts. | `DEPLOYMENTS[chainId].demo`, `.contracts`, `.subgraph`; links via `lib/explorer.ts`. The two "buy" receipts are the deployer buying from its own range (limitations L15); the three "Treasury ·" receipts are the Circle App Kits runs. |

Units and rounding. Ladder amounts are whole dollars; counters are whole USDC. Bar widths are `value ÷ k` as a percentage with a 2% floor so a rung is never invisible.

<a id="tab-chain"></a>
## Trade

The buyer's tab: the price chart with the strategy drawn on it, the option chain (the matrix of quotes by strike), and the strategy payoff builder.

### Price chart

| Element | What it shows | Where it comes from |
|---|---|---|
| `ETH/USD · Coinbase ETH-USD · 1h · last N` | Hourly candles and the last close. | `api.exchange.coinbase.com` public candles, `granularity=3600`; on failure `api.kraken.com` OHLC at 60-minute interval and the caption reads "Kraken ETH/USD · 1h". Market context only; the protocol prices off its oracle. |
| Dotted blue line `Smile spot $S` | The app's spot (the header figure), as a horizontal price line. | The `spot` prop. |
| Solid green / red lines `long call 1×`, `short put 2×` … | One line per leg in the payoff builder, at the leg's strike; green for a bought leg, red for a written leg, with the quantity. | The builder's legs. |
| Dashed yellow `breakeven` lines | The underlying prices at which the strategy's expiry P&L crosses zero. | `breakevens(pnlSeries(legs, spot))` in `lib/options.ts`. |
| `nearest expiry in Nd` | The smallest days-to-expiry among the legs. | Leg `expiryDays`, default 30. |
| **Tape** selector, e.g. `C 2500 · 8 Oct (12)` | The instruments that have traded on the main vault, most fills first; the label is C/P, strike and expiry date, with the fill count in parentheses. | `lib/tape.ts` `readTape`: the subgraph on Sepolia and Arc, the vault's event log on Anvil. Re-polled every minute. |
| `· The Graph` or `· Anvil event log` | Which source the tape came from. | `tape.source`. |
| Purple line `premium / unit $P` | The premium paid per unit at each fill of the selected instrument, on the left price scale. | `TapeFill.premiumPerUnit`. |
| Pink line `implied vol N%` | The Black-Scholes volatility that reproduces each fill's premium, given the candle close at that hour, the strike and the time to expiry. Absent for a fill whose premium is below intrinsic value (no volatility explains it). | `impliedVol()` in `PriceChart.tsx`: bisection on sigma in [1%, 500%], r = 0; spot at the fill is the last candle at or before the fill, or the prop spot when no candle covers it. |
| `Tape · no trades yet` | No fills on this chain. | Empty tape. |

### Option chain

| Element | What it shows | Where it comes from |
|---|---|---|
| **Expiry** pills `1d 7d 30d 90d` | The tenor the matrix quotes. When an LP range is active the pills are locked and the pill nearest the range's expiry is highlighted, with `Nd (LP auth)` showing the exact days left. | `selectedDays`, or `activeAuth.expiry`. |
| `Bid↓ to sell · Ask↑ to buy` | Reminder of which column does what. | Literal. |
| Range strip: `Covered Calls` / `Cash-Secured Puts`, `$K₁ – $K₂` or `single strike $K` | The active authorisation (the market-wide latest active range on the main vault): side and strike band. | `AquaCollateralVault.authorizations(latest)`, polled every 10 seconds in `page.tsx`. |
| `used / max WETH` (or USDC), progress bar, `N% used` | How much of the range's collateral capacity has been consumed by fills. Calls are capped in WETH, puts in USDC. | `usedCollateral` and `maxCollateral` from the same read, refreshed every 6 seconds. |
| `Nd left` (red when 3 or fewer) | Days until the range expires. | `(expiry − now) / 86400`, rounded. |
| `firm depth N WETH` and `⚠ soft` | The size a fill can actually clear right now: the minimum of the authorised remainder, the LP wallet's token balance, and the LP's allowance to Aqua. "soft" appears when the wallet backs less than the authorised remainder — the rest of the displayed depth is phantom (limitations L11). | `hooks/useFirmDepth.ts`: ERC-20 `balanceOf(lp)` and `allowance(lp, Aqua)` every 10 seconds. |
| Rows: strikes at −20%, −10%, −5%, 0, +5%, +10%, +20% of spot, rounded to $50 | The strike grid. | `STRIKES_OFFSETS` in `OptionMatrix.tsx`. |
| **IV** e.g. `82.4%` | The implied volatility the smile assigns to that strike: σ = σ_tenor × max(0.1, 1 + α × ln(K/S)² + β × ln(K/S)), with σ_tenor and β read live from the on-chain hook for the selected expiry (α is the range default 2.0). A trailing `*` means the live read has not landed and the pre-event constants (0.80, 2.0, 0) are showing. | `useLiveSurface()` → `OptionPricingHook.sigmaFor(timeToExpiry)` and `beta()`; `smileSigma()` in `lib/options.ts`. |
| **Δ** e.g. `0.53` (calls) / `−0.47` (puts) | Black-Scholes delta at the live smile volatility: the option's price sensitivity to a $1 move in spot, and roughly the probability of expiring in the money. Put delta is call delta minus one. | `callDelta()` with the Abramowitz–Stegun normal CDF. |
| **Bid↓sell** (green) and **Ask↑buy** (red) e.g. `$121.30` | Per-unit premium from the same formula the vault charges: intrinsic + spot × σ_strike × √T × min(S,K)/max(S,K) (README, Mathematical Specification §2), at the live sigma. Ask rounds up to the cent, Bid rounds down; the on-chain spread adds the staleness-scaled and size terms at fill time, and the 1% protocol fee is grossed up on top of the Ask. Ask cells are dimmed and unclickable unless the strike is inside the active range on the matching side. | `priceWAD()` → `protocolPremium()` in `lib/options.ts`. |
| **Strike** column, highlighted row | The at-the-money row is the strike within 1% of spot. | `isATM`. |

Clicking an Ask opens the buy panel; clicking a Bid opens the sell (write) panel; a strike where you hold OptionTokens offers a close panel.

**Buy panel.** `Amount (contracts)` is the number of units. `Call · K $2,500 · 12.34 USDC premium` is `Ask × amount` in USDC (the Ask WAD scaled to 6 decimals). The three steps are: `1. Swap 0.00512 ETH → 12.34 USDC` (only when a Uniswap API key is configured; an `EXACT_OUTPUT` quote from the Trading API for exactly the premium, executed through the Universal Router and shown afterwards as `✓ Swapped via Uniswap (0x…) ↗`), `2. Approve USDC` (an ERC-20 approval for twice the premium, to the vault), and `3. Buy N Call` which calls `AquaCollateralVault.buy(authId, strike, amount, maxPremium)`. The yellow line "Size exceeds the LP's firm depth…" appears when the collateral the fill would pull (amount WETH for calls, amount × strike USDC for puts) exceeds the firm depth, and the buy button is disabled.

**Sell panel** (writing from the matrix). `Call`/`Put`, `K_min`, `K_max`, `×` size, `receive ~$N USDC` (Bid × size), `lock N WETH` for calls or `lock $N USDC` (size × K_max) for puts; expiry `1d 7d 30d`; "range write · collateral splits across N strikes" counts $50 steps between the bounds. It runs approve → `authorizeRange` → `Aqua.ship`, reporting `Confirm approval… / Approving… / Registering… / Shipping to Aqua… / ✓ Written`.

**Close panel.** `Close position · 0.0100 contracts` is your OptionToken balance (18 decimals); "Burns OptionToken · releases LP collateral · decrements σ" describes `AquaCollateralVault.close(optionToken, lp, balance, minPayout = 0)`: the payout is the on-chain Bid, accepted as is.

### Strategy Payoff Builder

| Element | What it shows | Where it comes from |
|---|---|---|
| Outlook tabs and strategy chips | Preset multi-leg strategies grouped by market view; hovering a chip shows its description. | `STRATEGIES` in `PayoffBuilder.tsx`. |
| Leg row: side, `K`, `×`, `DTE`, `~$N` | Each leg's strike, quantity, days to expiry and the protocol's per-unit premium for it. | `protocolPremium(spot, K, isCall, DTE/365)`: intrinsic + spot × σ_smile × √T × min(S,K)/max(S,K), the same formula the on-chain instruction uses. |
| Payoff chart: solid, purple dashed, pink dotted lines; `S` marker; `$N` breakeven labels | P&L versus underlying price at the nearest expiry (solid), today (T+0, purple dashed) and halfway to expiry (pink dotted); the vertical marker is spot; yellow labels are breakevens. | `pnlSeries()`: 200 points from 60% to 140% of spot; each leg valued by Black-Scholes at the smile σ with r = 0, collapsing to intrinsic at expiry; P&L = value − entry cost. |
| **Net debit / Net credit** `$N` | Entry cost at the protocol's premiums: positive is paid, negative is received. | `entryCost()`. |
| **Max profit**, **Max loss** (`∞` when unbounded) | Extremes of the expiry P&L over the plotted range; "∞" when the curve is still rising or falling at the edge. | `strategyStats()`. |
| **Breakeven** `$N · $M` | Zero crossings of the expiry P&L. | `breakevens()`. |
| **Prob. profit** `N%` | Probability of finishing profitable at the nearest expiry under a lognormal terminal distribution centred on spot with the at-the-money smile σ. | `probabilityOfProfit()`. |
| **Δ**, **Γ**, **Θ/day** `$N`, **Vega** `$N` | Net Greeks of the strategy at spot: delta (per $1 of spot), gamma (change in delta per $1), theta (P&L per calendar day), vega (P&L per 1 volatility point). | The `greeks` package at the smile σ per leg. |
| **P&L by price and date** heat map | A 15 × 8 grid: rows are underlying prices from +30% to −30% of spot, columns are calendar days from today to the nearest expiry; each cell is the strategy P&L, green for gain, red for loss; hovering shows the exact value. | `pnlMatrix()`. |
| **What the writer locks on Smile, per unit** — `main vault`, `SpreadVault`, `MarginVault` | For each written leg: the naked collateral (1 ETH per call, the strike in USDC per put); the netted escrow when a bought leg of the same type caps the loss ((K₂ − K₁)/K₂ ETH for calls, K₂ − K₁ USDC for puts), otherwise "— add a long call above/put below"; the margined amount for puts, `min(K, max(K − S, 0) + 0.5 × S)`, otherwise "puts only". | `writerCollateral()` in `lib/options.ts`. |

Per chain. The chart's candles are public exchange data on every chain. The tape is the subgraph on Sepolia and Arc and the event log on Anvil; on a public chain without a subgraph the tape stays empty rather than falling back to an RPC scan. Quotes in the matrix depend only on the header spot and the smile constants, so they look the same on every chain; the on-chain price at fill time depends on that chain's oracle.

<a id="tab-income"></a>
## Earn · One-Click

The income writer's front door: pick a side and a risk band, and the app turns a delta target into a strike range, estimates the yield, and runs approve → authorise → ship as one flow.

| Element | What it shows | Where it comes from |
|---|---|---|
| Side: **Covered calls** / **Cash-secured puts** | Which side you write. Calls lock WETH, puts lock USDC. | Local state. |
| Presets **Conservative** `10–20Δ · far OTM, high win rate`, **Balanced** `20–30Δ · the classic income band`, **Aggressive** `30–40Δ · richer premium, more assignments` | The delta band. Delta approximates the probability of expiring in the money, so a lower band is further out of the money. | `PRESETS` in `IncomeOneClick.tsx`. |
| **Tenor** `7 days` / `30 days` | Days to expiry. | `TENORS`. |
| **Strike range** `$K₁–$K₂` | The strikes whose Black-Scholes |delta| equals the two band edges, at the smile σ, rounded to $50. | `strikeForDelta()` by bisection, `roundStrike()`. |
| Size input (WETH for calls, USDC for puts) | The collateral you commit. | Local state; becomes `maxCollateral`. |
| **Est. premium** `$N` | Premium per unit at the mid-strike times the units the collateral backs: units = size for calls, size ÷ mid-strike for puts. | `protocolPremium(spot, midStrike, isCall, T)`. |
| **Est. APR** `N%` | (estimated premium ÷ collateral value) × (365 ÷ tenor days) × 100, where collateral value is size × spot for calls and size for puts. An annualised rate from one period's premium; not compounded, not net of assignments. | Computed in the component. |
| **Expected move by expiry** `±N% (~$M)` | ATM vol × √T, the size of move the premium is charging for, in percent and dollars. | `surfaceQuotes(spot, T).expectedMovePct`. |
| `ATM volatility (N%/yr here)` | The at-the-money smile σ. With the current constants this is 80%. | `smileSigma(spot, spot)`. |
| **Which direction costs more** `±N vol pts` — the risk reversal | σ at the 25-delta call strike minus σ at the 25-delta put strike. With β = 0 this is close to zero. | `surfaceQuotes().rr25`. |
| **Extra charge for big moves** `+N vol pts` — the butterfly | Mean of the two 25-delta wing vols minus the ATM vol: the fat-tails premium. | `surfaceQuotes().bf25`. |
| `($K_put / $K_call today)` | The 25-delta reference strikes the wings were measured at. | `surfaceQuotes().k25put`, `.k25call`. |
| Progress `Confirm approval… / Approving… / Registering… / Shipping to Aqua…` and the green **… range is live** card with `$K₁ – $K₂ · N DTE · est. N% APR in premium` | The three transactions: ERC-20 approve to Aqua (skipped when the allowance already suffices), `AquaCollateralVault.authorizeRange`, `Aqua.ship` with the vault's ship parameters. | `useWriteContract` chain in the component; `getShipParams(authId)` supplies the ship arguments. |
| `node keeper/roll.mjs` | The keeper that settles, reclaims and re-ships at the new spot at expiry. | Literal pointer. |

Notes. Every estimate here uses the browser's smile constants and the header spot; the premium a buyer actually pays is set on-chain at fill time. The range only earns when someone buys against it; nothing leaves the wallet until then.

<a id="tab-lp-auth"></a>
## Earn · Write a Range

The manual version of the previous tab: choose strikes, collateral and expiry directly. The copilot's range prepare card ("Open in Write a Range → review & sign") prefills this form.

| Element | What it shows | Where it comes from |
|---|---|---|
| **Covered Calls** / **Cash-Secured Puts** | Side; sets the collateral token (WETH or USDC). | Local state. |
| **K_min (USD)**, **K_max (USD)** | The strike band buyers may choose from. Equal values write a single strike. | Inputs. |
| Collateral input, `N WETH` or `N USDC` summary | The most collateral the range may pull in total. Calls: whole WETH units; puts: USDC. | `maxCollateral`, sent as 18- or 6-decimal integers. |
| **Expiry (DTE)** `1 day / 7 days / 30 days` | Days to expiry. | `EXPIRY_PRESETS`. |
| `LP: 0x…` | The connected address that will own the range. | `useAccount()`. |
| Allowance indicator and the approve / authorise / ship progress | Whether the Aqua allowance already covers the collateral, then the same three-step flow as One-Click. | ERC-20 `allowance(lp, Aqua)`; `authorizeRange`; `Aqua.ship`. |
| Green **Range shipped to Aqua** card with `$K₁ – $K₂` | Confirmation. The new range becomes the matrix's active range. | `onAuthorized` callback into `page.tsx`. |

Per chain. Identical on every chain; on Arc the USDC is Circle's native USDC (18-decimal native asset, 6-decimal ERC-20 view), which the app already accounts for.

<a id="tab-spreads"></a>
## Spreads

`SpreadVault`: write a credit spread that escrows only its true maximum loss, and buy one.

| Element | What it shows | Where it comes from |
|---|---|---|
| **Call** / **Put** | Structure type. Call credit spread: short K₁, long K₂ (collateral WETH). Put credit spread: short K₂, long K₁ (collateral USDC). | Local state; strikes reset to spot rounded to $50 and +$200. |
| **K1 (USD, lower)**, **K2 (USD, higher)** | The two strikes. | Inputs. |
| **Capacity (units)** | Units the range may fill. | Input, as WAD. |
| **Expiry** `7 / 30 / 90 days` | Days to expiry. | `EXPIRY_PRESETS`. |
| **Escrow, netted (S12)** `N WETH` or `N USDC` | The collateral the range pulls in total: calls `units × (K₂ − K₁) / K₂` WETH; puts `units × (K₂ − K₁)` USDC, both rounded up. | `escrowFor()` in `SpreadDesk.tsx`, mirroring `SpreadVault.quote()`'s escrow arithmetic. |
| **Main vault, naked short leg** `N WETH` or `N USDC` | What the main vault would lock for the same short leg: 1 WETH per unit, or K₂ USDC per unit. | `units` or `units × K₂`. |
| **Capital efficiency** `N× tighter` | Naked ÷ netted per unit: K₂/(K₂ − K₁) for calls, K₂/(K₂ − K₁) for puts (the example 3000/3200 gives 16×). "K2 must exceed K1" when the strikes are invalid. | Computed in the component. |
| Progress and `Spread #N shipped — E WETH backing it, still in your wallet.` | approve → `SpreadVault.openStructure` → `Aqua.ship`. | `useWriteContract` chain. |
| **Buy the Spread** — **Structure** `#N · call/put credit · $K₁ / $K₂`, **Expires**, **Status** `active`/`closed` | The latest structure on the vault. | `SpreadVault.structures(latest)`. |
| **Units** | How many spread units to buy. | Input. |
| **Net premium (Ask long − Bid short)** `N USDC` | What the buyer pays before fees: the on-chain Ask of the long leg minus the Bid of the short leg, floored at 1 USDC. | `SpreadVault.quote(structureId, units)`, first output, refreshed every 10 seconds. |
| **Protocol fee** `N USDC` | The 1% fee on the net premium. | Second output of `quote`. |
| **You pay** `N USDC` | Premium plus fee. The transaction passes 1% above this as the slippage cap. | Sum; `maxPremium = total × 1.01`. |
| **Writer's escrow pulled on fill** `N WETH` / `N USDC` | The netted escrow for this many units, pulled just in time from the writer's wallet at the fill. | Third output of `quote`. |
| `SpreadToken: 0x…` and `You hold N units` | The ERC-20 minted per structure and your balance. | `SpreadVault.buy` return value; `balanceOf`. |

Per chain. Sepolia and Arc both have a `SpreadVault`; the Arc receipt shows the 0.000625 WETH pull for 0.01 units of a 3000/3200 call credit spread (16× less than the naked 0.01 WETH).

<a id="tab-margin"></a>
## Margin

`MarginVault`: write puts against initial margin instead of the full strike, buy one, and watch the health of the resulting position and of the vault as a whole. Two definitions first. **Initial margin (IM)** is what a writer must lock at the fill: `min(K, intrinsic + IM buffer × mark)` with the buffer at 50%. **Maintenance margin (MM)** is the floor below which the position can be flagged: the same formula with the 30% buffer. The **mark** is the lowest Chainlink answer in the last hour, never the vol surface.

| Element | What it shows | Where it comes from |
|---|---|---|
| **Write Margined Puts** — **Strike min**, **Strike max**, **Margin capacity (USDC)**, **Expiry** `7 / 30 / 90 days` | The range and the total margin it may pull. | Inputs. |
| Credit-line checkbox | Opt in to an Aqua credit line that auto-tops-up margin from free balance before a flag. | `openRange`'s `autoTopUp` flag. |
| `Range #N shipped — C USDC of margin capacity, still in your wallet.` | approve → `MarginVault.openRange` → `Aqua.ship`. | `useWriteContract` chain. |
| **Buy a Put from It** — **Range** `#N · $K₁ – $K₂ · credit line on/no credit line`, **Expires**, **Status** | The latest range. | `MarginVault.ranges(latest)`. |
| **Strike (USD)**, **Units** | The put to buy. | Inputs. |
| **Writer locks (initial margin)** `N USDC` | IM for this strike and size off the live mark. | `MarginVault.initialMargin(rangeId, strike, units)`. |
| **Main vault, cash-secured** ~~`N USDC`~~ | The full strike × units the main vault would lock, struck through. | `strike × units`. |
| **Capital efficiency** `N× tighter` | Full strike ÷ IM. | Ratio. |
| **Premium (Ask)** `N USDC` | The on-chain Ask for the put. | `MarginVault.quote(rangeId, strike, units)`. |
| **Protocol fee (50% insurance · 30% backstop · 20% DAO)** `N USDC` | The fee and its split. | Second output of `quote`. |
| **You pay** `N USDC` | Premium plus fee; 1% slippage headroom in the transaction. | Sum. |
| `Buy N put @ $K` and the two-step progress `Check wallet — approve USDC… / Buying…` | Approve USDC to the vault, then `MarginVault.buy(rangeId, strike, units, maxPremium)`. | `useWriteContract` chain. |
| `OptionToken (shared by every writer of this strike/expiry): 0x…`, `You hold N units` | The per-series token and your balance. | `seriesId(strike, expiry)`, `seriesOf(sid).token`, `balanceOf`. |
| **Margin Health · $K put · date** | The health panel for the range's writer in this series. | `MarginVault.health(sid, lp)`, `positions(sid, lp)`. |
| `mark = lowest Chainlink answer in the last hour · $M over N rounds` | The mark and how many feed rounds the one-hour walk covered. | `MarginVault.markSpot()` every 10 seconds. |
| **Units short**, **Locked** `N USDC`, **Maintenance / Initial** `MM / IM` | The writer's open units, locked margin, and the two thresholds at the live mark. | `positions` and `health`. |
| **State**: `no position`, `at IM` (green), `above MM` (yellow), `below MM`, `flagged`, `in auction` (red) | Locked versus IM and MM, or the position's flag/auction timestamps. | Derived in the component from `positions[3]` (flaggedAt), `positions[4]` (auctionStart) and `health`. |
| **Vault exposure** — **Naked notional**, **Ceiling (min of owner cap, 7× backstop)**, **Buffers IM / MM** `50% / 30%` | Open notional, its ceiling, and the two buffers as percentages of the mark over intrinsic. | `nakedNotional()`, `effectiveCeiling()`, `imBufferBps()`, `mmBufferBps()` (basis points ÷ 100). |
| **Behind the holders** — **Backstop pool**, **Insurance fund** | The two safety funds. | `MarginBackstop.totalAssets()`, `MarginVault.insuranceFund()`. |
| **Funded through Circle App Kits** — three receipts | On Arc: the Wallets-kit deposit into the backstop and the Gateway mint and `fundInsurance` transactions, linking to arcscan. | `DEPLOYMENTS[chainId].demo` entries whose label starts with "Treasury ·". |
| Footer: `./script/margin-lifecycle.sh`, `keeper/margin.mjs` | Liquidation is driven by the script on Anvil and by the keeper on a live chain, not by this page. | Literal. |

Per chain. On Arc the recorded fill locked 1.50 USDC for a 0.001-unit $3,000 put against the $3,000 mock mark (intrinsic 0 + 50% × 3,000 × 0.001). On Sepolia the mark comes from the real Chainlink feed. `MarginVault.buy` reverts when the mark is more than 90 minutes stale, which on Arc happens when nobody has posted a new mock round for a while.

<a id="tab-risk"></a>
## Risk Monitor

Every margined position on this chain with its health against the live mark, the vault's risk dials, and the liquidation timeline rebuilt from `MarginVault` events.

| Element | What it shows | Where it comes from |
|---|---|---|
| **Margin mark** `$M` — `worst of N rounds · T min old` | The mark, the number of feed rounds inspected, and the age of the latest round. | `markSpot()` every 5 seconds. |
| **Naked notional** `N USDC` — `ceiling N USDC` | Open notional and its ceiling. | `nakedNotional()`, `effectiveCeiling()`. |
| **Backstop pool** — `adopts unsold positions` | Pool assets. | `MarginBackstop.totalAssets()`. |
| **Insurance fund** — `after the backstop, before a haircut` | Fund balance. | `insuranceFund()`. |
| **Buffers IM / MM** `50% / 30%` — `of spot, over intrinsic` | The margin buffers. | `imBufferBps()`, `mmBufferBps()`. |
| **Positions** list: `0x… · $K put · date` or `backstop pool · …`, state label, bar, `N units short`, `locked L · MM M · IM I` | One card per (series, writer) that ever held a short here. The bar is the locked margin; the white tick is MM and the faint tick is IM (the bar's full width is 115% of IM). Green when locked ≥ IM, yellow between MM and IM, red below MM. The state reads `healthy`, `above maintenance`, `below maintenance`, `FLAGGED`, `IN AUCTION`, `closed` or `settled · finalized`. | Keys collected from `MarginLocked`, `TakenOver` (the bidder) and `Absorbed` (the pool) events; `positions`, `health`, `seriesOf` reads every 5 seconds. |
| **Liquidation timeline** — `live · N events`, `scanning…`, or an error | The vault's events oldest-first, newest at the top, each with an icon, a plain-language line and the block number. Events covered: OptionBought, MarginLocked, ToppedUp, Flagged, FlagCleared, AuctionStarted, TakenOver, Absorbed, PositionSettled, SeriesFinalized, HolderHaircut, Redeemed. | `getLogs` on `MarginVault` from its deploy block (Sepolia 11,677,124; Arc 61,470,464; Anvil 0), every 5 seconds. This is an RPC log scan, not the subgraph. |
| **Explain with the copilot →** | Sends the last twelve events to the copilot with a request to explain who gained or lost what. | `smile:ask` event; shown only when `NEXT_PUBLIC_COPILOT=1`. |

Per chain. On Anvil, `./script/margin-lifecycle.sh` fills this screen in real time (fill → crash → flag → auction → absorb → settle → finalize → redeem). On Sepolia and Arc only the recorded fill exists, because public chains cannot be time-warped through the grace and auction windows. Arc's RPC caps log ranges; a failure is shown in the caption rather than hidden.

<a id="tab-rfq"></a>
## RFQ

`RfqVault`: an LP ships a range, then signs price quotes off-chain in the wallet; a taker fills one. The formula tier stays the public floor; a signed quote can only improve on it.

| Element | What it shows | Where it comes from |
|---|---|---|
| **Strike min**, **Strike max**, **Capacity (WETH or USDC)**, **Expiry** `7 / 30 / 90 days` | The range to ship. | Inputs; approve → `RfqVault.openRange` → `Aqua.ship`. |
| **Latest range** `#N · calls/puts $K₁–$K₂`, **Status** `active`/`revoked` | The latest range on the vault. | `RfqVault.ranges(latest)` every 10 seconds. |
| **Strike**, **Max size (units)**, **Inside the formula (bps)**, **Valid for (min)** | The quote you are about to sign: strike, maximum fill size, how far below the formula Ask to price (basis points), time to live in minutes (default 10). | Inputs; the copilot's RFQ prepare card prefills them. |
| **Tier-1 formula Ask** ~~`N USDC`~~ | The formula price for that strike and size, struck through. | `RfqVault.formulaQuote(rangeId, strike, size)`. |
| **Your quote** `N USDC` | Formula Ask reduced by the improvement. | `formula × (1 − bps/10000)`. |
| **Per unit** `N USDC` | Your quote divided by the size: the `premiumPerUnit` field of the signed message. | Computed. |
| **Sign Quote** and the JSON that appears | An EIP-712 signature over `Quote(authId, strike, maxAmount, premiumPerUnit, ttl, nonce)` under the domain "Smile RFQ", produced by the wallet with no transaction. The nonce is the current timestamp in milliseconds. "Hand this to a taker (or switch accounts and fill it on the right)." | `useSignTypedData`. |
| **Fill a quote** — paste box, **Quote** `range #N · $K · up to N units`, **Signed by** `0x…`, **Status** `valid until HH:MM` / `expired` / `used / cancelled` | The pasted quote decoded, the recovered signer, and whether its nonce is still unused and its TTL unexpired. | `RfqVault.nonceUsed(lp, nonce)` every 5 seconds; TTL compared with the clock. |
| **Units to fill** | How many units to take, up to the quote's maximum. | Input. |
| **Tier-1 formula, incl. fee** ~~`N USDC`~~ | What the same fill would cost on the formula tier. | `formulaQuote` for the fill size plus the fee. |
| **This quote, incl. fee** `N USDC` | What this fill costs. | `RfqVault.fillCost(quote, units)`. |
| **Price improvement** `N USDC (B bps)` | Formula cost minus quote cost, and as basis points of the formula cost. | Difference. |
| Approve and **Fill** progress | Approve USDC for the total, then `RfqVault.fill(quote, signature, units, maxCost)`, which recovers the signer, checks ttl, size and nonce, and pulls the collateral just in time through Aqua. | `useWriteContract` chain. |

Per chain. `RfqVault` is deployed on Arc (recorded fill: 0.688860 USDC versus a 0.695819 formula Ask) and on Anvil; the Sepolia address map leaves it empty, so the tab reports the vault as unset there.

<a id="tab-lp-position"></a>
## My Positions

The LP dashboard: the connected wallet's own most recent active range on the main vault and the collateral state behind it.

| Element | What it shows | Where it comes from |
|---|---|---|
| **Wallet ETH** `N ETH` — `Self-custodied — earning until called` | The wallet's native balance, four decimals. On Arc this is USDC. | `useBalance`. |
| **Locked Collateral** `N ETH` or `N USDC` — `Pulled JIT by Aqua on match — none locked yet` / `· released on close` | Collateral consumed by fills on your range. | `AquaCollateralVault.authorizations(myAuth).usedCollateral`, every 6 seconds. |
| **Active Authorization** — **Strike Range** `$K₁ – $K₂`, **Max Collateral**, **Expires** (date and days left), used/max progress bar | Your latest active range. | On Sepolia and Arc: the subgraph query `authorizations(where: {lp, active: true})`; on Anvil: `getLogs` on `RangeAuthorized` filtered by the `lp` topic. Distinct from the market-wide range the Trade tab uses. |
| **Total Value Backing Quotes** `N ETH` — `Available to back new options` | The wallet balance again, framed as the capital that can back new ranges. | `useBalance`. |
| **Active Positions** e.g. `2` — `Instruments you wrote with open interest` | A count of the (strike, expiry) instruments this wallet has written that still have open interest. Shows `—` while the tape is loading and falls back to `≥1` only if the tape is unavailable. | `readTape()` instruments filtered by `lp` and `openInterest > 0` (subgraph on Sepolia/Arc, event log on Anvil). |

Per chain. On a public chain without a subgraph this tab shows no range; there is no RPC fallback there by design (limitations L12a).

<a id="tab-surface"></a>
## Vol Surface

A three-dimensional rendering of the implied-volatility surface, produced by the Python service in `volsurface/` and updated as trades execute.

| Element | What it shows | Where it comes from |
|---|---|---|
| Formula caption `σ(K,T) = σ_tenor(T) · max(0.1, 1 + α·ln(K/S)² + β·ln(K/S))` | The multiparameter smile: a per-tenor level, a curvature α and a skew β. | Literal; α = 2.0 and β = 0 are passed to the renderer. |
| The surface image | Volatility (height) over strike and tenor at the current spot; rotated by the **rotate** slider (azimuth −120 to 30). | `GET /surface.png?spot=…&alpha=…&beta=…&azim=…` from `NEXT_PUBLIC_VOLSURFACE_URL` (default `http://localhost:8000`); re-rendered 400 ms after the spot changes. |
| `σ tenor: 0–7d N% · 7–30d N% · 30–90d N% · 90d+ N%` | The per-tenor sigma levels the service currently holds. | `GET /state`. |
| `γ=N%/trade` | The bump applied to the traded tenor bucket per trade: up on a buy, down on a sellback. | `GET /state`. |
| `N trades` | How many trades the service has absorbed since the last reset. | `GET /state`. |
| **Reset σ** | Resets the service's sigma buckets to their initial level. | `POST /reset`. |
| **Vol-surface renderer offline** with `./volsurface/run.sh` | The service is not running. | Image load error. |

Notes. The service mirrors the feedback loop of the on-chain `OptionPricingHook` (each confirmed buy or sell on the Trade tab is posted to `/trade` with the leg's tenor); it does not read the hook's state. It runs only where the Python service runs, normally `./local.sh`; the static GitHub Pages build and the Vercel deployment show the offline card.

<a id="tab-proof"></a>
## Receipts

The recorded on-chain proof for the connected chain: demo transactions, contract addresses and the subgraph endpoint.

| Element | What it shows | Where it comes from |
|---|---|---|
| **On-Chain Proof · <chain>** with the real-money caption | One card per known deployment: only the connected chain when it is a known deployment, all known deployments otherwise (for example on Anvil). | `DEPLOYMENTS` in `lib/deployments.ts`. |
| Transaction rows: `0x… ↗`, label, note | Each recorded demo transaction, linked to the explorer. | `.demo`. |
| Contract rows: label and full address | Every deployed contract, linked to the explorer's address page. | `.contracts`. |
| `The Graph: <url>` | The Studio query endpoint for the chain's subgraph. | `.subgraph`. |
| `You are on a local chain (no public explorer)…` | Shown on Anvil. | No matching deployment. |
| **This session's last premium swap** `0x… ↗` | The hash of the Uniswap swap executed in step 1 of the buy panel during this session, when one happened. | `onSwapTx` from the Trade tab. |

Per chain. Sepolia's card lists the range, ship and buy receipts; Arc's lists fills on all four vaults plus the three Circle App Kits treasury transactions.

<a id="tab-copilot"></a>
## Copilot panel

The floating **Copilot** button opens the AI panel on every tab. It is served by `/api/copilot` (a server route, present on the Vercel deployment and on `./local.sh`, absent on the static GitHub Pages build) and reads the same tape, chain and documentation the app does. Its full tool list and configuration are described on the Sponsors · The Graph page.

| Element | What it shows | Where it comes from |
|---|---|---|
| Starter prompts | Three prompts for the current tab plus one general one, shown while the conversation is empty. | `lib/copilot/tabs.ts`, keyed by the active tab id. |
| **Skills** | The built-in trader procedures and any you add; a starter from a skill sends it as a message. | `frontend/skills/*.md`; user skills in browser storage. |
| ⚙ settings | Bring your own model API key and add MCP servers (The Graph Subgraph MCP is a preset). Sent per request in headers; never stored server-side. | `CopilotSettings.tsx`. |
| Proposal card: table `side · type · strike · amount · DTE · premium`, mini payoff chart, `debit/credit`, `max profit`, `max loss`, `prob. profit`, **Load into Payoff Builder →** | A strategy the copilot proposes, priced with the same `protocolPremium` and `strategyStats` as the builder. Loading it switches to the Trade tab with the legs in the builder. | `StrategyCard.tsx`. |
| Smile chart | The smile σ against strike with the ATM point and the 25-delta put and call strikes marked. | `ChatSmileChart.tsx`, `smileSigma`, `surfaceQuotes`. |
| Range card: rows `strikes $K₁ – $K₂`, `expiry N days`, `capacity N WETH/USDC`, `expected premium / unit $N`, rationale, button **Open in Write a Range → review & sign** | A range the copilot prepared from the liquidity map; the button prefills Earn · Write a Range and switches to it. | `PrepareCard.tsx`, `prepare_lp_range` tool. |
| Quote card: rows `strike $K call/put`, `max size N units`, `premium / unit $N (formula ask $M)`, `valid for N min`, button **Open in RFQ desk → sign in wallet** | A quote the copilot prepared; the button prefills the RFQ form. The user signs in the wallet; the copilot never holds a key. | `PrepareCard.tsx`, `prepare_rfq_quote` tool. |
| Quiz card | A multiple-choice question with the answer explained after you pick. | `QuizCard.tsx`, `quiz_question` tool. |
| Source citations in answers ("The Graph", "Deribit", document names) | Where a number in the answer came from: the subgraph tape, the Deribit reference market, or the documentation pack. | The tools' return values. |

Notes. Any number the copilot quotes about positions, open interest, liquidity or last trades on a public chain comes from the subgraph; screener prices are computed from the hook's live sigma per expiry with the same smile model as the app, and the copilot states that caveat itself.
