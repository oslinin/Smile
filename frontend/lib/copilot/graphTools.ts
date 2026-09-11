// The copilot's trading tools over the tape (lib/tape.ts): opportunities,
// liquidity, portfolio greeks and hedging. On Sepolia/Arc the tape is The
// Graph and nothing else; on Anvil it is the event log. Every result carries
// `source` so the model can say where the numbers came from. Pricing reuses
// lib/options.ts (the same math the builder and the on-chain opcode use) and
// the MIT black-scholes / greeks packages for the benchmark side.

import { blackScholes } from "black-scholes";
import { getDelta } from "greeks";
import type { Address } from "viem";
import { CONTRACTS, contractsFor } from "@/config/wagmi";
import {
  type BuilderLeg,
  DEFAULT_DTE,
  RISK_FREE_RATE,
  SIGMA_GLOBAL,
  pnlSeries,
  protocolPremium,
  smileSigma,
  strategyStats,
} from "@/lib/options";
import { readTape, type Tape, type TapeAuth, type TapeInstrument } from "@/lib/tape";
import { getPublicClient, readWalletPositions } from "./chain";
import type { PublicClient } from "viem";
import { nearestReference, referenceSurface, type ReferenceSurface } from "./deribit";

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
const YEAR = 31_536_000;
const nowSec = () => Date.now() / 1000;

export async function loadTape(chainId?: number, since?: number): Promise<Tape> {
  const vault = (chainId ? contractsFor(chainId) : CONTRACTS).aquaVault as Address;
  return readTape({ chainId, client: getPublicClient(chainId), vault, since });
}

