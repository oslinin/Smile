"use client";

import { useState, useEffect } from "react";
import { createPublicClient, http } from "viem";
import { sepolia, hardhat } from "viem/chains";

const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const CHAINLINK_FEEDS: Record<number, `0x${string}`> = {
  11155111: "0x694AA1769357215DE4FAC081bf1f309aDC325306", // Sepolia ETH/USD
};

const CHAINLINK_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId",         type: "uint80"  },
      { name: "answer",          type: "int256"  },
      { name: "startedAt",       type: "uint256" },
      { name: "updatedAt",       type: "uint256" },
      { name: "answeredInRound", type: "uint80"  },
    ],
  },
] as const;

export type PriceSource = "uniswap-api" | "chainlink" | "static";

export type SpotState =
  | { status: "loading" }
  | { status: "ok";       price: number; source: PriceSource }
  | { status: "fallback"; price: number; source: "static" };

const chainId = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? "11155111");

async function fetchUniswap(apiKey: string): Promise<number> {
  const res = await globalThis.fetch(
    "https://trade-api.gateway.uniswap.org/v1/quote",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        type: "EXACT_INPUT",
        tokenInChainId: 1,
        tokenOutChainId: 1,
        tokenIn: WETH_MAINNET,
        tokenOut: USDC_MAINNET,
        amount: "1000000000000000000",
        swapper: "0x0000000000000000000000000000000000000000",
      }),
    }
  );
  if (!res.ok) throw new Error(`Uniswap API ${res.status}`);
  const data = await res.json();
  // Trading API v1: output amount is under data.quote.output.amount; older API: data.quote (string)
  const rawAmount = data.quote?.output?.amount ?? data.quote;
  const price = Number(rawAmount) / 1e6;
  if (!price || price < 100) throw new Error("bad quote");
  return Math.round(price);
}

async function fetchChainlink(): Promise<number> {
  const feed = CHAINLINK_FEEDS[chainId];
  if (!feed) throw new Error("no feed for this chain");

  const chain = chainId === 31337 ? hardhat : sepolia;
  const transport = chainId === 31337 ? http("http://localhost:8545") : http();

  const client = createPublicClient({ chain, transport });
  const [, answer] = await client.readContract({
    address: feed,
    abi: CHAINLINK_ABI,
    functionName: "latestRoundData",
  });
  const price = Number(answer) / 1e8;
  if (!price || price < 100) throw new Error("bad price");
  return Math.round(price);
}

export function useUniswapSpot(): SpotState {
  const [state, setState] = useState<SpotState>({ status: "loading" });

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_UNISWAP_API_KEY;

    async function refresh() {
      // 1. Try Uniswap Trading API
      if (apiKey) {
        try {
          const price = await fetchUniswap(apiKey);
          setState({ status: "ok", price, source: "uniswap-api" });
          return;
        } catch {}
      }

      // 2. Try Chainlink on-chain price feed
      try {
        const price = await fetchChainlink();
        setState({ status: "ok", price, source: "chainlink" });
        return;
      } catch {}

      // 3. Static fallback
      setState({ status: "fallback", price: 3420, source: "static" });
    }

    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  return state;
}
