"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { OptionMatrix } from "@/components/OptionMatrix";
import { LPDashboard } from "@/components/LPDashboard";
import { useState } from "react";

const DEMO_SPOT = 3420;

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const [lastTx, setLastTx] = useState<string | null>(null);

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Options Marketplace</h1>
          <p className="text-gray-500 text-xs mt-0.5">
            Non-custodial · 1inch Aqua JIT · Uniswap v4 Hooks · Chainlink CRE
          </p>
        </div>
        {isConnected ? (
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
          <button
            onClick={() => connect({ connector: injected() })}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            Connect Wallet
          </button>
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

        {lastTx && (
          <div className="text-xs text-gray-500 font-mono">
            Last tx: {lastTx}
          </div>
        )}
      </div>
    </main>
  );
}
