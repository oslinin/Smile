# Uniswap in Smile

## Summary

Smile uses Uniswap in two roles. On-chain, a **Uniswap v4 hook** named
`OptionPricingHook` holds the protocol's implied-volatility surface: the
volatility number that every option premium is computed from lives in the
hook, is read live by the pricing path at the moment of each trade, and is
moved up or down by order flow. Off-chain, the **Uniswap Trading API** gives
the application its live ETH/USD spot price and builds the buyer's ETH-to-USDC
premium swap through the Universal Router, so a buyer holding only ETH can pay
a USDC premium in one flow.

All Uniswap code in the repository predates EthOnline 2026. The hook was
scaffolded on 2026-06-14, the Trading API integration landed the same day, and
the multiparameter surface (per-tenor buckets and skew) landed on 2026-07-07;
the pre-event baseline commit is dated 2026-09-05. No new Uniswap code was
written at the event. What the event added is *consumers* of the surface: the
three new vaults (`SpreadVault`, `MarginVault`, `RfqVault`) read the hook's
sigma through the shared `SmilePremiumLib`, and the AI copilot's
`find_opportunities` tool reads the hook's live sigma per expiry so that its
screening prices agree with what the chain would charge.

Terms used below are defined at first use and collected in the glossary at
the end.

## Features used

| Feature | Where in the code | Pre-existing or EthOnline 2026 |
|---|---|---|
| Uniswap v4 hook implementing `IHooks`; `beforeSwap` vetoes mispriced secondary-market swaps, `afterSwap` shifts the whole surface | `src/hooks/OptionPricingHook.sol` | pre-existing (2026-06-14, surface 2026-07-07) |
| Per-tenor sigma buckets and `sigmaFor(timeToExpiry)`, the live sigma source for every quote | `OptionPricingHook.sigmaBuckets`, `sigmaFor`, `_bucketOf` | pre-existing |
| Smile multiplier with curvature alpha and skew beta | `src/swapvm/SmileMath.sol` `smileVol`; `hook.beta`, `setBeta` | pre-existing |
| Demand feedback: `bumpSigma` on every `buy()` and `close()`, gamma = 0.5 vol points | `OptionPricingHook.bumpSigma`, `AquaCollateralVault.sol:553` and `:829` | pre-existing |
| Sigma snapshot into each maker strategy at authorization time | `AquaCollateralVault.sol:299` (`auth.sigmaSource = address(hook)`) | pre-existing |
| SwapVM instruction reads the hook inside the same swap that buys or sells | `src/swapvm/OptionPremiumInstruction.sol:163` | pre-existing |
| Hook-to-vault wiring at deploy time | `script/Deploy.s.sol:239-240` | pre-existing |
| Live ETH/USD spot from the Uniswap Trading API, with Chainlink and static fallbacks | `frontend/hooks/useUniswapSpot.ts` | pre-existing |
| Buyer's ETH-to-USDC premium swap built by the Trading API and sent to the Universal Router | `frontend/hooks/useUniswapTrade.ts`, `frontend/components/OptionMatrix.tsx:562` | pre-existing |
| Trader-native reading of the surface: ATM vol, 25-delta risk reversal, 25-delta butterfly | `frontend/lib/options.ts` `surfaceQuotes` | pre-existing |
| Vol Surface tab: a rendered 3-D surface that applies the same bump per trade | `frontend/components/VolSurface.tsx`, `volsurface/server.py` | pre-existing |
| Sibling vaults quote off the same hook through the shared library | `src/periphery/SmilePremiumLib.sol` (`ISigmaSource.sigmaFor`) | EthOnline 2026 |
| Copilot screener prices off the hook's live sigma per expiry | `frontend/lib/copilot/graphTools.ts` `liveSigmaByExpiry` | EthOnline 2026 |
| Thirteen hook tests (tolerance veto, bump direction, bucket selection, skew, access control) | `test/OptionPricingHook.t.sol` | pre-existing |

## Why it is necessary

An options market needs two things a spot exchange does not: a price for
*volatility*, and a venue in which to hedge.

