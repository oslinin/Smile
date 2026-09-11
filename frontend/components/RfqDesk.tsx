"use client";

// R6 hybrid RFQ tier in one tab. Tier 1 is the formula surface every other
// tab prices off — permissionless, always live. Tier 2 is this: an LP ships
// a range to the RfqVault, then signs EIP-712 quotes in their wallet (no
// gas), and a taker who holds a quote fills it. The number this tab exists
// to show is the price improvement — the signed quote next to the formula
// Ask for the same strike and size — while the collateral is still pulled
// JIT from the LP wallet through Aqua at the fill, exactly as tier 1 does.
//
// Single-browser demo: sign as the LP account, switch MetaMask to the taker
// account, fill. The last signed quote stays in the page; quotes can also be
// pasted as JSON.

import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useSignTypedData, useChainId } from "wagmi";
import { useState, useEffect, useRef } from "react";
import { takePrefill, type RfqPrefill } from "@/components/copilot/PrepareCard";
import { CONTRACTS, AQUA_ABI, SHIP_PARAMS_ABI } from "@/config/wagmi";

const QUOTE_TYPES = {
  Quote: [
    { name: "authId", type: "uint256" },
    { name: "strike", type: "uint256" },
    { name: "maxAmount", type: "uint256" },
    { name: "premiumPerUnit", type: "uint256" },
    { name: "ttl", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const QUOTE_TUPLE = {
  name: "q", type: "tuple",
  components: [
    { name: "authId", type: "uint256" }, { name: "strike", type: "uint256" }, { name: "maxAmount", type: "uint256" },
    { name: "premiumPerUnit", type: "uint256" }, { name: "ttl", type: "uint256" }, { name: "nonce", type: "uint256" },
  ],
} as const;

const RFQ_ABI = [
  {
    name: "openRange", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "strikeMin", type: "uint256" }, { name: "strikeMax", type: "uint256" }, { name: "expiry", type: "uint256" },
      { name: "maxCollateral", type: "uint256" }, { name: "isCall", type: "bool" },
    ],
    outputs: [{ name: "authId", type: "uint256" }],
  },
  { name: "nextAuthId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    name: "ranges", type: "function", stateMutability: "view", inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "lp", type: "address" }, { name: "strikeMin", type: "uint256" }, { name: "strikeMax", type: "uint256" },
      { name: "expiry", type: "uint256" }, { name: "maxCollateral", type: "uint256" }, { name: "collateralToken", type: "address" },
      { name: "premiumToken", type: "address" }, { name: "isCall", type: "bool" }, { name: "active", type: "bool" },
      { name: "strategyHash", type: "bytes32" }, { name: "feeBps", type: "uint32" }, { name: "feeRecipient", type: "address" },
    ],
  },
  {
    name: "formulaQuote", type: "function", stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }, { name: "strike", type: "uint256" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "lpPremium", type: "uint256" }, { name: "fee", type: "uint256" }],
  },
  {
    name: "fillCost", type: "function", stateMutability: "view",
    inputs: [QUOTE_TUPLE, { name: "amount", type: "uint256" }],
    outputs: [{ name: "lpPremium", type: "uint256" }, { name: "fee", type: "uint256" }],
  },
  {
    name: "fill", type: "function", stateMutability: "nonpayable",
    inputs: [QUOTE_TUPLE, { name: "signature", type: "bytes" }, { name: "amount", type: "uint256" }, { name: "maxPremium", type: "uint256" }],
    outputs: [{ name: "token", type: "address" }, { name: "premiumPaid", type: "uint256" }],
  },
  { name: "nonceUsed", type: "function", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "cancelQuote", type: "function", stateMutability: "nonpayable", inputs: [{ name: "nonce", type: "uint256" }], outputs: [] },
  ...SHIP_PARAMS_ABI,
] as const;

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

