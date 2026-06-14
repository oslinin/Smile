"use client";

import { useAccount, useReadContract, useBalance } from "wagmi";
import { useState, useEffect } from "react";
import { CONTRACTS } from "@/config/wagmi";
import type { ActiveAuth } from "@/components/AuthorizeRange";

const VAULT_ABI = [
  {
    name: "authorizations",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }],
    outputs: [
      { name: "lp", type: "address" },
      { name: "strikeMin", type: "uint256" },
      { name: "strikeMax", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "maxCollateral", type: "uint256" },
      { name: "usedCollateral", type: "uint256" },
      { name: "collateralToken", type: "address" },
      { name: "isCall", type: "bool" },
      { name: "active", type: "bool" },
    ],
  },
] as const;

interface LPDashboardProps {
  activeAuth?: ActiveAuth | null;
}

export function LPDashboard({ activeAuth }: LPDashboardProps) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { data: ethBalance } = useBalance({ address });

  const { data: auth } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "authorizations",
    args: [activeAuth?.authId ?? BigInt(0)],
    query: {
      enabled: !!CONTRACTS.aquaVault && !!activeAuth,
      refetchInterval: 6000,
    },
  });

  if (!mounted || !isConnected) {
    return (
      <div className="rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">
        {mounted ? "Connect wallet to view LP dashboard." : null}
      </div>
    );
  }

  const walletEth = ethBalance ? (Number(ethBalance.value) / 1e18) : null;

  const isCall = activeAuth?.isCall ?? true;
  const decimals = isCall ? 1e18 : 1e6;
  const symbol = isCall ? "ETH" : "USDC";

  const maxCollateral = auth?.[4] !== undefined ? Number(auth[4]) / decimals : null;
  const usedCollateral = auth?.[5] !== undefined ? Number(auth[5]) / decimals : null;
  const availableCollateral = maxCollateral !== null && usedCollateral !== null
    ? maxCollateral - usedCollateral
    : null;

  const strikeMin = activeAuth?.strikeMin;
  const strikeMax = activeAuth?.strikeMax;
  const expiry = activeAuth?.expiry;
  const expiryDate = expiry ? new Date(expiry * 1000).toLocaleDateString() : null;
  const daysLeft = expiry ? Math.max(0, Math.round((expiry - Date.now() / 1000) / 86400)) : null;

  const fmt = (v: number | null, decimals = 4) =>
    v === null ? "…" : v.toLocaleString(undefined, { maximumFractionDigits: decimals });

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <h3 className="text-white font-semibold text-sm">LP Dashboard</h3>

      {/* Wallet */}
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Wallet ETH"
          value={walletEth !== null ? `${fmt(walletEth)} ETH` : "…"}
          sub="Self-custodied — earning until called"
        />
        <Stat
          label="Locked Collateral"
          value={usedCollateral !== null ? `${fmt(usedCollateral, 4)} ${symbol}` : activeAuth ? "…" : "—"}
          sub={usedCollateral === 0 || usedCollateral === null
            ? "Pulled JIT by Aqua on match — none locked yet"
            : "Pulled JIT by Aqua · released on close"}
          highlight={usedCollateral !== null && usedCollateral > 0}
        />
      </div>

      {/* Authorization details */}
      {activeAuth ? (
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400 uppercase tracking-widest">Active Authorization</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${isCall ? "bg-blue-900/60 text-blue-300" : "bg-orange-900/60 text-orange-300"}`}>
              Auth #{String(activeAuth.authId)} · {isCall ? "Covered Calls" : "Cash-Secured Puts"}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-gray-500 mb-0.5">Strike Range</div>
              <div className="font-mono text-white">
                {strikeMin === strikeMax
                  ? `$${strikeMin?.toLocaleString()}`
                  : `$${strikeMin?.toLocaleString()} – $${strikeMax?.toLocaleString()}`}
              </div>
            </div>
            <div>
              <div className="text-gray-500 mb-0.5">Max Collateral</div>
              <div className="font-mono text-white">
                {maxCollateral !== null ? `${fmt(maxCollateral, 4)} ${symbol}` : "…"}
              </div>
            </div>
            <div>
              <div className="text-gray-500 mb-0.5">Expires</div>
              <div className="font-mono text-white">
                {expiryDate ?? "…"}
                {daysLeft !== null && (
                  <span className={`ml-1.5 ${daysLeft <= 3 ? "text-red-400" : "text-gray-500"}`}>
                    ({daysLeft}d)
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Utilization bar */}
          {maxCollateral !== null && usedCollateral !== null && maxCollateral > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-gray-500">
                <span>
                  <span className="text-white font-mono">{fmt(usedCollateral, 4)}</span>
                  {" "}used of{" "}
                  <span className="text-white font-mono">{fmt(maxCollateral, 4)} {symbol}</span>
                </span>
                <span className="text-gray-400">
                  {fmt(availableCollateral, 4)} {symbol} free in wallet
                </span>
              </div>
              <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all"
                  style={{ width: `${Math.min((usedCollateral / maxCollateral) * 100, 100).toFixed(1)}%` }}
                />
              </div>
              {usedCollateral === 0 && (
                <p className="text-gray-500 text-xs mt-1">
                  Your collateral stays in your wallet. It will be pulled just-in-time by 1inch Aqua when a buyer matches a strike in your range.
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-gray-600 text-xs">
          Authorize a strike range on the first tab to see your LP position here.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Total Value Backing Quotes"
          value={walletEth !== null ? `${fmt(walletEth)} ETH` : "…"}
          sub="Available to back new options"
          highlight
        />
        <Stat
          label="Active Positions"
          value={usedCollateral !== null && usedCollateral > 0 ? "≥1" : "0"}
          sub="Options sold · collateral locked"
        />
      </div>
    </div>
  );
}

function Stat({ label, value, sub, highlight }: {
  label: string; value: string; sub: string; highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-blue-950/60 border border-blue-800" : "bg-gray-800"}`}>
      <div className="text-gray-400 text-xs">{label}</div>
      <div className={`text-lg font-mono font-semibold mt-1 ${highlight ? "text-blue-300" : "text-white"}`}>{value}</div>
      <div className="text-gray-500 text-xs mt-0.5">{sub}</div>
    </div>
  );
}
