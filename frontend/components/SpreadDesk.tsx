"use client";

// S12 defined-risk netting, end to end in one tab: an LP writes a credit
// spread whose Aqua strategy backs only the structure's true max loss, and a
// taker buys it. The number this tab exists to show is the escrow ratio —
// 0.0625 WETH instead of 1 WETH for a 3000/3200 call credit spread (16x),
// 200 USDC instead of 3,200 for the put-credit twin — computed live from the
// strikes, exactly as SpreadVault.quote() computes it on-chain.
//
// Same three-step Aqua flow as AuthorizeRange (approve → register → ship),
// against the sibling SpreadVault instead of the main vault.

import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract } from "wagmi";
import { useState, useEffect, useRef } from "react";
import { CONTRACTS, AQUA_ABI, SHIP_PARAMS_ABI } from "@/config/wagmi";

const SPREAD_ABI = [
  {
    name: "openStructure", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "kind", type: "uint8" },
      { name: "strikes", type: "uint256[4]" },
      { name: "expiry", type: "uint256" },
      { name: "maxCollateral", type: "uint256" },
    ],
    outputs: [{ name: "authId", type: "uint256" }],
  },
  { name: "nextAuthId", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    name: "quote", type: "function", stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }, { name: "units", type: "uint256" }],
    outputs: [{ name: "premium", type: "uint256" }, { name: "fee", type: "uint256" }, { name: "escrow", type: "uint256" }],
  },
  {
    name: "buy", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "authId", type: "uint256" }, { name: "units", type: "uint256" }, { name: "maxPremium", type: "uint256" }],
    outputs: [{ name: "token", type: "address" }, { name: "premiumPaid", type: "uint256" }],
  },
  { name: "spreadTokens", type: "function", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  {
    name: "strikesOf", type: "function", stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[4]" }],
  },
  {
    name: "structures", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "lp", type: "address" }, { name: "kind", type: "uint8" }, { name: "expiry", type: "uint256" },
      { name: "maxCollateral", type: "uint256" }, { name: "active", type: "bool" }, { name: "strategyHash", type: "bytes32" },
      { name: "feeBps", type: "uint32" }, { name: "feeRecipient", type: "address" },
    ],
  },
  ...SHIP_PARAMS_ABI,
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

/// Mirrors SpreadVault.quote()'s escrow math (ceil), so the capacity the LP
/// ships is never a wei short of what the first fill pulls.
function escrowFor(isCall: boolean, k1: number, k2: number, unitsWad: bigint): bigint {
  if (k2 <= k1) return ZERO_BI;
  const gap = BigInt(k2 - k1);
  if (isCall) return (unitsWad * gap + BigInt(k2) - ONE_BI) / BigInt(k2);   // (K2-K1)/K2 WETH per unit
  return (unitsWad * gap * USDC_UNIT + WAD - ONE_BI) / WAD;                // K2-K1 USDC per unit
}

