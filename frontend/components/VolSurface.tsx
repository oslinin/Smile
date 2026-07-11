"use client";

// 3-D volatility surface rendered by the Python service in ../../volsurface.
// The surface evolves as trades execute: every confirmed buy/sell is POSTed to
// /trade, which bumps the traded tenor bucket by ±γ (the same feedback loop the
// on-chain OptionPricingHook applies), then we re-fetch the freshly rendered PNG.
//
// Start the renderer with `volsurface/run.sh` (or it comes up with `./local.sh`).
// When it isn't running the panel shows a hint instead of a broken image — so
// the static GitHub Pages build degrades gracefully.

import { useCallback, useEffect, useRef, useState } from "react";

const BASE = (process.env.NEXT_PUBLIC_VOLSURFACE_URL ?? "http://localhost:8000").replace(/\/$/, "");

// α/β mirror the frontend smile (lib/options.ts) and SmileMath.sol.
const ALPHA = 2.0;
const BETA = 0.0;

export interface SurfaceTrade {
  dte: number;                    // days to expiry of the traded leg → tenor bucket
  direction: "buy" | "sell";      // buy steepens σ, sellback decays it
  nonce: number;                  // increments per trade so effects re-fire
}

interface SurfaceState {
  sigma_tenor: number[];
  tenor_labels: string[];
  gamma: number;
  trades: number;
}

export function VolSurface({ spot, trade }: { spot: number; trade?: SurfaceTrade | null }) {
  const [version, setVersion] = useState(0);       // cache-buster for the PNG
  const [azim, setAzim] = useState(-58);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [info, setInfo] = useState<SurfaceState | null>(null);
  const lastNonce = useRef<number | null>(null);

  const roundedSpot = Math.round(spot);
  const src = `${BASE}/surface.png?spot=${roundedSpot}&alpha=${ALPHA}&beta=${BETA}&azim=${azim}&v=${version}`;

  const refreshState = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/state`, { cache: "no-store" });
      if (r.ok) setInfo(await r.json());
    } catch {
      /* service down — the <img> onError path drives the fallback UI */
    }
  }, []);

  useEffect(() => { refreshState(); }, [refreshState]);

  // Re-render when spot moves (debounced so live spot ticks don't thrash it).
  useEffect(() => {
    const t = setTimeout(() => setVersion((v) => v + 1), 400);
    return () => clearTimeout(t);
  }, [roundedSpot]);

  // A confirmed trade mutates the surface: bump the bucket, then re-render.
  useEffect(() => {
    if (!trade || trade.nonce === lastNonce.current) return;
    lastNonce.current = trade.nonce;
    (async () => {
      try {
        await fetch(`${BASE}/trade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dte: trade.dte, direction: trade.direction }),
        });
        await refreshState();
        setVersion((v) => v + 1);
      } catch {
        /* ignore — panel falls back if the renderer is offline */
      }
    })();
  }, [trade, refreshState]);

  const resetSurface = async () => {
    try {
      await fetch(`${BASE}/reset`, { method: "POST" });
      await refreshState();
      setVersion((v) => v + 1);
    } catch { /* offline */ }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-gray-500 max-w-xl">
          Multiparameter vol surface{" "}
          <span className="text-gray-400">σ(K,T) = σ<sub>tenor</sub>(T)·max(0.1, 1 + α·ln(K/S)² + β·ln(K/S))</span>,
          rendered in Python (matplotlib). Each trade bumps the traded tenor bucket
          by ±γ — the surface re-renders live.
        </p>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-gray-500 flex items-center gap-1.5">
            rotate
            <input
              type="range" min={-120} max={30} value={azim}
              onChange={(e) => setAzim(Number(e.target.value))}
              className="w-24 accent-fuchsia-500"
            />
          </label>
          <button
            onClick={resetSurface}
            className="text-[11px] text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-1 transition-colors"
          >
            Reset σ
          </button>
        </div>
      </div>

      <div className="relative rounded-xl border border-gray-800 bg-[#030712] overflow-hidden min-h-[360px] flex items-center justify-center">
        {status === "error" ? (
          <div className="text-center px-6 py-16 space-y-2">
            <p className="text-sm text-gray-300 font-semibold">Vol-surface renderer offline</p>
            <p className="text-xs text-gray-500 max-w-sm mx-auto">
              Start the Python service to see the live surface:
            </p>
            <code className="inline-block text-[11px] text-fuchsia-300 bg-gray-900 border border-gray-800 rounded px-2 py-1 mt-1">
              ./volsurface/run.sh
            </code>
            <p className="text-[11px] text-gray-600">
              expected at <span className="font-mono">{BASE}</span> · then{" "}
              <button onClick={() => { setStatus("loading"); setVersion((v) => v + 1); }} className="underline hover:text-gray-400">retry</button>
            </p>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt="Volatility surface"
            className="w-full h-auto max-w-[820px]"
            onLoad={() => setStatus("ok")}
            onError={() => setStatus("error")}
          />
        )}
      </div>

      {info && status === "ok" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono text-gray-500">
          <span className="text-gray-400">σ tenor:</span>
          {info.tenor_labels.map((lbl, i) => (
            <span key={lbl}>
              {lbl} <span className="text-fuchsia-300">{(info.sigma_tenor[i] * 100).toFixed(1)}%</span>
            </span>
          ))}
          <span className="text-gray-600">· γ={(info.gamma * 100).toFixed(1)}%/trade</span>
          <span className="text-gray-600">· {info.trades} trades</span>
        </div>
      )}
    </div>
  );
}