**A price for volatility.** An option premium is mostly a bet on how much the
underlying will move. The number that encodes that bet is the *implied
volatility* (sigma), an annualised standard deviation of returns expressed as a
percentage. A venue that fixes sigma by fiat cannot respond to demand: if
everyone buys calls, the premium should rise, as it would on any exchange
where a market maker widens and lifts quotes under one-sided flow. Smile
therefore stores sigma on-chain and lets trades move it. The hook is the
natural home for that state because Uniswap v4 hooks are contracts that the
pool manager calls at fixed points in a swap's lifecycle, so the same contract
can both observe secondary-market flow (`afterSwap`) and serve the primary
market's pricing path (`sigmaFor`).

**A venue to hedge in.** Traditional options markets function because
broker-dealers *delta-hedge*: they offset the directional exposure of the
options they have written by trading the underlying. Without a liquid spot
venue, a market maker cannot lay off risk, and quotes stay wide or absent.
Uniswap is that venue for Smile. The README states the aim directly: the
trading and settlement functionality provided by Uniswap and Chainlink should
let capable liquidity providers and arbitrageurs continuously arbitrage away
mispricings between options and the underlying.

**Why the lookup is on-chain and stepwise.** Smile chose an on-chain step
lookup over an off-chain quoting service. `sigmaFor` is read atomically inside
the same transaction that buys or sells, so the price a trader receives is
exactly what the bucket held at that block; there is no off-chain quote to go
stale or be front-run, and no quoting service that must stay online. The cost
is that sigma is a step function of time to expiry with edges at 7, 30 and 90
days. The README's design note records the alternative (an RFQ-style signed
quote, verified on-chain much as a CRE report is) and the reason it was
deferred: blending feedback across neighbouring buckets would let a trade at a
bucket edge nudge a bucket nothing traded in.

## Market value add

**Price impact for volatility.** On a spot exchange, a large buy walks the
book and the next buyer pays more. Smile's feedback loop gives options the
same property: each buy raises the traded tenor's sigma by gamma, each
sellback lowers it, so persistent one-sided demand steepens the surface and
raises premiums. Higher premiums attract sellers and arbitrageurs, whose
sellbacks bring sigma back down. This is the mechanism by which a market with
no designated market maker can still discover a volatility level.

**Emergent market makers.** The README's glossary defines an emergent market
maker as an arbitrageur who buys underpriced options at the Ask, delta-hedges
on Uniswap, and sells back at the Bid when sigma corrects, capturing the
spread while enforcing consistency between implied volatility and the spot
market. Uniswap is the leg of that trade that makes it possible.

**A familiar dictionary.** The surface's three parameters, tenor sigma, alpha
and beta, map exactly onto the *level / skew / curvature* decomposition that
options desks quote to each other: ATM volatility, the 25-delta risk reversal
and the 25-delta butterfly. The application computes these three numbers
from the actual smile at the actual 25-delta strikes and shows them in the
One-Click Income panel with plain-language captions. A Deribit market maker
can therefore read Smile's surface risk in the units they already manage.

**One-asset checkout.** Because the Trading API builds the ETH-to-USDC swap
for the exact premium amount (an `EXACT_OUTPUT` quote), a buyer who holds
only ETH sees a single flow: swap, approve, buy. The premium is a USDC amount
throughout the protocol; the swap is the on-ramp.

## Technical details

### The surface: tenor buckets and `sigmaFor`

Sigma is stored per *tenor bucket*, that is, per band of time to expiry. Four
bands cover the term structure, and `sigmaFor` returns the band a given expiry
falls into. Values are in WAD, the fixed-point convention in which `1e18`
represents 1.0, so `0.8e18` is 80% annualised volatility.

`src/hooks/OptionPricingHook.sol`

