"use client";

// Native ETH sentinel address used by the Uniswap Trading API
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const MAINNET_CHAIN_ID = 1;
const BASE_URL = "https://trade-api.gateway.uniswap.org/v1";

export interface UniswapSwapQuote {
  ethIn: bigint;              // wei to send with the tx
  usdcOut: bigint;            // USDC (6 dec) the swap delivers
  calldata: `0x${string}`;   // Universal Router calldata
  to: `0x${string}`;         // Universal Router address
  quoteId: string;
}

// Ask the Trading API for an EXACT_OUTPUT quote, then fetch calldata via /v1/swap.
// The Trading API v1 separates quoting (CLASSIC routing) from transaction building.
export async function fetchUniswapSwapQuote(
  usdcAmountOut: bigint,
  swapper: `0x${string}`,
  usdcToken: string,
  apiKey: string,
): Promise<UniswapSwapQuote> {
  const headers = { "Content-Type": "application/json", "x-api-key": apiKey };

  // Step 1: get the quote
  const quoteRes = await globalThis.fetch(`${BASE_URL}/quote`, {
    method: "POST",
    headers,
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

  if (!quoteRes.ok) {
    const body = await quoteRes.text().catch(() => "");
    throw new Error(`Uniswap quote ${quoteRes.status}: ${body.slice(0, 120)}`);
  }

  const quoteData = await quoteRes.json();

  // Some older/alternate API versions include methodParameters directly in the quote
  const mp = quoteData.quote?.methodParameters ?? quoteData.methodParameters;
  if (mp?.calldata) {
    return {
      ethIn: BigInt(mp.value ?? "0"),
      usdcOut: usdcAmountOut,
      calldata: mp.calldata as `0x${string}`,
      to: mp.to as `0x${string}`,
      quoteId: quoteData.quote?.quoteId ?? "",
    };
  }

  // Step 2: CLASSIC routing returns quote without calldata — fetch tx via /v1/swap
  const swapRes = await globalThis.fetch(`${BASE_URL}/swap`, {
    method: "POST",
    headers,
    body: JSON.stringify({ quote: quoteData.quote }),
  });

  if (!swapRes.ok) {
    const body = await swapRes.text().catch(() => "");
    throw new Error(`Uniswap swap ${swapRes.status}: ${body.slice(0, 120)}`);
  }

  const swapData = await swapRes.json();
  console.log("Uniswap /v1/swap response:", JSON.stringify(swapData, null, 2));
  const tx = swapData.swap ?? swapData;
  const calldata = tx.data ?? tx.calldata;
  if (!calldata) throw new Error(`Uniswap /v1/swap returned no calldata — keys: ${Object.keys(tx).join(", ")}`);

  return {
    ethIn: BigInt(tx.value ?? "0"),
    usdcOut: usdcAmountOut,
    calldata: calldata as `0x${string}`,
    to: tx.to as `0x${string}`,
    quoteId: quoteData.quote?.quoteId ?? "",
  };
}