// The on-chain surface is live: the Uniswap v4 hook bumps sigma per tenor
// bucket on every trade (the σ feedback loop), so the ask the chain actually
// charges drifts from the frontend's constant SIGMA_GLOBAL. Read the hook's
// bucket for each expiry and scale the smile by it; fall back to the
// constant when the hook can't be read (no vault address, old deployment).
const HOOK_ABI = [
  { name: "hook", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "sigmaFor", type: "function", stateMutability: "view", inputs: [{ name: "timeToExpiry", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

async function liveSigmaByExpiry(client: PublicClient, vault: Address, expiries: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const hook = await client.readContract({ address: vault, abi: HOOK_ABI, functionName: "hook" });
    const now = Math.floor(Date.now() / 1000);
    await Promise.all(
      expiries.map(async (e) => {
        const wad = await client.readContract({ address: hook, abi: HOOK_ABI, functionName: "sigmaFor", args: [BigInt(Math.max(e - now, 0))] });
        out.set(e, Number(wad) / 1e18);
      })
    );
  } catch {
    /* constant model below */
  }
  return out;
}

/** protocolPremium with the hook's live sigma for that expiry in place of SIGMA_GLOBAL. */
function liveAsk(spot: number, strike: number, isCall: boolean, tYears: number, sigmaGlobal: number): number {
  const sigma = smileSigma(spot, strike) * (sigmaGlobal / SIGMA_GLOBAL);
  const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  return intrinsic + spot * sigma * Math.sqrt(Math.max(tYears, 0)) * (Math.min(spot, strike) / Math.max(spot, strike));
}

/** Black-Scholes implied vol by bisection; null when the premium is below intrinsic. */
export function impliedVol(premium: number, spot: number, strike: number, tYears: number, isCall: boolean): number | null {
  const type = isCall ? "call" : "put";
  const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  if (premium <= intrinsic || tYears <= 0) return null;
  let lo = 0.01;
  let hi = 5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if ((blackScholes(spot, strike, tYears, mid, RISK_FREE_RATE, type) || 0) > premium) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Grid strikes a range covers, capped so a wide range can't explode the scan. */
function gridStrikes(a: TapeAuth, cap = 40): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(a.strikeMin / 50) * 50; k <= a.strikeMax && out.length < cap; k += 50) out.push(k);
  return out;
}

/** Option units a range can still write at `strike` (calls: WETH units; puts: USDC / strike). */
function freeUnits(a: TapeAuth, strike: number): number {
  const free = Math.max(0, a.maxCollateral - a.usedCollateral);
  return a.isCall ? free : free / strike;
}

async function tryReference(): Promise<ReferenceSurface | null> {
  try {
    return await referenceSurface();
  } catch {
    return null;
  }
}

// ── find_opportunities ──────────────────────────────────────────────────────

export interface Opportunity {
  authId: number;
  instrument: string; // "C 3000 · 12d"
  isCall: boolean;
  strike: number;
  expiresInDays: number;
  smileAskUsd: number;
  smileIv: number | null;
  referenceIv: number | null;
  referenceInstrument: string | null;
  ivEdgePts: number | null; // smileIv − referenceIv, in vol points (negative = Smile cheaper)
  lastTradedUsd: number | null;
  lastTradedIv: number | null;
  vsLastTradePct: number | null;
  freeUnits: number;
  openInterest: number;
}

export async function findOpportunities(
  chainId: number | undefined,
  spot: number,
  opts: { side?: "cheap" | "expensive" | "both"; isCall?: boolean; maxResults?: number }
) {
  const [tape, ref] = await Promise.all([loadTape(chainId), tryReference()]);
  const vault = (chainId ? contractsFor(chainId) : CONTRACTS).aquaVault as Address;
  const sigmas = await liveSigmaByExpiry(getPublicClient(chainId), vault, [...new Set(tape.auths.map((a) => a.expiry))]);
  const now = nowSec();
  const byToken = new Map(tape.instruments.map((i) => [`${i.authId}-${i.strike}`, i]));
  const rows: Opportunity[] = [];
  for (const a of tape.auths) {
    if (opts.isCall !== undefined && a.isCall !== opts.isCall) continue;
    const t = (a.expiry - now) / YEAR;
    if (t <= 0) continue;
    const sigmaGlobal = sigmas.get(a.expiry) ?? SIGMA_GLOBAL;
    for (const k of gridStrikes(a)) {
      const ask = liveAsk(spot, k, a.isCall, t, sigmaGlobal);
      const smileIv = impliedVol(ask, spot, k, t, a.isCall);
      const near = ref ? nearestReference(ref, k, a.expiry, a.isCall) : null;
      const referenceIv = near ? near.iv : null;
      const inst = byToken.get(`${a.authId}-${k}`);
      const lastIv = inst && inst.lastPremiumPerUnit > 0 ? impliedVol(inst.lastPremiumPerUnit, spot, k, t, a.isCall) : null;
      rows.push({
        authId: a.authId,
        instrument: `${a.isCall ? "C" : "P"} ${k} · ${Math.round(t * 365)}d`,
        isCall: a.isCall,
        strike: k,
        expiresInDays: Math.round(t * 365 * 10) / 10,
        smileAskUsd: round2(ask),
        smileIv: smileIv === null ? null : round4(smileIv),
        referenceIv: referenceIv === null ? null : round4(referenceIv),
        referenceInstrument: near?.name ?? null,
        ivEdgePts: smileIv !== null && referenceIv !== null ? round2((smileIv - referenceIv) * 100) : null,
        lastTradedUsd: inst ? round2(inst.lastPremiumPerUnit) : null,
        lastTradedIv: lastIv === null ? null : round4(lastIv),
        vsLastTradePct: inst && inst.lastPremiumPerUnit > 0 ? round2(((ask - inst.lastPremiumPerUnit) / inst.lastPremiumPerUnit) * 100) : null,
        freeUnits: round4(freeUnits(a, k)),
        openInterest: inst ? round4(inst.openInterest) : 0,
      });
    }
  }
  // Rank on the reference edge when Deribit answered, else on the gap to the
  // flat SIGMA_GLOBAL benchmark (the protocol's own ATM vol).
  const edge = (r: Opportunity) => r.ivEdgePts ?? (r.smileIv === null ? 0 : (r.smileIv - SIGMA_GLOBAL) * 100);
  const withEdge = rows.filter((r) => r.smileIv !== null && r.freeUnits > 0);
  const n = opts.maxResults ?? 6;
  const cheap = [...withEdge].sort((x, y) => edge(x) - edge(y)).slice(0, n);
  const expensive = [...withEdge].sort((x, y) => edge(y) - edge(x)).slice(0, n);
  const liveSigma = Object.fromEntries([...sigmas].map(([e, v]) => [`${Math.round((e - now) / 86400)}d`, round4(v)]));
  return {
    source: tape.source,
    liveSigmaGlobalByExpiry: sigmas.size ? liveSigma : { note: `hook unreadable — constant ${SIGMA_GLOBAL}` },
    reference: ref ? { venue: "Deribit", indexPrice: ref.indexPrice, dvol: ref.dvol === null ? null : round4(ref.dvol), listed: ref.instruments.length } : { venue: "none", note: `Deribit unreachable — edge measured against the flat ${SIGMA_GLOBAL * 100}% protocol vol` },
    spotUsd: spot,
    universe: { activeRanges: tape.auths.length, strikesScanned: rows.length, instrumentsTraded: tape.instruments.length },
    cheap: opts.side === "expensive" ? undefined : cheap,
    expensive: opts.side === "cheap" ? undefined : expensive,
    note: "ivEdgePts < 0: Smile's ask implies less vol than the listed reference (cheap to buy). vsLastTradePct: today's ask vs the last fill of the same instrument. freeUnits is what the range can still write at that strike; capacity is shared across the range's strikes. Model caveat: Smile's on-chain time value is S·σ·√T·damping with no Black-Scholes 0.4 factor, so BS-implied vol reads roughly 2× the protocol's σ; the absolute gap to Deribit is mostly that plus the deployment's σ_global, and the σ feedback loop (liveSigmaGlobalByExpiry) moves it with flow — rank instruments against each other and against their own last trades, and quote the Deribit gap as context, not as a free lunch.",
  };
}

// ── liquidity_map ───────────────────────────────────────────────────────────

export async function liquidityMap(chainId: number | undefined, spot: number, opts: { isCall?: boolean }) {
  const tape = await loadTape(chainId);
  const now = nowSec();
  const oiByAuth = new Map<number, number>();
  const lastTradeByAuth = new Map<number, number>();
  for (const i of tape.instruments) {
    oiByAuth.set(i.authId, (oiByAuth.get(i.authId) ?? 0) + i.openInterest);
    lastTradeByAuth.set(i.authId, Math.max(lastTradeByAuth.get(i.authId) ?? 0, i.lastTradeAt));
  }
  const ranges = tape.auths
    .filter((a) => opts.isCall === undefined || a.isCall === opts.isCall)
    .map((a) => {
      const usedPct = a.maxCollateral > 0 ? (a.usedCollateral / a.maxCollateral) * 100 : 0;
      const last = lastTradeByAuth.get(a.authId) ?? 0;
      const daysSinceTrade = last ? (now - last) / 86400 : null;
      const ageDays = (now - a.createdAt) / 86400;
      const expiresInDays = (a.expiry - now) / 86400;
      const flags: string[] = [];
      if (usedPct >= 80) flags.push("scarce");
      if (a.fillCount === 0 && ageDays > 1) flags.push("empty");
      if ((daysSinceTrade ?? ageDays) > 3) flags.push("stale");
      if (expiresInDays < 3) flags.push("expiring");
      return {
        authId: a.authId,
        lp: a.lp,
        type: a.isCall ? "call" : "put",
        strikes: `${a.strikeMin}–${a.strikeMax}`,
        expiresInDays: Math.round(expiresInDays * 10) / 10,
        capacity: `${round4(a.maxCollateral)} ${a.isCall ? "WETH" : "USDC"}`,
        usedPct: round2(usedPct),
        freeUnitsAtSpot: round4(freeUnits(a, Math.max(50, Math.round(spot / 50) * 50))),
        fills: a.fillCount,
        openInterest: round4(oiByAuth.get(a.authId) ?? 0),
        daysSinceTrade: daysSinceTrade === null ? null : round2(daysSinceTrade),
        flags,
      };
    });
  // Per-strike heat map across every range: how many ranges quote it, how
  // much they can still write, how much is open. An LP reads the empty
  // strikes near spot as where to quote; a buyer reads the thin ones as
  // where to expect the ask to move.
  const strikes = new Map<string, { strike: number; type: string; ranges: number; freeUnits: number; openInterest: number }>();
  for (const a of tape.auths) {
    if (opts.isCall !== undefined && a.isCall !== opts.isCall) continue;
    for (const k of gridStrikes(a)) {
      const key = `${a.isCall ? "C" : "P"}${k}`;
      const row = strikes.get(key) ?? { strike: k, type: a.isCall ? "call" : "put", ranges: 0, freeUnits: 0, openInterest: 0 };
      row.ranges += 1;
      row.freeUnits += freeUnits(a, k);
      strikes.set(key, row);
    }
  }
  for (const i of tape.instruments) {
    const row = strikes.get(`${i.isCall ? "C" : "P"}${i.strike}`);
    if (row) row.openInterest += i.openInterest;
  }
  const heat = [...strikes.values()]
    .map((r) => ({ ...r, freeUnits: round4(r.freeUnits), openInterest: round4(r.openInterest) }))
    .sort((x, y) => x.strike - y.strike);
  return {
    source: tape.source,
    spotUsd: spot,
    ranges,
    strikeHeatMap: heat,
    summary: {
      activeRanges: ranges.length,
      scarce: ranges.filter((r) => r.flags.includes("scarce")).length,
      empty: ranges.filter((r) => r.flags.includes("empty")).length,
      stale: ranges.filter((r) => r.flags.includes("stale")).length,
      uncoveredStrikesNearSpot: [-200, -150, -100, -50, 0, 50, 100, 150, 200]
        .map((d) => Math.round(spot / 50) * 50 + d)
        .filter((k) => !strikes.has(`C${k}`) && !strikes.has(`P${k}`)),
    },
  };
}

// ── portfolio_greeks ────────────────────────────────────────────────────────

function legsStats(legs: BuilderLeg[], spot: number) {
  const s = strategyStats(legs, spot, pnlSeries(legs, spot));
  return {
    markValueUsd: round2(-s.cost), // cost of the book at today's marks = its liquidation value, sign flipped
    greeks: {
      delta: round4(s.greeks.delta),
      gamma: round4(s.greeks.gamma),
      thetaPerDay: round2(s.greeks.theta),
      vegaPer1Pct: round2(s.greeks.vega),
    },
    maxProfit: s.maxProfit === null ? "unlimited" : round2(s.maxProfit),
    maxLoss: s.maxLoss === null ? "unlimited" : round2(s.maxLoss),
  };
}

export async function portfolioGreeks(chainId: number | undefined, spot: number, address: string) {
  const client = getPublicClient(chainId);
  const [wallet, tape] = await Promise.all([readWalletPositions(client, address, chainId), loadTape(chainId)]);
  const now = nowSec();
  const me = address.toLowerCase();
  const longLegs: BuilderLeg[] = wallet.longOptions.map((p) => ({
    direction: "buy",
    isCall: p.isCall,
    strike: p.strike,
    amount: p.amount,
    expiryDays: Math.max(1, Math.round(p.expiresInDays)),
  }));
  // Written side: every instrument on one of my ranges with open interest is
  // a short position of mine (the holder can be anyone).
  const written: TapeInstrument[] = tape.instruments.filter((i) => i.lp.toLowerCase() === me && i.openInterest > 0 && i.expiry > now);
  const shortLegs: BuilderLeg[] = written.map((i) => ({
    direction: "sell",
    isCall: i.isCall,
    strike: i.strike,
    amount: i.openInterest,
    expiryDays: Math.max(1, Math.round((i.expiry - now) / 86400)),
  }));
  // Cost basis of the long side from my own fills (subgraph fills are the
  // whole history; the Anvil tape too).
  const costByToken = new Map<string, { paid: number; units: number }>();
  for (const f of tape.fills) {
    if (f.buyer.toLowerCase() !== me) continue;
    const c = costByToken.get(f.optionToken) ?? { paid: 0, units: 0 };
    c.paid += f.premiumUsd;
    c.units += f.amount;
    costByToken.set(f.optionToken, c);
  }
  const longs = wallet.longOptions.map((p) => {
    const c = costByToken.get(p.optionToken.toLowerCase());
    const t = Math.max(p.expiresInDays, 0.01) / 365;
    const mark = protocolPremium(spot, p.strike, p.isCall, t);
    return {
      instrument: `${p.isCall ? "C" : "P"} ${p.strike} · ${Math.round(p.expiresInDays)}d`,
      units: round4(p.amount),
      markPerUnit: round2(mark),
      avgCostPerUnit: c && c.units > 0 ? round2(c.paid / c.units) : null,
      unrealizedUsd: c && c.units > 0 ? round2((mark - c.paid / c.units) * p.amount) : null,
    };
  });
  const shorts = written.map((i) => ({
    instrument: `${i.isCall ? "C" : "P"} ${i.strike} · ${Math.round((i.expiry - now) / 86400)}d`,
    units: round4(i.openInterest),
    markPerUnit: round2(protocolPremium(spot, i.strike, i.isCall, Math.max(i.expiry - now, 864) / YEAR)),
    lastSoldPerUnit: round2(i.lastPremiumPerUnit),
    authId: i.authId,
  }));
  const all = [...longLegs, ...shortLegs];
  const aggregate = all.length ? legsStats(all, spot) : null;
  return {
    source: wallet.source,
    spotUsd: spot,
    balances: wallet.balances,
    long: longs,
    written: shorts,
    ranges: wallet.lpAuths,
    aggregate,
    long_only: longLegs.length ? legsStats(longLegs, spot) : null,
    written_only: shortLegs.length ? legsStats(shortLegs, spot) : null,
    deltaInEth: aggregate ? round4(aggregate.greeks.delta) : 0,
    deltaInUsd: aggregate ? round2(aggregate.greeks.delta * spot) : 0,
    legs: all,
    note: "Positions come from the tape (The Graph on public networks). Written exposure = open interest on your ranges. Hand `legs` to hedge_suggestion or scenario_analysis.",
  };
}

// ── hedge_suggestion ────────────────────────────────────────────────────────

export function hedgeSuggestion(
  spot: number,
  legs: BuilderLeg[],
  hedgeWith: "spot" | "call" | "put",
  strike?: number,
  expiryDays?: number,
  targetDelta = 0
) {
  const before = legsStats(legs, spot);
  const net = before.greeks.delta - targetDelta;
  if (Math.abs(net) < 1e-4) return { before, hedge: null, note: "Already at the target delta." };
  if (hedgeWith === "spot") {
    const units = -net;
    return {
      before,
      hedge: { instrument: "ETH spot", action: units > 0 ? "buy" : "sell", units: round4(Math.abs(units)), notionalUsd: round2(Math.abs(units) * spot) },
      after: { greeks: { ...before.greeks, delta: round4(targetDelta) } },
      note: "Spot hedges delta only; gamma, theta and vega are unchanged — re-hedge as spot moves (gamma) and as expiry nears.",
    };
  }
  const isCall = hedgeWith === "call";
  const k = strike ?? Math.round((isCall ? spot * 1.05 : spot * 0.95) / 50) * 50;
  const dte = expiryDays ?? DEFAULT_DTE;
  const t = Math.max(dte, 0.01) / 365;
  const d = getDelta(spot, k, t, smileSigma(spot, k), RISK_FREE_RATE, isCall ? "call" : "put");
  if (Math.abs(d) < 1e-6) return { before, hedge: null, note: `A ${k} ${hedgeWith} has ~zero delta at ${dte}d — pick a strike nearer the money.` };
  const q = -net / d; // signed units: >0 buy, <0 sell
  const leg: BuilderLeg = { direction: q > 0 ? "buy" : "sell", isCall, strike: k, amount: round4(Math.abs(q)), expiryDays: dte };
  const after = legsStats([...legs, leg], spot);
  return {
    before,
    hedge: {
      instrument: `${isCall ? "call" : "put"} K=${k} ${dte}d (delta ${round4(d)} per unit)`,
      action: leg.direction,
      units: leg.amount,
      premiumPerUnitUsd: round2(protocolPremium(spot, k, isCall, t)),
      leg,
    },
    after,
    afterLegs: [...legs, leg],
    note:
      leg.direction === "sell"
        ? "Selling options to flatten delta adds short gamma and short vega: the hedge decays in your favour but a fast move re-opens the delta. Writing on Smile locks collateral JIT through Aqua."
        : "Buying options to flatten delta costs premium (theta) but adds gamma: the hedge improves as the move continues.",
  };
}
