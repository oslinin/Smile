"use client";

// 3-D volatility surface, rendered in the browser with Plotly — no Python
// service, so it works on the static and Vercel builds alike. The surface
// evolves as trades execute: every confirmed buy/sell bumps the traded tenor
// bucket by ±γ (the same feedback loop the on-chain OptionPricingHook applies),
// and the surface re-renders live. Drag to rotate; the state lives here.
//
// The model mirrors SmileMath.sol / OptionPricingHook and the former Python
// renderer (volsurface/server.py):
//   σ(K,T) = σ_tenor(T) · max(0.1, 1 + α·ln(K/S)² + β·ln(K/S))

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// α/β mirror the frontend smile (lib/options.ts) and SmileMath.sol.
const ALPHA = 2.0;
const BETA = 0.0;
const GAMMA = 0.005; // σ feedback per trade (0.5%)
const SIGMA_FLOOR = 0.05;
const SIGMA_CAP = 3.0;

// Tenor buckets in days: [0,7), [7,30), [30,90), [90,inf) — the term structure.
const TENOR_EDGES = [0, 7, 30, 90, Infinity];
const TENOR_LABELS = ["0-7d", "7-30d", "30-90d", "90d+"];
const DEFAULT_SIGMA_TENOR = [0.95, 0.85, 0.8, 0.72];

export interface SurfaceTrade {
  dte: number; // days to expiry of the traded leg → tenor bucket
  direction: "buy" | "sell"; // buy steepens σ, sellback decays it
  nonce: number; // increments per trade so effects re-fire
}