```solidity
/// @dev Tenor cutoffs for the σ term structure.
uint256 public constant TENOR_1 = 7 days;
uint256 public constant TENOR_2 = 30 days;
uint256 public constant TENOR_3 = 90 days;

/// @dev σ per tenor bucket in WAD, adjusted by demand feedback.
uint256[4] public sigmaBuckets;

/// @dev Signed skew β in WAD (0 = symmetric smile; negative = downside skew).
int256 public beta;

/// @dev Demand feedback step: γ = 0.5% per trade (in WAD).
uint256 public constant GAMMA = 0.005e18;

/// @notice σ for a given time-to-expiry — the tenor dimension of the surface.
/// This is the live σ source the SwapVM option-premium instruction queries.
function sigmaFor(uint256 timeToExpiry) public view returns (uint256) {
    return sigmaBuckets[_bucketOf(timeToExpiry)];
}

function _bucketOf(uint256 timeToExpiry) internal pure returns (uint256) {
    if (timeToExpiry < TENOR_1) return 0;
    if (timeToExpiry < TENOR_2) return 1;
    if (timeToExpiry < TENOR_3) return 2;
    return 3;
}
```

### The smile: alpha and beta

The tenor sigma is the volatility *at the money*, that is, for a strike equal
to spot. Strikes away from spot are priced with a multiplier in log-moneyness
`ln(K/S)`. Alpha sets the curvature (how much more the wings cost than the
centre) and beta sets the skew (which side costs more). The multiplier is
floored at 0.1 so that deep wings can never drive sigma to zero. In plain
text the formula is
`sigma_strike = sigma_tenor * max(0.1, 1 + alpha * ln(K/S)^2 + beta * ln(K/S))`.

`src/swapvm/SmileMath.sol`

```solidity
/// @notice σ_strike = σ · (1 + α · ln(K/S)² + β · ln(K/S))  — smile + skew.
/// β < 0 tilts the surface so low strikes (downside) price richer, matching
/// the empirical equity/crypto skew; β = 0 recovers the symmetric smile.
/// The multiplier is floored at 0.1 so deep wings can never zero out σ.
function smileVol(
    uint256 spot,
    uint256 strike,
    uint256 sigma,
    uint256 alpha,
    int256 beta
) internal pure returns (uint256) {
    if (spot == 0) return sigma;
    // ln(K/S) in WAD
    int256 lnKS = lnWad(int256((strike * WAD) / spot));
    // lnKS² in WAD
    uint256 lnKS2 = uint256((lnKS * lnKS) / int256(WAD));
    // multiplier = 1 + α·lnKS² + β·lnKS  (in WAD, signed while skew applies)
    int256 multiplier = int256(WAD + (alpha * lnKS2) / WAD) + (beta * lnKS) / int256(WAD);
    int256 floorMultiplier = int256(WAD / 10);
    if (multiplier < floorMultiplier) multiplier = floorMultiplier;
    return (sigma * uint256(multiplier)) / WAD;
}
```

The defaults are alpha = 2.0 and beta = 0 (`SmilePremiumLib.ALPHA = 2e18`,
`frontend/lib/options.ts` `ALPHA = 2.0`, `BETA = 0.0`). Beta is set by the
hook's deployer through `setBeta`; a negative value makes puts richer than
calls at equal distance from spot, which matches observed equity and crypto
markets.

### The feedback loop: `bumpSigma` and `afterSwap`

