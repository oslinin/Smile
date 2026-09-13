// The tape: every range, instrument, fill and position, in one shape, from
// one of two sources —
//   "subgraph"   — The Graph (Sepolia, Arc, or an explicit URL). The only
//                  source on public networks: no RPC scan exists there.
//   "anvil-logs" — the same entities rebuilt from eth_getLogs, for the local
//                  Anvil chain only (this VPS is arm64; graph-node has no
//                  arm64 image). Gated on chain id 31337/1337.
// Every result carries its `source` so the copilot can say where the data
// came from. Numbers are plain USD / option units; premium token is USDC
// (6 decimals) on every deployment.

import { parseAbiItem, type Address, type PublicClient } from "viem";
import {
  fetchActiveAuthorizations,
  fetchFills,
  fetchInstruments,
  fetchPositionsByHolder,
  isLocalChain,
  subgraphUrlFor,
} from "@/lib/subgraph";

const WAD = 1e18;
const USDC = 1e6;

export type TapeSource = "subgraph" | "anvil-logs";

export interface TapeAuth {
  authId: number;
  lp: string;
  strikeMin: number;
  strikeMax: number;
  expiry: number;
  isCall: boolean;
  collateralToken: string;
  maxCollateral: number; // WETH for calls, USDC for puts
  usedCollateral: number;
  active: boolean;
  fillCount: number;
  createdAt: number;
}

export interface TapeInstrument {
  optionToken: string;
  authId: number;
  lp: string;
  strike: number;
  expiry: number;
  isCall: boolean;
  openInterest: number;
  volume: number;
  fillCount: number;
  lastPremiumPerUnit: number; // USD per option unit, fee included
  lastTradeAt: number;
}

export interface TapeFill {
  id: string;
  authId: number;
  optionToken: string;
  lp: string;
  buyer: string;
  strike: number;
  expiry: number;
  isCall: boolean;
  amount: number;
  premiumUsd: number;
  premiumPerUnit: number;
  timestamp: number;
  blockNumber: number;
}

export interface TapePosition {
  holder: string;
  optionToken: string;
  authId: number;
  lp: string;
  strike: number;
  expiry: number;
  isCall: boolean;
  balance: number;
}

export interface Tape {
  source: TapeSource;
  auths: TapeAuth[]; // active only
  instruments: TapeInstrument[];
  fills: TapeFill[];
}

export interface TapeOpts {
  chainId?: number;
  /** Required for the Anvil path; unused on the subgraph path. */
  client?: PublicClient;
  vault?: Address;
  /** Only fills at or after this unix time (subgraph path). Default: all. */
  since?: number;
}

const authDecimals = (isCall: boolean) => (isCall ? WAD : USDC);

// ── subgraph path ───────────────────────────────────────────────────────────

async function tapeFromSubgraph(url: string, since: number): Promise<Tape> {
  const [auths, instruments, fills] = await Promise.all([
    fetchActiveAuthorizations(url),
    fetchInstruments(url),
    fetchFills(url, since),
  ]);
  return {
    source: "subgraph",
    auths: auths.map((a) => ({
      authId: Number(a.authId),
      lp: a.lp,
      strikeMin: Number(a.strikeMin) / WAD,
      strikeMax: Number(a.strikeMax) / WAD,
      expiry: Number(a.expiry),
      isCall: a.isCall,
      collateralToken: a.collateralToken,
      maxCollateral: Number(a.maxCollateral) / authDecimals(a.isCall),
      usedCollateral: Number(a.usedCollateral) / authDecimals(a.isCall),
      active: a.active,
      fillCount: a.fillCount,
      createdAt: Number(a.createdAtTimestamp),
    })),
    instruments: instruments.map((i) => ({
      optionToken: i.id,
      authId: Number(i.authorization.id),
      lp: i.lp,
      strike: Number(i.strike) / WAD,
      expiry: Number(i.expiry),
      isCall: i.isCall,
      openInterest: Number(i.openInterest) / WAD,
      volume: Number(i.volume) / WAD,
      fillCount: i.fillCount,
      lastPremiumPerUnit: Number(i.lastPremiumPerUnit) / USDC,
      lastTradeAt: Number(i.lastTradeAt),
    })),
    fills: fills.map((f) => ({
      id: f.id,
      authId: Number(f.authorization.id),
      optionToken: f.optionToken,
      lp: f.lp,
      buyer: f.buyer,
      strike: Number(f.strike) / WAD,
      expiry: Number(f.expiry),
      isCall: f.isCall,
      amount: Number(f.amount) / WAD,
      premiumUsd: Number(f.premium) / USDC,
      premiumPerUnit: Number(f.amount) > 0 ? Number(f.premium) / USDC / (Number(f.amount) / WAD) : 0,
      timestamp: Number(f.timestamp),
      blockNumber: Number(f.blockNumber),
    })),
  };
}

