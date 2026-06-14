/**
 * Chainlink CRE workflow: Option Series Settlement
 *
 * Triggered at option expiry. Fetches spot prices from multiple sources,
 * forms a consensus (trimmed mean), and writes the result on-chain by
 * calling AquaOptionSettlement.settleSeries() via the CRE forwarder.
 *
 * This is the required Chainlink CRE on-chain state change.
 * Automation/Functions are deprecated — this targets CRE directly.
 */

import { ethers } from "ethers";

// ── Config ────────────────────────────────────────────────────────────────────

const SETTLEMENT_ABI = [
  "function settleSeries(bytes32 seriesId, uint256 spotPrice) external",
  "function series(bytes32) external view returns (uint256 expiry, uint256 strikePrice, uint256 collateralPerUnit, address collateralToken, address optionToken, address lp, uint256 totalCollateral, bool settled, uint256 settlementPrice)",
];

interface CREContext {
  /** RPC endpoint injected by CRE runtime */
  rpcUrl: string;
  /** CRE-managed signing key (forwarder address) */
  privateKey: string;
  /** AquaOptionSettlement contract address */
  settlementAddress: string;
  /** Series ID to settle (bytes32 hex) */
  seriesId: string;
}

// ── Price feeds ───────────────────────────────────────────────────────────────

interface PriceFeed {
  name: string;
  fetch: () => Promise<number>;
}

const PRICE_FEEDS: PriceFeed[] = [
  {
    name: "Binance",
    fetch: async () => {
      const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT");
      const j = await r.json() as { price: string };
      return parseFloat(j.price);
    },
  },
  {
    name: "Coinbase",
    fetch: async () => {
      const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
      const j = await r.json() as { data: { amount: string } };
      return parseFloat(j.data.amount);
    },
  },
  {
    name: "Kraken",
    fetch: async () => {
      const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSDT");
      const j = await r.json() as { result: { ETHUSDT: { c: string[] } } };
      return parseFloat(j.result.ETHUSDT.c[0]);
    },
  },
];

// ── Consensus logic ───────────────────────────────────────────────────────────

/**
 * Fetch all feeds concurrently, drop the top and bottom outlier,
 * return the mean of the remainder. Requires ≥ 2 successful feeds.
 */
async function consensusPrice(): Promise<number> {
  const results = await Promise.allSettled(PRICE_FEEDS.map((f) => f.fetch()));

  const prices: number[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && isFinite(r.value) && r.value > 0) {
      console.log(`[CRE] ${PRICE_FEEDS[i].name}: $${r.value.toFixed(2)}`);
      prices.push(r.value);
    } else {
      const reason = r.status === "rejected" ? r.reason : "invalid value";
      console.warn(`[CRE] ${PRICE_FEEDS[i].name} failed:`, reason);
    }
  }

  if (prices.length < 2) {
    throw new Error(`Insufficient price feeds: only ${prices.length} succeeded`);
  }

  prices.sort((a, b) => a - b);
  // Trim one outlier on each side if we have ≥ 3 feeds
  const trimmed = prices.length >= 3 ? prices.slice(1, -1) : prices;
  const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

  console.log(`[CRE] Consensus spot price: $${mean.toFixed(2)} (from ${prices.length} feeds)`);
  return mean;
}

// ── Main workflow ─────────────────────────────────────────────────────────────

export async function run(ctx: CREContext): Promise<void> {
  const provider = new ethers.JsonRpcProvider(ctx.rpcUrl);
  const signer = new ethers.Wallet(ctx.privateKey, provider);
  const settlement = new ethers.Contract(ctx.settlementAddress, SETTLEMENT_ABI, signer);

  // Verify series exists and needs settlement
  const s = await settlement.series(ctx.seriesId);
  if (s.settled) {
    console.log("[CRE] Series already settled, skipping.");
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  if (now < Number(s.expiry)) {
    const remaining = Number(s.expiry) - now;
    console.log(`[CRE] Series not yet expired (${remaining}s remaining), skipping.`);
    return;
  }

  // Fetch consensus price
  const spotUSD = await consensusPrice();

  // Convert to USDC 6-decimal fixed-point
  const spotFixed = BigInt(Math.round(spotUSD * 1e6));

  // Write on-chain — this is the required CRE state change
  console.log(`[CRE] Calling settleSeries(${ctx.seriesId}, ${spotFixed}) ...`);
  const tx = await settlement.settleSeries(ctx.seriesId, spotFixed);
  const receipt = await tx.wait();

  console.log(`[CRE] Settlement confirmed! TxHash: ${receipt.hash}`);
  console.log(`[CRE] Block: ${receipt.blockNumber}, Gas: ${receipt.gasUsed}`);
}

// ── CRE CLI simulation entry point ───────────────────────────────────────────

// When run directly (npx ts-node option-settlement.ts --simulate), use
// environment variables to populate the context.
if (require.main === module) {
  const ctx: CREContext = {
    rpcUrl: process.env.RPC_URL ?? "http://localhost:8545",
    privateKey: process.env.CRE_PRIVATE_KEY ?? "",
    settlementAddress: process.env.SETTLEMENT_ADDRESS ?? "",
    seriesId: process.env.SERIES_ID ?? "",
  };

  run(ctx)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[CRE] Workflow failed:", err.message);
      process.exit(1);
    });
}
