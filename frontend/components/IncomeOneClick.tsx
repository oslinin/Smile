"use client";

import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract } from "wagmi";
import { useState, useEffect, useRef, useMemo } from "react";
import { CONTRACTS, AQUA_ABI, SHIP_PARAMS_ABI } from "@/config/wagmi";
import { USDC_SEPOLIA, WETH_SEPOLIA, type ActiveAuth } from "@/components/AuthorizeRange";
import { strikeForDelta, roundStrike, protocolPremium, surfaceQuotes } from "@/lib/options";

// S9 (docs/solutions.md): the thetagang front door. Pick a side and a risk
// preset; the app translates delta targets into a strike range, shows the
// estimated premium yield, and runs the whole approve → authorize → ship
// pipeline as one click (each step auto-fires when the previous confirms —
// the wallet still asks for each signature, custody never leaves the user).
// Auto-rolling at expiry is the LP-run keeper: `node keeper/roll.mjs`.

const VAULT_ABI = [
  {
    name: "authorizeRange",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strikeMin", type: "uint256" },
      { name: "strikeMax", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "maxCollateral", type: "uint256" },
      { name: "collateralToken", type: "address" },
      { name: "premiumToken", type: "address" },
      { name: "isCall", type: "bool" },
    ],
    outputs: [{ name: "authId", type: "uint256" }],
  },
  {
    name: "nextAuthId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  ...SHIP_PARAMS_ABI,
] as const;

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Delta bands, thetagang-style: delta ≈ P(expiring ITM), so "conservative"
// means far OTM — high win rate, modest premium.
const PRESETS = [
  { id: "conservative", label: "Conservative", deltas: [0.1, 0.2] as const, blurb: "10–20Δ · far OTM, high win rate" },
  { id: "balanced", label: "Balanced", deltas: [0.2, 0.3] as const, blurb: "20–30Δ · the classic income band" },
  { id: "aggressive", label: "Aggressive", deltas: [0.3, 0.4] as const, blurb: "30–40Δ · richer premium, more assignments" },
] as const;

const TENORS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

interface IncomeOneClickProps {
  spot: number;
  onAuthorized: (auth: ActiveAuth) => void;
}