async function positionsFromSubgraph(url: string, holder: string): Promise<TapePosition[]> {
  const rows = await fetchPositionsByHolder(holder, url);
  return rows.map((p) => ({
    holder: p.holder,
    optionToken: p.optionToken,
    authId: Number(p.instrument.authorization.id),
    lp: p.instrument.lp,
    strike: Number(p.instrument.strike) / WAD,
    expiry: Number(p.instrument.expiry),
    isCall: p.instrument.isCall,
    balance: Number(p.balance) / WAD,
  }));
}

// ── Anvil path: the same entities from the vault's events ───────────────────

const EV_RANGE = parseAbiItem(
  "event RangeAuthorized(uint256 indexed authId, address indexed lp, uint256 strikeMin, uint256 strikeMax, uint256 expiry, bool isCall, uint256 maxCollateral)"
);
const EV_REVOKED = parseAbiItem("event AuthorizationRevoked(uint256 indexed authId)");
const EV_BOUGHT = parseAbiItem(
  "event OptionBought(uint256 indexed authId, address indexed optionToken, address indexed buyer, uint256 strike, uint256 amount, uint256 premium)"
);
const EV_CLOSED = parseAbiItem("event OptionClosed(address indexed optionToken, address indexed holder, uint256 amount)");
const EV_REDEEMED = parseAbiItem(
  "event Redeemed(address indexed optionToken, address indexed holder, uint256 amount, uint256 payout)"
);
const EV_PULL_FAILED = parseAbiItem(
  "event PullFailed(uint256 indexed authId, address indexed lp, address indexed buyer, uint256 compensation)"
);
const AUTH_GETTER = [
  {
    name: "authorizations",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }],
    outputs: [
      { name: "lp", type: "address" },
      { name: "strikeMin", type: "uint256" },
      { name: "strikeMax", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "maxCollateral", type: "uint256" },
      { name: "usedCollateral", type: "uint256" },
      { name: "collateralToken", type: "address" },
      { name: "isCall", type: "bool" },
      { name: "active", type: "bool" },
    ],
  },
] as const;

interface AnvilState {
  tape: Tape;
  positions: Map<string, TapePosition>; // key optionToken-holder
}

