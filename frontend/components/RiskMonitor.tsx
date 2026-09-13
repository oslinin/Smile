"use client";

// The Risk Monitor: every MarginVault position with its health against the
// live mark, the vault's risk dials, and the liquidation timeline rebuilt
// from events — Flagged → AuctionStarted → TakenOver / Absorbed →
// PositionSettled → SeriesFinalized (→ HolderHaircut). On Anvil,
// ./script/margin-lifecycle.sh fills this screen in real time; on Sepolia
// and Arc it shows the recorded fills. "Explain" hands the recent events to
// the copilot.

import { useChainId, usePublicClient, useReadContracts } from "wagmi";
import { parseAbiItem } from "viem";
import { useEffect, useMemo, useState } from "react";
import { CONTRACTS } from "@/config/wagmi";

const EVENTS = [
  parseAbiItem("event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium)"),
  parseAbiItem("event MarginLocked(bytes32 indexed sid, address indexed writer, uint256 pulled, uint256 fromFree, uint256 notional)"),
  parseAbiItem("event ToppedUp(bytes32 indexed sid, address indexed writer, uint256 fromFree, uint256 fromCreditLine, uint256 fromCaller)"),
  parseAbiItem("event Flagged(bytes32 indexed sid, address indexed writer, address indexed flagger, uint256 locked, uint256 maintenance)"),
  parseAbiItem("event FlagCleared(bytes32 indexed sid, address indexed writer)"),
  parseAbiItem("event AuctionStarted(bytes32 indexed sid, address indexed writer, uint256 locked, uint256 maintenance)"),
  parseAbiItem("event TakenOver(bytes32 indexed sid, address indexed writer, address indexed bidder, uint256 units, uint256 moved, uint256 bonus, uint256 penalty, uint256 posted)"),
  parseAbiItem("event Absorbed(bytes32 indexed sid, address indexed writer, uint256 units, uint256 moved, uint256 drawn, uint256 tip, uint256 penalty)"),
  parseAbiItem("event PositionSettled(bytes32 indexed sid, address indexed writer, uint256 units, uint256 owed, uint256 paid, uint256 shortfall, uint256 released)"),
  parseAbiItem("event SeriesFinalized(bytes32 indexed sid, uint256 owed, uint256 pot, uint256 backstopDrawn, uint256 insuranceDrawn, uint256 payoutPerUnit)"),
  parseAbiItem("event HolderHaircut(bytes32 indexed sid, uint256 owed, uint256 paid, uint16 haircutBps, uint16 newImBufferBps)"),
  parseAbiItem("event Redeemed(address indexed optionToken, address indexed holder, uint256 amount, uint256 payout)"),
] as const;

const MV_ABI = [
  { name: "positions", type: "function", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }, { name: "", type: "address" }], outputs: [{ name: "authId", type: "uint256" }, { name: "units", type: "uint256" }, { name: "locked", type: "uint256" }, { name: "flaggedAt", type: "uint64" }, { name: "auctionStart", type: "uint64" }, { name: "flagger", type: "address" }] },
  { name: "health", type: "function", stateMutability: "view", inputs: [{ name: "sid", type: "bytes32" }, { name: "writer", type: "address" }], outputs: [{ name: "locked", type: "uint256" }, { name: "mm", type: "uint256" }, { name: "im", type: "uint256" }] },
  { name: "seriesOf", type: "function", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "strike", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "token", type: "address" }, { name: "totalUnits", type: "uint256" }, { name: "positionCount", type: "uint256" }, { name: "settledPositions", type: "uint256" }, { name: "owedTotal", type: "uint256" }, { name: "pot", type: "uint256" }, { name: "backstopDrawn", type: "uint256" }, { name: "finalized", type: "bool" }, { name: "payoutPerUnit", type: "uint256" }, { name: "haircutBps", type: "uint16" }] },
  { name: "markSpot", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "spotWad", type: "uint256" }, { name: "latestUpdatedAt", type: "uint256" }, { name: "roundsUsed", type: "uint256" }] },
  { name: "nakedNotional", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "effectiveCeiling", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "insuranceFund", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "imBufferBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { name: "mmBufferBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
] as const;
const BACKSTOP_ABI = [{ name: "totalAssets", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }] as const;