export function IncomeOneClick({ spot, onAuthorized }: IncomeOneClickProps) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  const [isCall, setIsCall] = useState(true);
  const [presetId, setPresetId] = useState<(typeof PRESETS)[number]["id"]>("balanced");
  const [tenorDays, setTenorDays] = useState(30);
  const [size, setSize] = useState("1.0"); // WETH units (CC) or USDC budget (CSP)
  const [step, setStep] = useState<"idle" | "approving" | "authorizing" | "shipping" | "done">("idle");
  const [authIdToShip, setAuthIdToShip] = useState<bigint | null>(null);
  const firedRef = useRef(false);
  const authFiredRef = useRef(false);
  const shipFiredRef = useRef(false);

  useEffect(() => { setMounted(true); }, []);

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const tYears = tenorDays / 365;

  // Delta band → strike band. For calls higher delta = nearer the money =
  // LOWER strike; for puts higher |delta| = HIGHER strike. Sort handles both.
  const [strikeMin, strikeMax] = useMemo(() => {
    const a = roundStrike(strikeForDelta(spot, preset.deltas[0], isCall, tYears));
    const b = roundStrike(strikeForDelta(spot, preset.deltas[1], isCall, tYears));
    return a <= b ? [a, b] : [b, a];
  }, [spot, preset, isCall, tYears]);

  const midStrike = (strikeMin + strikeMax) / 2;
  const premiumPerUnit = protocolPremium(spot, midStrike, isCall, tYears);

  // The surface behind the quote, in the three numbers vol desks use —
  // rendered below in plain English so non-traders can sanity-check the price.
  const surface = useMemo(() => surfaceQuotes(spot, tYears), [spot, tYears]);
  const expectedMoveUsd = surface.expectedMovePct * spot;

  // Units the collateral backs: calls lock 1 WETH per unit; puts lock K USDC.
  const sizeNum = Number(size) || 0;
  const units = isCall ? sizeNum : sizeNum / midStrike;
  const estIncome = premiumPerUnit * units;
  const collateralUsd = isCall ? sizeNum * spot : sizeNum;
  const periodYieldPct = collateralUsd > 0 ? (estIncome / collateralUsd) * 100 : 0;
  const aprPct = periodYieldPct * (365 / tenorDays);

  const collateralToken = isCall ? WETH_SEPOLIA : USDC_SEPOLIA;
  const maxCollateralBig = isCall
    ? BigInt(Math.round(sizeNum * 1e18))
    : BigInt(Math.round(sizeNum * 1e6));
  const expiry = BigInt(Math.floor(Date.now() / 1000) + tenorDays * 86_400);

  const { data: nextAuthId } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "nextAuthId",
    query: { enabled: !!CONTRACTS.aquaVault },
  });

  const { data: currentAllowance, refetch: refetchAllowance } = useReadContract({
    address: collateralToken as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [
      (address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      (CONTRACTS.aqua || "0x0000000000000000000000000000000000000000") as `0x${string}`,
    ],
    query: { enabled: !!address && !!CONTRACTS.aqua },
  });

  const { data: shipParams } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "getShipParams",
    args: [authIdToShip ?? BigInt(0)],
    query: { enabled: !!CONTRACTS.aquaVault && authIdToShip !== null },
  });

  const { writeContract: approve, data: approveTxHash, isPending: approvePending, error: approveError } = useWriteContract();
  const { isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });
  const { writeContract: authorize, data: authTxHash, isPending: authPending, error: authError } = useWriteContract();
  const { isSuccess: authSuccess } = useWaitForTransactionReceipt({ hash: authTxHash });
  const { writeContract: ship, data: shipTxHash, isPending: shipPending, error: shipError } = useWriteContract();
  const { isSuccess: shipSuccess } = useWaitForTransactionReceipt({ hash: shipTxHash });

  const fireAuthorize = () => {
    if (authFiredRef.current || nextAuthId === undefined) return;
    authFiredRef.current = true;
    setAuthIdToShip(nextAuthId);
    setStep("authorizing");
    authorize({
      address: CONTRACTS.aquaVault as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "authorizeRange",
      args: [
        BigInt(Math.round(strikeMin * 1e18)),
        BigInt(Math.round(strikeMax * 1e18)),
        expiry,
        maxCollateralBig,
        collateralToken as `0x${string}`,
        USDC_SEPOLIA as `0x${string}`,
        isCall,
      ],
    });
  };

  // The one-click pipeline: each confirmation auto-fires the next step.
  useEffect(() => {
    if (approveSuccess && step === "approving") fireAuthorize();
  }, [approveSuccess, step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (authSuccess && step === "authorizing" && shipParams && !shipFiredRef.current && CONTRACTS.aqua) {
      shipFiredRef.current = true;
      setStep("shipping");
      const [app, strategy, tokens, amounts] = shipParams;
      ship({
        address: CONTRACTS.aqua as `0x${string}`,
        abi: AQUA_ABI,
        functionName: "ship",
        args: [app, strategy, [...tokens], [...amounts]],
      });
    }
  }, [authSuccess, step, shipParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (shipSuccess && authIdToShip !== null && !firedRef.current && address) {
      firedRef.current = true;
      setStep("done");
      onAuthorized({
        authId: authIdToShip,
        strikeMin,
        strikeMax,
        expiry: Number(expiry),
        isCall,
        collateralToken,
        lp: address,
      });
    }
  }, [shipSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStart = async () => {
    if (!address || !CONTRACTS.aquaVault || !CONTRACTS.aqua || sizeNum <= 0) return;
    const { data: freshAllowance } = await refetchAllowance();
    if (freshAllowance !== undefined && freshAllowance >= maxCollateralBig) {
      fireAuthorize();
      return;
    }
    setStep("approving");
    approve({
      address: collateralToken as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONTRACTS.aqua as `0x${string}`, maxCollateralBig],
    });
  };

  const handleReset = () => {
    setStep("idle");
    setAuthIdToShip(null);
    firedRef.current = false;
    authFiredRef.current = false;
    shipFiredRef.current = false;
  };

  if (!mounted || !isConnected) {
    return (
      <div className="rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">
        {mounted ? "Connect wallet to set up an income strategy." : null}
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="rounded-xl border border-green-800 bg-green-950/30 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-green-400 text-sm font-semibold">
            {isCall ? "Covered-call" : "Cash-secured-put"} range is live
          </span>
          <button onClick={handleReset} className="text-xs text-gray-500 hover:text-white">
            New strategy
          </button>
        </div>
        <div className="text-xs text-gray-400">
          {preset.label} ({preset.deltas[0] * 100}–{preset.deltas[1] * 100}Δ)
          {" · "}
          <span className="text-white font-mono">${strikeMin.toLocaleString()}</span>
          {" – "}
          <span className="text-white font-mono">${strikeMax.toLocaleString()}</span>
          {" · "}{tenorDays} DTE · est. {aprPct.toFixed(1)}% APR in premium
        </div>
        <div className="text-xs text-gray-500">
          Auth ID <span className="font-mono text-gray-300">{authIdToShip?.toString()}</span>
          {" · "}collateral stays in your wallet earning its own yield until a buyer matches.
        </div>
        <div className="text-xs text-gray-500">
          Auto-roll at expiry (self-custodial, runs with your key):{" "}
          <code className="text-gray-300">node keeper/roll.mjs</code>
        </div>
      </div>
    );
  }

  const working = step !== "idle";
  const stepText =
    step === "approving" ? (approvePending ? "1/3 Check wallet — approve Aqua…" : "1/3 Approving…")
    : step === "authorizing" ? (authPending ? "2/3 Check wallet — register range…" : "2/3 Registering…")
    : step === "shipping" ? (shipPending ? "3/3 Check wallet — ship to Aqua…" : "3/3 Shipping…")
    : "";
  const error = approveError || authError || shipError;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div>
        <h3 className="text-white font-semibold text-sm">One-Click Income</h3>
        <p className="text-gray-500 text-xs mt-1">
          Sell option premium against assets you already hold. Pick a risk band — the app
          picks the strikes, quotes the yield, and ships the range in one flow.
        </p>
      </div>

      <div className="flex gap-2">
        {[true, false].map((c) => (
          <button
            key={String(c)}
            onClick={() => setIsCall(c)}
            disabled={working}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
              isCall === c
                ? c ? "bg-blue-600 text-white" : "bg-orange-700 text-white"
                : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            {c ? "Covered Calls — yield on WETH" : "Cash-Secured Puts — buy ETH lower"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPresetId(p.id)}
            disabled={working}
            className={`rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-not-allowed border ${
              presetId === p.id
                ? "border-blue-500 bg-blue-950/40"
                : "border-gray-800 bg-gray-800/40 hover:border-gray-600"
            }`}
          >
            <div className="text-xs font-semibold text-white">{p.label}</div>
            <div className="text-[10px] text-gray-500 mt-0.5">{p.blurb}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">
            {isCall ? "WETH to cover" : "USDC to secure"}
          </label>
          <input
            type="number"
            value={size}
            disabled={working}
            onChange={(e) => setSize(e.target.value)}
            step={isCall ? "0.1" : "100"}
            min="0"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Tenor</label>
          <div className="flex gap-1">
            {TENORS.map((t) => (
              <button
                key={t.days}
                onClick={() => setTenorDays(t.days)}
                disabled={working}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                  tenorDays === t.days ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* The quote card — what the presets resolve to */}
      <div className="rounded-lg bg-gray-800/60 border border-gray-800 p-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Strike range</div>
          <div className="text-sm font-mono text-white mt-0.5">
            ${strikeMin.toLocaleString()}–${strikeMax.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Est. premium</div>
          <div className="text-sm font-mono text-white mt-0.5">
            ${estIncome.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Est. APR</div>
          <div className="text-sm font-mono text-green-400 mt-0.5">{aprPct.toFixed(1)}%</div>
        </div>
      </div>
      <p className="text-[10px] text-gray-600 -mt-2">
        Estimate assumes a fill at the band-mid strike at today&apos;s surface; actual premium
        is set at match time. Your collateral keeps earning its own yield until matched —
        premium APR stacks on top.
      </p>

      {/* The surface behind the quote, in plain English. Same three numbers a
          vol desk quotes (ATM / risk reversal / butterfly), each explained. */}
      <details className="rounded-lg border border-gray-800 bg-gray-800/30 group">
        <summary className="cursor-pointer px-3 py-2 text-[10px] uppercase tracking-wide text-gray-500 hover:text-gray-300 select-none">
          Why this price? Today&apos;s volatility, in plain English
        </summary>
        <div className="px-3 pb-3 space-y-2.5">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-gray-300">Expected move by expiry</span>
              <span className="text-xs font-mono text-white">
                ±{(surface.expectedMovePct * 100).toFixed(1)}% (~${Math.round(expectedMoveUsd).toLocaleString()})
              </span>
            </div>
            <p className="text-[10px] text-gray-500 mt-0.5">
              How far the market thinks ETH could drift before your option expires — that&apos;s
              what the premium is charging for. Traders call the underlying number{" "}
              <span className="text-gray-400">ATM volatility</span> (
              {(surface.atmVol * 100).toFixed(0)}%/yr here). Your strikes sit at the edge of
              or outside this band — you win when the move stays smaller than priced.
            </p>
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-gray-300">Which direction costs more</span>
              <span className="text-xs font-mono text-white">
                {surface.rr25 >= 0 ? "+" : "−"}{Math.abs(surface.rr25 * 100).toFixed(1)} vol pts
              </span>
            </div>
            <p className="text-[10px] text-gray-500 mt-0.5">
              Positive = insurance against a rally costs more; negative = crash protection
              costs more. Traders call this the{" "}
              <span className="text-gray-400">risk reversal</span>: the vol of an upside
              option minus a matching downside one.
            </p>
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-gray-300">Extra charge for big moves</span>
              <span className="text-xs font-mono text-white">
                +{(surface.bf25 * 100).toFixed(1)} vol pts
              </span>
            </div>
            <p className="text-[10px] text-gray-500 mt-0.5">
              Far-away strikes are priced richer than a perfect bell curve would say —
              the market pays up for rare, violent moves, and as the seller you collect
              that markup. Traders call it the{" "}
              <span className="text-gray-400">butterfly</span>.
            </p>
          </div>
          <p className="text-[10px] text-gray-600 border-t border-gray-800 pt-2">
            Measured at the &ldquo;25-delta&rdquo; strikes — the call and put with roughly a
            1-in-4 chance of finishing in the money (${Math.round(surface.k25put).toLocaleString()}{" "}
            / ${Math.round(surface.k25call).toLocaleString()} today) — the industry&apos;s
            standard yardsticks for the wings of the smile.
          </p>
        </div>
      </details>

      {error && (
        <div className="text-xs text-red-400">{error.message.split("\n")[0]}</div>
      )}
      {!CONTRACTS.aquaVault && (
        <div className="text-xs text-yellow-500">Set NEXT_PUBLIC_AQUA_VAULT to enable</div>
      )}

      <button
        onClick={working ? undefined : handleStart}
        disabled={working || !CONTRACTS.aquaVault || !CONTRACTS.aqua || sizeNum <= 0}
        className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
      >
        {working
          ? stepText
          : `Start earning — sell ${preset.deltas[0] * 100}–${preset.deltas[1] * 100}Δ ${isCall ? "calls" : "puts"}, ${tenorDays} DTE`}
      </button>
      {(currentAllowance ?? BigInt(0)) >= maxCollateralBig && !working && (
        <div className="text-[10px] text-green-600 -mt-2">✓ Aqua already approved — two signatures instead of three</div>
      )}
    </div>
  );
}