The primary market (the vault's own `buy()` and `close()`) knows which expiry
traded, so it bumps only that tenor's bucket. A secondary-market swap through
the Uniswap v4 pool carries no expiry, so `afterSwap` treats it as a
surface-wide demand shift and bumps every bucket.

`src/hooks/OptionPricingHook.sol`

```solidity
/// @notice Tenor-aware demand feedback: bump only the bucket that traded.
function bumpSigma(bool isBuy, uint256 timeToExpiry) external {
    require(msg.sender == vault, "only vault");
    _bump(_bucketOf(timeToExpiry), isBuy);
}

function _bump(uint256 bucket, bool isBuy) internal {
    if (isBuy) {
        sigmaBuckets[bucket] += GAMMA;
    } else {
        sigmaBuckets[bucket] = sigmaBuckets[bucket] > GAMMA ? sigmaBuckets[bucket] - GAMMA : 0;
    }
}

/// @notice Bump σ_global up on buy, down on sell — demand-driven IV feedback.
function afterSwap(
    address,
    PoolKey calldata,
    SwapParams calldata params,
    BalanceDelta,
    bytes calldata
) external returns (bytes4, int128) {
    require(msg.sender == poolManager, "only pool manager");
    bool isBuy = params.amountSpecified < 0;
    // Pool swaps carry no tenor info — treat as a surface-wide demand shift.
    for (uint256 i = 0; i < 4; i++) _bump(i, isBuy);
    return (IHooks.afterSwap.selector, 0);
}
```

The vault calls the hook after a fill and after a sellback:

`src/vaults/AquaCollateralVault.sol`

```solidity
optionToken = _mintSeries(authId, auth, strike, amount, collateralNeeded, buyer);

if (address(hook) != address(0)) hook.bumpSigma(true, auth.expiry - block.timestamp);
```

```solidity
if (address(hook) != address(0)) {
    hook.bumpSigma(false, auth.expiry > block.timestamp ? auth.expiry - block.timestamp : 0);
}
```

### The veto: `beforeSwap`

On the secondary market, the hook computes a fair value from the pricing
engine and rejects any swap whose execution price is more than 5% away from
it. Hook data carries the option's spot, strike, expiry and alpha.

`src/hooks/OptionPricingHook.sol`

```solidity
/// @dev Oracle price tolerance: 5% band around the engine's fair value.
uint256 public constant PRICE_TOLERANCE = 0.05e18;

uint256 fairValue = pricingEngine.quote(p);
uint256 executionPrice = _abs(params.amountSpecified);

uint256 diff = executionPrice > fairValue
    ? executionPrice - fairValue
    : fairValue - executionPrice;

require(diff * WAD / fairValue <= PRICE_TOLERANCE, "price outside oracle bounds");
```

### How a quote reaches the hook

When a liquidity provider authorises a range, the vault records the hook's
address as the strategy's sigma source, and the SwapVM instruction reads that
source inside the swap. This is the atomic read described above: the
premium is computed from the bucket's value at the block of the trade.

`src/vaults/AquaCollateralVault.sol`

```solidity
auth.sigmaSource = address(hook);
auth.premiumDecimals = IERC20Metadata(premiumToken).decimals();
auth.beta = address(hook) != address(0) ? hook.beta() : int256(0);
```

`src/swapvm/OptionPremiumInstruction.sol`

```solidity
// Live vol surface: σ per tenor from the sigma source, skewed per strike.
uint256 sigmaTenor = terms.sigmaSource != address(0)
    ? ISigmaSource(terms.sigmaSource).sigmaFor(v.timeToExpiry)
    : DEFAULT_SIGMA;
```

The vaults built at EthOnline 2026 take the same path through the shared
library, so a spread, a margined put and an RFQ floor all quote off the
identical surface:

`src/periphery/SmilePremiumLib.sol`

```solidity
uint256 sigma = t.sigmaSource != address(0)
    ? ISigmaSource(t.sigmaSource).sigmaFor(timeToExpiry)
    : DEFAULT_SIGMA;
if (t.sigmaMulBps != 0) sigma = (sigma * t.sigmaMulBps) / 1e4; // S5
if (sigma < MIN_QUOTE_SIGMA) sigma = MIN_QUOTE_SIGMA;

uint256 sigmaStrike = SmileMath.smileVol(t.spotWad, t.strike, sigma, ALPHA, t.beta);
```

`MarginVault` is the deliberate exception: it prices premiums off the hook
but computes *margin* from the Chainlink oracle only, never from `sigmaFor`,
so that trading cannot move margin requirements.

### Live spot from the Trading API

The application's spot price comes from a Uniswap Trading API quote for one
WETH into USDC on mainnet, refreshed every 60 seconds, with a Chainlink
on-chain read as the second source and a static value as the last resort.

`frontend/hooks/useUniswapSpot.ts`

```typescript
async function fetchUniswap(apiKey: string): Promise<number> {
  const res = await globalThis.fetch(
    "https://trade-api.gateway.uniswap.org/v1/quote",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        type: "EXACT_INPUT",
        tokenInChainId: 1,
        tokenOutChainId: 1,
        tokenIn: WETH_MAINNET,
        tokenOut: USDC_MAINNET,
        amount: "1000000000000000000",
        swapper: "0x0000000000000000000000000000000000000000",
      }),
    }
  );
  if (!res.ok) throw new Error(`Uniswap API ${res.status}`);
  const data = await res.json();
  // Trading API v1: output amount is under data.quote.output.amount; older API: data.quote (string)
  const rawAmount = data.quote?.output?.amount ?? data.quote;
  const price = Number(rawAmount) / 1e6;
  if (!price || price < 100) throw new Error("bad quote");
  return Math.round(price);
}
```

### Premium routing through the Universal Router

The buy flow asks the Trading API for an `EXACT_OUTPUT` quote (native ETH in,
exactly the premium in USDC out) and then for the calldata, which the wallet
sends to the Universal Router before the approve and `buy()` steps.

`frontend/hooks/useUniswapTrade.ts`

```typescript
// Ask the Trading API for an EXACT_OUTPUT quote, then fetch calldata via /v1/swap.
// The Trading API v1 separates quoting (CLASSIC routing) from transaction building.
export async function fetchUniswapSwapQuote(
  usdcAmountOut: bigint,
  swapper: `0x${string}`,
  usdcToken: string,
  apiKey: string,
): Promise<UniswapSwapQuote> {
```

### The trader's dictionary

The frontend evaluates the smile at the two strikes that have roughly 25%
probability of finishing in the money, one call and one put, and reports the
three desk numbers.

`frontend/lib/options.ts`

```typescript
export function surfaceQuotes(spot: number, tYears: number): SurfaceQuotes {
  const atmVol = smileSigma(spot, spot);
  const k25call = strikeForDelta(spot, 0.25, true, tYears);
  const k25put = strikeForDelta(spot, 0.25, false, tYears);
  const volC = smileSigma(spot, k25call);
  const volP = smileSigma(spot, k25put);
  return {
    atmVol,
    expectedMovePct: atmVol * Math.sqrt(Math.max(tYears, 0)),
    rr25: volC - volP,
    bf25: (volC + volP) / 2 - atmVol,
    k25call,
    k25put,
  };
}
```

### The Vol Surface tab

The **Vol Surface** tab renders a 3-D surface of `sigma_strike(K, T)` from a
small Python service in `volsurface/`. Every confirmed buy or sell is posted
to the service, which bumps the traded tenor bucket by the same gamma the
hook applies (`GAMMA = 0.005` in `volsurface/server.py`), so the surface
visibly re-rates as order flow arrives. The 7, 30 and 90 day bucket edges
appear as terraces on the plot.

### Deployment and tests

`script/Deploy.s.sol` deploys the hook with the pricing engine and an initial
sigma, then wires it before any range is authorised so that every strategy
snapshots it as its sigma source (`vault.setHook(address(hook))`,
`hook.setVault(address(vault))`). On Anvil and the testnets the pool manager
argument is a placeholder because no live Uniswap v4 pool is deployed there;
the hook's `beforeSwap` and `afterSwap` paths are exercised in
`test/OptionPricingHook.t.sol`, whose thirteen tests cover the 5% tolerance
veto in both directions, the bump direction on buy and sell, per-bucket
selection, the surface-wide bump from `afterSwap`, the `sigmaGlobal`
back-compat view, `setBeta` access control, and downside skew under a
negative beta. A real v4 hook address must encode the before-swap and
after-swap flags in its low byte (`address & 0xFF == 0xC0`), which the
contract's header comment records for a mined deployment.

## Limitations

The numbered items refer to `docs/limitations.md`.

- **L3, repricing lands after the trade.** The bump is applied after the
  fill, so a trader always executes at the pre-bump price. A market maker who
  repriced only after each fill would be run over; on-chain, a sniper pays no
  price impact on the trade where it matters.
- **L6, parameter risk for passive LPs.** An LP delegates pricing to the
  surface's sigma buckets, alpha and beta. If governance moves alpha or beta,
  or the feedback loop walks a bucket away from fair, every open quote in
  every affected range marks against the LP with no action on their part.
  These exposures are the desk's butterfly and risk-reversal sensitivities,
  but there is no dashboard surfacing them yet.
- **L7, the feedback loop is nudgeable.** Trades move sigma and trades can be
  manufactured: an attacker can sell back to walk sigma down before buying
  size. Each round trip pays the full spread and the 1% fee on re-entry, and
  gamma is small, so the attack is a bounded nuisance rather than a free
  lunch, but the loop is not manipulation-proof. `SmilePremiumLib` adds a
  `MIN_QUOTE_SIGMA` floor of 20% so a two-leg spread quote cannot collapse to
  zero on the way down.
- **L1 and L2, the oracle latency gap.** The surface prices off the last
  Chainlink round, so between heartbeats the quote is stale relative to
  the live market (L1) and drift smaller than the feed's deviation
  threshold leaves no on-chain signal at all (L2). A sniper who watches the
  live market buys the stale quote before the feed catches up; the hook's
  bump arrives after that trade (L3). The Pyth adapter (R5) narrows the
  window for quoting; it does not close it.
- **L4, one transaction can drain a whole range.** The main vault bounds
  this with a per-authorization block cap (R1, `maxBlockNotional`); the
  sibling vaults built at EthOnline 2026 have no such cap, so on them a
  single fill can consume an authorization's entire remaining collateral at
  one stale price, and the sigma bump fires only afterwards. The loss per
  staleness event is then bounded by the range's `maxCollateral`.
- **L5, on-chain rules cannot reject informed traders.** Every rule the hook
  or the vault could apply is public, so a sniper simulates it and submits
  only trades that pass. Rules can filter mechanically definable patterns
  (staleness, size, rate) but never informedness, which is not observable on
  chain. Rejection is therefore the wrong frame and pricing is the right
  one: the recommendations R1 through R4 make toxic flow pay for its toxicity
  through the spread rather than trying to identify it. Part 1 of
  `docs/limitations.md` explains adverse selection from zero for readers new
  to the term.
- **Bucket-edge discontinuities.** Sigma is a step function of time to
  expiry. Two expiries one day apart on either side of the 30-day edge can
  price off different buckets, and a trade can only move the bucket it landed
  in.
- **Secondary market not deployed (L14).** The v4 pool for OptionTokens is
  designed and tested but no live pool exists on Anvil, Sepolia or Arc; the
  pool manager is a placeholder in the deploy script. `afterSwap` is
  exercised in tests, not on a public network.
- **Spot source is mainnet.** The Trading API quote is for mainnet
  WETH/USDC regardless of the connected chain, and the premium swap targets
  mainnet as well; on testnets the Chainlink fallback supplies the displayed
  spot.

## Plans

The numbered items refer to `docs/solutions.md`.

- **S5, per-range LP-quoted vol.** The instruction and the library already
  apply an LP-chosen `sigmaMulBps` multiplier on top of the hook's tenor
  sigma. The protocol surface becomes the default for passive LPs; opinionated
  LPs quote their own volatility, which is how professional options markets
  quote.
- **S6, best-quote routing.** A router view that scans active ranges covering
  a strike and returns the best executable Ask or Bid. With S5, overlapping
  ranges with different sigma opinions form an order book in volatility
  space, and the touch is the discovered market volatility.
- **S7, an optional external IV anchor.** If range competition stays thin,
  anchor the default buckets to an external reference such as Deribit ATM
  volatility, with the feedback loop reduced to a bounded deviation around
  the anchor. This adds an oracle dependency and is gated on evidence that the
  default surface drifts.
- **Smooth interpolation.** The README's design note leaves smooth
  interpolation across tenors to a future RFQ-style quoting layer. `RfqVault`,
  built at EthOnline 2026, is the first piece of that layer: an LP may sign a
  quote from any model, and the formula surface remains the public floor.
- **Live v4 pool.** Deploying the OptionToken pool with a mined hook address
  would put `beforeSwap` and `afterSwap` on a public network.

## Glossary

- **Uniswap v4 hook.** A contract that the Uniswap v4 pool manager calls at
  fixed points in a pool's lifecycle. A hook's address encodes which
  callbacks it implements. `OptionPricingHook` implements `beforeSwap` and
  `afterSwap`.
- **PoolManager.** The single Uniswap v4 contract that holds every pool's
  state and invokes hooks. Only it may call `afterSwap` on Smile's hook.
- **beforeSwap / afterSwap.** The hook callbacks invoked immediately before
  and after a swap executes. Smile uses the first to veto and the second to
  reprice.
- **Universal Router.** Uniswap's router contract that executes the swap
  calldata the Trading API returns.
- **Uniswap Trading API.** Uniswap's hosted quoting and transaction-building
  service. Smile uses its `/v1/quote` endpoint for spot and its swap
  endpoint for the premium swap.
- **Implied volatility (sigma).** The annualised standard deviation of
  returns that an option premium implies. Expressed as a percentage; 80%
  means the market prices one-standard-deviation moves of 80% per year.
- **Vol surface.** Implied volatility as a function of strike and time to
  expiry. Smile's is `sigma_strike(K, T)`.
- **Tenor bucket.** A band of time to expiry that shares one sigma. Smile
  has four: under 7 days, 7 to 30, 30 to 90, and 90 days or more.
- **Term structure.** How implied volatility varies with time to expiry;
  the tenor dimension of the surface.
- **Smile.** The shape of implied volatility across strikes at one expiry.
  It is called a smile because wings usually price above the centre.
- **Curvature (alpha).** How much more the wings cost than the centre; the
  coefficient on `ln(K/S)^2`.
- **Skew (beta).** Which side costs more; the signed coefficient on
  `ln(K/S)`. Negative beta makes downside strikes richer.
- **Log-moneyness.** `ln(K/S)`, the natural logarithm of strike over spot.
  Zero at the money, negative for strikes below spot.
- **ATM (at the money).** A strike equal to the current spot price. ATM
  volatility is the tenor sigma itself.
- **OTM / ITM.** Out of the money and in the money: a call is ITM when spot is
  above the strike; a put is ITM when spot is below it.
- **Delta.** The sensitivity of an option's value to the spot price, between
  0 and 1 for calls. Approximately the probability of finishing in the money.
- **25-delta.** The reference strikes, one call and one put, whose delta is
  0.25; roughly 25% probability of finishing in the money. The near-universal
  points at which desks measure the wings.
- **Risk reversal (RR).** 25-delta call volatility minus 25-delta put
  volatility. Its sign says which direction costs more.
- **Butterfly (BF).** The average of the two 25-delta wing volatilities minus
  ATM volatility. The market's charge for fat tails.
- **Expected move.** ATM volatility times the square root of time to expiry,
  as a fraction of spot: the size of move the premium is charging for.
- **Gamma (feedback step).** In this document, the per-trade sigma step of
  0.5 volatility points (`GAMMA = 0.005e18`). Not the option Greek of the
  same name.
- **Demand feedback loop.** The rule that every buy raises the traded
  tenor's sigma by gamma and every sellback lowers it.
- **Delta hedging.** Offsetting the directional exposure of an options
  position by trading the underlying. On Smile, the underlying leg trades on
  Uniswap.
- **Arbitrage.** Buying and selling equivalent exposure in two places to
  capture a price difference. An arbitrageur who buys underpriced options and
  hedges on Uniswap is the mechanism that corrects Smile's sigma.
- **Emergent market maker.** An arbitrageur who, by repeatedly buying cheap
  options and selling back rich ones while hedging on Uniswap, performs the
  role of a designated market maker without being appointed.
- **Ask / Bid.** The price a taker pays to open a position and the price a
  holder receives to sell it back. The premium instruction prices the Ask in
  the forward swap direction and the Bid in the reverse direction.
- **Primary market.** Trades against the vault (`buy()` and `close()`), which
  mint or burn OptionTokens.
- **Secondary market.** Transfers of existing OptionTokens between holders,
  designed to run through a Uniswap v4 pool with the hook attached.
- **WAD.** Fixed-point notation in which `1e18` represents 1.0. All sigma
  values in the contracts are WAD.
- **SwapVM instruction.** A custom opcode executed inside the 1inch SwapVM.
  `OptionPremiumInstruction` is Smile's; it reads `sigmaFor` at execution.
- **Strategy / authorization.** A liquidity provider's signed range of
  strikes and expiries. At authorization the hook's address is stored as the
  strategy's sigma source.
- **RFQ (request for quote).** A model in which a maker signs a price
  off-chain for a specific taker to fill. `RfqVault` implements it as a tier
  above the formula surface.