function fmtUnits(v: bigint, decimals: number, digits = 4) {
  return (Number(v) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function SpreadDesk({ spot }: { spot: number }) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // ── Writer form ──────────────────────────────────────────────────────────
  const grid = (x: number) => Math.round(x / 50) * 50;
  const [isCall, setIsCall] = useState(true);
  const [k1, setK1] = useState(grid(spot));
  const [k2, setK2] = useState(grid(spot) + 200);
  const [expiryOffset, setExpiryOffset] = useState(30 * 86_400);
  const [units, setUnits] = useState("1");
  const [step, setStep] = useState<"idle" | "approving" | "approved" | "opening" | "opened" | "shipping" | "done">("idle");
  const [authIdToShip, setAuthIdToShip] = useState<bigint | null>(null);
  const openCalledRef = useRef(false);
  const shipCalledRef = useRef(false);

  const unitsWad = BigInt(Math.round((Number(units) || 0) * 1e18));
  const collateralToken = isCall ? CONTRACTS.weth : CONTRACTS.usdc;
  const collateralDecimals = isCall ? 18 : 6;
  const collateralSymbol = isCall ? "WETH" : "USDC";
  const escrow = escrowFor(isCall, k1, k2, unitsWad);
  const nakedPerUnit = isCall ? 1 : k2;                       // what the main vault locks per unit
  const nettedPerUnit = isCall ? (k2 - k1) / k2 : k2 - k1;
  const ratio = nettedPerUnit > 0 ? nakedPerUnit / nettedPerUnit : 0;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryOffset);
  const strikes: readonly [bigint, bigint, bigint, bigint] = isCall
    ? [ZERO_BI, ZERO_BI, BigInt(k1) * WAD, BigInt(k2) * WAD]
    : [BigInt(k1) * WAD, BigInt(k2) * WAD, ZERO_BI, ZERO_BI];
  const validStrikes = k2 > k1 && k1 > 0;

  const { data: nextAuthId, refetch: refetchNext } = useReadContract({
    address: CONTRACTS.spreadVault as `0x${string}`,
    abi: SPREAD_ABI,
    functionName: "nextAuthId",
    query: { enabled: !!CONTRACTS.spreadVault, refetchInterval: 10_000 },
  });

  const { data: collateralAllowance, refetch: refetchCollateralAllowance } = useReadContract({
    address: collateralToken,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [address ?? ZERO, (CONTRACTS.aqua || ZERO) as `0x${string}`],
    query: { enabled: !!address && !!CONTRACTS.aqua },
  });

  const { data: shipParams } = useReadContract({
    address: CONTRACTS.spreadVault as `0x${string}`,
    abi: SPREAD_ABI,
    functionName: "getShipParams",
    args: [authIdToShip ?? ZERO_BI],
    query: { enabled: !!CONTRACTS.spreadVault && authIdToShip !== null },
  });

  const { writeContract: approve, data: approveTx, isPending: approvePending, error: approveError } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTx });
  const { writeContract: open, data: openTx, isPending: openPending, error: openError } = useWriteContract();
  const { isLoading: openConfirming, isSuccess: openSuccess } = useWaitForTransactionReceipt({ hash: openTx });
  const { writeContract: ship, data: shipTx, isPending: shipPending, error: shipError } = useWriteContract();
  const { isLoading: shipConfirming, isSuccess: shipSuccess } = useWaitForTransactionReceipt({ hash: shipTx });

  useEffect(() => { if (approveSuccess && step === "approving") setStep("approved"); }, [approveSuccess]);
  useEffect(() => { if (openSuccess && step === "opening") setStep("opened"); }, [openSuccess]);
  useEffect(() => {
    if (shipSuccess && step === "shipping") {
      setStep("done");
      refetchNext();
    }
  }, [shipSuccess]);

  const handleStart = async () => {
    if (!address || !CONTRACTS.spreadVault || !CONTRACTS.aqua) return;
    const { data: fresh } = await refetchCollateralAllowance();
    if (fresh !== undefined && fresh >= escrow) { setStep("approved"); return; }
    setStep("approving");
    approve({ address: collateralToken, abi: ERC20_ABI, functionName: "approve", args: [CONTRACTS.aqua as `0x${string}`, escrow] });
  };

  const handleOpen = () => {
    if (openCalledRef.current) return;
    openCalledRef.current = true;
    setStep("opening");
    if (nextAuthId !== undefined) setAuthIdToShip(nextAuthId);
    open({
      address: CONTRACTS.spreadVault as `0x${string}`,
      abi: SPREAD_ABI,
      functionName: "openStructure",
      args: [isCall ? 0 : 1, strikes, expiry, escrow],
    });
  };

  const handleShip = () => {
    if (shipCalledRef.current || !shipParams || !CONTRACTS.aqua) return;
    shipCalledRef.current = true;
    setStep("shipping");
    const [app, strategy, tokens, amounts] = shipParams;
    ship({ address: CONTRACTS.aqua as `0x${string}`, abi: AQUA_ABI, functionName: "ship", args: [app, strategy, [...tokens], [...amounts]] });
  };

  const handleReset = () => {
    setStep("idle"); setAuthIdToShip(null);
    openCalledRef.current = false; shipCalledRef.current = false;
  };

  const isWorking =
    (step === "approving" && (approvePending || approveConfirming)) ||
    (step === "opening" && (openPending || openConfirming)) ||
    (step === "shipping" && (shipPending || shipConfirming));

  // ── Taker card: the structure just shipped, else the latest one on-chain ─
  const viewAuthId: bigint | null =
    step === "done" && authIdToShip !== null ? authIdToShip
    : nextAuthId !== undefined && nextAuthId > ZERO_BI ? nextAuthId - ONE_BI
    : null;

  const { data: structure } = useReadContract({
    address: CONTRACTS.spreadVault as `0x${string}`,
    abi: SPREAD_ABI,
    functionName: "structures",
    args: [viewAuthId ?? ZERO_BI],
    query: { enabled: !!CONTRACTS.spreadVault && viewAuthId !== null, refetchInterval: 10_000 },
  });
  const { data: viewStrikes } = useReadContract({
    address: CONTRACTS.spreadVault as `0x${string}`,
    abi: SPREAD_ABI,
    functionName: "strikesOf",
    args: [viewAuthId ?? ZERO_BI],
    query: { enabled: !!CONTRACTS.spreadVault && viewAuthId !== null },
  });
  const [buyUnits, setBuyUnits] = useState("1");
  const buyUnitsWad = BigInt(Math.round((Number(buyUnits) || 0) * 1e18));
  const { data: quoteData, error: quoteError } = useReadContract({
    address: CONTRACTS.spreadVault as `0x${string}`,
    abi: SPREAD_ABI,
    functionName: "quote",
    args: [viewAuthId ?? ZERO_BI, buyUnitsWad],
    query: { enabled: !!CONTRACTS.spreadVault && viewAuthId !== null && buyUnitsWad > ZERO_BI, refetchInterval: 10_000 },
  });
  const { refetch: refetchUsdcAllowance } = useReadContract({
    address: CONTRACTS.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [address ?? ZERO, (CONTRACTS.spreadVault || ZERO) as `0x${string}`],
    query: { enabled: !!address && !!CONTRACTS.spreadVault },
  });
  const { data: spreadToken, refetch: refetchToken } = useReadContract({
    address: CONTRACTS.spreadVault as `0x${string}`,
    abi: SPREAD_ABI,
    functionName: "spreadTokens",
    args: [viewAuthId ?? ZERO_BI],
    query: { enabled: !!CONTRACTS.spreadVault && viewAuthId !== null },
  });
  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: (spreadToken && spreadToken !== ZERO ? spreadToken : ZERO) as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address ?? ZERO],
    query: { enabled: !!address && !!spreadToken && spreadToken !== ZERO },
  });

  const [buyStep, setBuyStep] = useState<"idle" | "approving" | "buying" | "done">("idle");
  const { writeContract: approveUsdc, data: approveUsdcTx, isPending: approveUsdcPending, error: approveUsdcError } = useWriteContract();
  const { isLoading: approveUsdcConfirming, isSuccess: approveUsdcSuccess } = useWaitForTransactionReceipt({ hash: approveUsdcTx });
  const { writeContract: buy, data: buyTx, isPending: buyPending, error: buyError } = useWriteContract();
  const { isLoading: buyConfirming, isSuccess: buySuccess } = useWaitForTransactionReceipt({ hash: buyTx });

  const premium = quoteData?.[0] ?? ZERO_BI;
  const fee = quoteData?.[1] ?? ZERO_BI;
  const fillEscrow = quoteData?.[2] ?? ZERO_BI;
  const totalCost = premium + fee;
  const maxPremium = (totalCost * BigInt(101)) / BigInt(100); // 1% slippage headroom on a 10s-refreshing quote

  const doBuy = () => {
    if (viewAuthId === null) return;
    setBuyStep("buying");
    buy({ address: CONTRACTS.spreadVault as `0x${string}`, abi: SPREAD_ABI, functionName: "buy", args: [viewAuthId, buyUnitsWad, maxPremium] });
  };
  useEffect(() => { if (approveUsdcSuccess && buyStep === "approving") doBuy(); }, [approveUsdcSuccess]);
  useEffect(() => {
    if (buySuccess && buyStep === "buying") {
      setBuyStep("done");
      refetchToken().then(() => refetchBalance());
    }
  }, [buySuccess]);

  const handleBuy = async () => {
    if (!address || viewAuthId === null || totalCost === ZERO_BI) return;
    const { data: fresh } = await refetchUsdcAllowance();
    if (fresh !== undefined && fresh >= maxPremium) { doBuy(); return; }
    setBuyStep("approving");
    approveUsdc({ address: CONTRACTS.usdc, abi: ERC20_ABI, functionName: "approve", args: [CONTRACTS.spreadVault as `0x${string}`, maxPremium] });
  };

  const buyWorking = buyStep === "approving" ? (approveUsdcPending || approveUsdcConfirming) : buyStep === "buying" ? (buyPending || buyConfirming) : false;
  const structIsCall = structure ? Number(structure[1]) === 0 : isCall;
  const structActive = structure ? structure[4] : false;
  const structExpiry = structure ? Number(structure[2]) : 0;
  const sLo = viewStrikes ? Number(viewStrikes[structIsCall ? 2 : 0]) / 1e18 : 0;
  const sHi = viewStrikes ? Number(viewStrikes[structIsCall ? 3 : 1]) / 1e18 : 0;

  if (!mounted || !isConnected) {
    return (
      <div className="rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">
        {mounted ? "Connect wallet to write or buy a defined-risk spread." : null}
      </div>
    );
  }

  if (!CONTRACTS.spreadVault) {
    return (
      <div className="rounded-xl border border-gray-800 p-4 text-yellow-500 text-xs">
        Set NEXT_PUBLIC_SPREAD_VAULT (printed by ./local.sh) to enable the spread desk.
      </div>
    );
  }

  const input = "w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600 disabled:opacity-50";

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {/* ── Writer ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
        <div>
          <h3 className="text-white font-semibold text-sm">Write a Defined-Risk Spread</h3>
          <p className="text-gray-500 text-xs mt-1">
            S12 netting: the SpreadVault&apos;s own Aqua strategy backs only the structure&apos;s true max loss, not a
            whole leg as if the short were naked. Same JIT model: collateral stays in your wallet until a buyer matches.
          </p>
        </div>

        <div className="flex gap-2">
          {[true, false].map((c) => (
            <button key={String(c)} onClick={() => { setIsCall(c); setK1(grid(spot)); setK2(grid(spot) + 200); }} disabled={isWorking}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${isCall === c ? (c ? "bg-blue-600 text-white" : "bg-orange-700 text-white") : "bg-gray-800 text-gray-400 hover:text-white"}`}>
              {c ? "Call Credit (short K1 / long K2)" : "Put Credit (short K2 / long K1)"}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">K1 (USD, lower)</label>
            <input type="number" value={k1} disabled={isWorking} onChange={(e) => setK1(Number(e.target.value))} className={input} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">K2 (USD, higher)</label>
            <input type="number" value={k2} disabled={isWorking} onChange={(e) => setK2(Number(e.target.value))} className={input} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Capacity (units)</label>
            <input type="number" value={units} disabled={isWorking} onChange={(e) => setUnits(e.target.value)} step="1" min="0" className={input} />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Expiry</label>
            <div className="flex gap-1">
              {EXPIRY_PRESETS.map((p) => (
                <button key={p.seconds} onClick={() => setExpiryOffset(p.seconds)} disabled={isWorking}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium ${expiryOffset === p.seconds ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* The whole point of S12, as a number */}
        <div className="rounded-lg border border-green-900 bg-green-950/30 p-3 text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-gray-400">Escrow, netted (S12)</span>
            <span className="font-mono text-green-400">{validStrikes ? `${fmtUnits(escrow, collateralDecimals)} ${collateralSymbol}` : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Main vault, naked short leg</span>
            <span className="font-mono text-gray-500 line-through">
              {validStrikes ? `${isCall ? (Number(units) || 0).toLocaleString() : ((Number(units) || 0) * k2).toLocaleString()} ${collateralSymbol}` : "—"}
            </span>
          </div>
          <div className="flex justify-between border-t border-green-900/60 pt-1">
            <span className="text-gray-300">Capital efficiency</span>
            <span className="font-mono text-white font-semibold">{validStrikes ? `${ratio.toFixed(1)}× tighter` : "K2 must exceed K1"}</span>
          </div>
        </div>

        {step !== "idle" && (
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className={step === "approving" ? "text-blue-400 font-semibold" : "text-green-400"}>✓ 1. Approve Aqua</span>
            <span className="text-gray-700">→</span>
            <span className={step === "approved" ? "text-yellow-400 font-semibold" : step === "opening" ? "text-blue-400 font-semibold" : ["opened", "shipping", "done"].includes(step) ? "text-green-400" : "text-gray-600"}>2. Open structure</span>
            <span className="text-gray-700">→</span>
            <span className={step === "opened" ? "text-yellow-400 font-semibold" : step === "shipping" ? "text-blue-400 font-semibold" : step === "done" ? "text-green-400" : "text-gray-600"}>3. Ship to Aqua</span>
            {step !== "done" && !isWorking && <button onClick={handleReset} className="ml-auto text-gray-500 hover:text-white">Reset</button>}
          </div>
        )}
        {(approveError || openError || shipError) && (
          <div className="text-xs text-red-400">{(approveError || openError || shipError)?.message.split("\n")[0]}</div>
        )}

        {(step === "idle" || step === "approving") && (
          <button onClick={handleStart} disabled={isWorking || !validStrikes || escrow === ZERO_BI || !CONTRACTS.aqua}
            className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold">
            {step === "idle"
              ? (collateralAllowance !== undefined && collateralAllowance >= escrow ? "Open Spread" : "1. Approve Aqua & Open Spread")
              : approvePending ? "Check wallet — confirm approval…" : "Approving…"}
          </button>
        )}
        {(step === "approved" || step === "opening") && (
          <button onClick={() => { openCalledRef.current = false; handleOpen(); }} disabled={isWorking}
            className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold">
            {openPending ? "Check wallet — confirm…" : openConfirming ? "Opening…" : "2. Open Structure"}
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
            <span className="text-green-400">Spread #{authIdToShip?.toString()} shipped — {fmtUnits(escrow, collateralDecimals)} {collateralSymbol} backing it, still in your wallet.</span>
            <button onClick={handleReset} className="text-gray-500 hover:text-white">New</button>
          </div>
        )}
      </div>

      {/* ── Taker ──────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
        <div>
          <h3 className="text-white font-semibold text-sm">Buy the Spread</h3>
          <p className="text-gray-500 text-xs mt-1">
            Priced off the same vol surface as single legs: Ask on the leg you go long, Bid on the leg you go short.
            One SpreadToken per structure, so the position trades as a unit.
          </p>
        </div>

        {viewAuthId === null ? (
          <div className="text-gray-600 text-xs">No spread structures yet. Write one on the left.</div>
        ) : (
          <>
            <div className="rounded-lg bg-gray-800 p-3 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-400">Structure</span>
                <span className="font-mono text-white">
                  #{viewAuthId.toString()} · {structIsCall ? "Call credit" : "Put credit"}
                  {viewStrikes ? ` · $${sLo.toLocaleString()} / $${sHi.toLocaleString()}` : ""}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Expires</span>
                <span className="font-mono text-white">{structExpiry ? new Date(structExpiry * 1000).toLocaleDateString() : "…"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Status</span>
                <span className={structActive ? "text-green-400" : "text-red-400"}>{structActive ? "active" : "inactive"}</span>
              </div>
            </div>

            <div>
              <label className="text-xs text-gray-400 mb-1 block">Units</label>
              <input type="number" value={buyUnits} disabled={buyWorking} onChange={(e) => setBuyUnits(e.target.value)} step="1" min="0" className={input} />
            </div>

            <div className="rounded-lg border border-gray-700 p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-gray-400">Net premium (Ask long − Bid short)</span><span className="font-mono text-white">{quoteData ? `${fmtUnits(premium, 6, 2)} USDC` : quoteError ? "—" : "…"}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Protocol fee</span><span className="font-mono text-gray-300">{quoteData ? `${fmtUnits(fee, 6, 2)} USDC` : "…"}</span></div>
              <div className="flex justify-between border-t border-gray-700 pt-1"><span className="text-gray-300">You pay</span><span className="font-mono text-white font-semibold">{quoteData ? `${fmtUnits(totalCost, 6, 2)} USDC` : "…"}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Writer&apos;s escrow pulled on fill</span><span className="font-mono text-green-400">{quoteData ? `${fmtUnits(fillEscrow, structIsCall ? 18 : 6)} ${structIsCall ? "WETH" : "USDC"}` : "…"}</span></div>
              {quoteError && <div className="text-red-400">{quoteError.message.split("\n")[0]}</div>}
            </div>

            {(approveUsdcError || buyError) && (
              <div className="text-xs text-red-400">{(approveUsdcError || buyError)?.message.split("\n")[0]}</div>
            )}

            <button onClick={handleBuy} disabled={buyWorking || !quoteData || !structActive || buyUnitsWad === ZERO_BI}
              className="w-full py-2 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-semibold">
              {buyStep === "approving" ? (approveUsdcPending ? "Check wallet — approve USDC…" : "Approving…")
                : buyStep === "buying" ? (buyPending ? "Check wallet — confirm buy…" : "Buying…")
                : `Buy ${buyUnits || 0} unit${Number(buyUnits) === 1 ? "" : "s"}`}
            </button>

            {spreadToken && spreadToken !== ZERO && (
              <div className="text-xs text-gray-400 space-y-0.5">
                <div>SpreadToken: <span className="font-mono text-gray-300">{spreadToken.slice(0, 6)}…{spreadToken.slice(-4)}</span></div>
                {tokenBalance !== undefined && (
                  <div>You hold <span className="font-mono text-white">{fmtUnits(tokenBalance, 18)}</span> units</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
