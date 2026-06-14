"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const T = 30 / 365; // 30-day expiry for premium estimates

function smileSigma(spot: number, strike: number): number {
  const lnKS = Math.log(strike / spot);
  return 0.80 * (1 + 2.0 * lnKS * lnKS);
}

function estimatePremium(spot: number, strike: number, isCall: boolean): number {
  const sigma = smileSigma(spot, strike);
  const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  return intrinsic + spot * sigma * Math.sqrt(T);
}

export interface Leg {
  id: number;
  direction: "buy" | "sell";
  isCall: boolean;
  strike: number;
  amount: number;
}

const PRESETS = [
  {
    label: "Bull Spread",
    make: (s: number): Omit<Leg, "id">[] => [
      { direction: "buy",  isCall: true, strike: Math.round(s / 50) * 50,        amount: 1 },
      { direction: "sell", isCall: true, strike: Math.round(s * 1.1 / 50) * 50,  amount: 1 },
    ],
  },
  {
    label: "Butterfly",
    make: (s: number): Omit<Leg, "id">[] => [
      { direction: "buy",  isCall: true, strike: Math.round(s * 0.95 / 50) * 50, amount: 1 },
      { direction: "sell", isCall: true, strike: Math.round(s / 50) * 50,         amount: 2 },
      { direction: "buy",  isCall: true, strike: Math.round(s * 1.05 / 50) * 50, amount: 1 },
    ],
  },
  {
    label: "Strangle",
    make: (s: number): Omit<Leg, "id">[] => [
      { direction: "buy", isCall: false, strike: Math.round(s * 0.9 / 50) * 50, amount: 1 },
      { direction: "buy", isCall: true,  strike: Math.round(s * 1.1 / 50) * 50, amount: 1 },
    ],
  },
];

// ── Payoff chart ──────────────────────────────────────────────────────────────

const N = 200;

function PayoffChart({ legs, spot }: { legs: Leg[]; spot: number }) {
  const spotMin = spot * 0.7;
  const spotMax = spot * 1.3;

  const data = useMemo(() => {
    return Array.from({ length: N }, (_, i) => {
      const s = spotMin + (spotMax - spotMin) * (i / (N - 1));
      const pnl = legs.reduce((sum, leg) => {
        const p = estimatePremium(spot, leg.strike, leg.isCall);
        const intrinsic = leg.isCall ? Math.max(s - leg.strike, 0) : Math.max(leg.strike - s, 0);
        return sum + (leg.direction === "buy" ? intrinsic - p : p - intrinsic) * leg.amount;
      }, 0);
      const rounded = Math.round(pnl * 100) / 100;
      return {
        s: Math.round(s),
        pnl: rounded,
        pnlPos: Math.max(rounded, 0),
        pnlNeg: Math.min(rounded, 0),
      };
    });
  }, [legs, spot, spotMin, spotMax]);

  const breakevens = useMemo(() => {
    const result: number[] = [];
    for (let i = 1; i < data.length; i++) {
      const a = data[i - 1], b = data[i];
      if (a.pnl * b.pnl < 0) {
        const t = -a.pnl / (b.pnl - a.pnl);
        result.push(a.s + t * (b.s - a.s));
      }
    }
    return result;
  }, [data]);

  return (
    <div className="rounded-lg bg-gray-950 p-2" style={{ height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 8, left: 48, bottom: 16 }}>
          <defs>
            <linearGradient id="profit" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#22c55e" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="loss" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#ef4444" stopOpacity={0.05} />
              <stop offset="95%" stopColor="#ef4444" stopOpacity={0.3} />
            </linearGradient>
          </defs>

          <XAxis
            dataKey="s"
            type="number"
            domain={[spotMin, spotMax]}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
            tick={{ fill: "#6b7280", fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: "#1f2937" }}
          />
          <YAxis
            tickFormatter={(v: number) => `$${v}`}
            tick={{ fill: "#6b7280", fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: "#1f2937" }}
          />
          <Tooltip
            contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 6, fontSize: 11 }}
            labelFormatter={(v) => `S = $${Number(v).toLocaleString()}`}
            formatter={(v) => [`$${Number(v).toFixed(2)}`, "P&L"]}
          />

          {/* zero baseline */}
          <ReferenceLine y={0} stroke="#374151" strokeWidth={1} />

          {/* current spot */}
          <ReferenceLine
            x={Math.round(spot)}
            stroke="#4b5563"
            strokeDasharray="4 3"
            label={{ value: `S`, position: "top", fill: "#6b7280", fontSize: 9 }}
          />

          {/* breakeven markers */}
          {breakevens.map((be, i) => (
            <ReferenceLine
              key={i}
              x={Math.round(be)}
              stroke="#fbbf24"
              strokeWidth={1}
              label={{ value: `$${Math.round(be).toLocaleString()}`, position: "insideTopRight", fill: "#fbbf24", fontSize: 8 }}
            />
          ))}

          {/* profit area (above zero) */}
          <Area
            type="monotone"
            dataKey="pnlPos"
            stroke="none"
            fill="url(#profit)"
            baseValue={0}
            legendType="none"
            activeDot={false}
            isAnimationActive={false}
          />
          {/* loss area (below zero) */}
          <Area
            type="monotone"
            dataKey="pnlNeg"
            stroke="none"
            fill="url(#loss)"
            baseValue={0}
            legendType="none"
            activeDot={false}
            isAnimationActive={false}
          />
          {/* payoff line — drawn on top */}
          <Area
            type="monotone"
            dataKey="pnl"
            stroke="#93c5fd"
            strokeWidth={2}
            fill="none"
            dot={false}
            activeDot={{ r: 3, fill: "#93c5fd" }}
            baseValue={0}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── PayoffBuilder ─────────────────────────────────────────────────────────────

