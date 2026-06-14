"use client";

import { useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi";
import { useState, useEffect, useRef } from "react";
import { keccak256, encodePacked } from "viem";

const SETTLEMENT_ADDRESS = "0x96381D3795A73Fc6a982A9B77D51f6d3F392aDCA" as const;
export const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
export const WETH_SEPOLIA = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" as const;

const SETTLEMENT_ABI = [
  {
    name: "registerSeries",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "seriesId", type: "bytes32" },
      { name: "expiry", type: "uint256" },
      { name: "strikePrice", type: "uint256" },
      { name: "collateralPerUnit", type: "uint256" },
      { name: "collateralToken", type: "address" },
      { name: "optionToken", type: "address" },
      { name: "lp", type: "address" },
      { name: "totalCollateral", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const EXPIRY_PRESETS = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];

export interface ActiveSeries {
  seriesId: `0x${string}`;
  strike: number;
  expiry: number;
  optionToken: string;
  lp: string;
  isCall: boolean;
  collateralToken: string;
}

interface RegisterSeriesProps {
  spot: number;
  onRegistered: (series: ActiveSeries) => void;
}

export function RegisterSeries({ spot, onRegistered }: RegisterSeriesProps) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [strike, setStrike] = useState(Math.round(spot / 50) * 50);
  const [expiryOffset, setExpiryOffset] = useState(7 * 86_400);
  const [optionToken, setOptionToken] = useState("");
  const [isCall, setIsCall] = useState(true);

  const collateralToken = isCall ? WETH_SEPOLIA : USDC_SEPOLIA;
  // Call: 1 WETH per contract (18 dec). Put: strike USDC per contract (6 dec).
  const collateralPerUnit = isCall
    ? BigInt("1000000000000000000")
    : BigInt(Math.round(strike * 1e6));
  const [registered, setRegistered] = useState<ActiveSeries | null>(null);
  const firedRef = useRef(false);

  const expiry = Math.floor(Date.now() / 1000) + expiryOffset;
  const strikeWAD = BigInt(Math.round(strike * 1e18));
  const expiryBig = BigInt(expiry);

  const seriesId: `0x${string}` | null = address
    ? keccak256(encodePacked(["address", "uint256", "uint256"], [address, strikeWAD, expiryBig]))
    : null;

  const { writeContract, data: txHash, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess && seriesId && !firedRef.current && address) {
      firedRef.current = true;
      const series: ActiveSeries = { seriesId, strike, expiry, optionToken, lp: address, isCall, collateralToken };
      setRegistered(series);
      onRegistered(series);
    }
  }, [isSuccess]);

  const handleRegister = () => {
    if (!address || !seriesId) return;
    writeContract({
      address: SETTLEMENT_ADDRESS,
      abi: SETTLEMENT_ABI,
      functionName: "registerSeries",
      args: [
        seriesId,
        expiryBig,
        strikeWAD,
        collateralPerUnit,
        collateralToken as `0x${string}`,
        (optionToken || "0x0000000000000000000000000000000000000000") as `0x${string}`,
        address,
        BigInt(0),
      ],
    });
  };

  if (!mounted || !isConnected) {
    return (
      <div className="rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">
        {mounted ? "Connect wallet to register a series." : null}
      </div>
    );
  }

  if (registered) {
    return (
      <div className="rounded-xl border border-green-800 bg-green-950/30 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-green-400 text-sm font-semibold">Series registered</span>
          <button
            onClick={() => { setRegistered(null); firedRef.current = false; }}
            className="text-xs text-gray-500 hover:text-white"
          >
            New series
          </button>
        </div>
        <div className="text-xs text-gray-400">
          <span className={registered.isCall ? "text-blue-400" : "text-orange-400"}>
            {registered.isCall ? "Call" : "Put"}
          </span>
          {" · "}Strike <span className="text-white font-mono">${registered.strike.toLocaleString()}</span>
          {" · "}expires {new Date(registered.expiry * 1000).toLocaleDateString()}
          {" · "}collateral <span className="text-white font-mono">{registered.isCall ? "WETH" : "USDC"}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-mono truncate">{registered.seriesId}</span>
          <button
            onClick={() => navigator.clipboard.writeText(registered.seriesId)}
            className="text-xs text-blue-400 hover:text-blue-300 shrink-0"
          >
            Copy ID
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-4">
      <h3 className="text-white font-semibold text-sm">Register Option Series</h3>

      <div className="flex gap-2">
        {[true, false].map((c) => (
          <button
            key={String(c)}
            onClick={() => setIsCall(c)}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
              isCall === c
                ? c ? "bg-blue-600 text-white" : "bg-orange-700 text-white"
                : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            {c ? "Call (WETH collateral)" : "Put (USDC collateral)"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Strike (USD)</label>
          <input
            type="number"
            value={strike}
            onChange={(e) => setStrike(Number(e.target.value))}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Expiry</label>
          <div className="flex gap-1">
            {EXPIRY_PRESETS.map((p) => (
              <button
                key={p.seconds}
                onClick={() => setExpiryOffset(p.seconds)}
                className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${
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

      <div>
        <label className="text-xs text-gray-400 mb-1 block">
          Option Token{" "}
          <span className="text-gray-600">(deployed OptionToken.sol — leave blank for demo)</span>
        </label>
        <input
          type="text"
          value={optionToken}
          onChange={(e) => setOptionToken(e.target.value)}
          placeholder="0x…"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-600"
        />
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>Collateral: USDC · LP: {address?.slice(0, 6)}…{address?.slice(-4)}</span>
        {seriesId && (
          <span className="font-mono">{seriesId.slice(0, 10)}…</span>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-400">{error.message.split("\n")[0]}</div>
      )}

      <button
        onClick={handleRegister}
        disabled={isPending || isConfirming}
        className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
      >
        {isPending ? "Confirm in wallet…" : isConfirming ? "Confirming…" : "Register Series"}
      </button>
    </div>
  );
}
