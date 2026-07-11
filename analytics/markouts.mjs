#!/usr/bin/env node
// S8 markout instrumentation (docs/solutions.md).
//
// For every OptionBought fill, re-quote the protocol's own surface at
// +1/+5/+30 minutes and record the difference. Persistent NEGATIVE markouts
// (the surface re-quotes below what the buyer paid soon after the fill mean
// the LP sold cheap to informed flow) are the empirical signature of adverse
// selection — and the gate for building the Phase-3 firm tier and the
// signed-quote RFQ tier. Without this data, those decisions are guesses.
//
// Usage:
//   cd analytics && npm install
//   RPC_URL=http://127.0.0.1:8545 VAULT=0x… ENGINE=0x… ORACLE=0x… [HOOK=0x…] \
//     npm run markouts
//
// Env:
//   RPC_URL            RPC endpoint            (default http://127.0.0.1:8545)
//   VAULT              AquaCollateralVault     (required)
//   ENGINE             OptionPricingEngine     (required)
//   ORACLE             spot feed (Chainlink-shaped; the Pyth adapter works too)
//   HOOK               OptionPricingHook — live σ source (optional; 0.8 WAD fallback)
//   MARKOUT_INTERVALS  re-quote delays in seconds (default "60,300,1800")
//   MARKOUT_OUT        CSV output path         (default markouts.csv)
//   MARKOUT_STATE      checkpoint file         (default markout-state.json)
//   POLL_SEC           log-poll cadence        (default 15)
//
// Sign convention: markout = tradePremiumPerUnit − requotePerUnit, both USD
// per option unit, Ask side. Positive = the LP won the trade so far.

