#!/usr/bin/env node
// S13 margin keeper — the permissionless half of MarginVault (Part B of
// docs/plans/2026-09-05-aqua.md).
//
// Anyone can run this against any key: every call it makes is open to the
// public and paid for by the vault (flagger slice, keeper tip). It watches
// every series the vault has minted and drives the lifecycle:
//
//   for each open position:      health() below MM  → flag()
//   for each flagged position:   grace over          → startAuction()
//   for each auctioned position: window over         → absorb()
//   for each expired series:     settle the price     → settleWithChainlinkRound()
//                                every writer         → settlePosition()
//                                all settled / +6h    → finalizeSeries()
//
// Usage:
//   cd keeper && npm install
//   RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY=0x… MARGIN_VAULT=0x… \
//     MARGIN_SETTLEMENT=0x… ORACLE=0x… npm run margin
//
// Env:
//   RPC_URL            RPC endpoint                    (default http://127.0.0.1:8545)
//   PRIVATE_KEY        keeper key                      (required)
//   MARGIN_VAULT       MarginVault                     (required)
//   MARGIN_SETTLEMENT  the vault's AquaOptionSettlement (required)
//   ORACLE             Chainlink-shaped feed           (required)
//   FROM_BLOCK         first block to scan for fills   (default 0)
//   POLL_SEC           cadence                         (default 30)
//   ONCE               "1" = one pass, then exit

import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = (k, d) => process.env[k] ?? d;
const requireEnv = (k) => { const v = process.env[k]; if (!v) { console.error(`missing required env ${k}`); process.exit(1); } return v; };

const RPC_URL = env("RPC_URL", "http://127.0.0.1:8545");
const MV = requireEnv("MARGIN_VAULT");
const SETTLEMENT = requireEnv("MARGIN_SETTLEMENT");
const ORACLE = requireEnv("ORACLE");
const FROM_BLOCK = BigInt(env("FROM_BLOCK", "0"));
const POLL_SEC = Number(env("POLL_SEC", "30"));
const ONCE = env("ONCE", "") === "1";

const account = privateKeyToAccount(requireEnv("PRIVATE_KEY"));
const pub = createPublicClient({ transport: http(RPC_URL) });
const wallet = createWalletClient({ account, transport: http(RPC_URL) });

const MV_ABI = parseAbi([
  "event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium)",
  "event TakenOver(bytes32 indexed sid, address indexed writer, address indexed bidder, uint256 units, uint256 moved, uint256 bonus, uint256 penalty, uint256 posted)",
  "event Absorbed(bytes32 indexed sid, address indexed writer, uint256 units, uint256 moved, uint256 drawn, uint256 tip, uint256 penalty)",
  "function ranges(uint256) view returns (address lp, uint256 strikeMin, uint256 strikeMax, uint256 expiry, uint256 maxCapacity, bool active, bool autoTopUp, uint16 lpMarginBps, uint16 sigmaMulBps, bytes32 strategyHash, uint32 feeBps, int256 beta, uint16 spotStaleness)",
  "function seriesId(uint256 strike, uint256 expiry) pure returns (bytes32)",
  "function seriesOf(bytes32) view returns (uint256 strike, uint256 expiry, address token, uint256 totalUnits, uint256 positionCount, uint256 settledPositions, uint256 owedTotal, uint256 pot, uint256 backstopDrawn, bool finalized, uint256 payoutPerUnit, uint16 haircutBps)",
  "function positions(bytes32, address) view returns (uint256 authId, uint256 units, uint256 locked, uint64 flaggedAt, uint64 auctionStart, address flagger)",
  "function health(bytes32 sid, address writer) view returns (uint256 locked, uint256 mm, uint256 im)",
  "function isCovered(bytes32 sid, address writer) view returns (bool)",
  "function backstop() view returns (address)",
  "function GRACE() view returns (uint256)",
  "function AUCTION_LENGTH() view returns (uint256)",
  "function FINALIZE_GRACE() view returns (uint256)",
  "function flag(bytes32 sid, address writer)",
  "function startAuction(bytes32 sid, address writer)",
  "function absorb(bytes32 sid, address writer) returns (uint256)",
  "function settlePosition(bytes32 sid, address writer)",
  "function finalizeSeries(bytes32 sid)",
]);
const SETTLEMENT_ABI = parseAbi([
  "function series(bytes32) view returns (address optionToken, uint256 expiry, uint256 strike, bool isCall, bool settled, uint256 settlementPrice)",
  "function settleWithChainlinkRound(bytes32 seriesId, uint80 roundId)",
]);
const ORACLE_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80, int256, uint256, uint256 updatedAt, uint80)",
]);

