"use client";

import { useState, useEffect } from "react";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

export type SpotState =
  | { status: "loading" }
  | { status: "ok"; price: number; source: "uniswap-api" }
  | { status: "fallback"; price: number; source: "static" };

export function useUniswapSpot(): SpotState {
  const [state, setState] = useState<SpotState>({ status: "loading" });

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_UNISWAP_API_KEY;

    async function fetch() {
      try {
        if (!apiKey) throw new Error("no key");

        const res = await globalThis.fetch(
          "https://trade-api.gateway.uniswap.org/v1/quote",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
            },
            body: JSON.stringify({
              type: "EXACT_INPUT",
              tokenInChainId: 1,
              tokenOutChainId: 1,
              tokenIn: WETH,
              tokenOut: USDC,
              // 1 ETH in wei
              amount: "1000000000000000000",
              swapper: "0x0000000000000000000000000000000000000000",
            }),
          }
        );

        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();

        // quote is USDC amount (6 decimals) for 1 ETH in
        const usdcOut = Number(data.quote) / 1e6;
        if (!usdcOut || usdcOut < 100) throw new Error("bad quote");

        setState({ status: "ok", price: Math.round(usdcOut), source: "uniswap-api" });
      } catch {
        setState({ status: "fallback", price: 3420, source: "static" });
      }
    }

    fetch();
    // Refresh every 60 s
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, []);

  return state;
}