type Quote = { authId: bigint; strike: bigint; maxAmount: bigint; premiumPerUnit: bigint; ttl: bigint; nonce: bigint };
type SignedQuote = { quote: Quote; signature: `0x${string}`; lp: `0x${string}` };

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_BI = BigInt(0);
const ONE_BI = BigInt(1);
const WAD = BigInt(10) ** BigInt(18);
const EXPIRY_PRESETS = [
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
  { label: "90 days", seconds: 90 * 86_400 },
];

const usd = (v: bigint | undefined, digits = 2) => v === undefined ? "…" : `${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: digits })} USDC`;
const serialize = (s: SignedQuote) => JSON.stringify({ ...s, quote: Object.fromEntries(Object.entries(s.quote).map(([k, v]) => [k, v.toString()])) }, null, 2);
function parse(text: string): SignedQuote | null {
  try {
    const o = JSON.parse(text);
    const q = o.quote;
    return {
      lp: o.lp, signature: o.signature,
      quote: { authId: BigInt(q.authId), strike: BigInt(q.strike), maxAmount: BigInt(q.maxAmount), premiumPerUnit: BigInt(q.premiumPerUnit), ttl: BigInt(q.ttl), nonce: BigInt(q.nonce) },
    };
  } catch { return null; }
}

export function RfqDesk({ spot }: { spot: number }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const rfq = (CONTRACTS.rfqVault || ZERO) as `0x${string}`;
  const enabled = !!CONTRACTS.rfqVault;

  // ── 1. LP ships a range ─────────────────────────────────────────────────
  const grid = (x: number) => Math.round(x / 50) * 50;
  const [isCall, setIsCall] = useState(true);
  const [kMin, setKMin] = useState(grid(spot) - 500);
  const [kMax, setKMax] = useState(grid(spot) + 500);
  const [expiryOffset, setExpiryOffset] = useState(30 * 86_400);
  const [capacity, setCapacity] = useState("1");
  const [step, setStep] = useState<"idle" | "approving" | "approved" | "opening" | "opened" | "shipping" | "done">("idle");
  const [authIdToShip, setAuthIdToShip] = useState<bigint | null>(null);
  const openCalledRef = useRef(false);
  const shipCalledRef = useRef(false);

  const collateralToken = isCall ? CONTRACTS.weth : CONTRACTS.usdc;
  const capacityRaw = BigInt(Math.round((Number(capacity) || 0) * (isCall ? 1e18 : 1e6)));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryOffset);

  const { data: nextAuthId, refetch: refetchNext } = useReadContract({ address: rfq, abi: RFQ_ABI, functionName: "nextAuthId", query: { enabled, refetchInterval: 10_000 } });
  const { data: collateralAllowance, refetch: refetchCollateralAllowance } = useReadContract({
    address: collateralToken, abi: ERC20_ABI, functionName: "allowance", args: [address ?? ZERO, (CONTRACTS.aqua || ZERO) as `0x${string}`],
    query: { enabled: !!address && !!CONTRACTS.aqua },
  });
  const { data: shipParams } = useReadContract({ address: rfq, abi: RFQ_ABI, functionName: "getShipParams", args: [authIdToShip ?? ZERO_BI], query: { enabled: enabled && authIdToShip !== null } });

  const { writeContract: approve, data: approveTx, isPending: approvePending, error: approveError } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTx });
  const { writeContract: open, data: openTx, isPending: openPending, error: openError } = useWriteContract();
  const { isLoading: openConfirming, isSuccess: openSuccess } = useWaitForTransactionReceipt({ hash: openTx });
  const { writeContract: ship, data: shipTx, isPending: shipPending, error: shipError } = useWriteContract();
  const { isLoading: shipConfirming, isSuccess: shipSuccess } = useWaitForTransactionReceipt({ hash: shipTx });
  useEffect(() => { if (approveSuccess && step === "approving") setStep("approved"); }, [approveSuccess]);
  useEffect(() => { if (openSuccess && step === "opening") setStep("opened"); }, [openSuccess]);
  useEffect(() => { if (shipSuccess && step === "shipping") { setStep("done"); refetchNext(); } }, [shipSuccess]);

  const handleStart = async () => {
    if (!address || !enabled || !CONTRACTS.aqua) return;
    const { data: fresh } = await refetchCollateralAllowance();
    if (fresh !== undefined && fresh >= capacityRaw) { setStep("approved"); return; }
    setStep("approving");
    approve({ address: collateralToken, abi: ERC20_ABI, functionName: "approve", args: [CONTRACTS.aqua as `0x${string}`, capacityRaw] });
  };
  const handleOpen = () => {
    if (openCalledRef.current) return;
    openCalledRef.current = true;
    setStep("opening");
    if (nextAuthId !== undefined) setAuthIdToShip(nextAuthId);
    open({ address: rfq, abi: RFQ_ABI, functionName: "openRange", args: [BigInt(kMin) * WAD, BigInt(kMax) * WAD, expiry, capacityRaw, isCall] });
  };
  const handleShip = () => {
    if (shipCalledRef.current || !shipParams || !CONTRACTS.aqua) return;
    shipCalledRef.current = true;
    setStep("shipping");
    const [app, strategy, tokens, amounts] = shipParams;
    ship({ address: CONTRACTS.aqua as `0x${string}`, abi: AQUA_ABI, functionName: "ship", args: [app, strategy, [...tokens], [...amounts]] });
  };
  const handleReset = () => { setStep("idle"); setAuthIdToShip(null); openCalledRef.current = false; shipCalledRef.current = false; };
  const isWorking = (step === "approving" && (approvePending || approveConfirming)) || (step === "opening" && (openPending || openConfirming)) || (step === "shipping" && (shipPending || shipConfirming));

  // ── 2. LP signs a quote (no gas) ────────────────────────────────────────
  // A copilot prefill pins the range to quote on; otherwise the desk shows
  // the range just shipped, else the latest one.
  const [pinnedAuthId, setPinnedAuthId] = useState<bigint | null>(null);
  const viewAuthId: bigint | null = pinnedAuthId ?? (step === "done" && authIdToShip !== null ? authIdToShip : nextAuthId !== undefined && nextAuthId > ZERO_BI ? nextAuthId - ONE_BI : null);
  const { data: range } = useReadContract({ address: rfq, abi: RFQ_ABI, functionName: "ranges", args: [viewAuthId ?? ZERO_BI], query: { enabled: enabled && viewAuthId !== null, refetchInterval: 10_000 } });
  const rLp = range ? range[0] : ZERO;
  const rMin = range ? Number(range[1]) / 1e18 : 0;
  const rMax = range ? Number(range[2]) / 1e18 : 0;
  const rIsCall = range ? range[7] : true;
  const rActive = range ? range[8] : false;

  const [qStrike, setQStrike] = useState(grid(spot));
  const [qAmount, setQAmount] = useState("1");
  const [improveBps, setImproveBps] = useState("100");
  const [ttlMin, setTtlMin] = useState("10");
  const qStrikeWad = BigInt(Math.max(0, Math.round(qStrike))) * WAD;
  const qAmountWad = BigInt(Math.round((Number(qAmount) || 0) * 1e18));
  const { data: formula } = useReadContract({
    address: rfq, abi: RFQ_ABI, functionName: "formulaQuote", args: [viewAuthId ?? ZERO_BI, qStrikeWad, qAmountWad],
    query: { enabled: enabled && viewAuthId !== null && qAmountWad > ZERO_BI, refetchInterval: 10_000 },
  });
  const formulaPremium = formula?.[0] ?? ZERO_BI;
  const improved = qAmountWad > ZERO_BI ? (formulaPremium * BigInt(10_000 - (Number(improveBps) || 0)) / BigInt(10_000)) : ZERO_BI;
  const premiumPerUnit = qAmountWad > ZERO_BI ? (improved * WAD) / qAmountWad : ZERO_BI;

  // Prefill from the copilot's prepare_rfq_quote card: the range to quote
  // on, strike, size, ttl, and the premium expressed as an improvement on
  // the formula ask (the desk quotes in bps below formula).
  useEffect(() => {
    const apply = (p: RfqPrefill | null) => {
      if (!p) return;
      setPinnedAuthId(BigInt(p.authId));
      setQStrike(p.strike);
      setQAmount(String(p.maxAmount));
      setTtlMin(String(p.ttlMinutes));
      if (p.formulaAskUsd && p.formulaAskUsd > 0) {
        setImproveBps(String(Math.max(0, Math.round((1 - p.premiumPerUnitUsd / p.formulaAskUsd) * 10_000))));
      }
    };
    apply(takePrefill<RfqPrefill>("rfq"));
    const onPrefill = (ev: Event) => apply((ev as CustomEvent<RfqPrefill>).detail);
    window.addEventListener("smile:prefill-rfq", onPrefill);
    return () => window.removeEventListener("smile:prefill-rfq", onPrefill);
  }, []);

  const [signed, setSigned] = useState<SignedQuote | null>(null);
  const { signTypedDataAsync, isPending: signing, error: signError } = useSignTypedData();
  const handleSign = async () => {
    if (!address || viewAuthId === null) return;
    const quote: Quote = { authId: viewAuthId, strike: qStrikeWad, maxAmount: qAmountWad, premiumPerUnit, ttl: BigInt(Math.floor(Date.now() / 1000) + (Number(ttlMin) || 10) * 60), nonce: BigInt(Date.now()) };
    const signature = await signTypedDataAsync({
      domain: { name: "Smile RFQ", version: "1", chainId, verifyingContract: rfq },
      types: QUOTE_TYPES, primaryType: "Quote", message: quote,
    });
    const s = { quote, signature, lp: address };
    setSigned(s);
    setPasted(serialize(s));
  };

  // ── 3. Taker fills ──────────────────────────────────────────────────────
  const [pasted, setPasted] = useState("");
  const taking = parse(pasted) ?? signed;
  const [fillUnits, setFillUnits] = useState("1");
  const fillWad = BigInt(Math.round((Number(fillUnits) || 0) * 1e18));
  const { data: cost, error: costError } = useReadContract({
    address: rfq, abi: RFQ_ABI, functionName: "fillCost", args: [taking?.quote ?? { authId: ZERO_BI, strike: ZERO_BI, maxAmount: ZERO_BI, premiumPerUnit: ZERO_BI, ttl: ZERO_BI, nonce: ZERO_BI }, fillWad],
    query: { enabled: enabled && !!taking && fillWad > ZERO_BI },
  });
  const { data: formulaForFill } = useReadContract({
    address: rfq, abi: RFQ_ABI, functionName: "formulaQuote", args: [taking?.quote.authId ?? ZERO_BI, taking?.quote.strike ?? ZERO_BI, fillWad],
    query: { enabled: enabled && !!taking && fillWad > ZERO_BI, refetchInterval: 10_000 },
  });
  const { data: used } = useReadContract({ address: rfq, abi: RFQ_ABI, functionName: "nonceUsed", args: [taking?.lp ?? ZERO, taking?.quote.nonce ?? ZERO_BI], query: { enabled: enabled && !!taking, refetchInterval: 5_000 } });
  const { refetch: refetchUsdcAllowance } = useReadContract({ address: CONTRACTS.usdc, abi: ERC20_ABI, functionName: "allowance", args: [address ?? ZERO, rfq], query: { enabled: !!address && enabled } });
  const lpPremium = cost?.[0] ?? ZERO_BI;
  const fee = cost?.[1] ?? ZERO_BI;
  const total = lpPremium + fee;
  const formulaTotal = formulaForFill ? formulaForFill[0] + formulaForFill[1] : ZERO_BI;
  const saving = formulaTotal > total ? formulaTotal - total : ZERO_BI;
  const expiredQuote = taking ? Number(taking.quote.ttl) * 1000 < Date.now() : false;

  const [fillStep, setFillStep] = useState<"idle" | "approving" | "filling" | "done">("idle");
  const { writeContract: approveUsdc, data: approveUsdcTx, isPending: approveUsdcPending, error: approveUsdcError } = useWriteContract();
  const { isLoading: approveUsdcConfirming, isSuccess: approveUsdcSuccess } = useWaitForTransactionReceipt({ hash: approveUsdcTx });
  const { writeContract: fill, data: fillTx, isPending: fillPending, error: fillError } = useWriteContract();
  const { isLoading: fillConfirming, isSuccess: fillSuccess } = useWaitForTransactionReceipt({ hash: fillTx });
  const doFill = () => {
    if (!taking) return;
    setFillStep("filling");
    fill({ address: rfq, abi: RFQ_ABI, functionName: "fill", args: [taking.quote, taking.signature, fillWad, total] });
  };
  useEffect(() => { if (approveUsdcSuccess && fillStep === "approving") doFill(); }, [approveUsdcSuccess]);
  useEffect(() => { if (fillSuccess && fillStep === "filling") setFillStep("done"); }, [fillSuccess]);
  const handleFill = async () => {
    if (!address || !taking || total === ZERO_BI) return;
    const { data: fresh } = await refetchUsdcAllowance();
    if (fresh !== undefined && fresh >= total) { doFill(); return; }
    setFillStep("approving");
    approveUsdc({ address: CONTRACTS.usdc, abi: ERC20_ABI, functionName: "approve", args: [rfq, total] });
  };
  const fillWorking = fillStep === "approving" ? (approveUsdcPending || approveUsdcConfirming) : fillStep === "filling" ? (fillPending || fillConfirming) : false;

  if (!mounted || !isConnected) return <div className="rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">{mounted ? "Connect wallet to quote or fill." : null}</div>;
  if (!enabled) return <div className="rounded-xl border border-gray-800 p-4 text-yellow-500 text-xs">Set NEXT_PUBLIC_RFQ_VAULT (printed by ./local.sh) to enable the RFQ desk.</div>;

  const input = "w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600 disabled:opacity-50";
  const btn = (c: string) => `w-full py-2 rounded-lg ${c} disabled:opacity-50 text-white text-sm font-semibold`;

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      {/* ── LP: ship a range ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
        <div>
          <h3 className="text-white font-semibold text-sm">1 · LP ships a range</h3>
          <p className="text-gray-500 text-xs mt-1">Same JIT Aqua allowance as tier 1 — collateral stays in your wallet until a quote is filled.</p>
        </div>
        <div className="flex gap-2">
          {[true, false].map((c) => (
            <button key={String(c)} onClick={() => setIsCall(c)} disabled={isWorking} className={`flex-1 py-2 rounded-lg text-xs font-semibold ${isCall === c ? (c ? "bg-blue-600 text-white" : "bg-orange-700 text-white") : "bg-gray-800 text-gray-400 hover:text-white"}`}>{c ? "Calls (WETH)" : "Puts (USDC)"}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="text-xs text-gray-400 mb-1 block">Strike min</label><input type="number" value={kMin} disabled={isWorking} onChange={(e) => setKMin(Number(e.target.value))} className={input} /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Strike max</label><input type="number" value={kMax} disabled={isWorking} onChange={(e) => setKMax(Number(e.target.value))} className={input} /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Capacity ({isCall ? "WETH" : "USDC"})</label><input type="number" value={capacity} disabled={isWorking} onChange={(e) => setCapacity(e.target.value)} className={input} /></div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Expiry</label>
            <div className="flex gap-1">{EXPIRY_PRESETS.map((p) => <button key={p.seconds} onClick={() => setExpiryOffset(p.seconds)} disabled={isWorking} className={`flex-1 py-2 rounded-lg text-xs ${expiryOffset === p.seconds ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400"}`}>{p.label}</button>)}</div>
          </div>
        </div>
        {(approveError || openError || shipError) && <div className="text-xs text-red-400">{(approveError || openError || shipError)?.message.split("\n")[0]}</div>}
        {(step === "idle" || step === "approving") && <button onClick={handleStart} disabled={isWorking || kMax < kMin || capacityRaw === ZERO_BI} className={btn("bg-blue-600 hover:bg-blue-500")}>{step === "idle" ? (collateralAllowance !== undefined && collateralAllowance >= capacityRaw ? "Open Range" : "Approve Aqua & Open Range") : "Approving…"}</button>}
        {(step === "approved" || step === "opening") && <button onClick={() => { openCalledRef.current = false; handleOpen(); }} disabled={isWorking} className={btn("bg-blue-600 hover:bg-blue-500")}>{openPending ? "Check wallet…" : openConfirming ? "Opening…" : "Open Range"}</button>}
        {(step === "opened" || step === "shipping") && <button onClick={() => { shipCalledRef.current = false; handleShip(); }} disabled={isWorking || !shipParams} className={btn("bg-green-700 hover:bg-green-600")}>{shipPending ? "Check wallet…" : shipConfirming ? "Shipping…" : "Ship to Aqua"}</button>}
        {step === "done" && <div className="rounded-lg border border-green-800 bg-green-950/30 p-3 text-xs flex justify-between"><span className="text-green-400">Range #{authIdToShip?.toString()} shipped.</span><button onClick={handleReset} className="text-gray-500 hover:text-white">New</button></div>}
        {viewAuthId !== null && (
          <div className="rounded-lg bg-gray-800 p-3 text-xs space-y-1">
            <div className="flex justify-between"><span className="text-gray-400">Latest range</span><span className="font-mono text-white">#{viewAuthId.toString()} · {rIsCall ? "calls" : "puts"} ${rMin.toLocaleString()}–${rMax.toLocaleString()}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">LP</span><span className="font-mono text-gray-300">{rLp.slice(0, 6)}…{rLp.slice(-4)}{rLp.toLowerCase() === address?.toLowerCase() ? " (you)" : ""}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Status</span><span className={rActive ? "text-green-400" : "text-red-400"}>{rActive ? "active" : "revoked"}</span></div>
          </div>
        )}
      </div>

      {/* ── LP: sign a quote ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
        <div>
          <h3 className="text-white font-semibold text-sm">2 · LP signs a quote (no gas)</h3>
          <p className="text-gray-500 text-xs mt-1">An EIP-712 message from your wallet: strike, size cap, price, expiry, nonce. Price it off whatever model you like — here, the formula Ask minus an improvement.</p>
        </div>
        {viewAuthId === null ? <div className="text-gray-600 text-xs">Ship a range first.</div> : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs text-gray-400 mb-1 block">Strike</label><input type="number" value={qStrike} step="50" onChange={(e) => setQStrike(Number(e.target.value))} className={input} /></div>
              <div><label className="text-xs text-gray-400 mb-1 block">Max size (units)</label><input type="number" value={qAmount} onChange={(e) => setQAmount(e.target.value)} className={input} /></div>
              <div><label className="text-xs text-gray-400 mb-1 block">Inside the formula (bps)</label><input type="number" value={improveBps} onChange={(e) => setImproveBps(e.target.value)} className={input} /></div>
              <div><label className="text-xs text-gray-400 mb-1 block">Valid for (min)</label><input type="number" value={ttlMin} onChange={(e) => setTtlMin(e.target.value)} className={input} /></div>
            </div>
            <div className="rounded-lg border border-green-900 bg-green-950/30 p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-gray-400">Tier-1 formula Ask</span><span className="font-mono text-gray-500 line-through">{usd(formula ? formulaPremium : undefined)}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Your quote</span><span className="font-mono text-green-400">{usd(formula ? improved : undefined)}</span></div>
              <div className="flex justify-between border-t border-green-900/60 pt-1"><span className="text-gray-300">Per unit</span><span className="font-mono text-white">{formula ? `${(Number(premiumPerUnit) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC` : "…"}</span></div>
            </div>
            {signError && <div className="text-xs text-red-400">{signError.message.split("\n")[0]}</div>}
            <button onClick={handleSign} disabled={signing || !formula || rLp.toLowerCase() !== address?.toLowerCase()} className={btn("bg-blue-600 hover:bg-blue-500")}>
              {signing ? "Check wallet — sign…" : rLp.toLowerCase() !== address?.toLowerCase() ? "Connect as the range's LP to sign" : "Sign Quote"}
            </button>
            {signed && (
              <div className="text-xs space-y-1">
                <div className="text-green-400">Signed. Nonce {signed.quote.nonce.toString()}, valid until {new Date(Number(signed.quote.ttl) * 1000).toLocaleTimeString()}.</div>
                <textarea readOnly value={serialize(signed)} className={`${input} h-28 text-[10px]`} />
                <div className="text-gray-500">Hand this to a taker (or switch accounts and fill it on the right).</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Taker: fill ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
        <div>
          <h3 className="text-white font-semibold text-sm">3 · Taker fills the quote</h3>
          <p className="text-gray-500 text-xs mt-1">The vault recovers the signer, checks ttl / size / nonce, takes the premium, and pulls the collateral JIT from the LP wallet through Aqua — tier-1 custody at a tier-2 price.</p>
        </div>
        <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="paste a signed quote (JSON) — or sign one on the left" className={`${input} h-24 text-[10px]`} />
        {taking && (
          <>
            <div className="rounded-lg bg-gray-800 p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-gray-400">Quote</span><span className="font-mono text-white">range #{taking.quote.authId.toString()} · ${(Number(taking.quote.strike) / 1e18).toLocaleString()} · up to {(Number(taking.quote.maxAmount) / 1e18).toLocaleString()} units</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Signed by</span><span className="font-mono text-gray-300">{taking.lp.slice(0, 6)}…{taking.lp.slice(-4)}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Status</span><span className={used || expiredQuote ? "text-red-400" : "text-green-400"}>{used ? "used / cancelled" : expiredQuote ? "expired" : `valid until ${new Date(Number(taking.quote.ttl) * 1000).toLocaleTimeString()}`}</span></div>
            </div>
            <div><label className="text-xs text-gray-400 mb-1 block">Units to fill</label><input type="number" value={fillUnits} disabled={fillWorking} onChange={(e) => setFillUnits(e.target.value)} className={input} /></div>
            <div className="rounded-lg border border-green-900 bg-green-950/30 p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-gray-400">Tier-1 formula, incl. fee</span><span className="font-mono text-gray-500 line-through">{usd(formulaForFill ? formulaTotal : undefined)}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">This quote, incl. fee</span><span className="font-mono text-green-400">{usd(cost ? total : undefined)}</span></div>
              <div className="flex justify-between border-t border-green-900/60 pt-1"><span className="text-gray-300">Price improvement</span><span className="font-mono text-white font-semibold">{cost && formulaForFill ? `${usd(saving)} (${formulaTotal > ZERO_BI ? (Number(saving) * 10_000 / Number(formulaTotal)).toFixed(0) : "0"} bps)` : "…"}</span></div>
              {costError && <div className="text-red-400">{costError.message.split("\n")[0]}</div>}
            </div>
            {(approveUsdcError || fillError) && <div className="text-xs text-red-400">{(approveUsdcError || fillError)?.message.split("\n")[0]}</div>}
            <button onClick={handleFill} disabled={fillWorking || !cost || !!used || expiredQuote || fillWad === ZERO_BI || fillWad > taking.quote.maxAmount} className={btn("bg-green-700 hover:bg-green-600")}>
              {fillStep === "approving" ? "Approving USDC…" : fillStep === "filling" ? (fillPending ? "Check wallet…" : "Filling…") : fillStep === "done" ? "Filled ✓ — fill another" : `Fill ${fillUnits || 0} unit${Number(fillUnits) === 1 ? "" : "s"} at the signed price`}
            </button>
            {fillStep === "done" && <div className="text-xs text-green-400">Filled. Collateral left the LP wallet at this block; the OptionToken is in yours.</div>}
          </>
        )}
      </div>
    </div>
  );
}
