"use client";

// TradingView's own open-source engine (lightweight-charts, Apache-2.0)
// drawing real ETH candles with the strategy you are building on top of
// them: every leg's strike, the breakevens, and the protocol's spot. Market
// data is public spot-exchange history (Coinbase, Kraken fallback) — it is
// context for the trade, the protocol itself prices off its oracle.
//
// Below the candles: the traded tape of one instrument — premium per unit
// at every fill, and the implied vol that premium means (Black-Scholes
// inverted in the browser, spot = the candle close at that hour). The tape
// comes from The Graph on public chains and from the vault's event log on
// Anvil (lib/tape.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { Address, PublicClient } from "viem";
import { blackScholes } from "black-scholes";
import { createChart, CandlestickSeries, LineSeries, ColorType, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { type BuilderLeg, pnlSeries, breakevens as findBreakevens, DEFAULT_DTE, RISK_FREE_RATE } from "@/lib/options";
import { readTape, type Tape, type TapeFill } from "@/lib/tape";
import { CONTRACTS } from "@/config/wagmi";

type Candle = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

async function fetchCandles(): Promise<{ candles: Candle[]; source: string }> {
  try {
    const r = await fetch("https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=3600");
    if (!r.ok) throw new Error(String(r.status));
    const rows = (await r.json()) as number[][]; // [time, low, high, open, close, volume], newest first
    const candles = rows.map((c) => ({ time: c[0] as UTCTimestamp, low: c[1], high: c[2], open: c[3], close: c[4] })).sort((a, b) => a.time - b.time);
    return { candles, source: "Coinbase ETH-USD · 1h" };
  } catch {
    const r = await fetch("https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=60");
    const j = (await r.json()) as { result: Record<string, (string | number)[][]> };
    const key = Object.keys(j.result).find((k) => k !== "last") ?? "";
    const candles = (j.result[key] ?? []).map((c) => ({ time: Number(c[0]) as UTCTimestamp, open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]) }));
    return { candles, source: "Kraken ETH/USD · 1h" };
  }
}