// First block worth scanning per chain (MarginVault deploy blocks; Anvil from 0).
const FROM_BLOCK: Record<number, bigint> = { 11155111: BigInt(11677124), 5042002: BigInt(61470464) };

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_BI = BigInt(0);
type Ev = { eventName: string; args: Record<string, unknown>; blockNumber: bigint | null; logIndex: number | null; transactionHash: string | null };
type Key = { sid: `0x${string}`; writer: `0x${string}` };

const usdc = (v: bigint | undefined, d = 2) => v === undefined ? "…" : `${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: d })} USDC`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const units = (v: bigint) => (Number(v) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 });

function describe(e: Ev, backstop: string): { icon: string; tone: string; text: string } {
  const a = e.args;
  const w = (x: unknown) => short(String(x));
  switch (e.eventName) {
    case "OptionBought": return { icon: "🟢", tone: "text-gray-200", text: `Fill: ${w(a.buyer)} bought ${units(a.amount as bigint)} × $${(Number(a.strike as bigint) / 1e18).toLocaleString()} put for ${usdc(a.premium as bigint)}` };
    case "MarginLocked": return { icon: "🔒", tone: "text-gray-300", text: `Writer ${w(a.writer)} locked ${usdc((a.pulled as bigint) + (a.fromFree as bigint))} of initial margin (${usdc(a.pulled as bigint)} pulled JIT through Aqua) against ${usdc(a.notional as bigint)} of notional` };
    case "ToppedUp": return { icon: "➕", tone: "text-blue-300", text: `Top-up for ${w(a.writer)}: free ${usdc(a.fromFree as bigint)}, credit line ${usdc(a.fromCreditLine as bigint)}, caller ${usdc(a.fromCaller as bigint)}` };
    case "Flagged": return { icon: "🚩", tone: "text-yellow-300", text: `Margin call: ${w(a.writer)} flagged by ${w(a.flagger)} — locked ${usdc(a.locked as bigint)} < maintenance ${usdc(a.maintenance as bigint)}. 1 h grace starts.` };
    case "FlagCleared": return { icon: "✅", tone: "text-green-300", text: `Flag cleared for ${w(a.writer)} — back at initial margin` };
    case "AuctionStarted": return { icon: "🔔", tone: "text-orange-300", text: `Auction open on ${w(a.writer)}'s position (still ${usdc(a.locked as bigint)} < MM ${usdc(a.maintenance as bigint)} on post-flag rounds). Bonus 1% → 10% over 30 min.` };
    case "TakenOver": return { icon: "🤝", tone: "text-emerald-300", text: `Takeover: ${w(a.bidder)} took ${units(a.units as bigint)} units from ${w(a.writer)} — ${usdc(a.moved as bigint)} travelled, bonus ${usdc(a.bonus as bigint)}, penalty ${usdc(a.penalty as bigint)}, bidder posted ${usdc(a.posted as bigint)}. Holder untouched.` };
    case "Absorbed": return { icon: "🛟", tone: "text-emerald-300", text: `Backstop absorbed ${units(a.units as bigint)} units from ${w(a.writer)}: ${usdc(a.moved as bigint)} travelled, pool drew only ${usdc(a.drawn as bigint)}, keeper tip ${usdc(a.tip as bigint)}` };
    case "PositionSettled": return { icon: "⚖️", tone: String(a.writer).toLowerCase() === backstop.toLowerCase() ? "text-emerald-300" : "text-gray-200", text: `Settled ${w(a.writer)}: owed ${usdc(a.owed as bigint)}, paid ${usdc(a.paid as bigint)}${(a.shortfall as bigint) > ZERO_BI ? `, shortfall ${usdc(a.shortfall as bigint)} → bad debt` : ""}${(a.released as bigint) > ZERO_BI ? `, ${usdc(a.released as bigint)} released` : ""}` };
    case "SeriesFinalized": return { icon: "🏁", tone: "text-white", text: `Series finalized: holders owed ${usdc(a.owed as bigint)}, pot ${usdc(a.pot as bigint)} (backstop ${usdc(a.backstopDrawn as bigint)}, insurance ${usdc(a.insuranceDrawn as bigint)}) → ${usdc(a.payoutPerUnit as bigint)} per unit` };
    case "HolderHaircut": return { icon: "✂️", tone: "text-red-400 font-semibold", text: `HAIRCUT: holders paid ${usdc(a.paid as bigint)} of ${usdc(a.owed as bigint)} (${Number(a.haircutBps) / 100}%). IM buffer ratchets to ${Number(a.newImBufferBps) / 100}%.` };
    case "Redeemed": return { icon: "💵", tone: "text-green-300", text: `Holder ${w(a.holder)} redeemed ${units(a.amount as bigint)} units for ${usdc(a.payout as bigint)}` };
    default: return { icon: "•", tone: "text-gray-400", text: String(e.eventName) };
  }
}

