"use client";

// Native ETH sentinel address used by the Uniswap Trading API
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const MAINNET_CHAIN_ID = 1;
const API_URL = "https://trade-api.gateway.uniswap.org/v1/quote";

export interface UniswapSwapQuote {
  ethIn: bigint;              // wei to send with the tx
  usdcOut: bigint;            // USDC (6 dec) the swap delivers
  calldata: `0x${string}`;   // Universal Router calldata
  to: `0x${string}`;         // Universal Router address
  quoteId: string;
}

// Ask the Trading API for an EXACT_OUTPUT quote:
//   "give me exactly usdcAmountOut USDC, paying with as little ETH as possible"
export async function fetchUniswapSwapQuote(
  usdcAmountOut: bigint,
  swapper: `0x${string}`,
  usdcToken: string,
  apiKey: string,
): Promise<UniswapSwapQuote> {
  const res = await globalThis.fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      type: "EXACT_OUTPUT",
      tokenInChainId: MAINNET_CHAIN_ID,
      tokenOutChainId: MAINNET_CHAIN_ID,
      tokenIn: NATIVE_ETH,
      tokenOut: usdcToken,
      amount: usdcAmountOut.toString(),
      swapper,
      slippageTolerance: 1.0,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Uniswap API ${res.status}: ${body.slice(0, 120)}`);
  }

  const data = await res.json();
  // Trading API v1 nests methodParameters under data.quote; older routing API has it at top level
  const mp = data.quote?.methodParameters ?? data.methodParameters;
  if (!mp?.calldata) throw new Error("Uniswap API returned no calldata — no mainnet liquidity route found");

  return {
    ethIn: BigInt(mp.value ?? "0"),
    usdcOut: usdcAmountOut,
    calldata: mp.calldata as `0x${string}`,
    to: mp.to as `0x${string}`,
    quoteId: data.quote?.quoteId ?? "",
  };
}
