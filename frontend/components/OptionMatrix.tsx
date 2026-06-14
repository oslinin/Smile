"use client";

import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useSendTransaction, useAccount } from "wagmi";
import { useEffect, useState, useCallback, useRef } from "react";
import type { Leg } from "@/components/PayoffBuilder";
import { CONTRACTS } from "@/config/wagmi";
import type { ActiveAuth } from "@/components/AuthorizeRange";
import { USDC_SEPOLIA } from "@/components/AuthorizeRange";
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
    name: "buy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "authId", type: "uint256" },
      { name: "strike", type: "uint256" },
      { name: "spot", type: "uint256" },
      { name: "buyer", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "premiumToken", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "close",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "optionToken", type: "address" },
      { name: "lp", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
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

function useOptionQuote(spot: number, strike: number, expiry: number, isBuy: boolean) {
  const spotWAD = BigInt(Math.round(spot * 1e18));
  const strikeWAD = BigInt(Math.round(strike * 1e18));
  const expiryBig = BigInt(expiry);

  return useReadContract({
    address: CONTRACTS.pricingEngine as `0x${string}`,
    abi: PRICING_ENGINE_ABI,
    functionName: "quote",
    args: [{ spot: spotWAD, strike: strikeWAD, expiry: expiryBig, sigmaGlobal: SIGMA_GLOBAL, alpha: ALPHA, isBuy }],
    query: { enabled: !!CONTRACTS.pricingEngine && spot > 0 },
  });
}

function formatWAD(val: bigint | undefined): string {
  if (val === undefined) return "…";
  return `$${(Number(val) / 1e18).toFixed(2)}`;
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
}

function BuyPanel({ auth, strike, spot, askWAD, onClose, onSwapTx, onBuyConfirmed }: BuyPanelProps) {
  const { address } = useAccount();
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
    if (!canTrade) return;
    buyTx({
      address: CONTRACTS.aquaVault as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "buy",
      args: [
        auth.authId,
        BigInt(Math.round(strike * 1e18)),
        BigInt(Math.round(spot * 1e18)),
        address!,
        amountWAD,
        USDC_SEPOLIA as `0x${string}`,
      ],
    });
  };

  const isWorking = quoteLoading || swapPending || swapConfirming || approvePending || approveConfirming || buyPending || buyConfirming;
  const anyError = quoteError ?? swapError?.message.split("\n")[0] ?? approveError?.message.split("\n")[0] ?? buyError?.message.split("\n")[0];

  return (
    <tr className="bg-blue-950/20 border-b border-gray-800">
      <td colSpan={7} className="px-4 py-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-gray-400">Amount (contracts)</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setSwapQuote(null); }}
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
              {/* Step 1: Uniswap swap quote + execution */}
              {!swapSuccess && (
                <>
                  {!swapQuote ? (
                    <button
                      onClick={fetchQuote}
                      disabled={isWorking || !totalUsdcPremium}
                      className="px-3 py-1.5 rounded-lg bg-pink-700 hover:bg-pink-600 disabled:opacity-50 text-white text-xs font-semibold transition-colors"
                    >
                      {quoteLoading ? "Quoting…" : "1. Get Uniswap Quote"}
                    </button>
                  ) : (
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
              {swapSuccess && swapTxHash && (
                <span className="text-xs text-pink-400 font-mono">
                  ✓ Swapped via Uniswap ({swapTxHash.slice(0, 10)}…)
                </span>
              )}

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
}

function ClosePanel({ optionToken, lp, balance, onClose }: ClosePanelProps) {
  const { writeContract, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });
  const canClose = !!CONTRACTS.aquaVault && balance > BigInt(0);

  const handleClose = () => {
    if (!canClose) return;
    writeContract({
      address: CONTRACTS.aquaVault as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "close",
      args: [optionToken as `0x${string}`, lp as `0x${string}`, balance],
    });
  };

  return (
    <tr className="bg-red-950/20 border-b border-gray-800">
      <td colSpan={7} className="px-4 py-3">
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
}

function StrikeRow({ spot, strike, expiry, activeAuth, onSwapTx, onBuyConfirmed }: StrikeRowProps) {
  const [panel, setPanel] = useState<"buy" | "close" | null>(null);
  const { address } = useAccount();
  const bid = useOptionQuote(spot, strike, expiry, false);
  const ask = useOptionQuote(spot, strike, expiry, true);
  const moneyness = ((strike - spot) / spot) * 100;
  const T = Math.max(0, (expiry - Date.now() / 1000) / (365 * 24 * 3600));
  const sigma = smileVol(spot, strike);
  const delta = callDelta(spot, strike, sigma, T);
  const isATM = Math.abs(moneyness) < 1;

  // Strike is tradeable if it falls within the LP's authorized range
  const isTradeable = activeAuth &&
    strike >= activeAuth.strikeMin &&
    strike <= activeAuth.strikeMax;

  const strikeWAD = BigInt(Math.round(strike * 1e18));

  // Look up whether an OptionToken exists for this (authId, strike)
  const { data: optionTokenAddr } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "optionTokens",
    args: [activeAuth?.authId ?? BigInt(0), strikeWAD],
    query: { enabled: !!isTradeable && !!CONTRACTS.aquaVault && !!activeAuth },
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

  return (
    <>
      <tr className={`border-b border-gray-800 ${isATM ? "bg-blue-950/40" : ""}`}>
        <td className="py-2 px-3 text-right font-mono text-sm">${strike.toLocaleString()}</td>
        <td className="py-2 px-3 text-center font-mono text-sm text-purple-400">{delta.toFixed(2)}</td>
        <td className="py-2 px-3 text-center text-gray-400 text-xs">
          {moneyness > 0 ? "+" : ""}{moneyness.toFixed(1)}%
        </td>
        <td className="py-2 px-3 text-right font-mono text-sm text-green-400">
          {bid.isLoading ? "…" : bid.error ? "–" : formatWAD(bid.data as bigint)}
        </td>
        <td className="py-2 px-3 text-right font-mono text-sm text-red-400">
          {ask.isLoading ? "…" : ask.error ? "–" : formatWAD(ask.data as bigint)}
        </td>
        <td className="py-2 px-3 text-right text-xs text-gray-500">
          {ask.data ? `${(sigma * 100).toFixed(1)}%` : "–"}
        </td>
        <td className="py-2 px-3 text-center">
          {isTradeable ? (
            <div className="flex gap-1 justify-center">
              <button
                onClick={() => setPanel(panel === "buy" ? null : "buy")}
                className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                  panel === "buy" ? "bg-gray-700 text-gray-300" : "bg-blue-600 hover:bg-blue-500 text-white"
                }`}
              >
                Buy
              </button>
              {hasPosition && hasToken && (
                <button
                  onClick={() => setPanel(panel === "close" ? null : "close")}
                  className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                    panel === "close" ? "bg-gray-700 text-gray-300" : "bg-red-700 hover:bg-red-600 text-white"
                  }`}
                >
                  Close
                </button>
              )}
            </div>
          ) : (
            <span className="text-gray-700 text-xs">–</span>
          )}
        </td>
      </tr>
      {panel === "buy" && activeAuth && (
        <BuyPanel auth={activeAuth} strike={strike} spot={spot} askWAD={ask.data as bigint | undefined} onClose={() => setPanel(null)} onSwapTx={onSwapTx} onBuyConfirmed={onBuyConfirmed} />
      )}
      {panel === "close" && activeAuth && hasToken && holderBalance !== undefined && (
        <ClosePanel
          optionToken={optionTokenAddr as string}
          lp={activeAuth.lp}
          balance={holderBalance}
          onClose={() => setPanel(null)}
        />
      )}
    </>
  );
}

