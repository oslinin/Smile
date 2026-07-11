"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useSendTransaction, useAccount, useChainId } from "wagmi";
import { explorerTxUrl } from "@/lib/explorer";
import { useEffect, useState, useCallback, useRef } from "react";
import type { Leg } from "@/components/PayoffBuilder";
import { CONTRACTS, AQUA_ABI, SHIP_PARAMS_ABI } from "@/config/wagmi";
import type { ActiveAuth } from "@/components/AuthorizeRange";
import { USDC_SEPOLIA, WETH_SEPOLIA } from "@/components/AuthorizeRange";
import { fetchUniswapSwapQuote, type UniswapSwapQuote } from "@/hooks/useUniswapTrade";

const PRICING_ENGINE_ABI = [
  {
    name: "quote",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "spot", type: "uint256" },
          { name: "strike", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "sigmaGlobal", type: "uint256" },
          { name: "alpha", type: "uint256" },
          { name: "isBuy", type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "premium", type: "uint256" }],
  },
] as const;

const VAULT_ABI = [
  {
    name: "authorizations",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }],
    outputs: [
      { name: "lp", type: "address" },
      { name: "strikeMin", type: "uint256" },
      { name: "strikeMax", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "maxCollateral", type: "uint256" },
      { name: "usedCollateral", type: "uint256" },
      { name: "collateralToken", type: "address" },
      { name: "isCall", type: "bool" },
      { name: "active", type: "bool" },
    ],
  },
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
  {
    name: "buy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "authId", type: "uint256" },
      { name: "strike", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "maxPremium", type: "uint256" },
    ],
    outputs: [
      { name: "optionToken", type: "address" },
      { name: "premiumPaid", type: "uint256" },
    ],
  },
  ...SHIP_PARAMS_ABI,
  {
    name: "close",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "optionToken", type: "address" },
      { name: "lp", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minPayout", type: "uint256" },
    ],
    outputs: [{ name: "payout", type: "uint256" }],
  },
  {
    name: "optionTokens",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "authId", type: "uint256" },
      { name: "strike", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
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
] as const;

const WAD = BigInt("1000000000000000000");
const SIGMA_GLOBAL = (BigInt(80) * WAD) / BigInt(100);
const ALPHA = BigInt(2) * WAD;
const STRIKES_OFFSETS = [-20, -10, -5, 0, 5, 10, 20];

function authRangeStrikes(min: number, max: number): number[] {
  if (min === max) return [min];
  const raw = Math.round((max - min) / 6 / 50) * 50 || 50;
  return Array.from({ length: 7 }, (_, i) => Math.round((min + i * raw) / 50) * 50)
    .filter((v, i, a) => v <= max && a.indexOf(v) === i);
}

const SIGMA_GLOBAL_NUM = 0.80;
const ALPHA_NUM = 2.0;

function smileVol(spot: number, strike: number): number {
  const lnKS = Math.log(strike / spot);
  return SIGMA_GLOBAL_NUM * (1 + ALPHA_NUM * lnKS * lnKS);
}

// Abramowitz & Stegun 26.2.17 — max error 1.5e-7
function normalCDF(x: number): number {
  const p = 0.3275911;
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const poly = t * (a[0] + t * (a[1] + t * (a[2] + t * (a[3] + t * a[4]))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x)));
}

function callDelta(spot: number, strike: number, sigma: number, T: number): number {
  if (T <= 0) return spot > strike ? 1 : 0;
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return normalCDF(d1);
}

function blackScholesCall(spot: number, strike: number, sigma: number, T: number): number {
  if (T <= 0) return Math.max(0, spot - strike);
  if (sigma <= 0 || spot <= 0 || strike <= 0) return Math.max(0, spot - strike);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return spot * normalCDF(d1) - strike * normalCDF(d2);
}

function blackScholesPut(spot: number, strike: number, sigma: number, T: number): number {
  if (T <= 0) return Math.max(0, strike - spot);
  if (sigma <= 0 || spot <= 0 || strike <= 0) return Math.max(0, strike - spot);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return strike * normalCDF(-d2) - spot * normalCDF(-d1);
}

function priceWAD(spot: number, strike: number, expiry: number, isCall: boolean, isBuy: boolean): bigint {
  const T = Math.max(0, (expiry - Date.now() / 1000) / (365 * 24 * 3600));
  const sigma = smileVol(spot, strike);
  const price = isCall
    ? blackScholesCall(spot, strike, sigma, T)
    : blackScholesPut(spot, strike, sigma, T);
  const p = BigInt(Math.round(Math.max(0, price) * 1e12)) * BigInt(1e6);
  return isBuy ? (p * BigInt(101)) / BigInt(100) : (p * BigInt(99)) / BigInt(100);
}

