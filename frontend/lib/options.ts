// Options strategy engine for the payoff builder.
//
// Valuation approach (T+0 curve, expiry-payoff-as-t-minus-minT, strategy
// value = Σ Black-Scholes leg values, P&L = value(x) − entry value) adapted
// from react-option-charts © Adam Hwang, MIT licensed:
//   https://github.com/adamhwang/react-option-charts
// Pricing/greeks via the MIT `black-scholes` and `greeks` packages.
//
// Entry premiums intentionally use the SAME parametric smile the on-chain
// SwapVM instruction quotes (SmileMath.sol), so the builder's cost basis
// matches what `vault.buy()` actually charges.

import { blackScholes } from "black-scholes";
import { getDelta, getGamma, getTheta, getVega } from "greeks";

export const RISK_FREE_RATE = 0; // protocol premium model carries no rate term

// ── Protocol smile (mirrors SmileMath.sol / OptionPricingEngine) ─────────────

export const SIGMA_GLOBAL = 0.8;
export const ALPHA = 2.0;
export const BETA = 0.0;

export function smileSigma(spot: number, strike: number): number {
  const lnKS = Math.log(strike / spot);
  const multiplier = Math.max(0.1, 1 + ALPHA * lnKS * lnKS + BETA * lnKS);
  return SIGMA_GLOBAL * multiplier;
}

// ── Trader-native surface quotes (ATM vol / risk reversal / butterfly) ───────
//
// The α/β smile above is exactly the "level / skew / curvature" decomposition
// every options desk uses, so we can re-express it in the three numbers vol
// traders actually quote — no new model, just the standard dictionary:
//
//   ATM vol        — the market's price for movement itself, regardless of
//                    direction. σ·√t of it is the "expected move" by expiry:
//                    the size of drift the premium is charging for.
//   Risk reversal  — 25Δ call vol minus 25Δ put vol: which DIRECTION costs
//     (RR)           more. Negative = downside insurance is pricier (crash
//                    fear); positive = upside chasing is pricier.
//   Butterfly      — average 25Δ wing vol minus ATM vol: how much EXTRA a
//     (BF)           big move costs vs a small one. The market's fat-tails
//                    charge; zero would mean it believes in perfect bell
//                    curves.
//
// "25Δ" (25-delta) just names the reference strikes: the OTM call and OTM put
// that each have ~25% probability of finishing in the money — near-universal
// convention for where to measure the wings.
//
// Values are computed by evaluating the actual smile at the actual 25Δ
// strikes (not a Taylor approximation), so they are exactly what the on-chain
// instruction charges at those strikes.

export interface SurfaceQuotes {
  /** ATM implied vol (annualized, e.g. 0.8 = 80%). */
  atmVol: number;
  /** Expected move by expiry as a fraction of spot: atmVol·√t. */
  expectedMovePct: number;
  /** 25Δ risk reversal: σ(25Δ call) − σ(25Δ put). Sign = which side costs more. */
  rr25: number;
  /** 25Δ butterfly: mean 25Δ wing vol − ATM vol. The fat-tails premium. */
  bf25: number;
  /** The reference strikes the wings were measured at. */
  k25call: number;
  k25put: number;
}

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

/** Per-unit premium in USD — mirrors SmileMath.premium (intrinsic + damped time value). */
export function protocolPremium(
  spot: number,
  strike: number,
  isCall: boolean,
  tYears: number
): number {
  const sigma = smileSigma(spot, strike);
  const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const moneyFactor = Math.min(spot, strike) / Math.max(spot, strike);
  const timeValue = spot * sigma * Math.sqrt(Math.max(tYears, 0)) * moneyFactor;
  return intrinsic + timeValue;
}

// ── Delta-targeted strike selection (S9 one-click income) ────────────────────

/**
 * Strike whose Black-Scholes |delta| equals `targetAbsDelta`, under the same
 * smile-adjusted σ the on-chain instruction quotes. Calls: delta falls as K
 * rises; puts: |delta| falls as K falls — both monotone, so bisection is safe.
 * Thetagang presets are expressed in delta ("sell the 15Δ call") because
 * delta ≈ P(expiring ITM): the knob users actually reason with.
 */
