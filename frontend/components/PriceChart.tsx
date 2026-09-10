"use client";

// TradingView's own open-source engine (lightweight-charts, Apache-2.0)
// drawing real ETH candles with the strategy you are building on top of
// them: every leg's strike, the breakevens, and the protocol's spot. Market
// data is public spot-exchange history (Coinbase, Kraken fallback) — it is
// context for the trade, the protocol itself prices off its oracle.

import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, ColorType, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { type BuilderLeg, pnlSeries, breakevens as findBreakevens, DEFAULT_DTE } from "@/lib/options";

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

export function PriceChart({ spot, legs }: { spot: number; legs: BuilderLeg[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const [source, setSource] = useState<string>("loading market data…");
  const [last, setLast] = useState<number | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      layout: { background: { type: ColorType.Solid, color: "#030712" }, textColor: "#9ca3af", fontSize: 11 },
      grid: { vertLines: { color: "#111827" }, horzLines: { color: "#111827" } },
      rightPriceScale: { borderColor: "#1f2937" },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: "#1f2937" }, vertLine: { labelBackgroundColor: "#1f2937" } },
      height: 320,
    });
    const s = c.addSeries(CandlestickSeries, { upColor: "#22c55e", downColor: "#ef4444", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#ef4444" });
    chart.current = c;
    series.current = s;
    let cancelled = false;
    fetchCandles()
      .then(({ candles, source: src }) => {
        if (cancelled || candles.length === 0) return;
        s.setData(candles);
        c.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 120), to: candles.length + 12 });
        setSource(src);
        setLast(candles[candles.length - 1].close);
      })
      .catch(() => setSource("market data unavailable"));
    const ro = new ResizeObserver(() => { if (box.current) c.applyOptions({ width: box.current.clientWidth }); });
    ro.observe(box.current);
    return () => { cancelled = true; ro.disconnect(); c.remove(); chart.current = null; series.current = null; };
  }, []);

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

  const dte = legs.length ? Math.min(...legs.map((l) => l.expiryDays ?? DEFAULT_DTE)) : null;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950 overflow-hidden">
      <div className="flex items-center justify-between flex-wrap gap-2 px-3 py-2 text-[11px] text-gray-500 border-b border-gray-800">
        <span><span className="text-gray-300 font-semibold">ETH/USD</span> · {source}{last ? ` · last ${last.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}</span>
        <span>
          <span className="text-blue-400">····</span> Smile spot ${spot.toLocaleString()}
          {legs.length > 0 && <> · <span className="text-green-400">—</span> long / <span className="text-red-400">—</span> short strikes · <span className="text-yellow-300">- -</span> breakeven{dte !== null ? ` · nearest expiry in ${dte}d` : ""}</>}
        </span>
      </div>
      <div ref={box} className="w-full" />
    </div>
  );
}
