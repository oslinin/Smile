// Copilot-only analytics on top of lib/options.ts. options.ts stays untouched:
// its strategyValue has no vol-shift knob, so scenario analysis re-derives leg
// values here with a bumped smile sigma.

import { blackScholes } from "black-scholes";
import {
  type BuilderLeg,
  DEFAULT_DTE,
  RISK_FREE_RATE,
  entryCost,
  smileSigma,
} from "@/lib/options";

const dte = (leg: BuilderLeg) => leg.expiryDays ?? DEFAULT_DTE;
const sign = (leg: BuilderLeg) => (leg.direction === "buy" ? 1 : -1);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** IV-vs-strike points for the vol-smile chart (fractions, e.g. 0.8 = 80%). */
export function smileCurve(
  spot: number,
  points = 41
): { strike: number; iv: number }[] {
  const lo = spot * 0.6;
  const hi = spot * 1.4;
  return Array.from({ length: points }, (_, i) => {
    const strike = Math.round(lo + ((hi - lo) * i) / (points - 1));
    return { strike, iv: round2(smileSigma(spot, strike) * 100) / 100 };
  });
}

/** Leg value at spot `x` with the smile shifted by `volShift` (abs vol pts as fraction). */
function legValueShifted(
  leg: BuilderLeg,
  x: number,
  elapsedDays: number,
  volShift: number
): number {
  const tRem = (dte(leg) - elapsedDays) / 365;
  if (tRem <= 0) {
    return leg.isCall ? Math.max(x - leg.strike, 0) : Math.max(leg.strike - x, 0);
  }
  const sigma = Math.max(0.01, smileSigma(x, leg.strike) + volShift);
  const type = leg.isCall ? "call" : "put";
  return blackScholes(x, leg.strike, tRem, sigma, RISK_FREE_RATE, type) || 0;
}

export interface ScenarioGridResult {
  /** Columns: spot shifts in % (e.g. -10 = spot down 10%). */
  spotShiftsPct: number[];
  /** Rows: vol shifts in absolute points (e.g. 20 = +20 vol pts). */
  volShiftsPts: number[];
  daysForward: number;
  /** pnl[volRow][spotCol] in USD relative to entry cost at current spot. */
  pnl: number[][];
  worst: { pnl: number; spotShiftPct: number; volShiftPts: number };
  best: { pnl: number; spotShiftPct: number; volShiftPts: number };
}

export function scenarioGrid(
  legs: BuilderLeg[],
  spot: number,
  opts: { spotShiftsPct?: number[]; volShiftsPts?: number[]; daysForward?: number } = {}
): ScenarioGridResult {
  const spotShiftsPct = opts.spotShiftsPct ?? [-20, -10, -5, 0, 5, 10, 20];
  const volShiftsPts = opts.volShiftsPts ?? [-20, 0, 20];
  const daysForward = Math.max(0, opts.daysForward ?? 0);
  const cost = entryCost(legs, spot);

  let worst = { pnl: Infinity, spotShiftPct: 0, volShiftPts: 0 };
  let best = { pnl: -Infinity, spotShiftPct: 0, volShiftPts: 0 };

  const pnl = volShiftsPts.map((vp) =>
    spotShiftsPct.map((sp) => {
      const x = spot * (1 + sp / 100);
      const value = legs.reduce(
        (sum, leg) => sum + sign(leg) * leg.amount * legValueShifted(leg, x, daysForward, vp / 100),
        0
      );
      const p = round2(value - cost);
      if (p < worst.pnl) worst = { pnl: p, spotShiftPct: sp, volShiftPts: vp };
      if (p > best.pnl) best = { pnl: p, spotShiftPct: sp, volShiftPts: vp };
      return p;
    })
  );

  return { spotShiftsPct, volShiftsPts, daysForward, pnl, worst, best };
}