export function strikeForDelta(
  spot: number,
  targetAbsDelta: number,
  isCall: boolean,
  tYears: number
): number {
  const type = isCall ? "call" : "put";
  const absDelta = (k: number) =>
    Math.abs(getDelta(spot, k, Math.max(tYears, 1e-4), smileSigma(spot, k), RISK_FREE_RATE, type));
  // |delta| decreases as the strike moves OTM for both sides.
  let nearMoney = spot;
  let farOtm = isCall ? spot * 3 : spot * 0.2;
  for (let i = 0; i < 60; i++) {
    const mid = (nearMoney + farOtm) / 2;
    if (absDelta(mid) > targetAbsDelta) nearMoney = mid;
    else farOtm = mid;
  }
  return (nearMoney + farOtm) / 2;
}

/** Round a strike to the protocol's UI convention ($50 increments). */
export const roundStrike = (k: number) => Math.max(50, Math.round(k / 50) * 50);

// ── Leg & strategy model ─────────────────────────────────────────────────────

export interface BuilderLeg {
  direction: "buy" | "sell";
  isCall: boolean;
  strike: number;
  amount: number;
  /** Days to expiry; defaults to 30 when omitted (legacy legs). */
  expiryDays?: number;
}

export const DEFAULT_DTE = 30;

const dte = (leg: BuilderLeg) => leg.expiryDays ?? DEFAULT_DTE;
const sign = (leg: BuilderLeg) => (leg.direction === "buy" ? 1 : -1);

/** Entry cost (debit > 0, credit < 0) at the protocol's quoted premiums. */
export function entryCost(legs: BuilderLeg[], spot: number): number {
  return legs.reduce(
    (sum, leg) =>
      sum + sign(leg) * leg.amount * protocolPremium(spot, leg.strike, leg.isCall, dte(leg) / 365),
    0
  );
}

/**
 * Strategy value at underlying `x` after `elapsedDays`.
 * Remaining t ≤ 0 collapses a leg to intrinsic — so evaluating at the
 * nearest expiry (elapsed = min DTE) yields the classic payoff diagram while
 * longer-dated legs keep their remaining time value (calendars work).
 */
export function strategyValue(legs: BuilderLeg[], x: number, elapsedDays: number): number {
  return legs.reduce((sum, leg) => {
    const tRem = (dte(leg) - elapsedDays) / 365;
    const type = leg.isCall ? "call" : "put";
    const value =
      tRem <= 0
        ? leg.isCall
          ? Math.max(x - leg.strike, 0)
          : Math.max(leg.strike - x, 0)
        : blackScholes(x, leg.strike, tRem, smileSigma(x, leg.strike), RISK_FREE_RATE, type);
    return sum + sign(leg) * leg.amount * (value || 0);
  }, 0);
}

// ── P&L series, breakevens, stats ────────────────────────────────────────────

export interface PnlPoint {
  s: number;
  expiry: number; // P&L at nearest expiry
  now: number;    // P&L today (T+0 curve)
}

export function pnlSeries(legs: BuilderLeg[], spot: number, points = 200): PnlPoint[] {
  const cost = entryCost(legs, spot);
  const minDte = Math.min(...legs.map(dte));
  const lo = spot * 0.6;
  const hi = spot * 1.4;
  return Array.from({ length: points }, (_, i) => {
    const s = lo + ((hi - lo) * i) / (points - 1);
    return {
      s: Math.round(s),
      expiry: round2(strategyValue(legs, s, minDte) - cost),
      now: round2(strategyValue(legs, s, 0) - cost),
    };
  });
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function breakevens(data: PnlPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const a = data[i - 1];
    const b = data[i];
    if (a.expiry === 0 || a.expiry * b.expiry < 0) {
      const t = a.expiry === 0 ? 0 : -a.expiry / (b.expiry - a.expiry);
      out.push(a.s + t * (b.s - a.s));
    }
  }
  return out;
}

