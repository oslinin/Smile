#!/usr/bin/env node
// S9 auto-roll keeper (docs/solutions.md) — the second half of One-Click Income.
//
// SELF-CUSTODIAL BY DESIGN: rolling a range requires the LP's signature, so
// this keeper is a script the LP runs with their OWN key — nobody else can
// roll (or touch) their position. It is the automation a covered-call writer
// would otherwise do by hand every expiry:
//
//   while true:
//     if my range expired:
//       1. settle each minted series permissionlessly (find the Chainlink
//          round covering expiry — anyone may do this)
//       2. reclaimCollateral() for whatever is not owed to holders
//       3. revokeAuthorization() (frees the range, refunds any S2 bond)
//       4. authorize + Aqua.ship() a fresh range at the SAME delta band and
//          tenor, at TODAY's spot — premium keeps compounding
//     sleep POLL_SEC
//
// Usage:
//   cd keeper && npm install
//   RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY=0x… VAULT=0x… SETTLEMENT=0x… \
//     ORACLE=0x… AQUA=0x… WETH=0x… USDC=0x… npm run roll
//
// Env:
//   RPC_URL      RPC endpoint                  (default http://127.0.0.1:8545)
//   PRIVATE_KEY  the LP's key — never leaves this machine     (required)
//   VAULT        AquaCollateralVault                          (required)
//   SETTLEMENT   AquaOptionSettlement                         (required)
//   ORACLE       Chainlink-shaped spot feed                   (required)
//   AQUA         official 1inch Aqua registry                 (required)
//   WETH / USDC  token addresses                              (required)
//   HOOK         OptionPricingHook σ source     (optional; 0.8 fallback)
//   SIDE         call | put                     (default call)
//   DELTA_BAND   delta band, e.g. "0.20,0.30"   (default 0.20,0.30)
//   TENOR_DAYS   days per cycle                 (default 30)
//   COLLATERAL   human units — WETH for calls, USDC for puts  (default 1.0)
//   POLL_SEC     check cadence                  (default 60)
//   STATE        checkpoint file                (default roll-state.json)

