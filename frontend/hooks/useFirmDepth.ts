"use client";

import { useReadContracts } from "wagmi";
import { CONTRACTS } from "@/config/wagmi";

const ERC20_MINI_ABI = [
  {
    name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface FirmDepth {
  /** min(authorized remaining, LP wallet balance, LP→Aqua allowance) — the
   *  size a fill can ACTUALLY clear right now. null while loading. */
  firmDepth: bigint | null;
  /** Authorized remaining per the vault registry (maxCollateral − used). */
  authorizedRemaining: bigint | null;
  /** True when the wallet backs less than the authorized remaining — the
   *  displayed depth is partly phantom (docs/limitations.md L11). */
  soft: boolean;
}

/**
 * S1 honest depth (docs/solutions.md): Aqua liquidity is unrehypothecated, so
 * the balance behind a quote lives in the LP's wallet and can move at any
 * time. Depth shown to takers must therefore be the minimum of what the vault
 * registry authorizes and what the wallet + Aqua allowance can deliver.
 */
export function useFirmDepth(params: {
  lp?: string;
  collateralToken?: string;
  maxCollateral?: bigint;
  usedCollateral?: bigint;
}): FirmDepth {
  const { lp, collateralToken, maxCollateral, usedCollateral } = params;
  const enabled =
    !!lp && !!collateralToken && !!CONTRACTS.aqua && maxCollateral !== undefined;

  const { data } = useReadContracts({
    contracts: [
      {
        address: collateralToken as `0x${string}`,
        abi: ERC20_MINI_ABI,
        functionName: "balanceOf",
        args: [lp as `0x${string}`],
      },
      {
        address: collateralToken as `0x${string}`,
        abi: ERC20_MINI_ABI,
        functionName: "allowance",
        args: [lp as `0x${string}`, CONTRACTS.aqua as `0x${string}`],
      },
    ],
    query: { enabled, refetchInterval: 10_000 },
  });

  const balance = data?.[0]?.result as bigint | undefined;
  const allowance = data?.[1]?.result as bigint | undefined;

  if (!enabled || maxCollateral === undefined) {
    return { firmDepth: null, authorizedRemaining: null, soft: false };
  }
  const authorizedRemaining =
    maxCollateral > (usedCollateral ?? BigInt(0))
      ? maxCollateral - (usedCollateral ?? BigInt(0))
      : BigInt(0);
  if (balance === undefined || allowance === undefined) {
    return { firmDepth: null, authorizedRemaining, soft: false };
  }
  const walletBacked = balance < allowance ? balance : allowance;
  const firmDepth = walletBacked < authorizedRemaining ? walletBacked : authorizedRemaining;
  return { firmDepth, authorizedRemaining, soft: firmDepth < authorizedRemaining };
}