export interface StrategyStats {
  cost: number;              // debit (+) or credit (−)
  maxProfit: number | null;  // null = unlimited
  maxLoss: number | null;    // null = unlimited
  pop: number;               // probability of profit at expiry (lognormal, ATM σ)
  greeks: { delta: number; gamma: number; theta: number; vega: number };
}

export function strategyStats(legs: BuilderLeg[], spot: number, data: PnlPoint[]): StrategyStats {
  const cost = entryCost(legs, spot);
  const first = data[0];
  const last = data[data.length - 1];

  // Unbounded tails: if the expiry P&L is still rising/falling at the edges,
  // profit/loss is unlimited in that direction.
  const leftSlope = data[1].expiry - first.expiry;
  const rightSlope = last.expiry - data[data.length - 2].expiry;
  let maxProfit: number | null = Math.max(...data.map((d) => d.expiry));
  let maxLoss: number | null = Math.min(...data.map((d) => d.expiry));
  if ((rightSlope > 1e-9 && last.expiry >= maxProfit!) || (leftSlope < -1e-9 && first.expiry >= maxProfit!)) maxProfit = null;
  if ((rightSlope < -1e-9 && last.expiry <= maxLoss!) || (leftSlope > 1e-9 && first.expiry <= maxLoss!)) maxLoss = null;

  // Net greeks at current spot (per-1%-IV vega, per-day theta).
  const g = legs.reduce(
    (acc, leg) => {
      const t = Math.max(dte(leg), 0.01) / 365;
      const v = smileSigma(spot, leg.strike);
      const type = leg.isCall ? "call" : "put";
      const q = sign(leg) * leg.amount;
      acc.delta += q * getDelta(spot, leg.strike, t, v, RISK_FREE_RATE, type);
      acc.gamma += q * getGamma(spot, leg.strike, t, v, RISK_FREE_RATE);
      acc.theta += q * getTheta(spot, leg.strike, t, v, RISK_FREE_RATE, type);
      acc.vega += q * getVega(spot, leg.strike, t, v, RISK_FREE_RATE);
      return acc;
    },
    { delta: 0, gamma: 0, theta: 0, vega: 0 }
  );

  return { cost, maxProfit, maxLoss, pop: probabilityOfProfit(legs, spot, data), greeks: g };
}

/**
 * P(profit at nearest expiry) under a lognormal terminal distribution with
 * the ATM smile σ — the same simplification OptionStrat-style tools make.
 */
function probabilityOfProfit(legs: BuilderLeg[], spot: number, data: PnlPoint[]): number {
  const minDte = Math.min(...legs.map(dte));
  const t = Math.max(minDte, 0.01) / 365;
  const sigma = smileSigma(spot, spot) * Math.sqrt(t);

  // P(S_T <= x) for lognormal centered on spot (zero drift, matching r = 0).
  const cdf = (x: number) => normCdf((Math.log(x / spot) + (sigma * sigma) / 2) / sigma);

  // Sum the probability mass of each profitable region between breakevens.
  let pop = 0;
  let profitable = data[0].expiry > 0;
  let prev = 0; // CDF at the previous boundary (0 at the left tail)
  for (const be of [...breakevens(data), Infinity]) {
    const cdfAt = be === Infinity ? 1 : cdf(be);
    if (profitable) pop += cdfAt - prev;
    prev = cdfAt;
    profitable = !profitable;
  }
  return Math.min(Math.max(pop, 0), 1);
}

/** Abramowitz & Stegun 26.2.17 — same approximation the contracts document. */
function normCdf(x: number): number {
  const b = [0.31938153, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (b[0] + t * (b[1] + t * (b[2] + t * (b[3] + t * b[4]))));
  const nd = (1 / Math.sqrt(2 * Math.PI)) * Math.exp((-x * x) / 2) * poly;
  return x >= 0 ? 1 - nd : nd;
}
