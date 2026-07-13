"use client";

// Compact payoff chart for inline chat rendering. Recomputes the P&L series
// in the browser from the tool-call legs, so chart data never round-trips
// through the model. Chart styling mirrors PayoffBuilder's PayoffChart.

import { useMemo } from "react";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  type BuilderLeg,
  breakevens as findBreakevens,
  pnlSeries,
} from "@/lib/options";

export function ChatPayoffChart({ legs, spot }: { legs: BuilderLeg[]; spot: number }) {
  const data = useMemo(
    () =>
      pnlSeries(legs, spot, 120).map((p) => ({
        ...p,
        pnlPos: Math.max(p.expiry, 0),
        pnlNeg: Math.min(p.expiry, 0),
      })),
    [legs, spot]
  );
  const breakevens = useMemo(() => findBreakevens(data), [data]);
  if (data.length === 0) return null;

  return (
    <div className="rounded-lg bg-gray-950 p-1" style={{ height: 170 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 6, left: 8, bottom: 4 }}>
          <defs>
            <linearGradient id="cp-profit" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#22c55e" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="cp-loss" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#ef4444" stopOpacity={0.05} />
              <stop offset="95%" stopColor="#ef4444" stopOpacity={0.3} />
            </linearGradient>
          </defs>

          <XAxis
            dataKey="s"
            type="number"
            domain={[data[0].s, data[data.length - 1].s]}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
            tick={{ fill: "#6b7280", fontSize: 8 }}
            tickLine={false}
            axisLine={{ stroke: "#1f2937" }}
          />
          <YAxis
            tickFormatter={(v: number) => `$${v}`}
            tick={{ fill: "#6b7280", fontSize: 8 }}
            tickLine={false}
            axisLine={{ stroke: "#1f2937" }}
            width={44}
          />
          <Tooltip
            contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 6, fontSize: 10 }}
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
            label={{ value: "S", position: "top", fill: "#6b7280", fontSize: 8 }}
          />
          {breakevens.map((be, i) => (
            <ReferenceLine key={i} x={Math.round(be)} stroke="#fbbf24" strokeWidth={1} />
          ))}

          <Area type="monotone" dataKey="pnlPos" stroke="none" fill="url(#cp-profit)" baseValue={0} legendType="none" activeDot={false} isAnimationActive={false} />
          <Area type="monotone" dataKey="pnlNeg" stroke="none" fill="url(#cp-loss)" baseValue={0} legendType="none" activeDot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="now" stroke="#c084fc" strokeWidth={1.2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          <Area type="monotone" dataKey="expiry" stroke="#93c5fd" strokeWidth={1.6} fill="none" dot={false} baseValue={0} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
