"use client";

// Trade-proposal card rendered from a propose_trade tool call: legs table,
// live stats (recomputed client-side with the same lib/options math the
// builder uses), inline payoff chart, and a button that loads the legs into
// the existing Payoff Builder. Execution stays in the existing UI flow.

import { useMemo } from "react";
import {
  type BuilderLeg,
  DEFAULT_DTE,
  pnlSeries,
  protocolPremium,
  strategyStats,
} from "@/lib/options";
import { ChatPayoffChart } from "./ChatPayoffChart";

function fmtUsd(v: number | null): string {
  if (v === null) return "∞";
  return `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(0)}`;
}

export function StrategyCard({
  name,
  rationale,
  legs,
  spot,
  onLoad,
}: {
  name: string;
  rationale: string;
  legs: BuilderLeg[];
  spot: number;
  onLoad?: (legs: BuilderLeg[], name: string) => void;
}) {
  const stats = useMemo(() => strategyStats(legs, spot, pnlSeries(legs, spot)), [legs, spot]);

  return (
    <div className="rounded-lg border border-blue-900/60 bg-gray-900 p-3 space-y-2 my-1">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-white">{name}</div>
        <span className="text-[10px] text-gray-500 uppercase tracking-wide">proposal</span>
      </div>
      <p className="text-xs text-gray-400">{rationale}</p>

      <table className="w-full text-[11px] font-mono">
        <thead>
          <tr className="text-gray-600 text-left">
            <th className="font-normal">side</th>
            <th className="font-normal">type</th>
            <th className="font-normal">strike</th>
            <th className="font-normal">qty</th>
            <th className="font-normal">DTE</th>
            <th className="font-normal text-right">premium</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l, i) => (
            <tr key={i} className="text-gray-300">
              <td className={l.direction === "buy" ? "text-green-400" : "text-red-400"}>{l.direction}</td>
              <td>{l.isCall ? "call" : "put"}</td>
              <td>${l.strike}</td>
              <td>{l.amount}</td>
              <td>{l.expiryDays ?? DEFAULT_DTE}d</td>
              <td className="text-right">
                ${protocolPremium(spot, l.strike, l.isCall, (l.expiryDays ?? DEFAULT_DTE) / 365).toFixed(0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ChatPayoffChart legs={legs} spot={spot} />

      <div className="grid grid-cols-4 gap-1 text-center">
        {(
          [
            [stats.cost >= 0 ? "debit" : "credit", `$${Math.abs(stats.cost).toFixed(0)}`, ""],
            ["max profit", fmtUsd(stats.maxProfit), "text-green-400"],
            ["max loss", fmtUsd(stats.maxLoss), "text-red-400"],
            ["prob. profit", `${(stats.pop * 100).toFixed(0)}%`, ""],
          ] as const
        ).map(([label, value, cls]) => (
          <div key={label} className="rounded bg-gray-950 px-1 py-1">
            <div className="text-[8px] uppercase tracking-wide text-gray-600">{label}</div>
            <div className={`text-[11px] font-mono ${cls || "text-gray-200"}`}>{value}</div>
          </div>
        ))}
      </div>

      {onLoad && (
        <button
          onClick={() => onLoad(legs, name)}
          className="w-full text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white font-semibold transition-colors"
        >
          Load into Payoff Builder →
        </button>
      )}
    </div>
  );
}
