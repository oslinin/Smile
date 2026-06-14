"use client";

import { useReadContract } from "wagmi";
import { useEffect, useState } from "react";
import { CONTRACTS } from "@/config/wagmi";

const PRICING_ENGINE_ABI = [
  {
    name: "quote",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "spot", type: "uint256" },
          { name: "strike", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "sigmaGlobal", type: "uint256" },
          { name: "alpha", type: "uint256" },
          { name: "isBuy", type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "premium", type: "uint256" }],
  },
] as const;

const WAD = BigInt("1000000000000000000");
const SIGMA_GLOBAL = (BigInt(80) * WAD) / BigInt(100); // 80%
const ALPHA = BigInt(2) * WAD; // smile curvature
const STRIKES_OFFSETS = [-20, -10, -5, 0, 5, 10, 20]; // % from spot

const SIGMA_GLOBAL_NUM = 0.80;
const ALPHA_NUM = 2.0;

function smileVol(spot: number, strike: number): number {
  const lnKS = Math.log(strike / spot);
  return SIGMA_GLOBAL_NUM * (1 + ALPHA_NUM * lnKS * lnKS);
}

// Abramowitz & Stegun 26.2.17 — max error 1.5e-7
function normalCDF(x: number): number {
  const p = 0.3275911;
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const poly = t * (a[0] + t * (a[1] + t * (a[2] + t * (a[3] + t * a[4]))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x)));
}

function callDelta(spot: number, strike: number, sigma: number, T: number): number {
  if (T <= 0) return spot > strike ? 1 : 0;
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return normalCDF(d1);
}

interface Quote {
  strike: number;
  bid: string;
  ask: string;
  iv: string;
}

function useOptionQuote(spot: number, strike: number, expiry: number, isBuy: boolean) {
  const spotWAD = BigInt(Math.round(spot * 1e18));
  const strikeWAD = BigInt(Math.round(strike * 1e18));
  const expiryBig = BigInt(expiry);

  return useReadContract({
    address: CONTRACTS.pricingEngine as `0x${string}`,
    abi: PRICING_ENGINE_ABI,
    functionName: "quote",
    args: [{ spot: spotWAD, strike: strikeWAD, expiry: expiryBig, sigmaGlobal: SIGMA_GLOBAL, alpha: ALPHA, isBuy }],
    query: { enabled: !!CONTRACTS.pricingEngine && spot > 0 },
  });
}

function formatWAD(val: bigint | undefined): string {
  if (val === undefined) return "…";
  const dollars = Number(val) / 1e18;
  return `$${dollars.toFixed(2)}`;
}

/** Single-row quote fetcher for one strike. */
function StrikeRow({ spot, strike, expiry }: { spot: number; strike: number; expiry: number }) {
  const bid = useOptionQuote(spot, strike, expiry, false);
  const ask = useOptionQuote(spot, strike, expiry, true);
  const moneyness = ((strike - spot) / spot) * 100;
  const T = Math.max(0, (expiry - Date.now() / 1000) / (365 * 24 * 3600));
  const sigma = smileVol(spot, strike);
  const delta = callDelta(spot, strike, sigma, T);

  return (
    <tr className={`border-b border-gray-800 ${Math.abs(moneyness) < 1 ? "bg-blue-950/40" : ""}`}>
      <td className="py-2 px-3 text-right font-mono text-sm">
        ${strike.toLocaleString()}
      </td>
      <td className="py-2 px-3 text-center font-mono text-sm text-purple-400">
        {delta.toFixed(2)}
      </td>
      <td className="py-2 px-3 text-center text-gray-400 text-xs">
        {moneyness > 0 ? "+" : ""}{moneyness.toFixed(1)}%
      </td>
      <td className="py-2 px-3 text-right font-mono text-sm text-green-400">
        {bid.isLoading ? "…" : bid.error ? "–" : formatWAD(bid.data as bigint)}
      </td>
      <td className="py-2 px-3 text-right font-mono text-sm text-red-400">
        {ask.isLoading ? "…" : ask.error ? "–" : formatWAD(ask.data as bigint)}
      </td>
      <td className="py-2 px-3 text-right text-xs text-gray-500">
        {ask.data ? `${(sigma * 100).toFixed(1)}%` : "–"}
      </td>
    </tr>
  );
}

export function OptionMatrix({ spot }: { spot: number }) {
  const [expiry, setExpiry] = useState(0);

  useEffect(() => {
    // 30 days from now
    setExpiry(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  }, []);

  const strikes = STRIKES_OFFSETS.map((pct) =>
    Math.round((spot * (1 + pct / 100)) / 50) * 50
  );

  if (!CONTRACTS.pricingEngine) {
    return (
      <div className="text-gray-500 text-sm">
        Set NEXT_PUBLIC_PRICING_ENGINE to enable live quotes.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-white">
        <thead>
          <tr className="border-b border-gray-700 bg-gray-900 text-gray-400 text-xs uppercase">
            <th className="py-2 px-3 text-right">Strike</th>
            <th className="py-2 px-3 text-center">Delta</th>
            <th className="py-2 px-3 text-center">Moneyness</th>
            <th className="py-2 px-3 text-right">Bid</th>
            <th className="py-2 px-3 text-right">Ask</th>
            <th className="py-2 px-3 text-right">IV</th>
          </tr>
        </thead>
        <tbody>
          {expiry > 0 &&
            strikes.map((k) => (
              <StrikeRow key={k} spot={spot} strike={k} expiry={expiry} />
            ))}
        </tbody>
      </table>
    </div>
  );
}