import { createPublicClient, http, parseAbi } from "viem";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const env = (k, d) => process.env[k] ?? d;
const requireEnv = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing required env ${k}`); process.exit(1); }
  return v;
};

const RPC_URL   = env("RPC_URL", "http://127.0.0.1:8545");
const VAULT     = requireEnv("VAULT");
const ENGINE    = requireEnv("ENGINE");
const ORACLE    = requireEnv("ORACLE");
const HOOK      = env("HOOK", "");
const INTERVALS = env("MARKOUT_INTERVALS", "60,300,1800").split(",").map(Number);
const OUT       = env("MARKOUT_OUT", "markouts.csv");
const STATE     = env("MARKOUT_STATE", "markout-state.json");
const POLL_SEC  = Number(env("POLL_SEC", "15"));
const ALPHA     = 2_000_000_000_000_000_000n; // 2e18 — vault's smile curvature
const WAD       = 10n ** 18n;

const client = createPublicClient({ transport: http(RPC_URL) });

const EVENTS_ABI = parseAbi([
  "event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium)",
]);
const ENGINE_ABI = parseAbi([
  "function quote((uint256 spot, uint256 strike, uint256 expiry, uint256 sigmaGlobal, uint256 alpha, bool isBuy)) view returns (uint256)",
]);
const HOOK_ABI = parseAbi([
  "function sigmaFor(uint256 timeToExpiry) view returns (uint256)",
]);
const ORACLE_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
// Prefix of the vault's authorizations getter — trailing fields ignored.
const VAULT_ABI = [{
  name: "authorizations", type: "function", stateMutability: "view",
  inputs: [{ name: "authId", type: "uint256" }],
  outputs: [
    { name: "lp", type: "address" }, { name: "strikeMin", type: "uint256" },
    { name: "strikeMax", type: "uint256" }, { name: "expiry", type: "uint256" },
    { name: "maxCollateral", type: "uint256" }, { name: "usedCollateral", type: "uint256" },
    { name: "collateralToken", type: "address" }, { name: "isCall", type: "bool" },
    { name: "active", type: "bool" },
  ],
}];

function loadState() {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8"));
  return { fromBlock: 0 };
}
function saveState(s) { writeFileSync(STATE, JSON.stringify(s)); }

if (!existsSync(OUT)) {
  appendFileSync(
    OUT,
    "txHash,fillTime,authId,optionToken,strike,amount,side,tradePremiumPerUnitUsd," +
      INTERVALS.map((s) => `quote${s}sUsd`).join(",") + "," +
      INTERVALS.map((s) => `markout${s}sUsd`).join(",") + "\n"
  );
}

async function spotWad() {
  const [, answer] = await client.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "latestRoundData" });
  const dec = await client.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "decimals" });
  return BigInt(answer) * 10n ** BigInt(18 - dec);
}

async function sigmaWad(expiry, nowSec) {
  if (!HOOK) return 800_000_000_000_000_000n; // DEFAULT_SIGMA 0.8e18
  const tte = expiry > nowSec ? expiry - nowSec : 0n;
  return client.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "sigmaFor", args: [tte] });
}

/** Ask re-quote in USD per option unit; null once expired/unquotable. */
async function requoteUsd(fill) {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (nowSec >= fill.expiry) return null;
  try {
    const [spot, sigma] = await Promise.all([spotWad(), sigmaWad(fill.expiry, nowSec)]);
    const premiumWad = await client.readContract({
      address: ENGINE, abi: ENGINE_ABI, functionName: "quote",
      args: [{ spot, strike: fill.strike, expiry: fill.expiry, sigmaGlobal: sigma, alpha: ALPHA, isBuy: true }],
    });
    return Number(premiumWad) / 1e18;
  } catch (e) {
    console.error(`requote failed for ${fill.txHash}: ${e.shortMessage ?? e.message}`);
    return null;
  }
}

const fmt = (v) => (v === null ? "" : v.toFixed(4));

async function trackFill(fill) {
  const quotes = [];
  for (const intervalSec of INTERVALS) {
    const dueMs = (fill.fillTime + intervalSec) * 1000 - Date.now();
    if (dueMs > 0) await new Promise((r) => setTimeout(r, dueMs));
    quotes.push(await requoteUsd(fill));
  }
  const markouts = quotes.map((q) => (q === null ? null : fill.tradePerUnitUsd - q));
  appendFileSync(
    OUT,
    [
      fill.txHash, fill.fillTime, fill.authId, fill.optionToken,
      Number(fill.strike) / 1e18, Number(fill.amount) / 1e18, "ask",
      fill.tradePerUnitUsd.toFixed(4),
      ...quotes.map(fmt), ...markouts.map(fmt),
    ].join(",") + "\n"
  );
  const last = markouts[markouts.length - 1];
  console.log(
    `fill ${fill.txHash.slice(0, 10)} K=${Number(fill.strike) / 1e18} ` +
      `paid=$${fill.tradePerUnitUsd.toFixed(2)}/unit → markouts [${markouts.map(fmt).join(", ")}] ` +
      (last !== null && last < 0 ? "⚠ LP lost" : "")
  );
}

async function main() {
  const state = loadState();
  if (!state.fromBlock) state.fromBlock = Number(await client.getBlockNumber());
  console.log(`watching OptionBought on ${VAULT} from block ${state.fromBlock} (intervals: ${INTERVALS.join("/")}s)`);

  for (;;) {
    const latest = Number(await client.getBlockNumber());
    if (latest >= state.fromBlock) {
      const logs = await client.getContractEvents({
        address: VAULT, abi: EVENTS_ABI, eventName: "OptionBought",
        fromBlock: BigInt(state.fromBlock), toBlock: BigInt(latest),
      });
      for (const log of logs) {
        const { authId, optionToken, strike, amount, premium } = log.args;
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        const [, , , expiry] = await client.readContract({
          address: VAULT, abi: VAULT_ABI, functionName: "authorizations", args: [authId],
        });
        const fill = {
          txHash: log.transactionHash,
          fillTime: Number(block.timestamp),
          authId: Number(authId),
          optionToken, strike, amount, expiry,
          // premium is 6-dec USDC for the whole fill; per-unit in USD:
          tradePerUnitUsd: (Number(premium) / 1e6) / (Number(amount) / 1e18),
        };
        trackFill(fill); // deliberately not awaited — fills track concurrently
      }
      state.fromBlock = latest + 1;
      saveState(state);
    }
    await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
