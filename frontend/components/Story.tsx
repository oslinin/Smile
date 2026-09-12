"use client";

// The landing tab: the one screen a judge sees first. The capital-efficiency
// ladder as live numbers from the connected chain — what a writer locks for
// the same $3,000 put or call, rung by rung — the chain you are on with its
// real receipts, and the protocol's live counters across every vault.

import { useAccount, useChainId, useReadContract, useReadContracts } from "wagmi";
import { useEffect, useState } from "react";
import { CONTRACTS } from "@/config/wagmi";
import { DEPLOYMENTS } from "@/lib/deployments";
import { explorerTxUrl, explorerAddressUrl } from "@/lib/explorer";

type TabId = "income" | "lp-auth" | "spreads" | "margin" | "rfq" | "chain" | "surface" | "lp-position" | "proof";

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_BI = BigInt(0);
const WAD = BigInt(10) ** BigInt(18);

const NEXT_AUTH_ABI = [{ name: "nextAuthId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;
const MARGIN_ABI = [
  { name: "marginRequirement", type: "function", stateMutability: "view", inputs: [{ name: "strike", type: "uint256" }, { name: "units", type: "uint256" }, { name: "spotWad", type: "uint256" }, { name: "initial", type: "bool" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "markSpot", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "spotWad", type: "uint256" }, { name: "latestUpdatedAt", type: "uint256" }, { name: "roundsUsed", type: "uint256" }] },
  { name: "nakedNotional", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "effectiveCeiling", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "insuranceFund", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "imBufferBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
] as const;
const BACKSTOP_ABI = [{ name: "totalAssets", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;

const usd0 = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const usdc = (v: bigint | undefined, d = 0) => v === undefined ? "…" : `${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: d })} USDC`;

function Rung({ title, sub, value, max, color, note, cta, onCta, tone }: {
  title: string; sub: string; value: number; max: number; color: string; note: string; cta: string; onCta: () => void; tone?: "old" | "new";
}) {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW(max > 0 ? Math.max(2, (value / max) * 100) : 0), 50); return () => clearTimeout(t); }, [value, max]);
  return (
    <div className="grid md:grid-cols-[180px_1fr_auto] gap-3 items-center py-3 border-b border-gray-800/80 last:border-0">
      <div>
        <div className="text-white text-sm font-semibold flex items-center gap-2">
          {title}
          {tone === "new" && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/60 text-green-300 border border-green-800">new</span>}
        </div>
        <div className="text-gray-500 text-xs">{sub}</div>
      </div>
      <div>
        {/* The fill sits behind in-flow text, so a note that wraps on a phone
            grows the track instead of being clipped by a fixed height. */}
        <div className="min-h-7 rounded-md bg-gray-800/80 overflow-hidden relative">
          <div className={`absolute inset-y-0 left-0 ${color} transition-all duration-700 ease-out`} style={{ width: `${w}%` }} />
          <div className="relative flex items-center min-h-7 px-3 py-1 text-xs font-mono text-white drop-shadow leading-snug">{note}</div>
        </div>
      </div>
      <button onClick={onCta} className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 whitespace-nowrap">{cta} →</button>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-gray-800/60 p-3">
      <div className="text-gray-500 text-[11px] uppercase tracking-wider">{label}</div>
      <div className="text-white font-mono text-lg">{value}</div>
      {hint && <div className="text-gray-500 text-[11px]">{hint}</div>}
    </div>
  );
}

export function Story({ spot, onGo }: { spot: number; onGo: (tab: TabId) => void }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const dep = DEPLOYMENTS[chainId];
  const chainName = dep?.name ?? (chainId === 31337 || chainId === 1337 ? "Anvil (local)" : `chain ${chainId}`);

  const k = Math.round(spot / 50) * 50;         // ATM strike for the ladder
  const k2 = k + 200;                            // spread's long strike
  const mv = (CONTRACTS.marginVault || ZERO) as `0x${string}`;
  const hasMargin = !!CONTRACTS.marginVault;

  // Live rung 3: MarginVault's own IM for a 1-unit put at K off its mark.
  const { data: mark } = useReadContract({ address: mv, abi: MARGIN_ABI, functionName: "markSpot", query: { enabled: hasMargin, refetchInterval: 15_000 } });
  const markWad = mark && mark[0] > ZERO_BI ? mark[0] : BigInt(Math.round(spot)) * WAD;
  const { data: im } = useReadContract({ address: mv, abi: MARGIN_ABI, functionName: "marginRequirement", args: [BigInt(k) * WAD, WAD, markWad, true], query: { enabled: hasMargin, refetchInterval: 15_000 } });
  const imUsd = im !== undefined ? Number(im) / 1e6 : Math.min(k, Math.max(k - spot, 0) + spot * 0.5);

  // Live counters across the vaults.
  const { data: counts } = useReadContracts({
    contracts: [
      { address: (CONTRACTS.aquaVault || ZERO) as `0x${string}`, abi: NEXT_AUTH_ABI, functionName: "nextAuthId" },
      { address: (CONTRACTS.spreadVault || ZERO) as `0x${string}`, abi: NEXT_AUTH_ABI, functionName: "nextAuthId" },
      { address: mv, abi: NEXT_AUTH_ABI, functionName: "nextAuthId" },
      { address: (CONTRACTS.rfqVault || ZERO) as `0x${string}`, abi: NEXT_AUTH_ABI, functionName: "nextAuthId" },
      { address: mv, abi: MARGIN_ABI, functionName: "nakedNotional" },
      { address: mv, abi: MARGIN_ABI, functionName: "effectiveCeiling" },
      { address: mv, abi: MARGIN_ABI, functionName: "insuranceFund" },
      { address: (CONTRACTS.marginBackstop || ZERO) as `0x${string}`, abi: BACKSTOP_ABI, functionName: "totalAssets" },
    ],
    query: { enabled: !!CONTRACTS.aquaVault, refetchInterval: 15_000 },
  });
  const n = (i: number) => { const r = counts?.[i]; return r && r.status === "success" ? (r.result as bigint) : undefined; };
  const ranges = [n(0), n(1), n(2), n(3)];
  const totalRanges = ranges.some((x) => x !== undefined) ? ranges.reduce<bigint>((a, b) => a + (b ?? ZERO_BI), ZERO_BI) : undefined;

  const ladder = [
    { title: "Naked put", sub: "the main vault · cash-secured", value: k, note: `${usd0(k)} USDC locked per unit`, color: "bg-blue-700", cta: "Trade", tab: "chain" as TabId, tone: "old" as const },
    { title: "Credit spread", sub: `SpreadVault · ${usd0(k)}/${usd0(k2)}`, value: k2 - k, note: `${usd0(k2 - k)} USDC — the true max loss, ${(k / (k2 - k)).toFixed(0)}× less`, color: "bg-green-600", cta: "Spreads", tab: "spreads" as TabId, tone: "new" as const },
    { title: "Margined put", sub: "MarginVault · opt-in, IM off the worst-of-hour mark", value: imUsd, note: `${usd0(imUsd)} USDC initial margin — ${(k / Math.max(imUsd, 1)).toFixed(1)}× less, liquidation-backed`, color: "bg-emerald-600", cta: "Margin", tab: "margin" as TabId, tone: "new" as const },
    { title: "Signed quote", sub: "RfqVault · LP-signed price, same collateral rules", value: k, note: "any price the LP signs — the custody model never changes", color: "bg-teal-700", cta: "RFQ", tab: "rfq" as TabId, tone: "new" as const },
  ];

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="rounded-2xl border border-gray-800 bg-gradient-to-br from-gray-900 via-gray-900 to-blue-950/40 p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="text-2xl md:text-3xl font-bold text-white leading-tight">Options where the collateral never leaves your wallet until it has to.</h1>
            <p className="text-gray-400 mt-3 text-sm md:text-base">
              Smile prices ETH options on-chain and pulls a writer&apos;s collateral <em>just in time</em> through 1inch Aqua — at the fill, not at deposit.
              EthOnline 2026 added three sibling vaults on the same registry: spreads that escrow only their true max loss, opt-in margin with a
              liquidation waterfall, and LP-signed RFQ quotes — plus a Graph subgraph and deployments on Sepolia and Circle&apos;s Arc.
            </p>
          </div>
          <div className="rounded-xl border border-gray-700 bg-gray-950/60 p-4 min-w-[220px]">
            <div className="text-gray-500 text-[11px] uppercase tracking-wider">You are on</div>
            <div className="text-white font-semibold text-lg">{mounted ? chainName : "…"}</div>
            <div className="text-gray-400 text-xs mt-1">{dep ? dep.realMoney : "mock USDC / WETH, settable oracle — the full lifecycle runs here in minutes"}</div>
            {dep?.subgraph && <div className="text-green-400 text-xs mt-2">● indexed by The Graph — no range cap, the copilot trades off it</div>}
            {!isConnected && mounted && <div className="text-gray-500 text-xs mt-2">connect a wallet to trade; reading works without one</div>}
          </div>
        </div>
      </div>

      {/* Ladder */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
          <h2 className="text-white font-semibold">What a writer locks for one {usd0(k)} put</h2>
          <span className="text-gray-500 text-xs">live from the connected chain · spot {usd0(spot)}{mark && mark[0] > ZERO_BI ? ` · margin mark ${usd0(Number(mark[0]) / 1e18)}` : ""}</span>
        </div>
        {ladder.map((r) => <Rung key={r.title} title={r.title} sub={r.sub} value={r.value} max={k} color={r.color} note={r.note} cta={r.cta} onCta={() => onGo(r.tab)} tone={r.tone} />)}
        <p className="text-gray-500 text-xs mt-3">Same premium surface on every rung (the SwapVM opcode and its Uniswap v4 hook); only the collateral rule changes. Blue was there on Sept 5; green is the continuation track.</p>
      </div>

      {/* Live counters */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Ranges shipped" value={totalRanges === undefined ? "…" : totalRanges.toString()} hint={ranges.every((x) => x !== undefined) ? `vault ${ranges[0]} · spread ${ranges[1]} · margin ${ranges[2]} · rfq ${ranges[3]}` : "across all vaults"} />
        <Stat label="Backstop pool" value={usdc(n(7))} hint="stands behind margined puts" />
        <Stat label="Naked notional / ceiling" value={`${usdc(n(4))} / ${usdc(n(5))}`} hint="ceiling = 7 × backstop" />
        <Stat label="Insurance fund" value={usdc(n(6))} hint="50% of margin fees + penalties" />
      </div>

      {/* Receipts */}
      {dep ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 space-y-3">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h2 className="text-white font-semibold">Real transactions on {dep.name}</h2>
            <a href={dep.explorer} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline">{dep.explorer.replace("https://", "")} ↗</a>
          </div>
          <ul className="space-y-1.5 text-xs">
            {dep.demo.map((t) => (
              <li key={t.hash} className="flex flex-wrap items-baseline gap-x-3">
                <a href={explorerTxUrl(chainId, t.hash) ?? "#"} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-400 hover:underline">{t.hash.slice(0, 10)}…{t.hash.slice(-6)}</a>
                <span className="text-gray-200">{t.label}</span>
                {t.note && <span className="text-gray-500">— {t.note}</span>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500 pt-1 border-t border-gray-800">
            {dep.contracts.map((c) => (
              <a key={c.address} href={explorerAddressUrl(chainId, c.address) ?? "#"} target="_blank" rel="noopener noreferrer" className="hover:text-gray-300">{c.label} <span className="font-mono">{c.address.slice(0, 6)}…{c.address.slice(-4)}</span></a>
            ))}
          </div>
          {dep.subgraph && <div className="text-[11px] text-gray-500">Subgraph: <a href={dep.subgraph} className="font-mono text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">{dep.subgraph}</a></div>}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-xs text-gray-400">
          <span className="text-white font-semibold">Local Anvil.</span> Every lifecycle runs here as real transactions in minutes — <span className="font-mono">./script/spread-lifecycle.sh</span>, <span className="font-mono">./script/margin-lifecycle.sh</span> (crash → margin call → auction → backstop → settle), <span className="font-mono">./script/rfq-lifecycle.sh</span>. Switch to Sepolia or Arc Testnet in the network menu to see the recorded testnet receipts.
        </div>
      )}
    </div>
  );
}