interface PayoffBuilderProps {
  spot: number;
  confirmedLegs?: Omit<Leg, "id">[];
}

export function PayoffBuilder({ spot, confirmedLegs = [] }: PayoffBuilderProps) {
  const [legs, setLegs] = useState<Leg[]>([]);
  const nextId = useRef(1);
  const syncedCount = useRef(0);

  // Append newly confirmed on-chain legs as they arrive
  useEffect(() => {
    if (confirmedLegs.length > syncedCount.current) {
      const fresh = confirmedLegs.slice(syncedCount.current);
      setLegs(prev => [...prev, ...fresh.map(l => ({ ...l, id: nextId.current++ }))]);
      syncedCount.current = confirmedLegs.length;
    }
  }, [confirmedLegs.length]);

  const addLeg = () => {
    if (legs.length >= 3) return;
    setLegs(prev => [...prev, {
      id: nextId.current++,
      direction: "buy",
      isCall: true,
      strike: Math.round(spot / 50) * 50,
      amount: 1,
    }]);
  };

  const removeLeg = (id: number) => setLegs(prev => prev.filter(l => l.id !== id));

  const update = (id: number, patch: Partial<Omit<Leg, "id">>) =>
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));

  const applyPreset = (make: (s: number) => Omit<Leg, "id">[]) =>
    setLegs(make(spot).map(l => ({ ...l, id: nextId.current++ })));

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-white font-semibold text-sm">Payoff Builder</h3>
        <div className="flex gap-2 flex-wrap">
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => applyPreset(p.make)}
              className="text-xs px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={addLeg}
            disabled={legs.length >= 3}
            className="text-xs px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white font-semibold transition-colors"
          >
            + Leg
          </button>
        </div>
      </div>

      {legs.length > 0 && (
        <div className="space-y-2">
          {legs.map(leg => (
            <div key={leg.id} className="flex items-center gap-2 flex-wrap text-xs">
              {(["buy", "sell"] as const).map(d => (
                <button key={d} onClick={() => update(leg.id, { direction: d })}
                  className={`px-2 py-1 rounded font-semibold transition-colors ${
                    leg.direction === d
                      ? d === "buy" ? "bg-green-700 text-white" : "bg-red-700 text-white"
                      : "bg-gray-800 text-gray-500 hover:text-white"
                  }`}>
                  {d === "buy" ? "Buy" : "Sell"}
                </button>
              ))}
              {([true, false] as const).map(c => (
                <button key={String(c)} onClick={() => update(leg.id, { isCall: c })}
                  className={`px-2 py-1 rounded font-semibold transition-colors ${
                    leg.isCall === c ? "bg-blue-700 text-white" : "bg-gray-800 text-gray-500 hover:text-white"
                  }`}>
                  {c ? "Call" : "Put"}
                </button>
              ))}
              <span className="text-gray-600">K</span>
              <input
                type="number" value={leg.strike} step={50}
                onChange={e => update(leg.id, { strike: Number(e.target.value) })}
                className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white font-mono text-xs focus:outline-none focus:border-blue-600"
              />
              <span className="text-gray-600">×</span>
              <input
                type="number" value={leg.amount} min="0.1" step="0.1"
                onChange={e => update(leg.id, { amount: Number(e.target.value) })}
                className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white font-mono text-xs focus:outline-none focus:border-blue-600"
              />
              <span className="text-gray-700 font-mono">
                ~${estimatePremium(spot, leg.strike, leg.isCall).toFixed(0)}/contract
              </span>
              <button onClick={() => removeLeg(leg.id)} className="ml-auto text-gray-700 hover:text-red-400 transition-colors">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {legs.length > 0 ? (
        <PayoffChart legs={legs} spot={spot} />
      ) : (
        <div className="h-44 rounded-lg bg-gray-950 flex items-center justify-center text-gray-700 text-sm">
          Add legs or pick a strategy above
        </div>
      )}

      {legs.length > 0 && (
        <p className="text-xs text-gray-700">
          Premiums estimated at current spot · each leg is a separate <code className="text-gray-600">vault.buy()</code> call
        </p>
      )}
    </div>
  );
}