// Bisection on sigma ∈ [0.01, 5]: BS price is monotone in vol, 60 halvings
// is far below float precision. null when the premium is under the floor
// (below intrinsic — no vol explains it).
function impliedVol(premium: number, spot: number, strike: number, tYears: number, isCall: boolean): number | null {
  const type = isCall ? "call" : "put";
  let lo = 0.01, hi = 5;
  if (blackScholes(spot, strike, tYears, lo, RISK_FREE_RATE, type) > premium) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (blackScholes(spot, strike, tYears, mid, RISK_FREE_RATE, type) > premium) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

const label = (f: TapeFill) => `${f.isCall ? "C" : "P"} ${f.strike} · ${new Date(f.expiry * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;

export function PriceChart({ spot, legs }: { spot: number; legs: BuilderLeg[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const premSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const ivSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const [source, setSource] = useState<string>("loading market data…");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [tape, setTape] = useState<Tape | null>(null);
  const [sel, setSel] = useState<string>("");
  const { chainId } = useAccount();
  const publicClient = usePublicClient();

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      layout: { background: { type: ColorType.Solid, color: "#030712" }, textColor: "#9ca3af", fontSize: 11 },
      grid: { vertLines: { color: "#111827" }, horzLines: { color: "#111827" } },
      rightPriceScale: { borderColor: "#1f2937", scaleMargins: { top: 0.05, bottom: 0.38 } },
      leftPriceScale: { borderColor: "#1f2937", visible: false, scaleMargins: { top: 0.68, bottom: 0.02 } },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: "#1f2937" }, vertLine: { labelBackgroundColor: "#1f2937" } },
      height: 320,
    });
    const s = c.addSeries(CandlestickSeries, { upColor: "#22c55e", downColor: "#ef4444", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#ef4444" });
    // Tape lines live in the lower third: premium on the (left) price axis,
    // IV on an overlay scale with the same margins.
    premSeries.current = c.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 2, priceScaleId: "left", priceFormat: { type: "price", precision: 2, minMove: 0.01 }, title: "premium" });
    ivSeries.current = c.addSeries(LineSeries, { color: "#f472b6", lineWidth: 2, priceScaleId: "iv", priceFormat: { type: "percent", precision: 1, minMove: 0.1 }, title: "IV" });
    c.priceScale("iv").applyOptions({ scaleMargins: { top: 0.68, bottom: 0.02 } });
    chart.current = c;
    series.current = s;
    let cancelled = false;
    fetchCandles()
      .then(({ candles: cs, source: src }) => {
        if (cancelled || cs.length === 0) return;
        setCandles(cs);
        s.setData(cs);
        c.timeScale().setVisibleLogicalRange({ from: Math.max(0, cs.length - 120), to: cs.length + 12 });
        setSource(src);
      })
      .catch(() => setSource("market data unavailable"));
    const ro = new ResizeObserver(() => { if (box.current) c.applyOptions({ width: box.current.clientWidth }); });
    ro.observe(box.current);
    return () => { cancelled = true; ro.disconnect(); c.remove(); chart.current = null; series.current = null; premSeries.current = null; ivSeries.current = null; };
  }, []);

  // The tape: once per chain, re-polled every minute. Any failure (no
  // subgraph, no vault, RPC down) just leaves the chart as it was.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      readTape({ chainId, client: publicClient as PublicClient | undefined, vault: (CONTRACTS.aquaVault || undefined) as Address | undefined })
        .then((t) => { if (!cancelled) setTape(t); })
        .catch(() => { if (!cancelled) setTape(null); });
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [chainId, publicClient]);

  // Instruments that traded, most fills first.
  const instruments = useMemo(() => {
    const by = new Map<string, TapeFill[]>();
    for (const f of tape?.fills ?? []) by.set(f.optionToken, [...(by.get(f.optionToken) ?? []), f]);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([token, fills]) => ({ token, fills, label: label(fills[0]) }));
  }, [tape]);
  const current = instruments.find((i) => i.token === sel) ?? instruments[0];

  // Points for the selected instrument: one per fill, strictly increasing
  // time (lightweight-charts requirement — equal timestamps keep the last).
  const points = useMemo(() => {
    const out = new Map<number, { premium: number; iv: number | null }>();
    for (const f of [...(current?.fills ?? [])].sort((a, b) => a.timestamp - b.timestamp)) {
      // Spot at the fill = close of the last candle at or before it; Anvil's
      // warped clock can land outside the candle window, then the prop spot.
      const candle = candles.filter((k) => k.time <= f.timestamp).pop();
      const t = Math.max((f.expiry - f.timestamp) / 31_536_000, 1 / 365);
      out.set(f.timestamp, { premium: f.premiumPerUnit, iv: impliedVol(f.premiumPerUnit, candle?.close ?? spot, f.strike, t, f.isCall) });
    }
    return [...out.entries()].map(([time, v]) => ({ time: time as UTCTimestamp, ...v }));
  }, [current, spot, candles]);

  useEffect(() => {
    premSeries.current?.setData(points.map((p) => ({ time: p.time, value: p.premium })));
    ivSeries.current?.setData(points.flatMap((p) => (p.iv === null ? [] : [{ time: p.time, value: p.iv * 100 }])));
    chart.current?.applyOptions({ leftPriceScale: { visible: points.length > 0 } });
  }, [points]);

  // Redraw the strategy overlay whenever the legs or the spot change.
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = [];
    const add = (price: number, color: string, title: string, style = LineStyle.Solid, width: 1 | 2 = 1) =>
      lines.current.push(s.createPriceLine({ price, color, title, lineStyle: style, lineWidth: width, axisLabelVisible: true }));
    add(spot, "#60a5fa", "Smile spot", LineStyle.Dotted, 1);
    for (const leg of legs) {
      add(leg.strike, leg.direction === "buy" ? "#22c55e" : "#ef4444", `${leg.direction === "buy" ? "long" : "short"} ${leg.isCall ? "call" : "put"} ${leg.amount}×`, LineStyle.Solid, 2);
    }
    if (legs.length > 0) {
      for (const be of findBreakevens(pnlSeries(legs, spot))) add(Math.round(be), "#fbbf24", "breakeven", LineStyle.Dashed, 1);
    }
  }, [legs, spot]);

  const last = candles.at(-1)?.close ?? null;
  const dte = legs.length ? Math.min(...legs.map((l) => l.expiryDays ?? DEFAULT_DTE)) : null;
  const lastPt = points[points.length - 1];
  const lastIv = [...points].reverse().find((p) => p.iv !== null)?.iv ?? null;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
      <div className="flex items-center justify-between flex-wrap gap-2 px-3 py-2 text-[11px] text-gray-500 border-b border-gray-800">
        <span><span className="text-gray-300 font-semibold">ETH/USD</span> · {source}{last ? ` · last ${last.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}</span>
        <span>
          <span className="text-blue-400">····</span> Smile spot ${spot.toLocaleString()}
          {legs.length > 0 && <> · <span className="text-green-400">—</span> long / <span className="text-red-400">—</span> short strikes · <span className="text-yellow-300">- -</span> breakeven{dte !== null ? ` · nearest expiry in ${dte}d` : ""}</>}
        </span>
      </div>
      <div className="flex items-center justify-between flex-wrap gap-2 px-3 py-1.5 text-[11px] text-gray-500 border-b border-gray-800">
        {current ? (
          <>
            <span className="flex items-center gap-2">
              <span className="text-gray-300 font-semibold">Tape</span>
              <select value={current.token} onChange={(e) => setSel(e.target.value)} className="bg-gray-900 border border-gray-800 rounded px-1 py-0.5 text-gray-300">
                {instruments.map((i) => <option key={i.token} value={i.token}>{i.label} ({i.fills.length})</option>)}
              </select>
              · {tape?.source === "subgraph" ? "The Graph" : "Anvil event log"}
            </span>
            <span>
              <span className="text-violet-400">—</span> premium / unit{lastPt ? ` $${lastPt.premium.toFixed(2)}` : ""} · <span className="text-pink-400">—</span> implied vol{lastIv !== null ? ` ${(lastIv * 100).toFixed(1)}%` : ""}
            </span>
          </>
        ) : (
          <span><span className="text-gray-300 font-semibold">Tape</span> · no trades yet</span>
        )}
      </div>
      <div ref={box} className="w-full" />
    </div>
  );
}