// ── OptionMatrix ──────────────────────────────────────────────────────────────

interface OptionMatrixProps {
  spot: number;
  activeAuth?: ActiveAuth | null;
  onSwapTx?: (hash: string) => void;
  onBuyConfirmed?: (leg: Omit<Leg, "id">) => void;
}

export function OptionMatrix({ spot, activeAuth, onSwapTx, onBuyConfirmed }: OptionMatrixProps) {
  const [expiry, setExpiry] = useState(0);

  useEffect(() => {
    // Use LP's expiry if authorized, otherwise default to 30 days
    setExpiry(activeAuth?.expiry ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  }, [activeAuth?.expiry]);

  const strikes = STRIKES_OFFSETS.map((pct) =>
    Math.round((spot * (1 + pct / 100)) / 50) * 50
  );

  if (!CONTRACTS.pricingEngine) {
    return (
      <div className="text-gray-500 text-sm">
        Set NEXT_PUBLIC_PRICING_ENGINE to enable live quotes.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-white">
        <thead>
          <tr className="border-b border-gray-700 bg-gray-900 text-gray-400 text-xs uppercase">
            <th className="py-2 px-3 text-right">Strike</th>
            <th className="py-2 px-3 text-center">Delta</th>
            <th className="py-2 px-3 text-center">Moneyness</th>
            <th className="py-2 px-3 text-right">Bid</th>
            <th className="py-2 px-3 text-right">Ask</th>
            <th className="py-2 px-3 text-right">IV</th>
            <th className="py-2 px-3 text-center">Action</th>
          </tr>
        </thead>
        <tbody>
          {expiry > 0 &&
            strikes.map((k) => (
              <StrikeRow key={k} spot={spot} strike={k} expiry={expiry} activeAuth={activeAuth} onSwapTx={onSwapTx} onBuyConfirmed={onBuyConfirmed} />
            ))}
        </tbody>
      </table>
    </div>
  );
}
