"use client";

import { useAccount, useConnect, useDisconnect, useChainId, useChains, useBalance, useReadContract, useSwitchChain } from "wagmi";
import { OptionMatrix } from "@/components/OptionMatrix";
import { CONTRACTS } from "@/config/wagmi";

const VAULT_ABI_MINI = [
  { name: "nextAuthId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    name: "authorizations", type: "function", stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }],
    outputs: [
      { name: "lp", type: "address" }, { name: "strikeMin", type: "uint256" },
      { name: "strikeMax", type: "uint256" }, { name: "expiry", type: "uint256" },
      { name: "maxCollateral", type: "uint256" }, { name: "usedCollateral", type: "uint256" },
      { name: "collateralToken", type: "address" }, { name: "isCall", type: "bool" },
      { name: "active", type: "bool" },
    ],
  },
] as const;
import { LPDashboard } from "@/components/LPDashboard";
import { AuthorizeRange, type ActiveAuth } from "@/components/AuthorizeRange";
import { TxProof } from "@/components/TxProof";
import { PayoffBuilder, type Leg } from "@/components/PayoffBuilder";
import { VolSurface, type SurfaceTrade } from "@/components/VolSurface";
import { useUniswapSpot } from "@/hooks/useUniswapSpot";
import { useState, useEffect } from "react";

type Eth = { request: (a: unknown) => Promise<unknown> };
function getEth() {
  return (window as unknown as { ethereum?: Eth }).ethereum ?? null;
}

async function switchToNetwork(chainId: number) {
  const eth = getEth();
  if (!eth) return;
  const hex = "0x" + chainId.toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 4902 && chainId === 31337) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x7a69",
          chainName: "Anvil",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["http://127.0.0.1:8545"],
        }],
      });
    }
  }
}

const NETWORKS = [
  { id: 11155111, name: "Sepolia" },
  { id: 31337,   name: "Anvil" },
];

