"use client";

import { useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi";
import { useState } from "react";
import { CONTRACTS } from "@/config/wagmi";

const VAULT_ABI = [
  {
    name: "pull",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "optionToken", type: "address" },
      { name: "lp", type: "address" },
      { name: "buyer", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "collateralToken", type: "address" },
      { name: "collateralAmount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

interface TradeButtonProps {
  optionToken: string;
  lp: string;
  collateralToken: string;
  collateralAmount: bigint;
  amount: bigint;
  label: string;
  onSuccess?: (txHash: string) => void;
}

export function TradeButton({
  optionToken,
  lp,
  collateralToken,
  collateralAmount,
  amount,
  label,
  onSuccess,
}: TradeButtonProps) {
  const { address } = useAccount();
  const [submitted, setSubmitted] = useState(false);

  const { writeContract, data: txHash, isPending } = useWriteContract();

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const handleClick = () => {
    if (!address || !CONTRACTS.aquaVault) return;
    setSubmitted(true);
    writeContract({
      address: CONTRACTS.aquaVault as `0x${string}`,
      abi: VAULT_ABI,
      functionName: "pull",
      args: [
        optionToken as `0x${string}`,
        lp as `0x${string}`,
        address,
        amount,
        collateralToken as `0x${string}`,
        collateralAmount,
      ],
    });
  };

  if (isSuccess && txHash && onSuccess) {
    onSuccess(txHash);
  }

  const disabled = !address || isPending || isConfirming;

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                 text-white text-sm font-semibold transition-colors"
    >
      {isPending ? "Confirm in wallet…" : isConfirming ? "Confirming…" : isSuccess ? "✓ Filled" : label}
    </button>
  );
}