import { createPublicClient, createWalletClient, http, parseAbi, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const env = (k, d) => process.env[k] ?? d;
const requireEnv = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing required env ${k}`); process.exit(1); }
  return v;
};

const RPC_URL    = env("RPC_URL", "http://127.0.0.1:8545");
const VAULT      = requireEnv("VAULT");
const SETTLEMENT = requireEnv("SETTLEMENT");
const ORACLE     = requireEnv("ORACLE");
const AQUA       = requireEnv("AQUA");
const WETH       = requireEnv("WETH");
const USDC       = requireEnv("USDC");
const HOOK       = env("HOOK", "");
const IS_CALL    = env("SIDE", "call") !== "put";
const [D_LO, D_HI] = env("DELTA_BAND", "0.20,0.30").split(",").map(Number);
const TENOR_DAYS = Number(env("TENOR_DAYS", "30"));
const COLLATERAL = Number(env("COLLATERAL", "1.0"));
const POLL_SEC   = Number(env("POLL_SEC", "60"));
const STATE      = env("STATE", "roll-state.json");

const account = privateKeyToAccount(requireEnv("PRIVATE_KEY"));
const pub = createPublicClient({ transport: http(RPC_URL) });
const wallet = createWalletClient({ account, transport: http(RPC_URL) });

const VAULT_ABI = parseAbi([
  "function authorizeRange(uint256 strikeMin, uint256 strikeMax, uint256 expiry, uint256 maxCollateral, address collateralToken, address premiumToken, bool isCall) returns (uint256)",
  "function nextAuthId() view returns (uint256)",
  "function getShipParams(uint256 authId) view returns (address app, bytes strategy, address[] tokens, uint256[] amounts)",
  "function revokeAuthorization(uint256 authId)",
  "function reclaimCollateral(address optionToken) returns (uint256)",
  "event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium)",
]);
const SETTLEMENT_ABI = parseAbi([
  "function settleWithChainlinkRound(bytes32 seriesId, uint80 roundId)",
]);
const AQUA_ABI = parseAbi([
  "function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)",
]);
const ORACLE_ABI = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
]);
const HOOK_ABI = parseAbi(["function sigmaFor(uint256) view returns (uint256)"]);
const ERC20_ABI = parseAbi([
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
]);

// ── the same smile math the contracts and frontend use ──────────────────────
const ALPHA = 2.0;
function smileSigma(spot, strike, sigmaTenor) {
  const lnKS = Math.log(strike / spot);
  return sigmaTenor * Math.max(0.1, 1 + ALPHA * lnKS * lnKS);
}
function normCdf(x) {
  const b = [0.31938153, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (b[0] + t * (b[1] + t * (b[2] + t * (b[3] + t * b[4]))));
  const nd = (1 / Math.sqrt(2 * Math.PI)) * Math.exp((-x * x) / 2) * poly;
  return x >= 0 ? 1 - nd : nd;
}
function absDelta(spot, strike, tYears, sigmaTenor, isCall) {
  const sigma = smileSigma(spot, strike, sigmaTenor);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * tYears) / (sigma * Math.sqrt(tYears));
  return isCall ? normCdf(d1) : normCdf(-d1);
}
function strikeForDelta(spot, target, tYears, sigmaTenor, isCall) {
  let near = spot, far = isCall ? spot * 3 : spot * 0.2;
  for (let i = 0; i < 60; i++) {
    const mid = (near + far) / 2;
    if (absDelta(spot, mid, tYears, sigmaTenor, isCall) > target) near = mid;
    else far = mid;
  }
  return Math.max(50, Math.round((near + far) / 2 / 50) * 50);
}

// ── chain helpers ────────────────────────────────────────────────────────────
async function tx(request) {
  const hash = await wallet.writeContract(request);
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

async function spotUsd() {
  const [, answer] = await pub.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "latestRoundData" });
  const dec = await pub.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "decimals" });
  return Number(answer) / 10 ** Number(dec);
}

async function sigmaTenor(tenorSec) {
  if (!HOOK) return 0.8;
  try {
    const s = await pub.readContract({ address: HOOK, abi: HOOK_ABI, functionName: "sigmaFor", args: [BigInt(tenorSec)] });
    return Number(s) / 1e18;
  } catch { return 0.8; }
}

/// First Chainlink round updated AT/AFTER `expiry` — walk back from latest.
/// Returns null while the feed hasn't published past expiry yet.
async function roundCovering(expiry) {
  let [roundId, , , updatedAt] = await pub.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "latestRoundData" });
  if (Number(updatedAt) < expiry) return null;
  let candidate = roundId;
  while (roundId > 0n) {
    roundId -= 1n;
    try {
      const [, , , prevUpdated] = await pub.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "getRoundData", args: [roundId] });
      if (Number(prevUpdated) === 0 || Number(prevUpdated) < expiry) break;
      candidate = roundId;
    } catch { break; }
  }
  return candidate;
}

async function ensureApproval(token) {
  const allowance = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [account.address, AQUA] });
  if (allowance < 2n ** 200n) {
    await tx({ address: token, abi: ERC20_ABI, functionName: "approve", args: [AQUA, 2n ** 256n - 1n], account });
    console.log(`approved Aqua for ${token}`);
  }
}

// ── the roll cycle ───────────────────────────────────────────────────────────
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { authId: null, expiry: 0, fromBlock: "0" });
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

async function openRange(state) {
  const spot = await spotUsd();
  const tenorSec = Math.round(TENOR_DAYS * 86_400);
  const sigma = await sigmaTenor(tenorSec);
  const t = TENOR_DAYS / 365;
  const kA = strikeForDelta(spot, D_HI, t, sigma, IS_CALL);
  const kB = strikeForDelta(spot, D_LO, t, sigma, IS_CALL);
  const [kMin, kMax] = kA <= kB ? [kA, kB] : [kB, kA];
  const expiry = Math.floor(Date.now() / 1000) + tenorSec;

  const collateralToken = IS_CALL ? WETH : USDC;
  const maxCollateral = IS_CALL
    ? BigInt(Math.round(COLLATERAL * 1e18))
    : BigInt(Math.round(COLLATERAL * 1e6));

  await ensureApproval(collateralToken);
  await ensureApproval(USDC); // premium-token pulls (fees, sellbacks)

  const authId = await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: "nextAuthId" });
  await tx({
    address: VAULT, abi: VAULT_ABI, functionName: "authorizeRange",
    args: [BigInt(kMin) * 10n ** 18n, BigInt(kMax) * 10n ** 18n, BigInt(expiry), maxCollateral, collateralToken, USDC, IS_CALL],
    account,
  });
  const [app, strategy, tokens, amounts] = await pub.readContract({
    address: VAULT, abi: VAULT_ABI, functionName: "getShipParams", args: [authId],
  });
  await tx({ address: AQUA, abi: AQUA_ABI, functionName: "ship", args: [app, strategy, tokens, amounts], account });

  state.authId = authId.toString();
  state.expiry = expiry;
  state.fromBlock = (await pub.getBlockNumber()).toString();
  saveState(state);
  console.log(`[roll] shipped ${IS_CALL ? "covered-call" : "cash-secured-put"} range auth=${authId} $${kMin}–$${kMax} exp=${new Date(expiry * 1000).toISOString()} (${(D_LO * 100) | 0}–${(D_HI * 100) | 0}Δ @ spot $${spot.toFixed(0)})`);
}

async function settleAndUnwind(state) {
  const authId = BigInt(state.authId);
  const round = await roundCovering(state.expiry);
  if (round === null) {
    console.log(`[roll] auth=${state.authId} expired; waiting for a post-expiry oracle round…`);
    return false;
  }

  // Every series this range minted — from its OptionBought logs.
  const logs = await pub.getContractEvents({
    address: VAULT, abi: VAULT_ABI, eventName: "OptionBought",
    args: { authId }, fromBlock: BigInt(state.fromBlock), toBlock: "latest",
  });
  const series = new Map(); // strike → optionToken
  for (const log of logs) series.set(log.args.strike.toString(), log.args.optionToken);

  for (const [strike, optionToken] of series) {
    const seriesId = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }], [authId, BigInt(strike)],
    ));
    try {
      await tx({ address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: "settleWithChainlinkRound", args: [seriesId, round], account });
      console.log(`[roll] settled series strike=$${Number(strike) / 1e18}`);
    } catch { /* already settled by someone else — permissionless, that's fine */ }
    try {
      await tx({ address: VAULT, abi: VAULT_ABI, functionName: "reclaimCollateral", args: [optionToken], account });
      console.log(`[roll] reclaimed collateral for strike=$${Number(strike) / 1e18}`);
    } catch { /* nothing to reclaim (fully owed to holders, or already taken) */ }
  }

  try {
    await tx({ address: VAULT, abi: VAULT_ABI, functionName: "revokeAuthorization", args: [authId], account });
  } catch { /* already revoked */ }
  console.log(`[roll] auth=${state.authId} unwound (${series.size} series)`);
  return true;
}

async function main() {
  console.log(`[roll] S9 auto-roller · LP ${account.address} · ${IS_CALL ? "covered calls" : "cash-secured puts"} · ${(D_LO * 100) | 0}–${(D_HI * 100) | 0}Δ · ${TENOR_DAYS}d · ${COLLATERAL} ${IS_CALL ? "WETH" : "USDC"}`);
  const state = loadState();
  if (state.authId === null) await openRange(state);

  for (;;) {
    try {
      const now = Math.floor(Date.now() / 1000);
      if (state.authId !== null && now >= state.expiry) {
        const unwound = await settleAndUnwind(state);
        if (unwound) {
          state.authId = null;
          saveState(state);
          await openRange(state); // the roll
        }
      }
    } catch (e) {
      console.error(`[roll] cycle error: ${e.shortMessage ?? e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
  }
}

main();