function bucketForDte(dte: number): number {
  for (let i = 0; i < TENOR_EDGES.length - 1; i++) {
    if (dte >= TENOR_EDGES[i] && dte < TENOR_EDGES[i + 1]) return i;
  }
  return TENOR_LABELS.length - 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// max(0.1, 1 + α·ln(m)² + β·ln(m)) — the smile in strike space (m = K/S).
function smileMultiplier(moneyness: number): number {
  const ln = Math.log(moneyness);
  return Math.max(0.1, 1 + ALPHA * ln * ln + BETA * ln);
}

function linspace(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

export function VolSurface({ spot, trade }: { spot: number; trade?: SurfaceTrade | null }) {
  const [sigmaTenor, setSigmaTenor] = useState<number[]>([...DEFAULT_SIGMA_TENOR]);
  const [trades, setTrades] = useState(0);
  const [ready, setReady] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const lastNonce = useRef<number | null>(null);

  const roundedSpot = Math.round(spot) || 3420;

  // A confirmed trade bumps the traded tenor bucket, mirroring OptionPricingHook.
  useEffect(() => {
    if (!trade || trade.nonce === lastNonce.current) return;
    lastNonce.current = trade.nonce;
    const idx = bucketForDte(trade.dte);
    const sign = trade.direction === "buy" ? 1 : -1; // buy steepens, sellback decays
    setSigmaTenor((prev) => {
      const next = [...prev];
      next[idx] = clamp(next[idx] + sign * GAMMA, SIGMA_FLOOR, SIGMA_CAP);
      return next;
    });
    setTrades((t) => t + 1);
  }, [trade]);

  const resetSurface = useCallback(() => {
    setSigmaTenor([...DEFAULT_SIGMA_TENOR]);
    setTrades(0);
  }, []);

  // The surface grid: moneyness 0.6–1.4 × DTE 1–180, σ clipped to [5%, 300%].
  const { strikes, dtes, z, atmZ } = useMemo(() => {
    const moneyness = linspace(0.6, 1.4, 48);
    const dteGrid = linspace(1, 180, 48);
    const strikeGrid = moneyness.map((m) => m * roundedSpot);
    const smile = moneyness.map(smileMultiplier);
    const tenor = dteGrid.map((d) => sigmaTenor[bucketForDte(d)]);
    // z[row=dte][col=strike] = σ_tenor(T) · smile(K/S) · 100
    const zGrid = tenor.map((tv) =>
      smile.map((sv) => clamp(tv * sv * 100, SIGMA_FLOOR * 100, SIGMA_CAP * 100)),
    );
    const atm = tenor.map((tv) => tv * 100); // ATM ridge at K = spot
    return { strikes: strikeGrid, dtes: dteGrid, z: zGrid, atmZ: atm };
  }, [roundedSpot, sigmaTenor]);

  useEffect(() => {
    let cancelled = false;
    const el = plotRef.current;
    if (!el) return;
    (async () => {
      const Plotly = (await import("plotly.js-dist-min")).default;
      if (cancelled || !plotRef.current) return;
      const data = [
        {
          type: "surface",
          x: strikes,
          y: dtes,
          z,
          colorscale: "Plasma",
          showscale: true,
          colorbar: { title: { text: "σ %", font: { color: "#9ca3af", size: 10 } }, tickfont: { color: "#9ca3af", size: 9 }, thickness: 12, len: 0.6, outlinewidth: 0 },
          contours: { z: { show: true, usecolormap: true, width: 1, project: { z: false } } },
          hovertemplate: "K $%{x:,.0f}<br>%{y:.0f}d<br>σ %{z:.1f}%<extra></extra>",
          opacity: 0.97,
        },
        {
          type: "scatter3d",
          mode: "lines",
          name: "ATM term structure",
          x: dtes.map(() => roundedSpot),
          y: dtes,
          z: atmZ,
          line: { color: "#22d3ee", width: 5 },
          hovertemplate: "ATM %{y:.0f}d · σ %{z:.1f}%<extra></extra>",
        },
      ];
      const axis = {
        color: "#9ca3af",
        gridcolor: "#1f2937",
        zerolinecolor: "#1f2937",
        backgroundcolor: "#050a16",
        showbackground: true,
        titlefont: { size: 11 },
        tickfont: { size: 9 },
      };
      const layout = {
        paper_bgcolor: "#030712",
        plot_bgcolor: "#030712",
        margin: { l: 0, r: 0, t: 0, b: 0 },
        showlegend: true,
        legend: { font: { color: "#e5e7eb", size: 10 }, bgcolor: "rgba(11,17,32,0.7)", x: 0, y: 1 },
        scene: {
          xaxis: { ...axis, title: { text: "Strike K ($)" } },
          yaxis: { ...axis, title: { text: "Days to expiry" } },
          zaxis: { ...axis, title: { text: "σ (%)" } },
          camera: { eye: { x: 1.7, y: -1.5, z: 0.9 } },
          aspectratio: { x: 1, y: 1, z: 0.6 },
        },
      };
      await Plotly.react(plotRef.current, data, layout, { displayModeBar: false, responsive: true });
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [strikes, dtes, z, atmZ, roundedSpot]);

  useEffect(() => {
    const el = plotRef.current;
    return () => {
      if (el) import("plotly.js-dist-min").then((m) => m.default.purge(el)).catch(() => {});
    };
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500 max-w-xl">
          Multiparameter vol surface{" "}
          <span className="text-gray-400">
            σ(K,T) = σ<sub>tenor</sub>(T)·max(0.1, 1 + α·ln(K/S)² + β·ln(K/S))
          </span>
          , rendered in the browser. Each trade bumps the traded tenor bucket by ±γ — the surface re-renders live. Drag to rotate.
        </p>
        <button
          onClick={resetSurface}
          className="text-[11px] text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-1 transition-colors"
        >
          Reset σ
        </button>
      </div>

      <div className="relative rounded-xl border border-gray-800 bg-[#030712] overflow-hidden min-h-[380px]">
        <div ref={plotRef} className="w-full" style={{ height: 420 }} />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">Rendering surface…</div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-gray-500">
        <span className="text-gray-400">σ tenor:</span>
        {TENOR_LABELS.map((lbl, i) => (
          <span key={lbl}>
            {lbl} <span className="text-fuchsia-300">{(sigmaTenor[i] * 100).toFixed(1)}%</span>
          </span>
        ))}
        <span className="text-gray-600">· γ={(GAMMA * 100).toFixed(1)}%/trade</span>
        <span className="text-gray-600">· {trades} trades</span>
      </div>
    </div>
  );
}
