"use client";

// S13 opt-in margin tier in one tab: a writer ships a margined put range, a
// taker buys a put from it, and the number this tab exists to show is what
// the writer locks — the initial margin off the worst-of-hour Chainlink mark
// (50% of spot ATM) instead of the whole strike the main vault takes. The
// health card below shows the same margin math the keeper liquidates on.
//
// Same three-step Aqua flow as the spread desk (approve → open → ship),
// against the MarginVault. Part B of
// docs/plans/2026-09-05-aqua.md.

import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract } from "wagmi";
import { useState, useEffect, useRef } from "react";
import { CONTRACTS, AQUA_ABI, SHIP_PARAMS_ABI } from "@/config/wagmi";
import { DEPLOYMENTS } from "@/lib/deployments";

const MARGIN_ABI = [
  {
    name: "openRange", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "strikeMin", type: "uint256" }, { name: "strikeMax", type: "uint256" }, { name: "expiry", type: "uint256" },
      { name: "maxCapacity", type: "uint256" }, { name: "lpMarginBps", type: "uint16" }, { name: "autoTopUp", type: "bool" },
      { name: "sigmaMulBps", type: "uint16" },
    ],
    outputs: [{ name: "authId", type: "uint256" }],
  },
  { name: "nextAuthId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    name: "ranges", type: "function", stateMutability: "view", inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "lp", type: "address" }, { name: "strikeMin", type: "uint256" }, { name: "strikeMax", type: "uint256" },
      { name: "expiry", type: "uint256" }, { name: "maxCapacity", type: "uint256" }, { name: "active", type: "bool" },
      { name: "autoTopUp", type: "bool" }, { name: "lpMarginBps", type: "uint16" }, { name: "sigmaMulBps", type: "uint16" },
      { name: "strategyHash", type: "bytes32" }, { name: "feeBps", type: "uint32" }, { name: "beta", type: "int256" },
      { name: "spotStaleness", type: "uint16" },
    ],
  },
  {
    name: "quote", type: "function", stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }, { name: "strike", type: "uint256" }, { name: "units", type: "uint256" }],
    outputs: [{ name: "lpPremium", type: "uint256" }, { name: "fee", type: "uint256" }],
  },
  {
    name: "initialMargin", type: "function", stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }, { name: "strike", type: "uint256" }, { name: "units", type: "uint256" }],
    outputs: [{ name: "im", type: "uint256" }],
  },
  {
    name: "buy", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "authId", type: "uint256" }, { name: "strike", type: "uint256" }, { name: "units", type: "uint256" }, { name: "maxPremium", type: "uint256" }],
    outputs: [{ name: "token", type: "address" }, { name: "premiumPaid", type: "uint256" }],
  },
  { name: "seriesId", type: "function", stateMutability: "pure", inputs: [{ name: "strike", type: "uint256" }, { name: "expiry", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }] },
  {
    name: "seriesOf", type: "function", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "strike", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "token", type: "address" },
      { name: "totalUnits", type: "uint256" }, { name: "positionCount", type: "uint256" }, { name: "settledPositions", type: "uint256" },
      { name: "owedTotal", type: "uint256" }, { name: "pot", type: "uint256" }, { name: "backstopDrawn", type: "uint256" },
      { name: "finalized", type: "bool" }, { name: "payoutPerUnit", type: "uint256" }, { name: "haircutBps", type: "uint16" },
    ],
  },
  {
    name: "health", type: "function", stateMutability: "view",
    inputs: [{ name: "sid", type: "bytes32" }, { name: "writer", type: "address" }],
    outputs: [{ name: "locked", type: "uint256" }, { name: "mm", type: "uint256" }, { name: "im", type: "uint256" }],
  },
  {
    name: "positions", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }, { name: "", type: "address" }],
    outputs: [
      { name: "authId", type: "uint256" }, { name: "units", type: "uint256" }, { name: "locked", type: "uint256" },
      { name: "flaggedAt", type: "uint64" }, { name: "auctionStart", type: "uint64" }, { name: "flagger", type: "address" },
    ],
  },
  { name: "markSpot", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "spotWad", type: "uint256" }, { name: "latestUpdatedAt", type: "uint256" }, { name: "roundsUsed", type: "uint256" }] },
  { name: "nakedNotional", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "effectiveCeiling", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "imBufferBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { name: "mmBufferBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { name: "insuranceFund", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  ...SHIP_PARAMS_ABI,
] as const;

const BACKSTOP_ABI = [
  { name: "totalAssets", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { name: "poolRequirement", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const EXPIRY_PRESETS = [
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
  { label: "90 days", seconds: 90 * 86_400 },
];

const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_BI = BigInt(0);
const ONE_BI = BigInt(1);
const WAD = BigInt(10) ** BigInt(18);
const USDC_UNIT = BigInt(1_000_000);

function fmtUsdc(v: bigint | undefined, digits = 2) {
  if (v === undefined) return "…";
  return `${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: digits })} USDC`;
}

export function MarginDesk({ spot }: { spot: number }) {
  const { address, isConnected, chainId } = useAccount();
  // How the pools were funded on this chain (Circle App Kits on Arc) — the
  // receipts tagged "Treasury ·" in lib/deployments.ts.
  const dep = chainId ? DEPLOYMENTS[chainId] : undefined;
  const treasury = dep?.demo.filter((t) => t.label.startsWith("Treasury ·")) ?? [];
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const mv = (CONTRACTS.marginVault || ZERO) as `0x${string}`;
  const enabled = !!CONTRACTS.marginVault;

  // ── Writer form ──────────────────────────────────────────────────────────
  const grid = (x: number) => Math.round(x / 50) * 50;
  const [kMin, setKMin] = useState(grid(spot) - 500);
  const [kMax, setKMax] = useState(grid(spot) + 500);
  const [expiryOffset, setExpiryOffset] = useState(30 * 86_400);
  const [capacity, setCapacity] = useState("10000");
  const [autoTopUp, setAutoTopUp] = useState(true);
  const [step, setStep] = useState<"idle" | "approving" | "approved" | "opening" | "opened" | "shipping" | "done">("idle");
  const [authIdToShip, setAuthIdToShip] = useState<bigint | null>(null);
  const openCalledRef = useRef(false);
  const shipCalledRef = useRef(false);

  const capacityUsdc = BigInt(Math.round((Number(capacity) || 0) * 1e6));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryOffset);
  const validRange = kMax >= kMin && kMin > 0;

  const { data: nextAuthId, refetch: refetchNext } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "nextAuthId",
    query: { enabled, refetchInterval: 10_000 },
  });
  const { data: usdcAllowanceAqua, refetch: refetchAquaAllowance } = useReadContract({
    address: CONTRACTS.usdc, abi: ERC20_ABI, functionName: "allowance",
    args: [address ?? ZERO, (CONTRACTS.aqua || ZERO) as `0x${string}`],
    query: { enabled: !!address && !!CONTRACTS.aqua },
  });
  const { data: shipParams } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "getShipParams",
    args: [authIdToShip ?? ZERO_BI],
    query: { enabled: enabled && authIdToShip !== null },
  });

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
    const { data: fresh } = await refetchAquaAllowance();
    if (fresh !== undefined && fresh >= capacityUsdc) { setStep("approved"); return; }
    setStep("approving");
    approve({ address: CONTRACTS.usdc, abi: ERC20_ABI, functionName: "approve", args: [CONTRACTS.aqua as `0x${string}`, capacityUsdc] });
  };
  const handleOpen = () => {
    if (openCalledRef.current) return;
    openCalledRef.current = true;
    setStep("opening");
    if (nextAuthId !== undefined) setAuthIdToShip(nextAuthId);
    open({
      address: mv, abi: MARGIN_ABI, functionName: "openRange",
      args: [BigInt(kMin) * WAD, BigInt(kMax) * WAD, expiry, capacityUsdc, 0, autoTopUp, 0],
    });
  };
  const handleShip = () => {
    if (shipCalledRef.current || !shipParams || !CONTRACTS.aqua) return;
    shipCalledRef.current = true;
    setStep("shipping");
    const [app, strategy, tokens, amounts] = shipParams;
    ship({ address: CONTRACTS.aqua as `0x${string}`, abi: AQUA_ABI, functionName: "ship", args: [app, strategy, [...tokens], [...amounts]] });
  };
  const handleReset = () => { setStep("idle"); setAuthIdToShip(null); openCalledRef.current = false; shipCalledRef.current = false; };
  const isWorking =
    (step === "approving" && (approvePending || approveConfirming)) ||
    (step === "opening" && (openPending || openConfirming)) ||
    (step === "shipping" && (shipPending || shipConfirming));

  // ── Taker card: the range just shipped, else the latest one on-chain ────
  const viewAuthId: bigint | null =
    step === "done" && authIdToShip !== null ? authIdToShip
    : nextAuthId !== undefined && nextAuthId > ZERO_BI ? nextAuthId - ONE_BI
    : null;
  const { data: range } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "ranges", args: [viewAuthId ?? ZERO_BI],
    query: { enabled: enabled && viewAuthId !== null, refetchInterval: 10_000 },
  });
  const rMin = range ? Number(range[1]) / 1e18 : 0;
  const rMax = range ? Number(range[2]) / 1e18 : 0;
  const rExpiry = range ? range[3] : ZERO_BI;
  const rActive = range ? range[5] : false;
  const rAutoTopUp = range ? range[6] : false;
  const rLp = range ? range[0] : ZERO;

  const [strike, setStrike] = useState(grid(spot));
  const [buyUnits, setBuyUnits] = useState("1");
  const buyUnitsWad = BigInt(Math.round((Number(buyUnits) || 0) * 1e18));
  const strikeWad = BigInt(Math.max(0, Math.round(strike))) * WAD;
  const { data: quoteData, error: quoteError } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "quote", args: [viewAuthId ?? ZERO_BI, strikeWad, buyUnitsWad],
    query: { enabled: enabled && viewAuthId !== null && buyUnitsWad > ZERO_BI, refetchInterval: 10_000 },
  });
  const { data: im } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "initialMargin", args: [viewAuthId ?? ZERO_BI, strikeWad, buyUnitsWad],
    query: { enabled: enabled && viewAuthId !== null && buyUnitsWad > ZERO_BI, refetchInterval: 10_000 },
  });
  const { refetch: refetchUsdcAllowance } = useReadContract({
    address: CONTRACTS.usdc, abi: ERC20_ABI, functionName: "allowance", args: [address ?? ZERO, mv],
    query: { enabled: !!address && enabled },
  });
  const { data: sid } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "seriesId", args: [strikeWad, rExpiry],
    query: { enabled: enabled && !!range },
  });
  const { data: series, refetch: refetchSeries } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "seriesOf", args: [sid ?? ("0x" + "0".repeat(64)) as `0x${string}`],
    query: { enabled: enabled && !!sid, refetchInterval: 10_000 },
  });
  const seriesToken = series ? series[2] : ZERO;
  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: seriesToken as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [address ?? ZERO],
    query: { enabled: !!address && seriesToken !== ZERO },
  });

  const [buyStep, setBuyStep] = useState<"idle" | "approving" | "buying" | "done">("idle");
  const { writeContract: approveUsdc, data: approveUsdcTx, isPending: approveUsdcPending, error: approveUsdcError } = useWriteContract();
  const { isLoading: approveUsdcConfirming, isSuccess: approveUsdcSuccess } = useWaitForTransactionReceipt({ hash: approveUsdcTx });
  const { writeContract: buy, data: buyTx, isPending: buyPending, error: buyError } = useWriteContract();
  const { isLoading: buyConfirming, isSuccess: buySuccess } = useWaitForTransactionReceipt({ hash: buyTx });

  const premium = quoteData?.[0] ?? ZERO_BI;
  const fee = quoteData?.[1] ?? ZERO_BI;
  const totalCost = premium + fee;
  const maxPremium = (totalCost * BigInt(101)) / BigInt(100);
  const fullStrikeLock = (strikeWad * buyUnitsWad) / WAD / (WAD / USDC_UNIT); // what the main vault would lock
  const ratio = im && im > ZERO_BI ? Number(fullStrikeLock) / Number(im) : 0;

  const doBuy = () => {
    if (viewAuthId === null) return;
    setBuyStep("buying");
    buy({ address: mv, abi: MARGIN_ABI, functionName: "buy", args: [viewAuthId, strikeWad, buyUnitsWad, maxPremium] });
  };
  useEffect(() => { if (approveUsdcSuccess && buyStep === "approving") doBuy(); }, [approveUsdcSuccess]);
  useEffect(() => {
    if (buySuccess && buyStep === "buying") { setBuyStep("done"); refetchSeries().then(() => refetchBalance()); }
  }, [buySuccess]);
  const handleBuy = async () => {
    if (!address || viewAuthId === null || totalCost === ZERO_BI) return;
    const { data: fresh } = await refetchUsdcAllowance();
    if (fresh !== undefined && fresh >= maxPremium) { doBuy(); return; }
    setBuyStep("approving");
    approveUsdc({ address: CONTRACTS.usdc, abi: ERC20_ABI, functionName: "approve", args: [mv, maxPremium] });
  };
  const buyWorking = buyStep === "approving" ? (approveUsdcPending || approveUsdcConfirming) : buyStep === "buying" ? (buyPending || buyConfirming) : false;

  // ── Health card: the writer's position in this series, and the vault's risk dials ─
  const { data: health } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "health", args: [sid ?? ("0x" + "0".repeat(64)) as `0x${string}`, rLp],
    query: { enabled: enabled && !!sid && rLp !== ZERO, refetchInterval: 10_000 },
  });
  const { data: position } = useReadContract({
    address: mv, abi: MARGIN_ABI, functionName: "positions", args: [sid ?? ("0x" + "0".repeat(64)) as `0x${string}`, rLp],
    query: { enabled: enabled && !!sid && rLp !== ZERO, refetchInterval: 10_000 },
  });
  const { data: mark } = useReadContract({ address: mv, abi: MARGIN_ABI, functionName: "markSpot", query: { enabled, refetchInterval: 10_000 } });
  const { data: naked } = useReadContract({ address: mv, abi: MARGIN_ABI, functionName: "nakedNotional", query: { enabled, refetchInterval: 10_000 } });
  const { data: ceiling } = useReadContract({ address: mv, abi: MARGIN_ABI, functionName: "effectiveCeiling", query: { enabled, refetchInterval: 10_000 } });
  const { data: imBps } = useReadContract({ address: mv, abi: MARGIN_ABI, functionName: "imBufferBps", query: { enabled } });
  const { data: mmBps } = useReadContract({ address: mv, abi: MARGIN_ABI, functionName: "mmBufferBps", query: { enabled } });
  const { data: insurance } = useReadContract({ address: mv, abi: MARGIN_ABI, functionName: "insuranceFund", query: { enabled, refetchInterval: 10_000 } });
  const { data: poolAssets } = useReadContract({
    address: (CONTRACTS.marginBackstop || ZERO) as `0x${string}`, abi: BACKSTOP_ABI, functionName: "totalAssets",
    query: { enabled: !!CONTRACTS.marginBackstop, refetchInterval: 10_000 },
  });

  if (!mounted || !isConnected) {
    return <div className="rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">{mounted ? "Connect wallet to write or buy a margined put." : null}</div>;
  }
  if (!enabled) {
    return <div className="rounded-xl border border-gray-800 p-4 text-yellow-500 text-xs">Set NEXT_PUBLIC_MARGIN_VAULT (printed by ./local.sh) to enable the margin desk.</div>;
  }

  const input = "w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600 disabled:opacity-50";
  const locked = health?.[0] ?? ZERO_BI;
  const mm = health?.[1] ?? ZERO_BI;
  const imReq = health?.[2] ?? ZERO_BI;
  const posUnits = position?.[1] ?? ZERO_BI;
  const flaggedAt = position ? Number(position[3]) : 0;
  const auctionStart = position ? Number(position[4]) : 0;
  const healthState = posUnits === ZERO_BI ? "no position" : auctionStart ? "in auction" : flaggedAt ? "flagged" : locked >= imReq ? "at IM" : locked >= mm ? "above MM" : "below MM";
  const healthColor = healthState === "below MM" || healthState === "flagged" || healthState === "in auction" ? "text-red-400" : healthState === "above MM" ? "text-yellow-400" : "text-green-400";

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-4">
        {/* ── Writer ─────────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
          <div>
            <h3 className="text-white font-semibold text-sm">Write Margined Puts</h3>
            <p className="text-gray-500 text-xs mt-1">
              S13 opt-in tier: a fill pulls only initial margin — intrinsic plus {imBps !== undefined ? `${Number(imBps) / 100}%` : "50%"} of the
              worst-of-hour Chainlink mark, never more than the strike — instead of the whole strike. Below the{" "}
              {mmBps !== undefined ? `${Number(mmBps) / 100}%` : "30%"} maintenance floor you get margin-called; unanswered, your position is auctioned,
              then absorbed by the backstop. Capacity here is margin, not notional.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-gray-400 mb-1 block">Strike min (USD)</label><input type="number" value={kMin} disabled={isWorking} onChange={(e) => setKMin(Number(e.target.value))} className={input} /></div>
            <div><label className="text-xs text-gray-400 mb-1 block">Strike max (USD)</label><input type="number" value={kMax} disabled={isWorking} onChange={(e) => setKMax(Number(e.target.value))} className={input} /></div>
            <div><label className="text-xs text-gray-400 mb-1 block">Margin capacity (USDC)</label><input type="number" value={capacity} disabled={isWorking} onChange={(e) => setCapacity(e.target.value)} className={input} /></div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Expiry</label>
              <div className="flex gap-1">
                {EXPIRY_PRESETS.map((p) => (
                  <button key={p.seconds} onClick={() => setExpiryOffset(p.seconds)} disabled={isWorking}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium ${expiryOffset === p.seconds ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>{p.label}</button>
                ))}
              </div>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={autoTopUp} disabled={isWorking} onChange={(e) => setAutoTopUp(e.target.checked)} />
            Aqua credit line: let a margin call pull the top-up from this same allowance before flagging me
          </label>

          {step !== "idle" && (
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span className={step === "approving" ? "text-blue-400 font-semibold" : "text-green-400"}>✓ 1. Approve Aqua</span>
              <span className="text-gray-700">→</span>
              <span className={step === "approved" ? "text-yellow-400 font-semibold" : step === "opening" ? "text-blue-400 font-semibold" : ["opened", "shipping", "done"].includes(step) ? "text-green-400" : "text-gray-600"}>2. Open range</span>
              <span className="text-gray-700">→</span>
              <span className={step === "opened" ? "text-yellow-400 font-semibold" : step === "shipping" ? "text-blue-400 font-semibold" : step === "done" ? "text-green-400" : "text-gray-600"}>3. Ship to Aqua</span>
              {step !== "done" && !isWorking && <button onClick={handleReset} className="ml-auto text-gray-500 hover:text-white">Reset</button>}
            </div>
          )}
          {(approveError || openError || shipError) && <div className="text-xs text-red-400">{(approveError || openError || shipError)?.message.split("\n")[0]}</div>}

          {(step === "idle" || step === "approving") && (
            <button onClick={handleStart} disabled={isWorking || !validRange || capacityUsdc === ZERO_BI || !CONTRACTS.aqua}
              className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold">
              {step === "idle" ? (usdcAllowanceAqua !== undefined && usdcAllowanceAqua >= capacityUsdc ? "Open Range" : "1. Approve Aqua & Open Range") : approvePending ? "Check wallet — confirm approval…" : "Approving…"}
            </button>
          )}
          {(step === "approved" || step === "opening") && (
            <button onClick={() => { openCalledRef.current = false; handleOpen(); }} disabled={isWorking}
              className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold">
              {openPending ? "Check wallet — confirm…" : openConfirming ? "Opening…" : "2. Open Range"}
            </button>
          )}
          {(step === "opened" || step === "shipping") && (
            <button onClick={() => { shipCalledRef.current = false; handleShip(); }} disabled={isWorking || !shipParams}
              className="w-full py-2 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-semibold">
              {shipPending ? "Check wallet — confirm ship…" : shipConfirming ? "Shipping…" : "3. Ship to Aqua"}
            </button>
          )}
          {step === "done" && (
            <div className="rounded-lg border border-green-800 bg-green-950/30 p-3 text-xs flex items-center justify-between">
              <span className="text-green-400">Range #{authIdToShip?.toString()} shipped — {fmtUsdc(capacityUsdc, 0)} of margin capacity, still in your wallet.</span>
              <button onClick={handleReset} className="text-gray-500 hover:text-white">New</button>
            </div>
          )}
        </div>

        {/* ── Taker ──────────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
          <div>
            <h3 className="text-white font-semibold text-sm">Buy a Put from It</h3>
            <p className="text-gray-500 text-xs mt-1">Same premium as the fully collateralized vault — the surface is shared. What changes is what the writer locks.</p>
          </div>
          {viewAuthId === null ? (
            <div className="text-gray-600 text-xs">No margined ranges yet. Write one on the left.</div>
          ) : (
            <>
              <div className="rounded-lg bg-gray-800 p-3 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-gray-400">Range</span><span className="font-mono text-white">#{viewAuthId.toString()} · ${rMin.toLocaleString()} – ${rMax.toLocaleString()} · {rAutoTopUp ? "credit line on" : "no credit line"}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Expires</span><span className="font-mono text-white">{rExpiry > ZERO_BI ? new Date(Number(rExpiry) * 1000).toLocaleDateString() : "…"}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Status</span><span className={rActive ? "text-green-400" : "text-red-400"}>{rActive ? "active" : "closed"}</span></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-gray-400 mb-1 block">Strike (USD)</label><input type="number" value={strike} disabled={buyWorking} onChange={(e) => setStrike(Number(e.target.value))} step="50" className={input} /></div>
                <div><label className="text-xs text-gray-400 mb-1 block">Units</label><input type="number" value={buyUnits} disabled={buyWorking} onChange={(e) => setBuyUnits(e.target.value)} step="1" min="0" className={input} /></div>
              </div>
              {/* The whole point of S13, as a number */}
              <div className="rounded-lg border border-green-900 bg-green-950/30 p-3 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-gray-400">Writer locks (initial margin)</span><span className="font-mono text-green-400">{fmtUsdc(im)}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Main vault, cash-secured</span><span className="font-mono text-gray-500 line-through">{fmtUsdc(fullStrikeLock, 0)}</span></div>
                <div className="flex justify-between border-t border-green-900/60 pt-1"><span className="text-gray-300">Capital efficiency</span><span className="font-mono text-white font-semibold">{ratio ? `${ratio.toFixed(2)}× tighter` : "…"}</span></div>
              </div>
              <div className="rounded-lg border border-gray-700 p-3 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-gray-400">Premium (Ask)</span><span className="font-mono text-white">{quoteData ? fmtUsdc(premium) : quoteError ? "—" : "…"}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Protocol fee (50% insurance · 30% backstop · 20% DAO)</span><span className="font-mono text-gray-300">{quoteData ? fmtUsdc(fee) : "…"}</span></div>
                <div className="flex justify-between border-t border-gray-700 pt-1"><span className="text-gray-300">You pay</span><span className="font-mono text-white font-semibold">{quoteData ? fmtUsdc(totalCost) : "…"}</span></div>
                {quoteError && <div className="text-red-400">{quoteError.message.split("\n")[0]}</div>}
              </div>
              {(approveUsdcError || buyError) && <div className="text-xs text-red-400">{(approveUsdcError || buyError)?.message.split("\n")[0]}</div>}
              <button onClick={handleBuy} disabled={buyWorking || !quoteData || !rActive || buyUnitsWad === ZERO_BI}
                className="w-full py-2 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-semibold">
                {buyStep === "approving" ? (approveUsdcPending ? "Check wallet — approve USDC…" : "Approving…") : buyStep === "buying" ? (buyPending ? "Check wallet — confirm buy…" : "Buying…") : `Buy ${buyUnits || 0} put${Number(buyUnits) === 1 ? "" : "s"} @ $${strike.toLocaleString()}`}
              </button>
              {seriesToken !== ZERO && (
                <div className="text-xs text-gray-400 space-y-0.5">
                  <div>OptionToken (shared by every writer of this strike/expiry): <span className="font-mono text-gray-300">{seriesToken.slice(0, 6)}…{seriesToken.slice(-4)}</span></div>
                  {tokenBalance !== undefined && <div>You hold <span className="font-mono text-white">{(Number(tokenBalance) / 1e18).toLocaleString()}</span> units</div>}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Health: what the keeper liquidates on ───────────────────────── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h3 className="text-white font-semibold text-sm">Margin Health · ${strike.toLocaleString()} put{rExpiry > ZERO_BI ? ` · ${new Date(Number(rExpiry) * 1000).toLocaleDateString()}` : ""}</h3>
          <span className="text-xs text-gray-500">mark = lowest Chainlink answer in the last hour{mark ? ` · $${(Number(mark[0]) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 })} over ${mark[2].toString()} round${mark[2] === ONE_BI ? "" : "s"}` : ""}</span>
        </div>
        <div className="grid sm:grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg bg-gray-800 p-3 space-y-1">
            <div className="text-gray-400">Writer {rLp !== ZERO ? `${rLp.slice(0, 6)}…${rLp.slice(-4)}` : "—"}</div>
            <div className="flex justify-between"><span className="text-gray-400">Units short</span><span className="font-mono text-white">{(Number(posUnits) / 1e18).toLocaleString()}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Locked</span><span className="font-mono text-white">{fmtUsdc(locked)}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Maintenance / Initial</span><span className="font-mono text-gray-300">{fmtUsdc(mm, 0)} / {fmtUsdc(imReq, 0)}</span></div>
            <div className="flex justify-between border-t border-gray-700 pt-1"><span className="text-gray-300">State</span><span className={`font-semibold ${healthColor}`}>{healthState}</span></div>
          </div>
          <div className="rounded-lg bg-gray-800 p-3 space-y-1">
            <div className="text-gray-400">Vault exposure</div>
            <div className="flex justify-between"><span className="text-gray-400">Naked notional</span><span className="font-mono text-white">{fmtUsdc(naked, 0)}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Ceiling (min of owner cap, 7× backstop)</span><span className="font-mono text-white">{fmtUsdc(ceiling, 0)}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Buffers IM / MM</span><span className="font-mono text-gray-300">{imBps !== undefined ? `${Number(imBps) / 100}%` : "…"} / {mmBps !== undefined ? `${Number(mmBps) / 100}%` : "…"}</span></div>
          </div>
          <div className="rounded-lg bg-gray-800 p-3 space-y-1">
            <div className="text-gray-400">Behind the holders</div>
            <div className="flex justify-between"><span className="text-gray-400">Backstop pool</span><span className="font-mono text-white">{fmtUsdc(poolAssets, 0)}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">Insurance fund</span><span className="font-mono text-white">{fmtUsdc(insurance, 0)}</span></div>
            <div className="text-gray-500 pt-1">Waterfall: writer margin → free balance → takeover bidder → backstop → insurance → (haircut, loudly).</div>
            {treasury.length > 0 && dep && (
              <div className="pt-2 border-t border-gray-700 space-y-0.5">
                <div className="text-gray-400">Funded through Circle App Kits</div>
                {treasury.map((t) => (
                  <div key={t.hash} className="flex justify-between gap-2">
                    <span className="text-gray-500">{t.label.replace("Treasury · ", "")}{t.note ? ` — ${t.note}` : ""}</span>
                    <a href={`${dep.explorer}/tx/${t.hash}`} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-400 hover:underline shrink-0">{t.hash.slice(0, 10)}…</a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <p className="text-gray-600 text-xs">
          Liquidation runs from a script, not this page: <span className="font-mono">./script/margin-lifecycle.sh</span> replays fill → crash → flag → auction → absorb → settle → finalize → redeem on the local Anvil, and <span className="font-mono">keeper/margin.mjs</span> watches a live deployment.
        </p>
      </div>
    </div>
  );
}
