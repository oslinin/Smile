"use client";

// Cards for the two execution-prep tools. The agent proposes a range to
// write (prepare_lp_range) or an RFQ quote to sign (prepare_rfq_quote); the
// button hands the numbers to the existing form on the matching tab, where
// the user reviews and signs in their wallet. The copilot never holds a key.

export interface RangePrefill {
  isCall: boolean;
  strikeMin: number;
  strikeMax: number;
  expiryDays: number;
  maxCollateral: number; // WETH for calls, USDC for puts
  rationale?: string;
  expectedPremiumUsd?: number;
}

export interface RfqPrefill {
  authId: number;
  isCall?: boolean;
  strike: number;
  maxAmount: number;
  premiumPerUnitUsd: number;
  ttlMinutes: number;
  rationale?: string;
  formulaAskUsd?: number;
}

export const PREFILL_KEYS = { range: "smile.prefill.range", rfq: "smile.prefill.rfq" } as const;

/** Store the prefill, switch the tab, and tell the form (if mounted) to read it. */
export function sendPrefill(kind: "range" | "rfq", value: RangePrefill | RfqPrefill) {
  try {
    window.sessionStorage.setItem(PREFILL_KEYS[kind], JSON.stringify(value));
  } catch {
    /* private mode: the event alone still works while the form is mounted */
  }
  window.dispatchEvent(new CustomEvent("smile:goto", { detail: kind === "range" ? "lp-auth" : "rfq" }));
  window.dispatchEvent(new CustomEvent(`smile:prefill-${kind}`, { detail: value }));
}

/** Read and clear a stored prefill (forms call this on mount). */
export function takePrefill<T>(kind: "range" | "rfq"): T | null {
  try {
    const raw = window.sessionStorage.getItem(PREFILL_KEYS[kind]);
    if (!raw) return null;
    window.sessionStorage.removeItem(PREFILL_KEYS[kind]);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-3 text-[11px]">
    <span className="text-gray-500">{k}</span>
    <span className="text-gray-200 font-mono">{v}</span>
  </div>
);

export function RangeCard({ p }: { p: RangePrefill }) {
  return (
    <div className="rounded-lg border border-emerald-900/60 bg-gray-900 p-3 space-y-1.5 my-1">
      <div className="text-xs font-semibold text-emerald-300">Write a range · {p.isCall ? "calls" : "puts"}</div>
      {p.rationale && <p className="text-[11px] text-gray-400">{p.rationale}</p>}
      <Row k="strikes" v={`$${p.strikeMin} – $${p.strikeMax}`} />
      <Row k="expiry" v={`${p.expiryDays} days`} />
      <Row k="capacity" v={`${p.maxCollateral} ${p.isCall ? "WETH" : "USDC"}`} />
      {p.expectedPremiumUsd !== undefined && <Row k="expected premium / unit" v={`$${p.expectedPremiumUsd.toFixed(2)}`} />}
      <button
        onClick={() => sendPrefill("range", p)}
        className="mt-1 w-full rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs py-1.5"
      >
        Open in Write a Range → review &amp; sign
      </button>
      <p className="text-[10px] text-gray-600">Collateral stays in your wallet until a buyer fills (Aqua JIT pull).</p>
    </div>
  );
}

export function RfqCard({ p }: { p: RfqPrefill }) {
  return (
    <div className="rounded-lg border border-amber-900/60 bg-gray-900 p-3 space-y-1.5 my-1">
      <div className="text-xs font-semibold text-amber-300">RFQ quote to sign · range #{p.authId}</div>
      {p.rationale && <p className="text-[11px] text-gray-400">{p.rationale}</p>}
      <Row k="strike" v={`$${p.strike}${p.isCall === undefined ? "" : p.isCall ? " call" : " put"}`} />
      <Row k="max size" v={`${p.maxAmount} units`} />
      <Row k="premium / unit" v={`$${p.premiumPerUnitUsd.toFixed(2)}${p.formulaAskUsd !== undefined ? ` (formula ask $${p.formulaAskUsd.toFixed(2)})` : ""}`} />
      <Row k="valid for" v={`${p.ttlMinutes} min`} />
      <button
        onClick={() => sendPrefill("rfq", p)}
        className="mt-1 w-full rounded-md bg-amber-600 hover:bg-amber-500 text-white text-xs py-1.5"
      >
        Open in RFQ desk → sign in wallet
      </button>
      <p className="text-[10px] text-gray-600">EIP-712 signature from your wallet; nothing is sent on-chain until a taker fills.</p>
    </div>
  );
}
