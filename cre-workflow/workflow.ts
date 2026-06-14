/**
 * Chainlink CRE Workflow — Option Series Settlement
 *
 * Each DON node independently fetches ETH/USD from Binance.
 * CRE forms median consensus across nodes, then submits a signed
 * report that calls AquaOptionSettlement.settleSeries() on-chain.
 *
 * Compile:  bun x cre-compile workflow.ts dist/workflow.wasm
 * Simulate: cre workflow simulate --target local-simulation \
 *             --config config.json workflow.ts
 * Deploy:   cre workflow deploy dist/workflow.wasm
 */

import {
  cre,
  Runner,
  consensusMedianAggregation,
  prepareReportRequest,
  ok,
  json,
  getNetwork,
  type Runtime,
  type HTTPSendRequester,
} from "@chainlink/cre-sdk";
import { encodeFunctionData, type Hex, getAddress } from "viem";
import { z } from "zod";

// ── Config schema ─────────────────────────────────────────────────────────────

const configSchema = z.object({
  schedule: z.string(),
  seriesId: z.string(),
  settlement: z.object({
    chainSelectorName: z.string(),
    contractAddress: z.string(),
  }),
});

type Config = z.infer<typeof configSchema>;

// ── Contract ABI ──────────────────────────────────────────────────────────────

const SETTLEMENT_ABI = [
  {
    name: "settleSeries",
    type: "function",
    inputs: [
      { name: "seriesId", type: "bytes32" },
      { name: "spotPrice", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── Per-node price fetch ───────────────────────────────────────────────────────
// This runs independently on EACH node in the DON.
// CRE applies consensusMedianAggregation() across all node results.

function fetchEthUsd(sendRequester: HTTPSendRequester): number {
  const res = sendRequester
    .sendRequest({
      url: "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
      method: "GET",
    })
    .result();

  if (!ok(res)) throw new Error(`Binance HTTP ${res.statusCode}`);

  const data = json(res) as { price: string };
  const price = Number.parseFloat(data.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Bad price: ${data.price}`);
  }
  return price;
}

// ── Workflow ──────────────────────────────────────────────────────────────────

function initWorkflow(runtime: Runtime<Config>) {
  const cron = new cre.capabilities.CronCapability();
  const trigger = cron.trigger({ schedule: runtime.config.schedule });

  const handler = cre.handler(trigger, (runtime) => {
    const { seriesId, settlement } = runtime.config;

    // 1. Fetch ETH/USD — each DON node queries Binance; CRE takes the median
    const http = new cre.capabilities.HTTPClient();
    const spotUsd = http
      .sendRequest(runtime, fetchEthUsd, consensusMedianAggregation())()
      .result();

    runtime.log(`[CRE] Consensus ETH/USD: $${spotUsd.toFixed(2)}`);

    // 2. Encode settleSeries calldata (price in USDC 6-decimal fixed-point)
    const spotUsdc6 = BigInt(Math.round(spotUsd * 1_000_000));
    const callData = encodeFunctionData({
      abi: SETTLEMENT_ABI,
      functionName: "settleSeries",
      args: [seriesId as Hex, spotUsdc6],
    });

    // 3. Build DON-signed CRE report
    const report = runtime.report(prepareReportRequest(callData)).result();
    runtime.log(`[CRE] Report ID: ${report.executionId()}`);

    // 4. Submit to AquaOptionSettlement on-chain
    const network = getNetwork({
      chainFamily: "evm",
      chainSelectorName: settlement.chainSelectorName,
      isTestnet: true,
    });
    if (!network) throw new Error(`Unknown chain: ${settlement.chainSelectorName}`);

    const evm = new cre.capabilities.EVMClient(network.chainSelector.selector);
    evm
      .writeReport(runtime, {
        receiver: getAddress(settlement.contractAddress) as unknown as Uint8Array,
        report,
      })
      .result();

    runtime.log(`[CRE] settleSeries(seriesId=${seriesId}, spot=${spotUsdc6}) submitted`);
  });

  return [handler];
}

// ── Entry point (required by CRE runtime) ─────────────────────────────────────

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}

main();