export default function Home() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const chains = useChains();
  const { data: balance } = useBalance({ address });
  const { switchChain, isPending: switching } = useSwitchChain();
  const currentChain = chains.find((c) => c.id === chainId);
  const [mounted, setMounted] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // EIP-6963 surfaces each installed wallet as its own connector. Dedupe by
  // name and drop the generic "Injected" fallback when named wallets exist, so
  // the picker lets you choose (e.g. MetaMask on Sepolia vs a local Hardhat wallet).
  const seenWallets = new Set<string>();
  const walletConnectors = connectors.filter((c) => {
    if (c.name === "Injected" && connectors.length > 1) return false;
    if (seenWallets.has(c.name)) return false;
    seenWallets.add(c.name);
    return true;
  });

  // Switch through the *connected* wagmi connector (not the ambiguous
  // window.ethereum, which can point at a different installed wallet). Falls
  // back to a raw EIP-3326 request when no wallet is connected yet.
  const handleSwitch = (id: number) => {
    setNetworkOpen(false);
    setSwitchError(null);
    if (!isConnected) { switchToNetwork(id); return; }
    switchChain(
      { chainId: id as 1 | 11155111 | 31337 | 1337 },
      { onError: (e) => setSwitchError(e.message.split("\n")[0]) },
    );
  };
  const [activeAuth, setActiveAuth] = useState<ActiveAuth | null>(null);
  const [swapTx, setSwapTx] = useState<string | undefined>();
  const [confirmedLegs, setConfirmedLegs] = useState<Omit<Leg, "id">[]>([]);
  const [surfaceTrade, setSurfaceTrade] = useState<SurfaceTrade | null>(null);
  const [activeTab, setActiveTab] = useState<"lp-auth" | "chain" | "surface" | "lp-position" | "proof">("lp-auth");
  const spot = useUniswapSpot();
  const spotPrice = spot.status === "loading" ? null : spot.price;

  // Notify the Python vol-surface renderer of each confirmed trade so it bumps
  // the traded tenor bucket. DTE comes from the active LP authorization's expiry.
  const notifySurface = (direction: "buy" | "sell") => {
    const dte = activeAuth
      ? Math.max(0, Math.round((activeAuth.expiry - Date.now() / 1000) / 86400))
      : 30;
    setSurfaceTrade((prev) => ({ dte, direction, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  useEffect(() => { setMounted(true); }, []);

  // Auto-fetch the latest active auth from the chain
  const { data: nextAuthId } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI_MINI,
    functionName: "nextAuthId",
    query: { enabled: !!CONTRACTS.aquaVault, refetchInterval: 10_000 },
  });
  const latestAuthId = nextAuthId !== undefined && nextAuthId > BigInt(0) ? nextAuthId - BigInt(1) : undefined;
  const { data: latestAuth } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI_MINI,
    functionName: "authorizations",
    args: [latestAuthId ?? BigInt(0)],
    query: { enabled: latestAuthId !== undefined, refetchInterval: 10_000 },
  });

  useEffect(() => {
    if (!latestAuth || !latestAuthId) return;
    const [lp, strikeMinWAD, strikeMaxWAD, expiry, , , collateralToken, isCall, active] = latestAuth;
    if (!active) return;
    setActiveAuth(prev => {
      // Only overwrite if caller hasn't manually set a newer auth
      if (prev && prev.authId >= latestAuthId) return prev;
      return {
        authId: latestAuthId,
        strikeMin: Number(strikeMinWAD) / 1e18,
        strikeMax: Number(strikeMaxWAD) / 1e18,
        expiry: Number(expiry),
        isCall,
        lp,
        collateralToken,
      };
    });
  }, [latestAuth, latestAuthId?.toString()]);

  useEffect(() => {
    if (!networkOpen) return;
    const close = () => setNetworkOpen(false);
    window.addEventListener("click", close, { capture: true, once: true });
    return () => window.removeEventListener("click", close, { capture: true });
  }, [networkOpen]);

  useEffect(() => {
    if (!walletOpen) return;
    const close = () => setWalletOpen(false);
    window.addEventListener("click", close, { capture: true, once: true });
    return () => window.removeEventListener("click", close, { capture: true });
  }, [walletOpen]);

  const TABS = [
    { id: "lp-auth",      label: "LP — Authorize Strike Range" },
    { id: "chain",        label: "Option Chain + Payoff Builder" },
    { id: "surface",      label: "Vol Surface · Python" },
    { id: "lp-position",  label: "LP Position" },
    { id: "proof",        label: "On-Chain Proof · Anvil" },
  ] as const;

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 pl-3 pr-6 py-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col items-start gap-0.5 min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/smile-icon.svg`} alt="Smile" height={28} className="block" style={{ height: 28 }} />
          <p className="text-gray-500 text-xs">
            Non-custodial · 1inch Aqua JIT · Uniswap v4 Hooks · Chainlink CRE
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <a
            href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/help.html`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-semibold text-gray-400 hover:text-white transition-colors"
          >
            Help ↗
          </a>
          {!mounted ? null : (
          <div className="flex items-center gap-3">
            {/* Network dropdown — always visible so you can switch before connecting */}
            <div className="relative">
              <button
                onClick={() => setNetworkOpen((o) => !o)}
                className="flex items-center gap-1.5 text-xs font-semibold px-2 py-1 rounded border transition-colors bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700"
              >
                {switching ? "Switching…" : isConnected
                  ? (currentChain?.name ?? `Chain ${chainId}`)
                  : "Network"}
                <svg className="w-3 h-3 opacity-60" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M6 8L1 3h10z"/>
                </svg>
              </button>
              {networkOpen && (
                <div className="absolute right-0 mt-1 w-40 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
                  {NETWORKS.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleSwitch(n.id)}
                      className={`w-full text-left px-3 py-2.5 text-xs transition-colors flex items-center justify-between ${
                        isConnected && chainId === n.id
                          ? "text-white bg-blue-900/40"
                          : "text-gray-400 hover:text-white hover:bg-gray-800"
                      }`}
                    >
                      <span>{n.name}</span>
                      {isConnected && chainId === n.id && <span className="text-blue-400 text-[10px]">✓ active</span>}
                    </button>
                  ))}
                </div>
              )}
              {switchError && (
                <div className="absolute right-0 mt-1 w-56 text-[11px] text-red-400 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 z-50">
                  {switchError}
                </div>
              )}
            </div>

            {isConnected ? (
              <>
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
              </>
            ) : (
              <div className="relative">
                <button
                  onClick={() => {
                    // Single wallet → connect directly; multiple → show picker
                    if (walletConnectors.length === 1) {
                      connect({ connector: walletConnectors[0] });
                    } else {
                      setWalletOpen((o) => !o);
                    }
                  }}
                  disabled={isPending || walletConnectors.length === 0}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  {isPending ? "Connecting…" : "Connect Wallet"}
                </button>
                {walletOpen && walletConnectors.length > 1 && (
                  <div className="absolute right-0 mt-1 w-52 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
                    {walletConnectors.map((c) => (
                      <button
                        key={c.uid}
                        onClick={() => { setWalletOpen(false); connect({ connector: c }); }}
                        className="w-full text-left px-3 py-2.5 text-xs text-gray-300 hover:text-white hover:bg-gray-800 transition-colors flex items-center gap-2"
                      >
                        {c.icon && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.icon} alt="" className="w-4 h-4 rounded" />
                        )}
                        <span>{c.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {error && (
                  <div className="absolute right-0 mt-1 text-xs text-red-400 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 z-10 max-w-60">
                    {error.message}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* Spot price bar */}
        <div className="flex items-center gap-4">
          <div className="text-3xl font-mono font-bold">
            {spotPrice == null ? (
              <span className="text-gray-600 animate-pulse">$—</span>
            ) : (
              <>${spotPrice.toLocaleString()}</>
            )}
          </div>
          <div className="text-gray-500 text-sm">ETH/USD · 30d expiry</div>
          {spot.status !== "loading" && (
            <span className={`text-xs font-mono ${
              spot.source === "uniswap-api" ? "text-pink-400" :
              spot.source === "chainlink"   ? "text-blue-400" :
                                              "text-gray-500"
            }`}>
              ●{" "}
              {spot.source === "uniswap-api" ? "Uniswap API" :
               spot.source === "chainlink"   ? "Chainlink"   :
                                               "static"}
            </span>
          )}
        </div>

        {/* Tab bar — wraps on narrow screens instead of overflowing */}
        <div className="flex flex-wrap gap-1 border-b border-gray-800">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-xs font-semibold tracking-wide transition-colors whitespace-nowrap border-b-2 -mb-px ${
                activeTab === tab.id
                  ? "border-blue-500 text-white"
                  : "border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-700"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab panels */}
        {activeTab === "lp-auth" && (
          <section>
            <AuthorizeRange spot={spotPrice ?? 3420} onAuthorized={setActiveAuth} />
          </section>
        )}

        {activeTab === "chain" && (
          <div className="space-y-8">
            <section>
              <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
                Option Chain
              </h2>
              <OptionMatrix
                spot={spotPrice ?? 3420}
                activeAuth={activeAuth}
                onSwapTx={setSwapTx}
                onBuyConfirmed={(leg) => { setConfirmedLegs(prev => [...prev, leg]); notifySurface("buy"); }}
                onSellConfirmed={(leg) => { setConfirmedLegs(prev => [...prev, leg]); notifySurface("sell"); }}
              />
            </section>
            <section>
              <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
                Strategy Payoff Builder
              </h2>
              <PayoffBuilder spot={spotPrice ?? 3420} confirmedLegs={confirmedLegs} />
            </section>
          </div>
        )}

        {activeTab === "surface" && (
          <section>
            <h2 className="text-gray-400 text-xs uppercase tracking-widest mb-3">
              Volatility Surface
            </h2>
            <VolSurface spot={spotPrice ?? 3420} trade={surfaceTrade} />
          </section>
        )}

        {activeTab === "lp-position" && (
          <section>
            <LPDashboard activeAuth={activeAuth} />
          </section>
        )}

        {activeTab === "proof" && (
          <section>
            <TxProof recentSwapTx={swapTx} />
          </section>
        )}
      </div>
    </main>
  );
}