async function stateFromLogs(client: PublicClient, vault: Address): Promise<AnvilState> {
  const range = { address: vault, fromBlock: BigInt(0), toBlock: "latest" as const };
  const [ranges, revoked, bought, closed, redeemed, pullFailed] = await Promise.all([
    client.getLogs({ ...range, event: EV_RANGE }),
    client.getLogs({ ...range, event: EV_REVOKED }),
    client.getLogs({ ...range, event: EV_BOUGHT }),
    client.getLogs({ ...range, event: EV_CLOSED }),
    client.getLogs({ ...range, event: EV_REDEEMED }),
    client.getLogs({ ...range, event: EV_PULL_FAILED }),
  ]);
  const blockTs = new Map<bigint, number>();
  const tsOf = async (bn: bigint) => {
    const hit = blockTs.get(bn);
    if (hit !== undefined) return hit;
    const b = await client.getBlock({ blockNumber: bn });
    blockTs.set(bn, Number(b.timestamp));
    return Number(b.timestamp);
  };

  // Ranges: live fields (usedCollateral, active) come from the getter, the
  // same way the subgraph's bound call does it.
  const inactive = new Set([...revoked, ...pullFailed].map((l) => Number(l.args.authId)));
  const auths: TapeAuth[] = [];
  for (const l of ranges) {
    const authId = Number(l.args.authId);
    const row = await client.readContract({ address: vault, abi: AUTH_GETTER, functionName: "authorizations", args: [BigInt(authId)] });
    const [lp, strikeMin, strikeMax, expiry, maxCollateral, usedCollateral, collateralToken, isCall, active] = row;
    if (!active || inactive.has(authId)) continue;
    auths.push({
      authId,
      lp,
      strikeMin: Number(strikeMin) / WAD,
      strikeMax: Number(strikeMax) / WAD,
      expiry: Number(expiry),
      isCall,
      collateralToken,
      maxCollateral: Number(maxCollateral) / authDecimals(isCall),
      usedCollateral: Number(usedCollateral) / authDecimals(isCall),
      active,
      fillCount: 0,
      createdAt: await tsOf(l.blockNumber),
    });
  }
  const authMeta = new Map<number, { lp: string; expiry: number; isCall: boolean }>();
  for (const l of ranges) {
    authMeta.set(Number(l.args.authId), { lp: l.args.lp as string, expiry: Number(l.args.expiry), isCall: l.args.isCall as boolean });
  }
  const byAuth = new Map(auths.map((a) => [a.authId, a]));

  const instruments = new Map<string, TapeInstrument>();
  const positions = new Map<string, TapePosition>();
  const fills: TapeFill[] = [];
  for (const l of bought) {
    const authId = Number(l.args.authId);
    const meta = authMeta.get(authId);
    if (!meta) continue;
    const token = (l.args.optionToken as string).toLowerCase();
    const buyer = (l.args.buyer as string).toLowerCase();
    const amount = Number(l.args.amount) / WAD;
    const premiumUsd = Number(l.args.premium) / USDC;
    const ts = await tsOf(l.blockNumber);
    const strike = Number(l.args.strike) / WAD;
    const inst = instruments.get(token) ?? {
      optionToken: token,
      authId,
      lp: meta.lp,
      strike,
      expiry: meta.expiry,
      isCall: meta.isCall,
      openInterest: 0,
      volume: 0,
      fillCount: 0,
      lastPremiumPerUnit: 0,
      lastTradeAt: 0,
    };
    inst.openInterest += amount;
    inst.volume += amount;
    inst.fillCount += 1;
    inst.lastPremiumPerUnit = amount > 0 ? premiumUsd / amount : inst.lastPremiumPerUnit;
    inst.lastTradeAt = ts;
    instruments.set(token, inst);
    const pk = `${token}-${buyer}`;
    const pos = positions.get(pk) ?? { holder: buyer, optionToken: token, authId, lp: meta.lp, strike, expiry: meta.expiry, isCall: meta.isCall, balance: 0 };
    pos.balance += amount;
    positions.set(pk, pos);
    const a = byAuth.get(authId);
    if (a) a.fillCount += 1;
    fills.push({
      id: `${l.transactionHash}-${l.logIndex}`,
      authId,
      optionToken: token,
      lp: meta.lp,
      buyer,
      strike,
      expiry: meta.expiry,
      isCall: meta.isCall,
      amount,
      premiumUsd,
      premiumPerUnit: amount > 0 ? premiumUsd / amount : 0,
      timestamp: ts,
      blockNumber: Number(l.blockNumber),
    });
  }
  for (const l of [...closed, ...redeemed]) {
    const token = (l.args.optionToken as string).toLowerCase();
    const holder = (l.args.holder as string).toLowerCase();
    const amount = Number(l.args.amount) / WAD;
    const inst = instruments.get(token);
    if (inst) inst.openInterest = Math.max(0, inst.openInterest - amount);
    const pos = positions.get(`${token}-${holder}`);
    if (pos) pos.balance = Math.max(0, pos.balance - amount);
  }
  fills.sort((a, b) => a.timestamp - b.timestamp);
  return {
    tape: { source: "anvil-logs", auths, instruments: [...instruments.values()], fills },
    positions,
  };
}

// ── public API ──────────────────────────────────────────────────────────────

export class SubgraphRequiredError extends Error {
  constructor(chainId?: number) {
    super(`No subgraph configured for chain ${chainId ?? "unknown"} — on public networks The Graph is the only position source (no RPC scan exists).`);
  }
}

/** Ranges, instruments and fills for the chain. Subgraph on public chains, event logs on Anvil. */
export async function readTape(opts: TapeOpts): Promise<Tape> {
  const url = subgraphUrlFor(opts.chainId);
  if (url) return tapeFromSubgraph(url, opts.since ?? 0);
  if (isLocalChain(opts.chainId) && opts.client && opts.vault) return (await stateFromLogs(opts.client, opts.vault)).tape;
  throw new SubgraphRequiredError(opts.chainId);
}

/** A wallet's long option positions (balance > 0). */
export async function readPositions(holder: string, opts: TapeOpts): Promise<{ source: TapeSource; positions: TapePosition[] }> {
  const url = subgraphUrlFor(opts.chainId);
  if (url) return { source: "subgraph", positions: await positionsFromSubgraph(url, holder) };
  if (isLocalChain(opts.chainId) && opts.client && opts.vault) {
    const st = await stateFromLogs(opts.client, opts.vault);
    const h = holder.toLowerCase();
    return { source: "anvil-logs", positions: [...st.positions.values()].filter((p) => p.holder === h && p.balance > 0) };
  }
  throw new SubgraphRequiredError(opts.chainId);
}