// kept for backward compat within this file
function optionPriceWAD(spot: number, strike: number, expiry: number, isBuy: boolean): bigint {
  return priceWAD(spot, strike, expiry, true, isBuy);
}

function formatWAD(val: bigint | undefined): string {
  if (val === undefined) return "…";
  return `$${(Number(val) / 1e18).toFixed(2)}`;
}

// ── LP Summary Bar ────────────────────────────────────────────────────────────

function LPSummaryBar({ auth }: { auth: ActiveAuth }) {
  const { data } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "authorizations",
    args: [auth.authId],
    query: { enabled: !!CONTRACTS.aquaVault, refetchInterval: 6000 },
  });

  const maxCollateral = data?.[4];
  const usedCollateral = data?.[5];
  const isCall = auth.isCall;
  const decimals = isCall ? 1e18 : 1e6;
  const symbol = isCall ? "WETH" : "USDC";

  const usedNum = usedCollateral !== undefined ? Number(usedCollateral) / decimals : null;
  const maxNum = maxCollateral !== undefined ? Number(maxCollateral) / decimals : null;
  const pct = usedNum !== null && maxNum !== null && maxNum > 0 ? usedNum / maxNum : 0;

  const daysLeft = Math.max(0, Math.round((auth.expiry - Date.now() / 1000) / 86400));
  const isSingle = auth.strikeMin === auth.strikeMax;

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-gray-900/60 border-b border-gray-800 text-xs flex-wrap">
      <span className={auth.isCall ? "text-blue-400 font-semibold" : "text-orange-400 font-semibold"}>
        {auth.isCall ? "Covered Calls" : "Cash-Secured Puts"}
      </span>
      <span className="text-gray-400">
        {isSingle
          ? <>single strike <span className="text-white font-mono">${auth.strikeMin.toLocaleString()}</span></>
          : <><span className="text-white font-mono">${auth.strikeMin.toLocaleString()}</span>
              <span className="text-gray-600"> – </span>
              <span className="text-white font-mono">${auth.strikeMax.toLocaleString()}</span></>
        }
      </span>
      <span className="text-gray-600">·</span>
      {usedNum !== null && maxNum !== null ? (
        <span className="flex items-center gap-1.5">
          <span className="text-gray-400">
            <span className="text-white font-mono">{usedNum.toFixed(2)}</span>
            <span className="text-gray-600"> / </span>
            <span className="font-mono">{maxNum.toFixed(2)} {symbol}</span>
          </span>
          <span className="w-20 h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <span
              className="h-full block rounded-full bg-blue-500 transition-all"
              style={{ width: `${Math.min(pct * 100, 100).toFixed(1)}%` }}
            />
          </span>
          <span className="text-gray-600">{(pct * 100).toFixed(0)}% used</span>
        </span>
      ) : (
        <span className="text-gray-700">capacity loading…</span>
      )}
      <span className="text-gray-600">·</span>
      <span className={daysLeft <= 3 ? "text-red-400" : "text-gray-400"}>
        {daysLeft}d left
      </span>
    </div>
  );
}

// ── SellPanel ─────────────────────────────────────────────────────────────────

interface SellPanelProps {
  strike: number;
  spot: number;
  bidWAD: bigint | undefined;
  defaultIsCall: boolean;
  defaultExpiry: number;
  onClose: () => void;
  onSellConfirmed?: (leg: Omit<Leg, "id">) => void;
  colSpan?: number;
}

