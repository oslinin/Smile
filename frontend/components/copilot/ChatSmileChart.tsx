"use client";

// IV-vs-strike smile curve for inline chat rendering, with the ATM point and
// 25-delta wings marked. Data recomputed client-side from lib/options math.

import { useMemo } from "react";
import {
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DEFAULT_DTE, smileSigma, surfaceQuotes } from "@/lib/options";
import { smileCurve } from "@/lib/copilot/analytics";

export function ChatSmileChart({ spot, expiryDays = DEFAULT_DTE }: { spot: number; expiryDays?: number }) {
  const data = useMemo(() => smileCurve(spot).map((p) => ({ ...p, ivPct: p.iv * 100 })), [spot]);
  const quotes = useMemo(() => surfaceQuotes(spot, expiryDays / 365), [spot, expiryDays]);

  return (
    <div className="rounded-lg bg-gray-950 p-1" style={{ height: 160 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 6, left: 0, bottom: 4 }}>
          <XAxis
            dataKey="strike"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
            tick={{ fill: "#6b7280", fontSize: 8 }}
            tickLine={false}
            axisLine={{ stroke: "#1f2937" }}
          />
          <YAxis
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
            tick={{ fill: "#6b7280", fontSize: 8 }}
            tickLine={false}
            axisLine={{ stroke: "#1f2937" }}
            width={38}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{ background: "#111827", border: "1px solid #374151", borderRadius: 6, fontSize: 10 }}
            labelFormatter={(v) => `K = $${Number(v).toLocaleString()}`}
            formatter={(v) => [`${Number(v).toFixed(1)}%`, "implied vol"]}
          />
          <ReferenceLine
            x={Math.round(spot)}
            stroke="#4b5563"
            strokeDasharray="4 3"
            label={{ value: "ATM", position: "top", fill: "#6b7280", fontSize: 8 }}
          />
          <ReferenceDot x={Math.round(quotes.k25put)} y={smileSigma(spot, quotes.k25put) * 100} r={3} fill="#f87171" stroke="none" label={{ value: "25Δp", position: "top", fill: "#f87171", fontSize: 8 }} />
          <ReferenceDot x={Math.round(quotes.k25call)} y={smileSigma(spot, quotes.k25call) * 100} r={3} fill="#4ade80" stroke="none" label={{ value: "25Δc", position: "top", fill: "#4ade80", fontSize: 8 }} />
          <Line type="monotone" dataKey="ivPct" stroke="#93c5fd" strokeWidth={1.6} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
