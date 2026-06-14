"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { OptionMatrix } from "@/components/OptionMatrix";
import { LPDashboard } from "@/components/LPDashboard";
import { useState, useEffect } from "react";

const DEMO_SPOT = 3420;

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  const [showConnectors, setShowConnectors] = useState(false);

  // Only render wallet UI after hydration — avoids empty connectors on static pre-render
  useEffect(() => { setMounted(true); }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Options Marketplace</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            Non-custodial · 1inch Aqua JIT · Uniswap v4 Hooks · Chainlink CRE
          </p>
        </div>

        {!mounted ? (
          <button disabled className="bg-blue-600 opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">
            Connect Wallet
          </button>
        ) : isConnected ? (
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm font-mono">
              {address?.slice(0, 6)}…{address?.slice(-4)}
            </span>
            <button
              onClick={() => disconnect()}
              className="text-xs text-gray-500 hover:text-white border border-gray-700 px-3 py-1 rounded-lg"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="relative">
            <button
              onClick={() => setShowConnectors((v) => !v)}
              disabled={isPending}
              className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
            >
              {isPending ? "Connecting…" : "Connect Wallet"}
            </button>

            {showConnectors && (
              <div className="absolute right-0 mt-2 w-52 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-10 overflow-hidden">
                {connectors.length === 0 && (
                  <div className="px-4 py-3 text-sm text-gray-400">
                    No wallet detected.<br />
                    <a href="https://metamask.io" target="_blank" rel="noreferrer"
                       className="text-blue-400 underline">Install MetaMask</a>
                  </div>
                )}
                {connectors.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => { connect({ connector: c }); setShowConnectors(false); }}
                    className="w-full text-left px-4 py-3 text-sm text-white hover:bg-gray-800 transition-colors border-b border-gray-800 last:border-0"
                  >
                    {c.name}
                  </button>
                ))}
                {error && (
                  <div className="px-4 py-2 text-xs text-red-400">{error.message}</div>
                )}
              </div>
            )}
          </div>
        )}
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <div className="flex items-center gap-4">
          <div className="text-3xl font-mono font-bold">${DEMO_SPOT.toLocaleString()}</div>
          <div className="text-gray-500 text-sm">ETH/USD · 30d expiry</div>
        </div>

        <section>
          <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
            Live Bid / Ask — Parametric Volatility Smile
          </h2>
          <OptionMatrix spot={DEMO_SPOT} />
        </section>

        <section>
          <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
            LP Position
          </h2>
          <LPDashboard />
        </section>
      </div>
    </main>
  );
}