function SellPanel({ strike, spot, bidWAD, defaultIsCall, defaultExpiry, onClose, onSellConfirmed, colSpan = 6 }: SellPanelProps) {
  const { address } = useAccount();
  const [kMin, setKMin] = useState(strike);
  const [kMax, setKMax] = useState(strike);
  const [amount, setAmount] = useState("1");
  const [isCall, setIsCall] = useState(defaultIsCall);
  const [expiryOffset, setExpiryOffset] = useState(
    Math.max(86400, defaultExpiry - Math.floor(Date.now() / 1000))
  );
  const [step, setStep] = useState<"idle" | "approving" | "authorizing" | "shipping" | "done">("idle");
  const [authIdToShip, setAuthIdToShip] = useState<bigint | null>(null);
  const firedRef = useRef(false);
  const shipFiredRef = useRef(false);

  const collateralToken = isCall ? WETH_SEPOLIA : USDC_SEPOLIA;
  const amountNum = Math.max(0.001, Number(amount));

  // Calls: collateral = amount WETH (18 dec). Puts: collateral = amount × K_max USDC (6 dec)
  const maxCollateral = isCall
    ? BigInt(Math.round(amountNum * 1e18))
    : BigInt(Math.round(amountNum * kMax * 1e6 / 1e18));

  const isSingle = kMin === kMax;
  const premiumPerContract = bidWAD !== undefined ? Number(bidWAD) / 1e18 : null;
  const totalPremium = premiumPerContract !== null ? (premiumPerContract * amountNum).toFixed(2) : "…";

  const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryOffset);
  const kMinWAD = BigInt(Math.round(kMin * 1e18));
  const kMaxWAD = BigInt(Math.round(kMax * 1e18));

  const { writeContract: approve, data: approveTxHash, isPending: approvePending } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });

  const { writeContract: authorize, data: authTxHash, isPending: authPending } = useWriteContract();
  const { isLoading: authConfirming, isSuccess: authSuccess } = useWaitForTransactionReceipt({ hash: authTxHash });

  const { writeContract: ship, data: shipTxHash, isPending: shipPending } = useWriteContract();
  const { isLoading: shipConfirming, isSuccess: shipSuccess } = useWaitForTransactionReceipt({ hash: shipTxHash });

  // The vault assigns authIds sequentially — snapshot the next one pre-tx
  const { data: nextAuthId } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "nextAuthId",
    query: { enabled: !!CONTRACTS.aquaVault },
  });

  // Official Aqua.ship() calldata for the freshly registered range
  const { data: shipParams } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "getShipParams",
    args: [authIdToShip ?? BigInt(0)],
    query: { enabled: !!CONTRACTS.aquaVault && authIdToShip !== null },
  });

  useEffect(() => {
    if (approveSuccess && step === "approving") {
      setStep("authorizing");
      if (nextAuthId !== undefined) setAuthIdToShip(nextAuthId);
      authorize({
        address: CONTRACTS.aquaVault as `0x${string}`,
        abi: VAULT_ABI,
        functionName: "authorizeRange",
        args: [kMinWAD, kMaxWAD, expiry, maxCollateral, collateralToken as `0x${string}`, USDC_SEPOLIA as `0x${string}`, isCall],
      });
    }
  }, [approveSuccess]);

  // Once registered, ship the strategy on the official Aqua registry
  useEffect(() => {
    if (authSuccess && step === "authorizing" && shipParams && CONTRACTS.aqua && !shipFiredRef.current) {
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
  }, [authSuccess, shipParams]);

  useEffect(() => {
    if (shipSuccess && !firedRef.current) {
      firedRef.current = true;
      setStep("done");
      onSellConfirmed?.({ direction: "sell", isCall, strike: kMin, amount: amountNum });
    }
  }, [shipSuccess]);

  const handleStart = () => {
    if (!address || !CONTRACTS.aquaVault || !CONTRACTS.aqua) return;
    setStep("approving");
    // Collateral allowance goes to the OFFICIAL Aqua registry — funds stay in
    // the LP wallet and get pulled just-in-time on a match.
    approve({
      address: collateralToken as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONTRACTS.aqua as `0x${string}`, maxCollateral],
    });
  };

  const isWorking = step !== "idle" && step !== "done";
  const canSubmit = !!CONTRACTS.aquaVault && !!address && kMin <= kMax && amountNum > 0 && !isWorking && step !== "done";

  return (
    <tr className="bg-orange-950/20 border-b border-gray-800">
      <td colSpan={colSpan} className="px-4 py-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {/* Call / Put toggle */}
            {([true, false] as const).map(c => (
              <button key={String(c)} onClick={() => setIsCall(c)} disabled={isWorking}
                className={`px-2 py-1 rounded font-semibold transition-colors disabled:opacity-50 ${
                  isCall === c ? (c ? "bg-blue-700 text-white" : "bg-orange-700 text-white") : "bg-gray-800 text-gray-500 hover:text-white"
                }`}>
                {c ? "Call" : "Put"}
              </button>
            ))}
            <span className="text-gray-600">K_min</span>
            <input type="number" value={kMin} step={50} disabled={isWorking}
              onChange={e => { const v = Number(e.target.value); setKMin(v); if (kMax < v) setKMax(v); }}
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white font-mono focus:outline-none focus:border-orange-600 disabled:opacity-50" />
            <span className="text-gray-600">K_max</span>
            <input type="number" value={kMax} step={50} disabled={isWorking}
              onChange={e => { const v = Number(e.target.value); setKMax(v); if (kMin > v) setKMin(v); }}
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white font-mono focus:outline-none focus:border-orange-600 disabled:opacity-50" />
            <span className="text-gray-600">×</span>
            <input type="number" value={amount} min="0.01" step="0.01" disabled={isWorking}
              onChange={e => setAmount(e.target.value)}
              className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white font-mono focus:outline-none focus:border-orange-600 disabled:opacity-50" />
            <span className="text-gray-700 font-mono">
              receive ~${totalPremium} USDC
              {isCall
                ? `, lock ${amountNum.toFixed(2)} WETH`
                : `, lock $${(amountNum * kMax / 1e18 * 1e6 / 1e6).toLocaleString(undefined, {maximumFractionDigits: 0})} USDC`}
            </span>
            <button onClick={onClose} className="ml-auto text-gray-500 hover:text-white text-xs">Cancel</button>
          </div>

          <div className="flex items-center gap-2 flex-wrap text-xs">
            {/* Expiry presets */}
            {[{ label: "1d", s: 86400 }, { label: "7d", s: 7*86400 }, { label: "30d", s: 30*86400 }].map(p => (
              <button key={p.s} onClick={() => setExpiryOffset(p.s)} disabled={isWorking}
                className={`px-2 py-1 rounded transition-colors disabled:opacity-50 ${expiryOffset === p.s ? "bg-orange-700 text-white" : "bg-gray-800 text-gray-500 hover:text-white"}`}>
                {p.label}
              </button>
            ))}
            <span className="text-gray-700">
              {isSingle ? "single-strike write" : `range write · ${isCall ? "WETH" : "USDC"} collateral splits across ${Math.round((kMax - kMin) / 50)} strikes`}
            </span>

            {step !== "idle" && (
              <span className="text-orange-400 font-semibold">
                {step === "approving" ? (approvePending ? "Confirm approval…" : approveConfirming ? "Approving…" : "…")
                  : step === "authorizing" ? (authPending ? "Confirm…" : authConfirming ? "Registering…" : "…")
                  : step === "shipping" ? (shipPending ? "Confirm…" : shipConfirming ? "Shipping to Aqua…" : "…")
                  : "✓ Written"}
              </span>
            )}

            <button onClick={handleStart} disabled={!canSubmit}
              className="px-3 py-1.5 rounded-lg bg-orange-700 hover:bg-orange-600 disabled:opacity-40 text-white font-semibold transition-colors">
              {step === "done" ? "✓ Written" : `Write ${isCall ? "Call" : "Put"}`}
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ── BuyPanel ──────────────────────────────────────────────────────────────────

interface BuyPanelProps {
  auth: ActiveAuth;
  strike: number;
  spot: number;
  askWAD: bigint | undefined;
  onClose: () => void;
  onSwapTx?: (hash: string) => void;
  onBuyConfirmed?: (leg: Omit<Leg, "id">) => void;
  colSpan?: number;
}

function BuyPanel({ auth, strike, spot, askWAD, onClose, onSwapTx, onBuyConfirmed, colSpan = 6 }: BuyPanelProps) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [amount, setAmount] = useState("1");
  const [swapQuote, setSwapQuote] = useState<UniswapSwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const amountWAD = BigInt(Math.round(Number(amount) * 1e18));

  // Total USDC premium: askWAD is $/contract in WAD (18 dec); USDC is 6 dec
  const totalUsdcPremium = askWAD
    ? (askWAD * amountWAD) / BigInt(1e12) / BigInt(1e18)
    : undefined;

  const fetchQuote = useCallback(async () => {
    if (!address || !totalUsdcPremium || totalUsdcPremium === BigInt(0)) return;
    const apiKey = process.env.NEXT_PUBLIC_UNISWAP_API_KEY;
    if (!apiKey) { setQuoteError("NEXT_PUBLIC_UNISWAP_API_KEY not set"); return; }
    setQuoteLoading(true);
    setQuoteError(null);
    try {
      const q = await fetchUniswapSwapQuote(totalUsdcPremium, address as `0x${string}`, USDC_SEPOLIA, apiKey);
      setSwapQuote(q);
    } catch (e) {
      setQuoteError((e as Error).message);
    } finally {
      setQuoteLoading(false);
    }
  }, [address, totalUsdcPremium?.toString()]);

  // Auto-fetch quote whenever premium or address changes (debounced for amount typing)
  useEffect(() => {
    setSwapQuote(null);
    const t = setTimeout(fetchQuote, 500);
    return () => clearTimeout(t);
  }, [fetchQuote]);

  // Uniswap swap: ETH → USDC via Universal Router
  const { sendTransaction: sendSwap, data: swapTxHash, isPending: swapPending, error: swapError } = useSendTransaction({
    mutation: { onSuccess: (hash) => onSwapTx?.(hash) },
  });
  const { isLoading: swapConfirming, isSuccess: swapSuccess } = useWaitForTransactionReceipt({ hash: swapTxHash });

  // Step 2: Approve USDC for vault
  const { writeContract: approveUsdc, data: approveTxHash, isPending: approvePending, error: approveError } = useWriteContract();
  const { isLoading: approveConfirming, isSuccess: approveSuccess } = useWaitForTransactionReceipt({ hash: approveTxHash });

  // Step 3: vault.buy()
  const { writeContract: buyTx, data: buyTxHash, isPending: buyPending, error: buyError } = useWriteContract();
  const { isLoading: buyConfirming, isSuccess: buySuccess } = useWaitForTransactionReceipt({ hash: buyTxHash });
  const buyFiredRef = useRef(false);

  useEffect(() => {
    if (buySuccess && !buyFiredRef.current) {
      buyFiredRef.current = true;
      onBuyConfirmed?.({ direction: "buy", isCall: auth.isCall, strike, amount: Number(amount) });
    }
  }, [buySuccess]);

  const canTrade = !!CONTRACTS.aquaVault && !!address;

  const handleSwap = () => {
    if (!swapQuote) return;
    sendSwap({ to: swapQuote.to, data: swapQuote.calldata, value: swapQuote.ethIn });
  };

  const handleApprove = () => {
    if (!canTrade || !totalUsdcPremium) return;
    approveUsdc({
      address: USDC_SEPOLIA as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [CONTRACTS.aquaVault as `0x${string}`, totalUsdcPremium * BigInt(2)],
    });
  };

  const handleBuy = () => {
    if (!canTrade || !totalUsdcPremium) return;
    buyTx({
      address: CONTRACTS.aquaVault as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "buy",
      args: [
        auth.authId,
        BigInt(Math.round(strike * 1e18)),
        amountWAD,
        // Premium is computed on-chain by the SwapVM instruction (oracle spot
        // + live σ); allow 2x headroom over our local estimate as slippage bound.
        totalUsdcPremium * BigInt(2),
      ],
    });
  };

  const isWorking = quoteLoading || swapPending || swapConfirming || approvePending || approveConfirming || buyPending || buyConfirming;
  const anyError = quoteError ?? swapError?.message.split("\n")[0] ?? approveError?.message.split("\n")[0] ?? buyError?.message.split("\n")[0];

  return (
    <tr className="bg-blue-950/20 border-b border-gray-800">
      <td colSpan={colSpan} className="px-4 py-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-gray-400">Amount (contracts)</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              min="0.01"
              step="0.01"
              className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs font-mono focus:outline-none focus:border-blue-600"
            />
            <span className="text-xs text-gray-500">
              {auth.isCall ? "Call" : "Put"} · K ${strike.toLocaleString()}
              {totalUsdcPremium !== undefined && ` · ${(Number(totalUsdcPremium) / 1e6).toFixed(2)} USDC premium`}
            </span>
            <button onClick={onClose} className="text-xs text-gray-500 hover:text-white ml-auto">Cancel</button>
          </div>

          {!canTrade && (
            <span className="text-xs text-yellow-500">Set NEXT_PUBLIC_AQUA_VAULT to enable trading</span>
          )}

          {canTrade && (
            <div className="flex items-center gap-2 flex-wrap">
              {/* Step 1: Uniswap swap → execute */}
              {!swapSuccess && (
                <>
                  {quoteLoading && (
                    <span className="text-xs text-gray-400 animate-pulse">Quoting via Uniswap…</span>
                  )}
                  {swapQuote && (
                    <button
                      onClick={handleSwap}
                      disabled={isWorking}
                      className="px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
                    >
                      {swapPending ? "Confirm in wallet…" : swapConfirming ? "Swapping…" : `1. Swap ${(Number(swapQuote.ethIn) / 1e18).toFixed(5)} ETH → ${(Number(swapQuote.usdcOut) / 1e6).toFixed(2)} USDC`}
                    </button>
                  )}
                </>
              )}
              {swapSuccess && swapTxHash && (() => {
                const url = explorerTxUrl(chainId, swapTxHash);
                return url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-pink-400 hover:text-pink-300 font-mono underline decoration-dotted"
                  >
                    ✓ Swapped via Uniswap ({swapTxHash.slice(0, 10)}…) ↗
                  </a>
                ) : (
                  <span className="text-xs text-pink-400 font-mono">
                    ✓ Swapped via Uniswap ({swapTxHash.slice(0, 10)}…)
                  </span>
                );
              })()}

              {/* Step 2: Approve */}
              {swapSuccess && !approveSuccess && (
                <button
                  onClick={handleApprove}
                  disabled={isWorking}
                  className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
                >
                  {approvePending ? "Confirm…" : approveConfirming ? "Approving…" : "2. Approve USDC"}
                </button>
              )}

              {/* Step 3: Buy */}
              {swapSuccess && approveSuccess && (
                <button
                  onClick={handleBuy}
                  disabled={isWorking || buySuccess}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
                >
                  {buyPending ? "Confirm…" : buyConfirming ? "Confirming…" : buySuccess ? "✓ Filled" : `3. Buy ${amount} ${auth.isCall ? "Call" : "Put"}`}
                </button>
              )}
            </div>
          )}

          {anyError && (
            <span className="text-xs text-red-400">{anyError}</span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── ClosePanel ────────────────────────────────────────────────────────────────

interface ClosePanelProps {
  optionToken: string;
  lp: string;
  balance: bigint;
  onClose: () => void;
  colSpan?: number;
}

function ClosePanel({ optionToken, lp, balance, onClose, colSpan = 6 }: ClosePanelProps) {
  const { writeContract, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const canClose = !!CONTRACTS.aquaVault && balance > BigInt(0);

  const handleClose = () => {
    if (!canClose) return;
    writeContract({
      address: CONTRACTS.aquaVault as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "close",
      // minPayout 0: sellback accepts any Bid (the holder is exiting; the Bid
      // itself is computed on-chain from the live surface)
      args: [optionToken as `0x${string}`, lp as `0x${string}`, balance, BigInt(0)],
    });
  };

  return (
    <tr className="bg-red-950/20 border-b border-gray-800">
      <td colSpan={colSpan} className="px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-400">
            Close position · {(Number(balance) / 1e18).toFixed(4)} contracts
          </span>
          <span className="text-xs text-gray-500">
            Burns OptionToken · releases LP collateral · decrements σ
          </span>
          {canClose && (
            <button
              onClick={handleClose}
              disabled={isPending || isConfirming || isSuccess}
              className="px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
            >
              {isPending ? "Confirm…" : isConfirming ? "Confirming…" : isSuccess ? "✓ Closed" : "Close Position"}
            </button>
          )}
          {error && <span className="text-xs text-red-400">{error.message.split("\n")[0]}</span>}
          <button onClick={onClose} className="text-xs text-gray-500 hover:text-white ml-auto">
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── StrikeRow ─────────────────────────────────────────────────────────────────

interface StrikeRowProps {
  spot: number;
  strike: number;
  expiry: number;
  activeAuth?: ActiveAuth | null;
  onSwapTx?: (hash: string) => void;
  onBuyConfirmed?: (leg: Omit<Leg, "id">) => void;
  onSellConfirmed?: (leg: Omit<Leg, "id">) => void;
}

function StrikeRow({ spot, strike, expiry, activeAuth, onSwapTx, onBuyConfirmed, onSellConfirmed }: StrikeRowProps) {
  type PanelState = { side: "call" | "put"; action: "buy" | "sell" | "close" } | null;
  const [panel, setPanel] = useState<PanelState>(null);
  const { address } = useAccount();

  const T     = Math.max(0, (expiry - Date.now() / 1000) / (365 * 24 * 3600));
  const sigma = smileVol(spot, strike);
  const cDelta = spot > 0 && expiry > 0 ? callDelta(spot, strike, sigma, T) : 0;
  const pDelta = cDelta - 1;
  const ivStr  = `${(sigma * 100).toFixed(1)}%`;

  const callBid = spot > 0 && expiry > 0 ? priceWAD(spot, strike, expiry, true,  false) : undefined;
  const callAsk = spot > 0 && expiry > 0 ? priceWAD(spot, strike, expiry, true,  true)  : undefined;
  const putBid  = spot > 0 && expiry > 0 ? priceWAD(spot, strike, expiry, false, false) : undefined;
  const putAsk  = spot > 0 && expiry > 0 ? priceWAD(spot, strike, expiry, false, true)  : undefined;

  const isATM       = Math.abs((strike - spot) / spot) < 0.01;
  const inAuthRange = !!activeAuth && strike >= activeAuth.strikeMin && strike <= activeAuth.strikeMax;
  const callBuyable = inAuthRange && activeAuth!.isCall;
  const putBuyable  = inAuthRange && !activeAuth!.isCall;

  const toggle = (side: "call" | "put", action: "buy" | "sell" | "close") =>
    setPanel(p => (p?.side === side && p.action === action) ? null : { side, action });

  const strikeWAD = BigInt(Math.round(strike * 1e18));
  const { data: optionTokenAddr } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "optionTokens",
    args: [activeAuth?.authId ?? BigInt(0), strikeWAD],
    query: { enabled: !!activeAuth && !!CONTRACTS.aquaVault },
  });
  const hasToken = optionTokenAddr && optionTokenAddr !== "0x0000000000000000000000000000000000000000";
  const { data: holderBalance } = useReadContract({
    address: (hasToken ? optionTokenAddr : "0x0000000000000000000000000000000000000000") as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [(address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`],
    query: { enabled: !!hasToken && !!address },
  });
  const hasPosition = holderBalance !== undefined && holderBalance > BigInt(0);

  const COL = 9;

  const callBidCls = [
    "py-2 px-3 text-right font-mono text-sm cursor-pointer select-none transition-colors",
    panel?.side === "call" && panel.action === "sell"
      ? "bg-orange-900/40 text-orange-300"
      : "text-green-400 hover:bg-orange-950/50 hover:text-orange-300",
  ].join(" ");

  const callAskCls = [
    "py-2 px-3 text-right font-mono text-sm transition-colors border-r border-gray-800",
    callBuyable ? "cursor-pointer select-none" : "cursor-default",
    panel?.side === "call" && panel.action === "buy"
      ? "bg-blue-900/40 text-blue-200"
      : callBuyable
      ? "text-red-400 hover:bg-blue-950/50 hover:text-blue-300"
      : "text-red-400 opacity-40",
  ].join(" ");

  const putAskCls = [
    "py-2 px-3 text-left font-mono text-sm transition-colors border-l border-gray-800",
    putBuyable ? "cursor-pointer select-none" : "cursor-default",
    panel?.side === "put" && panel.action === "buy"
      ? "bg-blue-900/40 text-blue-200"
      : putBuyable
      ? "text-red-400 hover:bg-blue-950/50 hover:text-blue-300"
      : "text-red-400 opacity-40",
  ].join(" ");

  const putBidCls = [
    "py-2 px-3 text-left font-mono text-sm cursor-pointer select-none transition-colors",
    panel?.side === "put" && panel.action === "sell"
      ? "bg-orange-900/40 text-orange-300"
      : "text-green-400 hover:bg-orange-950/50 hover:text-orange-300",
  ].join(" ");

  return (
    <>
      <tr className={`border-b border-gray-800 ${isATM ? "bg-blue-950/40" : ""}`}>
        {/* ── CALLS ── */}
        <td className="py-2 px-2 text-right text-xs text-gray-500 w-14">{ivStr}</td>
        <td className="py-2 px-2 text-right font-mono text-sm text-purple-400 w-14">{cDelta.toFixed(2)}</td>
        <td className={callBidCls} onClick={() => toggle("call", "sell")}>{formatWAD(callBid)}</td>
        <td className={callAskCls} onClick={() => callBuyable && toggle("call", "buy")}>{formatWAD(callAsk)}</td>

        {/* ── STRIKE ── */}
        <td className="py-2 px-3 text-center font-mono text-sm font-bold border-x border-gray-700 w-24">
          <span className="flex items-center justify-center gap-1">
            ${strike.toLocaleString()}
            {hasPosition && hasToken && (
              <button
                onClick={() => toggle(activeAuth?.isCall ? "call" : "put", "close")}
                className={`text-[10px] px-1 py-0.5 rounded font-semibold transition-colors ${
                  panel?.action === "close" ? "bg-gray-700 text-gray-400" : "bg-red-900/60 text-red-400 hover:bg-red-700"
                }`}
              >pos</button>
            )}
          </span>
        </td>

        {/* ── PUTS ── */}
        <td className={putAskCls} onClick={() => putBuyable && toggle("put", "buy")}>{formatWAD(putAsk)}</td>
        <td className={putBidCls} onClick={() => toggle("put", "sell")}>{formatWAD(putBid)}</td>
        <td className="py-2 px-2 text-left font-mono text-sm text-purple-400 w-14">{pDelta.toFixed(2)}</td>
        <td className="py-2 px-2 text-left text-xs text-gray-500 w-14">{ivStr}</td>
      </tr>

      {panel?.action === "sell" && (
        <SellPanel
          strike={strike}
          spot={spot}
          bidWAD={panel.side === "call" ? callBid : putBid}
          defaultIsCall={panel.side === "call"}
          defaultExpiry={activeAuth?.expiry ?? Math.floor(Date.now() / 1000) + 30 * 86400}
          onClose={() => setPanel(null)}
          onSellConfirmed={onSellConfirmed}
          colSpan={COL}
        />
      )}
      {panel?.action === "buy" && activeAuth && (
        <BuyPanel
          auth={activeAuth}
          strike={strike}
          spot={spot}
          askWAD={panel.side === "call" ? callAsk : putAsk}
          onClose={() => setPanel(null)}
          onSwapTx={onSwapTx}
          onBuyConfirmed={onBuyConfirmed}
          colSpan={COL}
        />
      )}
      {panel?.action === "close" && activeAuth && hasToken && holderBalance !== undefined && (
        <ClosePanel
          optionToken={optionTokenAddr as string}
          lp={activeAuth.lp}
          balance={holderBalance}
          onClose={() => setPanel(null)}
          colSpan={COL}
        />
      )}
    </>
  );
}

// ── OptionMatrix ──────────────────────────────────────────────────────────────

const EXPIRY_PRESETS = [
  { label: "1d",  days: 1  },
  { label: "7d",  days: 7  },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

interface OptionMatrixProps {
  spot: number;
  activeAuth?: ActiveAuth | null;
  onSwapTx?: (hash: string) => void;
  onBuyConfirmed?: (leg: Omit<Leg, "id">) => void;
  onSellConfirmed?: (leg: Omit<Leg, "id">) => void;
}

export function OptionMatrix({ spot, activeAuth, onSwapTx, onBuyConfirmed, onSellConfirmed }: OptionMatrixProps) {
  const [selectedDays, setSelectedDays] = useState(30);
  const [now, setNow] = useState(0);

  useEffect(() => { setNow(Math.floor(Date.now() / 1000)); }, []);

  // LP's authorized expiry takes precedence; otherwise use selected preset
  const expiry = activeAuth?.expiry ?? (now + selectedDays * 86400);

  // Highlight the preset tab closest to the active auth expiry
  const activeDays = activeAuth
    ? Math.round((activeAuth.expiry - now) / 86400)
    : selectedDays;

  const strikes = STRIKES_OFFSETS.map((pct) => Math.round((spot * (1 + pct / 100)) / 50) * 50);

  if (!CONTRACTS.pricingEngine) {
    return (
      <div className="text-gray-500 text-sm">
        Set NEXT_PUBLIC_PRICING_ENGINE to enable live quotes.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 overflow-hidden">
      {/* Expiry tab bar */}
      <div className="flex items-center gap-1 px-3 py-2 bg-gray-900 border-b border-gray-800">
        <span className="text-gray-600 text-xs mr-2">Expiry</span>
        {EXPIRY_PRESETS.map((p) => {
          const isActive = !activeAuth && selectedDays === p.days;
          const isAuthMatch = activeAuth && Math.abs(activeDays - p.days) < p.days * 0.3;
          return (
            <button
              key={p.days}
              onClick={() => { if (!activeAuth) setSelectedDays(p.days); }}
              className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                isActive || isAuthMatch
                  ? "bg-blue-600 text-white"
                  : activeAuth
                  ? "text-gray-700 cursor-default"
                  : "text-gray-500 hover:text-white hover:bg-gray-800"
              }`}
            >
              {p.label}
            </button>
          );
        })}
        {activeAuth && (
          <span className="ml-2 text-xs text-blue-400 font-mono">
            {Math.max(0, Math.round((activeAuth.expiry - now) / 86400))}d (LP auth)
          </span>
        )}
        <span className="ml-auto text-gray-600 text-xs">
          Bid↓ to sell · Ask↑ to buy
        </span>
      </div>

      {activeAuth && <LPSummaryBar auth={activeAuth} />}

      <div className="overflow-x-auto">
        <table className="w-full text-white">
          <thead>
            <tr className="bg-gray-900/80 text-[10px] uppercase tracking-wide">
              <th colSpan={4} className="py-1.5 text-center text-blue-400/80 border-r border-gray-700">Calls</th>
              <th className="py-1.5 text-center text-gray-500">Strike</th>
              <th colSpan={4} className="py-1.5 text-center text-orange-400/80 border-l border-gray-700">Puts</th>
            </tr>
            <tr className="border-b border-gray-700 bg-gray-900 text-gray-400 text-xs uppercase">
              <th className="py-2 px-2 text-right">IV</th>
              <th className="py-2 px-2 text-right">Δ</th>
              <th className="py-2 px-3 text-right">Bid↓sell</th>
              <th className="py-2 px-3 text-right border-r border-gray-700">Ask↑buy</th>
              <th className="py-2 px-3 text-center border-x border-gray-700">Strike</th>
              <th className="py-2 px-3 text-left border-l border-gray-700">Ask↑buy</th>
              <th className="py-2 px-3 text-left">Bid↓sell</th>
              <th className="py-2 px-2 text-left">Δ</th>
              <th className="py-2 px-2 text-left">IV</th>
            </tr>
          </thead>
          <tbody>
            {expiry > 0 &&
              strikes.map((k) => (
                <StrikeRow
                  key={k}
                  spot={spot}
                  strike={k}
                  expiry={expiry}
                  activeAuth={activeAuth}
                  onSwapTx={onSwapTx}
                  onBuyConfirmed={onBuyConfirmed}
                  onSellConfirmed={onSellConfirmed}
                />
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