const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
async function send(label, address, abi, functionName, args) {
  try {
    const hash = await wallet.writeContract({ address, abi, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`${label}: ${hash.slice(0, 18)}… ${r.status}`);
    return r.status === "success";
  } catch (e) {
    console.log(`${label}: skipped — ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
    return false;
  }
}

/// (sid → set of writers) from every fill and every takeover/absorb so far.
async function discover() {
  const [bought, taken, absorbed] = await Promise.all([
    pub.getLogs({ address: MV, event: parseAbiItem("event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium)"), fromBlock: FROM_BLOCK }),
    pub.getLogs({ address: MV, event: parseAbiItem("event TakenOver(bytes32 indexed sid, address indexed writer, address indexed bidder, uint256 units, uint256 moved, uint256 bonus, uint256 penalty, uint256 posted)"), fromBlock: FROM_BLOCK }),
    pub.getLogs({ address: MV, event: parseAbiItem("event Absorbed(bytes32 indexed sid, address indexed writer, uint256 units, uint256 moved, uint256 drawn, uint256 tip, uint256 penalty)"), fromBlock: FROM_BLOCK }),
  ]);
  const writers = new Map();
  const add = (sid, w) => { if (!writers.has(sid)) writers.set(sid, new Set()); writers.get(sid).add(w.toLowerCase()); };
  for (const l of bought) {
    const r = await read(MV, MV_ABI, "ranges", [l.args.authId]);
    const sid = await read(MV, MV_ABI, "seriesId", [l.args.strike, r[3]]);
    add(sid, r[0]);
  }
  for (const l of taken) add(l.args.sid, l.args.bidder);
  const backstop = await read(MV, MV_ABI, "backstop");
  for (const l of absorbed) add(l.args.sid, backstop);
  return writers;
}

/// First Chainlink round at/after `expiry` — the round settlement accepts.
async function roundCovering(expiry) {
  let [id, , , updatedAt] = await read(ORACLE, ORACLE_ABI, "latestRoundData");
  if (updatedAt < expiry) return null;
  while (id > 0n) {
    try {
      const [, , , prevAt] = await read(ORACLE, ORACLE_ABI, "getRoundData", [id - 1n]);
      if (prevAt < expiry) return id;
      id -= 1n;
    } catch { return id; }
  }
  return id;
}

async function pass() {
  const now = BigInt((await pub.getBlock()).timestamp);
  const [grace, auctionLen, finalizeGrace] = await Promise.all([
    read(MV, MV_ABI, "GRACE"), read(MV, MV_ABI, "AUCTION_LENGTH"), read(MV, MV_ABI, "FINALIZE_GRACE"),
  ]);
  const writers = await discover();
  for (const [sid, ws] of writers) {
    const s = await read(MV, MV_ABI, "seriesOf", [sid]);
    const [strike, expiry, , totalUnits, positionCount, , , , , finalized] = s;
    if (finalized) continue;
    const tag = `${sid.slice(0, 10)}… K=${Number(strike) / 1e18}`;

    if (now < expiry) {
      for (const w of ws) {
        const p = await read(MV, MV_ABI, "positions", [sid, w]);
        const [, units, , flaggedAt, auctionStart] = p;
        if (units === 0n) continue;
        if (auctionStart > 0n) {
          if (now >= auctionStart + auctionLen) await send(`absorb ${tag} ${w.slice(0, 8)}`, MV, MV_ABI, "absorb", [sid, w]);
        } else if (flaggedAt > 0n) {
          if (now >= flaggedAt + grace) await send(`startAuction ${tag} ${w.slice(0, 8)}`, MV, MV_ABI, "startAuction", [sid, w]);
        } else {
          const [locked, mm] = await read(MV, MV_ABI, "health", [sid, w]);
          const covered = await read(MV, MV_ABI, "isCovered", [sid, w]);
          if (locked < mm && !covered) await send(`flag ${tag} ${w.slice(0, 8)} (locked ${Number(locked) / 1e6} < MM ${Number(mm) / 1e6})`, MV, MV_ABI, "flag", [sid, w]);
        }
      }
      continue;
    }

    // Expired: settle the price, then every writer, then the series.
    const reg = await read(SETTLEMENT, SETTLEMENT_ABI, "series", [sid]);
    if (!reg[4]) {
      const round = await roundCovering(expiry);
      if (round === null) { console.log(`${tag}: waiting for a Chainlink round after expiry`); continue; }
      if (!(await send(`settle ${tag} round ${round}`, SETTLEMENT, SETTLEMENT_ABI, "settleWithChainlinkRound", [sid, round]))) continue;
    }
    for (const w of ws) {
      const [, units] = await read(MV, MV_ABI, "positions", [sid, w]);
      if (units > 0n) await send(`settlePosition ${tag} ${w.slice(0, 8)}`, MV, MV_ABI, "settlePosition", [sid, w]);
    }
    const [, , , , count] = await read(MV, MV_ABI, "seriesOf", [sid]);
    if (count === 0n || now >= expiry + finalizeGrace) {
      if (totalUnits > 0n) await send(`finalizeSeries ${tag}`, MV, MV_ABI, "finalizeSeries", [sid]);
    } else {
      console.log(`${tag}: ${count} writer(s) unsettled; finalizing at expiry + 6h regardless`);
    }
  }
}

console.log(`margin keeper ${account.address} watching ${MV} on ${RPC_URL}`);
for (;;) {
  try { await pass(); } catch (e) { console.error("pass failed:", e.shortMessage ?? e.message); }
  if (ONCE) break;
  await new Promise((r) => setTimeout(r, POLL_SEC * 1000));
}
