"use client";

import { useAccount, useConnect, useDisconnect, useChainId, useChains, useBalance, useSwitchChain } from "wagmi";
import { sepolia } from "wagmi/chains";
import { OptionMatrix } from "@/components/OptionMatrix";
import { LPDashboard } from "@/components/LPDashboard";
import { AuthorizeRange, type ActiveAuth } from "@/components/AuthorizeRange";
import { TxProof } from "@/components/TxProof";
import { PayoffBuilder, type Leg } from "@/components/PayoffBuilder";
import { useUniswapSpot } from "@/hooks/useUniswapSpot";
import { useState, useEffect } from "react";

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const chains = useChains();
  const { data: balance } = useBalance({ address });
  const { switchChain } = useSwitchChain();
  const currentChain = chains.find((c) => c.id === chainId);
  const isWrongChain = isConnected && chainId !== sepolia.id;

  useEffect(() => {
    if (isConnected && chainId !== sepolia.id) {
      switchChain({ chainId: sepolia.id });
    }
  }, [isConnected, chainId]);
  const [mounted, setMounted] = useState(false);
  const [activeAuth, setActiveAuth] = useState<ActiveAuth | null>(null);
  const [swapTx, setSwapTx] = useState<string | undefined>();
  const [confirmedLegs, setConfirmedLegs] = useState<Omit<Leg, "id">[]>([]);
  const spot = useUniswapSpot();
  const spotPrice = spot.status === "loading" ? null : spot.price;

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
            {isWrongChain ? (
              <button
                onClick={() => switchChain({ chainId: sepolia.id })}
                className="text-xs font-semibold px-2 py-0.5 rounded bg-red-900 text-red-300 border border-red-700 hover:bg-red-800"
              >
                Wrong Network — Switch to Sepolia
              </button>
            ) : currentChain && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">
                {currentChain.name}
              </span>
            )}
            {balance && (
              <span className="text-gray-400 text-sm font-mono">
                {(Number(balance.value) / 1e18).toFixed(4)} ETH
              </span>
            )}
            <span className="text-gray-500 text-sm font-mono">
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
            {connectors.length === 0 ? (
              <div className="text-xs text-gray-500 text-right max-w-[200px]">
                WalletConnect project ID not set
              </div>
            ) : (
              <button
                onClick={() => connect({ connector: connectors[0] })}
                disabled={isPending}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
              >
                {isPending ? "Connecting…" : "Connect Wallet"}
              </button>
            )}
            {error && (
              <div className="absolute right-0 mt-1 text-xs text-red-400 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 z-10 max-w-[240px]">
                {error.message}
              </div>
            )}
          </div>
        )}
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <div className="flex items-center gap-4">
          <div className="text-3xl font-mono font-bold">
            {spotPrice == null ? (
              <span className="text-gray-600 animate-pulse">$—</span>
            ) : (
              <>${spotPrice.toLocaleString()}</>
            )}
          </div>
          <div className="text-gray-500 text-sm">ETH/USD · 30d expiry</div>
          {spot.status === "ok" && (
            <span className="text-green-500 text-xs font-mono">● Uniswap API</span>
          )}
        </div>

        <section>
          <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
            LP — Authorize Strike Range
          </h2>
          <AuthorizeRange spot={spotPrice ?? 3420} onAuthorized={setActiveAuth} />
        </section>

        <section>
          <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
            Live Bid / Ask — Parametric Volatility Smile
          </h2>
          <OptionMatrix
            spot={spotPrice ?? 3420}
            activeAuth={activeAuth}
            onSwapTx={setSwapTx}
            onBuyConfirmed={(leg) => setConfirmedLegs(prev => [...prev, leg])}
          />
        </section>

        <section>
          <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
            LP Position
          </h2>
          <LPDashboard />
        </section>

        <section>
          <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
            Strategy Payoff Builder
          </h2>
          <PayoffBuilder spot={spotPrice ?? 3420} confirmedLegs={confirmedLegs} />
        </section>

        <section>
          <TxProof recentSwapTx={swapTx} />
        </section>
      </div>
    </main>
  );
}
