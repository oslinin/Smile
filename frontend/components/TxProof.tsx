"use client";

import { useChainId } from "wagmi";
import { explorerTxUrl, explorerAddressUrl } from "@/lib/explorer";
import { DEPLOYMENTS } from "@/lib/deployments";

interface TxProofProps {
  recentSwapTx?: string;  // premium swap tx hash from the buy flow
}

/// Receipts for the chain you are on: the recorded testnet deployments and
/// demo fills (Sepolia, Arc), plus whatever this session just did.
export function TxProof({ recentSwapTx }: TxProofProps) {
  const chainId = useChainId();
  const swapUrl = recentSwapTx ? explorerTxUrl(chainId, recentSwapTx) : null;
  const dep = DEPLOYMENTS[chainId];
  const known = Object.values(DEPLOYMENTS);

  return (
    <div className="space-y-4">
      {(dep ? [dep] : known).map((d) => (
        <div key={d.chainId} className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <h3 className="text-gray-400 text-xs uppercase tracking-widest">On-Chain Proof · {d.name}</h3>
            <span className="text-[11px] text-gray-500">{d.realMoney}</span>
          </div>
          <div className="space-y-1.5">
            {d.demo.map((t) => (
              <div key={t.hash} className="flex flex-wrap items-baseline gap-x-3 text-xs">
                <a href={explorerTxUrl(d.chainId, t.hash) ?? "#"} target="_blank" rel="noopener noreferrer" className="font-mono text-green-500 hover:text-green-400">{t.hash.slice(0, 10)}…{t.hash.slice(-6)} ↗</a>
                <span className="text-gray-200">{t.label}</span>
                {t.note && <span className="text-gray-500">— {t.note}</span>}
              </div>
            ))}
          </div>
          <div className="space-y-1 pt-2 border-t border-gray-800">
            {d.contracts.map((c) => (
              <div key={c.address} className="flex items-center justify-between gap-4 text-xs">
                <span className="text-gray-500 w-44 shrink-0">{c.label}</span>
                <a href={explorerAddressUrl(d.chainId, c.address) ?? "#"} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-400 hover:text-blue-300 truncate">{c.address}</a>
              </div>
            ))}
          </div>
          {d.subgraph && (
            <div className="text-[11px] text-gray-500 pt-2 border-t border-gray-800">
              The Graph: <a href={d.subgraph} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-400 hover:underline">{d.subgraph}</a>
            </div>
          )}
        </div>
      ))}

      {!dep && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 text-xs text-gray-400">
          You are on a local chain (no public explorer). Everything above was recorded on the public testnets; the same flows run here via <span className="font-mono">./script/*-lifecycle.sh</span>.
        </div>
      )}

      {recentSwapTx && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 flex items-center justify-between gap-4">
          <span className="text-gray-500 text-xs">This session&apos;s last premium swap</span>
          {swapUrl ? (
            <a href={swapUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-mono text-pink-400 hover:text-pink-300">{recentSwapTx.slice(0, 10)}…{recentSwapTx.slice(-6)} ↗</a>
          ) : (
            <span className="text-xs font-mono text-pink-400/70">{recentSwapTx.slice(0, 10)}…{recentSwapTx.slice(-6)}<span className="text-gray-600 ml-2">(local · no explorer)</span></span>
          )}
        </div>
      )}
    </div>
  );
}
