"use client";

import { useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract } from "wagmi";
import { useState, useEffect, useRef } from "react";
import { CONTRACTS, AQUA_ABI, SHIP_PARAMS_ABI } from "@/config/wagmi";

export const USDC_SEPOLIA = (
  process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
) as `0x${string}`;
export const WETH_SEPOLIA = (
  process.env.NEXT_PUBLIC_WETH_ADDRESS ?? "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"
) as `0x${string}`;

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

const EXPIRY_PRESETS = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];

export interface ActiveAuth {
  authId: bigint;
  strikeMin: number;
  strikeMax: number;
  expiry: number;
  isCall: boolean;
  collateralToken: string;
  lp: string;
}

interface AuthorizeRangeProps {
  spot: number;
  onAuthorized: (auth: ActiveAuth) => void;
}

/// LP flow on the official 1inch Aqua protocol:
///   1. approve   — ERC-20 approve the OFFICIAL Aqua registry (not the vault)
///   2. authorize — register the range terms in the vault (fixes the strategy)
///   3. ship      — Aqua.ship() the strategy: collateral stays in the wallet,
///                  pulled just-in-time when a buyer matches
export function AuthorizeRange({ spot, onAuthorized }: AuthorizeRangeProps) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  const [strikeMin, setStrikeMin] = useState(Math.round(spot * 0.9 / 50) * 50);
  const [strikeMax, setStrikeMax] = useState(Math.round(spot * 1.1 / 50) * 50);
  const [expiryOffset, setExpiryOffset] = useState(30 * 86_400);
  const [maxCollateral, setMaxCollateral] = useState("1.0");
  const [isCall, setIsCall] = useState(true);
  const [step, setStep] = useState<
    "idle" | "approving" | "approved" | "authorizing" | "authorized" | "shipping" | "done"
  >("idle");
  const [authIdToShip, setAuthIdToShip] = useState<bigint | null>(null);
  const [authorized, setAuthorized] = useState<ActiveAuth | null>(null);
  const firedRef = useRef(false);
  const authCalledRef = useRef(false);
  const shipCalledRef = useRef(false);

  useEffect(() => { setMounted(true); }, []);

  const collateralToken = isCall ? WETH_SEPOLIA : USDC_SEPOLIA;

  // For calls: 1.0 WETH = 1e18. For puts: collateral in USDC = maxCollateral * 1e6
  const maxCollateralBig = isCall
    ? BigInt(Math.round(Number(maxCollateral) * 1e18))
    : BigInt(Math.round(Number(maxCollateral) * 1e6));

  const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryOffset);
  const strikeMinWAD = BigInt(Math.round(strikeMin * 1e18));
  const strikeMaxWAD = BigInt(Math.round(strikeMax * 1e18));

  // Read nextAuthId so we know what authId will be assigned
  const { data: nextAuthId } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "nextAuthId",
    query: { enabled: !!CONTRACTS.aquaVault },
  });

  // Allowance is now granted to the OFFICIAL Aqua registry, not the vault
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

  const allowanceSufficient = currentAllowance !== undefined && currentAllowance >= maxCollateralBig;

  // Exact official Aqua.ship() calldata, straight from the vault
  const { data: shipParams } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "getShipParams",
    args: [authIdToShip ?? BigInt(0)],
    query: { enabled: !!CONTRACTS.aquaVault && authIdToShip !== null },
  });

  // Step 1: approve collateral token for Aqua
  const { writeContract: approve, data: approveTxHash, isPending: approvePending, error: approveError } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });

  // Step 2: authorizeRange (vault registry)
  const { writeContract: authorize, data: authTxHash, isPending: authPending, error: authError } = useWriteContract();
  const { isLoading: authConfirming, isSuccess: authSuccess } = useWaitForTransactionReceipt({ hash: authTxHash });

  // Step 3: Aqua.ship (official registry)
  const { writeContract: ship, data: shipTxHash, isPending: shipPending, error: shipError } = useWriteContract();
  const { isLoading: shipConfirming, isSuccess: shipSuccess } = useWaitForTransactionReceipt({ hash: shipTxHash });

  // After approval confirmed, move to "approved" so user clicks step 2 manually
  useEffect(() => {
    if (approveSuccess && step === "approving") {
      setStep("approved");
    }
  }, [approveSuccess]);

  const handleAuthorize = () => {
    if (authCalledRef.current) return;
    authCalledRef.current = true;
    setStep("authorizing");
    if (nextAuthId !== undefined) setAuthIdToShip(nextAuthId);
    authorize({
      address: CONTRACTS.aquaVault as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "authorizeRange",
      args: [strikeMinWAD, strikeMaxWAD, expiry, maxCollateralBig, collateralToken as `0x${string}`, USDC_SEPOLIA as `0x${string}`, isCall],
    });
  };

  useEffect(() => {
    if (authSuccess && step === "authorizing") {
      setStep("authorized");
    }
  }, [authSuccess]);

  const handleShip = () => {
    if (shipCalledRef.current || !shipParams || !CONTRACTS.aqua) return;
    shipCalledRef.current = true;
    setStep("shipping");
    const [app, strategy, tokens, amounts] = shipParams;
    ship({
      address: CONTRACTS.aqua as `0x${string}`,
      abi: AQUA_ABI,
      functionName: "ship",
      args: [app, strategy, [...tokens], [...amounts]],
    });
  };

  useEffect(() => {
    if (shipSuccess && authIdToShip !== null && !firedRef.current && address) {
      firedRef.current = true;
      setStep("done");
      const auth: ActiveAuth = {
        authId: authIdToShip,
        strikeMin,
        strikeMax,
        expiry: Number(expiry),
        isCall,
        collateralToken,
        lp: address,
      };
      setAuthorized(auth);
      onAuthorized(auth);
    }
  }, [shipSuccess]);

  const handleStart = async () => {
    if (!address || !CONTRACTS.aquaVault || !CONTRACTS.aqua) return;
    // Re-check allowance fresh before deciding
    const { data: freshAllowance } = await refetchAllowance();
    const sufficient = freshAllowance !== undefined && freshAllowance >= maxCollateralBig;
    if (sufficient) {
      // Already approved — jump straight to step 2
      setStep("approved");
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

  if (!mounted || !isConnected) {
    return (
      <div className="rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">
        {mounted ? "Connect wallet to authorize a range." : null}
      </div>
    );
  }

  if (authorized && step === "done") {
    return (
      <div className="rounded-xl border border-green-800 bg-green-950/30 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-green-400 text-sm font-semibold">Range shipped to Aqua</span>
          <button
            onClick={() => {
              setAuthorized(null); setStep("idle");
              firedRef.current = false; authCalledRef.current = false; shipCalledRef.current = false;
              setAuthIdToShip(null);
            }}
            className="text-xs text-gray-500 hover:text-white"
          >
            New range
          </button>
        </div>
        <div className="text-xs text-gray-400">
          <span className={authorized.isCall ? "text-blue-400" : "text-orange-400"}>
            {authorized.isCall ? "Covered Calls" : "Cash-Secured Puts"}
          </span>
          {" · "}
          <span className="text-white font-mono">${authorized.strikeMin.toLocaleString()}</span>
          {" – "}
          <span className="text-white font-mono">${authorized.strikeMax.toLocaleString()}</span>
          {" · "}expires {new Date(authorized.expiry * 1000).toLocaleDateString()}
        </div>
        <div className="text-xs text-gray-500">
          Auth ID: <span className="font-mono text-gray-300">{authorized.authId.toString()}</span>
          {" · "}shipped on the official 1inch Aqua — collateral stays in your wallet until a buyer matches
        </div>
      </div>
    );
  }

  const approveActive = step === "approving" && (approvePending || approveConfirming);
  const authActive   = step === "authorizing" && (authPending || authConfirming);
  const shipActive   = step === "shipping" && (shipPending || shipConfirming);
  const isWorking    = approveActive || authActive || shipActive;

  const handleReset = () => {
    setStep("idle");
    authCalledRef.current = false;
    shipCalledRef.current = false;
    firedRef.current = false;
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <div>
        <h3 className="text-white font-semibold text-sm">Authorize Strike Range</h3>
        <p className="text-gray-500 text-xs mt-1">
          Quote any strike in [K_min, K_max] from one collateral pool. Official 1inch Aqua JIT:
          your collateral stays in your wallet earning yield until a buyer matches.
        </p>
      </div>

      <div className="flex gap-2">
        {[true, false].map((c) => (
          <button
            key={String(c)}
            onClick={() => setIsCall(c)}
            disabled={isWorking}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors disabled:cursor-not-allowed ${
              isCall === c
                ? c ? "bg-blue-600 text-white" : "bg-orange-700 text-white"
                : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            {c ? "Covered Call (WETH)" : "Cash-Secured Put (USDC)"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">K_min (USD)</label>
          <input
            type="number"
            value={strikeMin}
            disabled={isWorking}
            onChange={(e) => setStrikeMin(Number(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">K_max (USD)</label>
          <input
            type="number"
            value={strikeMax}
            disabled={isWorking}
            onChange={(e) => setStrikeMax(Number(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600 disabled:opacity-50"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">
            Max collateral ({isCall ? "WETH" : "USDC"})
          </label>
          <input
            type="number"
            value={maxCollateral}
            disabled={isWorking}
            onChange={(e) => setMaxCollateral(e.target.value)}
            step={isCall ? "0.1" : "100"}
            min="0"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Expiry (DTE)</label>
          <div className="flex gap-1">
            {EXPIRY_PRESETS.map((p) => (
              <button
                key={p.seconds}
                onClick={() => setExpiryOffset(p.seconds)}
                disabled={isWorking}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                  expiryOffset === p.seconds
                    ? "bg-blue-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:text-white"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="text-xs text-gray-500 flex items-center justify-between">
        <span>LP: {address?.slice(0, 6)}…{address?.slice(-4)}</span>
        <span className="flex items-center gap-2">
          {allowanceSufficient && (
            <span className="text-green-500">✓ Aqua already approved</span>
          )}
          <span>Capacity: ~{isCall
            ? `${maxCollateral} WETH`
            : `${Number(maxCollateral).toLocaleString()} USDC`}
          </span>
        </span>
      </div>

      {/* Progress steps */}
      {step !== "idle" && (
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className={
            step === "approving" ? "text-blue-400 font-semibold" :
            "text-green-400"
          }>
            ✓ 1. Approve Aqua
          </span>
          <span className="text-gray-700">→</span>
          <span className={
            step === "approved"    ? "text-yellow-400 font-semibold" :
            step === "authorizing" ? "text-blue-400 font-semibold" :
            "text-green-400"
          }>
            2. Register range
          </span>
          <span className="text-gray-700">→</span>
          <span className={
            step === "authorized" ? "text-yellow-400 font-semibold" :
            step === "shipping"   ? "text-blue-400 font-semibold" :
            step === "done"       ? "text-green-400" :
            "text-gray-600"
          }>
            3. Ship to Aqua
          </span>
          {step !== "done" && !isWorking && (
            <button onClick={handleReset} className="ml-auto text-gray-500 hover:text-white text-xs">
              Reset
            </button>
          )}
        </div>
      )}

      {(approveError || authError || shipError) && (
        <div className="text-xs text-red-400">
          {(approveError || authError || shipError)?.message.split("\n")[0]}
        </div>
      )}

      {!CONTRACTS.aquaVault && (
        <div className="text-xs text-yellow-500">Set NEXT_PUBLIC_AQUA_VAULT to enable authorization</div>
      )}
      {!CONTRACTS.aqua && (
        <div className="text-xs text-yellow-500">Set NEXT_PUBLIC_AQUA to enable shipping strategies</div>
      )}

      {/* Step 1 button */}
      {(step === "idle" || step === "approving") && (
        <button
          onClick={handleStart}
          disabled={isWorking || !CONTRACTS.aquaVault || !CONTRACTS.aqua || strikeMin > strikeMax || Number(maxCollateral) <= 0}
          className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
        >
          {step === "idle"
            ? (allowanceSufficient ? "Authorize Range" : "1. Approve Aqua & Authorize Range")
            : approvePending ? "Check MetaMask — confirm approval…"
            : approveConfirming ? "Approving…" : "Waiting…"}
        </button>
      )}

      {/* Step 2 button — register the range in the vault */}
      {(step === "approved" || step === "authorizing") && (
        <button
          onClick={() => { authCalledRef.current = false; handleAuthorize(); }}
          disabled={authActive}
          className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
        >
          {authPending     ? "Check MetaMask — confirm registration…"
           : authConfirming ? "Registering…"
           : "2. Register Range"}
        </button>
      )}

      {/* Step 3 button — ship the strategy on the official Aqua */}
      {(step === "authorized" || step === "shipping") && (
        <button
          onClick={() => { shipCalledRef.current = false; handleShip(); }}
          disabled={shipActive || !shipParams}
          className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
        >
          {shipPending      ? "Check MetaMask — confirm ship…"
           : shipConfirming ? "Shipping to Aqua…"
           : !shipParams    ? "Loading strategy…"
           : "3. Ship to Aqua"}
        </button>
      )}
    </div>
  );
}
