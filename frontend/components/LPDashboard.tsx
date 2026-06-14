"use client";

import { useAccount, useReadContract, useBalance } from "wagmi";

const VAULT_ABI = [
  {
    name: "positions",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "optionToken", type: "address" },
      { name: "lp", type: "address" },
    ],
    outputs: [
      { name: "lockedCollateral", type: "uint256" },
      { name: "collateralToken", type: "address" },
    ],
  },
] as const;

import { CONTRACTS } from "@/config/wagmi";

interface LPDashboardProps {
  optionToken?: string;
}

export function LPDashboard({ optionToken }: LPDashboardProps) {
  const { address, isConnected } = useAccount();

  const { data: ethBalance } = useBalance({ address });

  const { data: position } = useReadContract({
    address: CONTRACTS.aquaVault as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "positions",
    args: [
      (optionToken ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      (address ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
    ],
    query: { enabled: isConnected && !!CONTRACTS.aquaVault && !!optionToken },
  });

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-gray-800 p-4 text-gray-500 text-sm">
        Connect wallet to view LP dashboard.
      </div>
    );
  }

  const lockedCollateral = position ? Number(position[0]) / 1e6 : 0;
  const walletEth = ethBalance ? (Number(ethBalance.value) / 1e18).toFixed(4) : "…";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-3">
      <h3 className="text-white font-semibold text-sm">LP Dashboard</h3>
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Wallet ETH"
          value={`${walletEth} ETH`}
          sub="Self-custodied — earning until called"
        />
        <Stat
          label="Locked Collateral"
          value={`$${lockedCollateral.toFixed(2)}`}
          sub="Pulled JIT by Aqua on match"
        />
        <Stat
          label="Total Value Unlocked"
          value={`${walletEth} ETH`}
          sub="Available to back new quotes"
          highlight
        />
        <Stat
          label="Active Positions"
          value={lockedCollateral > 0 ? "1" : "0"}
          sub="Tracked on-chain"
        />
      </div>
    </div>
  );
}

function Stat({ label, value, sub, highlight }: { label: string; value: string; sub: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${highlight ? "bg-blue-950/60 border border-blue-800" : "bg-gray-800"}`}>
      <div className="text-gray-400 text-xs">{label}</div>
      <div className={`text-lg font-mono font-semibold mt-1 ${highlight ? "text-blue-300" : "text-white"}`}>{value}</div>
      <div className="text-gray-500 text-xs mt-0.5">{sub}</div>
    </div>
  );
}
