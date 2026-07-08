"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import {
  type BuilderLeg,
  DEFAULT_DTE,
  protocolPremium,
  pnlSeries,
  breakevens as findBreakevens,
  strategyStats,
} from "@/lib/options";
import { STRATEGIES, OUTLOOKS, type Outlook } from "@/lib/strategyCatalog";

export interface Leg extends BuilderLeg {
  id: number;
}

const MAX_LEGS = 6;

// ── Payoff chart ──────────────────────────────────────────────────────────────

function PayoffChart({ legs, spot }: { legs: Leg[]; spot: number }) {
  const data = useMemo(() => {
    const points = pnlSeries(legs, spot).map((p) => ({
      ...p,
      pnlPos: Math.max(p.expiry, 0),
      pnlNeg: Math.min(p.expiry, 0),
    }));
    return points;
  }, [legs, spot]);

  const breakevens = useMemo(() => findBreakevens(data), [data]);
  const spotMin = data[0]?.s ?? spot * 0.6;
  const spotMax = data[data.length - 1]?.s ?? spot * 1.4;

  return (
    <div className="rounded-lg bg-gray-950 p-2" style={{ height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 8, left: 48, bottom: 16 }}>
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
            formatter={(v, name) => [
              `$${Number(v).toFixed(2)}`,
              name === "now" ? "P&L today" : name === "expiry" ? "P&L at expiry" : null,
            ]}
          />

          <ReferenceLine y={0} stroke="#374151" strokeWidth={1} />
          <ReferenceLine
            x={Math.round(spot)}
            stroke="#4b5563"
            strokeDasharray="4 3"
            label={{ value: `S`, position: "top", fill: "#6b7280", fontSize: 9 }}
          />
          {breakevens.map((be, i) => (
            <ReferenceLine
              key={i}
              x={Math.round(be)}
              stroke="#fbbf24"
              strokeWidth={1}
              label={{ value: `$${Math.round(be).toLocaleString()}`, position: "insideTopRight", fill: "#fbbf24", fontSize: 8 }}
            />
          ))}

          <Area type="monotone" dataKey="pnlPos" stroke="none" fill="url(#profit)" baseValue={0} legendType="none" activeDot={false} isAnimationActive={false} />
          <Area type="monotone" dataKey="pnlNeg" stroke="none" fill="url(#loss)" baseValue={0} legendType="none" activeDot={false} isAnimationActive={false} />

          {/* T+0 value curve (dashed) — strategy marked to model today */}
          <Line type="monotone" dataKey="now" stroke="#c084fc" strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={{ r: 2, fill: "#c084fc" }} isAnimationActive={false} />
          {/* expiry payoff line */}
          <Area type="monotone" dataKey="expiry" stroke="#93c5fd" strokeWidth={2} fill="none" dot={false} activeDot={{ r: 3, fill: "#93c5fd" }} baseValue={0} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Stats strip ───────────────────────────────────────────────────────────────

function fmtUsd(v: number | null): string {
  if (v === null) return "∞";
  const sign = v < 0 ? "−" : "";
  return `${sign}$${Math.abs(v).toFixed(0)}`;
}

function StatsStrip({ legs, spot }: { legs: Leg[]; spot: number }) {
  const stats = useMemo(() => {
    const data = pnlSeries(legs, spot);
    return strategyStats(legs, spot, data);
  }, [legs, spot]);

  const cells: [string, string, string?][] = [
    [stats.cost >= 0 ? "Net debit" : "Net credit", `$${Math.abs(stats.cost).toFixed(0)}`],
    ["Max profit", fmtUsd(stats.maxProfit), "text-green-400"],
    ["Max loss", fmtUsd(stats.maxLoss), "text-red-400"],
    ["Prob. profit", `${(stats.pop * 100).toFixed(0)}%`],
    ["Δ", stats.greeks.delta.toFixed(2)],
    ["Γ", stats.greeks.gamma.toFixed(4)],
    ["Θ/day", `$${stats.greeks.theta.toFixed(2)}`],
    ["Vega", `$${stats.greeks.vega.toFixed(2)}`],
  ];

  return (
    <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
      {cells.map(([label, value, cls]) => (
        <div key={label} className="rounded bg-gray-950 px-2 py-1.5 text-center">
          <div className="text-[9px] uppercase tracking-wide text-gray-600">{label}</div>
          <div className={`text-xs font-mono ${cls ?? "text-gray-200"}`}>{value}</div>
        </div>
      ))}
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
  const [outlook, setOutlook] = useState<Outlook>("bullish");
  const [activeStrategy, setActiveStrategy] = useState<string | null>(null);
  const nextId = useRef(1);
  const syncedCount = useRef(0);

  // Append newly confirmed on-chain legs as they arrive
  useEffect(() => {
    if (confirmedLegs.length > syncedCount.current) {
      const fresh = confirmedLegs.slice(syncedCount.current);
      setLegs(prev => [...prev, ...fresh.map(l => ({ ...l, id: nextId.current++ }))]);
      syncedCount.current = confirmedLegs.length;
      setActiveStrategy(null);
    }
  }, [confirmedLegs.length]);

  const addLeg = () => {
    if (legs.length >= MAX_LEGS) return;
    setActiveStrategy(null);
    setLegs(prev => [...prev, {
      id: nextId.current++,
      direction: "buy",
      isCall: true,
      strike: Math.round(spot / 50) * 50,
      amount: 1,
      expiryDays: DEFAULT_DTE,
    }]);
  };

  const removeLeg = (id: number) => {
    setActiveStrategy(null);
    setLegs(prev => prev.filter(l => l.id !== id));
  };

  const update = (id: number, patch: Partial<Omit<Leg, "id">>) => {
    setActiveStrategy(null);
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
  };

  const applyStrategy = (name: string) => {
    const def = STRATEGIES.find(s => s.name === name);
    if (!def) return;
    setLegs(def.build(spot).map(l => ({ ...l, id: nextId.current++ })));
    setActiveStrategy(name);
  };

  const shown = STRATEGIES.filter(s => s.outlook === outlook);
  const activeDef = STRATEGIES.find(s => s.name === activeStrategy);

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-white font-semibold text-sm">Strategy Builder</h3>
        <button
          onClick={addLeg}
          disabled={legs.length >= MAX_LEGS}
          className="text-xs px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white font-semibold transition-colors"
        >
          + Custom Leg
        </button>
      </div>

      {/* Outlook tabs */}
      <div className="flex gap-1">
        {OUTLOOKS.map(o => (
          <button
            key={o.key}
            onClick={() => setOutlook(o.key)}
            className={`flex-1 py-1.5 rounded text-xs font-semibold transition-colors ${
              outlook === o.key
                ? o.key === "bullish" ? "bg-green-800 text-white"
                : o.key === "bearish" ? "bg-red-800 text-white"
                : o.key === "neutral" ? "bg-gray-600 text-white"
                : "bg-purple-800 text-white"
                : "bg-gray-800 text-gray-500 hover:text-white"
            }`}
          >
            {o.icon} {o.label}
          </button>
        ))}
      </div>

      {/* Strategy chips for the selected outlook */}
      <div className="flex gap-1.5 flex-wrap">
        {shown.map(s => (
          <button
            key={s.name}
            onClick={() => applyStrategy(s.name)}
            title={s.description}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              activeStrategy === s.name
                ? "bg-blue-700 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>

      {activeDef && (
        <p className="text-xs text-gray-500">{activeDef.description}</p>
      )}

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
              <span className="text-gray-600">DTE</span>
              <input
                type="number" value={leg.expiryDays ?? DEFAULT_DTE} min="1" step="1"
                onChange={e => update(leg.id, { expiryDays: Number(e.target.value) })}
                className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white font-mono text-xs focus:outline-none focus:border-blue-600"
              />
              <span className="text-gray-700 font-mono">
                ~${protocolPremium(spot, leg.strike, leg.isCall, (leg.expiryDays ?? DEFAULT_DTE) / 365).toFixed(0)}
              </span>
              <button onClick={() => removeLeg(leg.id)} className="ml-auto text-gray-700 hover:text-red-400 transition-colors">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {legs.length > 0 ? (
        <>
          <PayoffChart legs={legs} spot={spot} />
          <StatsStrip legs={legs} spot={spot} />
        </>
      ) : (
        <div className="h-44 rounded-lg bg-gray-950 flex items-center justify-center text-gray-700 text-sm">
          Pick a strategy above or add custom legs
        </div>
      )}

      {legs.length > 0 && (
        <p className="text-xs text-gray-700">
          Solid line: P&L at nearest expiry · dashed: value today (T+0) · premiums quoted with the
          on-chain smile · buy legs execute via <code className="text-gray-600">vault.buy()</code>, sell legs
          via LP range writes
        </p>
      )}
    </div>
  );
}