export function RiskMonitor() {
  const chainId = useChainId();
  const client = usePublicClient();
  const mv = (CONTRACTS.marginVault || ZERO) as `0x${string}`;
  const backstop = (CONTRACTS.marginBackstop || ZERO) as `0x${string}`;
  const enabled = !!CONTRACTS.marginVault;
  const [events, setEvents] = useState<Ev[]>([]);
  const [lastScan, setLastScan] = useState<number | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Poll the vault's events. Cheap on Anvil/Sepolia; Arc's RPC caps ranges,
  // so we scan from the deploy block and let a failure show rather than spin.
  useEffect(() => {
    if (!client || !enabled) return;
    let stop = false;
    const scan = async () => {
      try {
        const logs = await client.getLogs({ address: mv, events: EVENTS, fromBlock: FROM_BLOCK[chainId] ?? ZERO_BI, toBlock: "latest" });
        if (stop) return;
        const evs = logs as unknown as Ev[];
        evs.sort((x, y) => (x.blockNumber === y.blockNumber ? Number((x.logIndex ?? 0) - (y.logIndex ?? 0)) : Number((x.blockNumber ?? ZERO_BI) - (y.blockNumber ?? ZERO_BI))));
        setEvents(evs);
        setLastScan(Date.now());
        setScanError(null);
      } catch (e) {
        if (!stop) setScanError((e as Error).message.split("\n")[0]);
      }
    };
    scan();
    const t = setInterval(scan, 5_000);
    return () => { stop = true; clearInterval(t); };
  }, [client, mv, chainId, enabled]);

  // Every (series, writer) that ever held a short here.
  const keys = useMemo<Key[]>(() => {
    const seen = new Map<string, Key>();
    for (const e of events) {
      const a = e.args;
      const add = (sid: unknown, writer: unknown) => { const k = `${sid}-${String(writer).toLowerCase()}`; if (!seen.has(k)) seen.set(k, { sid: sid as `0x${string}`, writer: writer as `0x${string}` }); };
      if (e.eventName === "MarginLocked") add(a.sid, a.writer);
      if (e.eventName === "TakenOver") add(a.sid, a.bidder);
      if (e.eventName === "Absorbed") add(a.sid, backstop);
    }
    return [...seen.values()];
  }, [events, backstop]);

  const { data: reads } = useReadContracts({
    contracts: keys.flatMap((k) => [
      { address: mv, abi: MV_ABI, functionName: "positions", args: [k.sid, k.writer] },
      { address: mv, abi: MV_ABI, functionName: "health", args: [k.sid, k.writer] },
      { address: mv, abi: MV_ABI, functionName: "seriesOf", args: [k.sid] },
    ]),
    query: { enabled: enabled && keys.length > 0, refetchInterval: 5_000 },
  });
  const { data: dials } = useReadContracts({
    contracts: [
      { address: mv, abi: MV_ABI, functionName: "markSpot" },
      { address: mv, abi: MV_ABI, functionName: "nakedNotional" },
      { address: mv, abi: MV_ABI, functionName: "effectiveCeiling" },
      { address: mv, abi: MV_ABI, functionName: "insuranceFund" },
      { address: mv, abi: MV_ABI, functionName: "imBufferBps" },
      { address: mv, abi: MV_ABI, functionName: "mmBufferBps" },
      { address: backstop, abi: BACKSTOP_ABI, functionName: "totalAssets" },
    ],
    query: { enabled, refetchInterval: 5_000 },
  });
  const dial = (i: number) => { const r = dials?.[i]; return r && r.status === "success" ? r.result : undefined; };
  const mark = dial(0) as readonly [bigint, bigint, bigint] | undefined;

  const explain = () => {
    const recent = events.slice(-12).map((e) => `- ${describe(e, backstop).text}`).join("\n");
    const text = `Explain what happened in Smile's MarginVault, in plain language for a trader, from these events (oldest first):\n${recent}\nSay who lost or gained what, whether holders were made whole, and what the backstop and insurance fund did.`;
    window.dispatchEvent(new CustomEvent("smile:ask", { detail: text }));
  };

  if (!enabled) return <div className="rounded-xl border border-gray-800 p-4 text-yellow-500 text-xs">Set NEXT_PUBLIC_MARGIN_VAULT to enable the risk monitor.</div>;

  const bar = (locked: bigint, mm: bigint, im: bigint) => {
    const max = Number(im > ZERO_BI ? im : ZERO_BI) * 1.15 || 1;
    const pct = (v: bigint) => `${Math.min(100, (Number(v) / max) * 100)}%`;
    const healthy = locked >= mm;
    return (
      <div className="relative h-4 rounded bg-gray-800 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${healthy ? (locked >= im ? "bg-green-600" : "bg-yellow-600") : "bg-red-600"} transition-all duration-700`} style={{ width: pct(locked) }} />
        <div className="absolute inset-y-0 w-0.5 bg-white/70" style={{ left: pct(mm) }} title="maintenance" />
        <div className="absolute inset-y-0 w-0.5 bg-white/30" style={{ left: pct(im) }} title="initial" />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Dials */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
        {[
          ["Margin mark", mark ? `$${(Number(mark[0]) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "…", mark ? `worst of ${mark[2].toString()} round${mark[2] === BigInt(1) ? "" : "s"} · ${Math.max(0, Math.round((Date.now() / 1000 - Number(mark[1])) / 60))} min old` : ""],
          ["Naked notional", usdc(dial(1) as bigint | undefined, 0), `ceiling ${usdc(dial(2) as bigint | undefined, 0)}`],
          ["Backstop pool", usdc(dial(6) as bigint | undefined, 0), "adopts unsold positions"],
          ["Insurance fund", usdc(dial(3) as bigint | undefined, 0), "after the backstop, before a haircut"],
          ["Buffers IM / MM", dial(4) !== undefined ? `${Number(dial(4)) / 100}% / ${Number(dial(5)) / 100}%` : "…", "of spot, over intrinsic"],
        ].map(([l, v, h]) => (
          <div key={l} className="rounded-lg bg-gray-900 border border-gray-800 p-3">
            <div className="text-gray-500 text-[11px] uppercase tracking-wider">{l}</div>
            <div className="text-white font-mono text-base">{v}</div>
            <div className="text-gray-500 text-[11px]">{h}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Positions */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
          <div className="flex items-baseline justify-between"><h3 className="text-white font-semibold text-sm">Positions</h3><span className="text-gray-500 text-[11px]">bar = locked · white tick = maintenance · faint tick = initial</span></div>
          {keys.length === 0 && <div className="text-gray-600 text-xs">No margined shorts on this chain yet. Buy a put on the Margin tab, or run <span className="font-mono">./script/margin-lifecycle.sh</span>.</div>}
          {keys.map((k, i) => {
            const p = reads?.[i * 3]; const h = reads?.[i * 3 + 1]; const s = reads?.[i * 3 + 2];
            const pos = p && p.status === "success" ? (p.result as unknown as readonly [bigint, bigint, bigint, bigint, bigint, string]) : undefined;
            const hl = h && h.status === "success" ? (h.result as unknown as readonly [bigint, bigint, bigint]) : undefined;
            const ser = s && s.status === "success" ? (s.result as unknown as readonly [bigint, bigint, string, bigint, bigint, bigint, bigint, bigint, bigint, boolean, bigint, number]) : undefined;
            const unitsOpen = pos?.[1] ?? ZERO_BI;
            const state = !pos ? "…" : unitsOpen === ZERO_BI ? (ser?.[9] ? "settled · finalized" : "closed") : pos[4] > ZERO_BI ? "IN AUCTION" : pos[3] > ZERO_BI ? "FLAGGED" : hl && hl[0] < hl[1] ? "below maintenance" : hl && hl[0] >= hl[2] ? "healthy" : "above maintenance";
            const color = state.includes("AUCTION") || state.includes("FLAGGED") || state.includes("below") ? "text-red-400" : state === "healthy" ? "text-green-400" : state.includes("above") ? "text-yellow-400" : "text-gray-400";
            const isPool = k.writer.toLowerCase() === backstop.toLowerCase();
            return (
              <div key={`${k.sid}-${k.writer}`} className="rounded-lg bg-gray-800/60 p-3 space-y-1.5 text-xs">
                <div className="flex justify-between items-baseline">
                  <span className="text-white font-mono">{isPool ? "backstop pool" : short(k.writer)} · ${ser ? (Number(ser[0]) / 1e18).toLocaleString() : "…"} put{ser ? ` · ${new Date(Number(ser[1]) * 1000).toLocaleDateString()}` : ""}</span>
                  <span className={`font-semibold ${color}`}>{state}</span>
                </div>
                {unitsOpen > ZERO_BI && hl && bar(hl[0], hl[1], hl[2])}
                <div className="flex justify-between text-gray-400">
                  <span>{units(unitsOpen)} units short</span>
                  <span>locked {usdc(hl?.[0])} · MM {usdc(hl?.[1], 0)} · IM {usdc(hl?.[2], 0)}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Timeline */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <h3 className="text-white font-semibold text-sm">Liquidation timeline</h3>
            <div className="flex items-center gap-3">
              <span className="text-gray-500 text-[11px]">{lastScan ? `live · ${events.length} events` : "scanning…"}{scanError ? ` · ${scanError}` : ""}</span>
              {process.env.NEXT_PUBLIC_COPILOT === "1" && events.length > 0 && <button onClick={explain} className="text-[11px] px-2 py-1 rounded bg-blue-900/60 text-blue-200 hover:bg-blue-800/60">Explain with the copilot →</button>}
            </div>
          </div>
          {events.length === 0 ? (
            <div className="text-gray-600 text-xs">Nothing yet. On Anvil: <span className="font-mono">./script/margin-lifecycle.sh</span> — fill → crash → flag → auction → absorb → settle → finalize → redeem — and watch it land here.</div>
          ) : (
            <ol className="space-y-1.5 max-h-[520px] overflow-y-auto pr-1">
              {[...events].reverse().map((e) => {
                const d = describe(e, backstop);
                return (
                  <li key={`${e.transactionHash}-${e.logIndex}`} className="flex gap-2 text-xs">
                    <span className="shrink-0">{d.icon}</span>
                    <span className={d.tone}>{d.text}<span className="text-gray-600"> · block {e.blockNumber?.toString()}</span></span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
