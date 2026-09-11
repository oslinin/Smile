// Server-side on-chain reads for the copilot (the route handler runs in
// Node, so wagmi hooks don't apply). Reads the same public vault state the
// UI components read; wallet positions are public data keyed by the address
// the client sends. ABIs are re-declared minimally here — the existing
// components already inline their own copies per file.
//
// No multicall: a fresh Anvil chain has no Multicall3 deployment, so reads
// use bounded Promise.all fan-outs instead.

import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { CONTRACTS, contractsFor } from "@/config/wagmi";
import { ALPHA, SIGMA_GLOBAL } from "@/lib/options";
import {
  fetchActiveAuthorizations,
  fetchAuthorizationsByLp,
  isLocalChain,
  subgraphUrlFor,
  type SubgraphAuthorization,
} from "@/lib/subgraph";
import { readPositions, SubgraphRequiredError } from "@/lib/tape";

const WAD = 1e18;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const MAX_AUTHS = 50;
const MAX_STRIKES_PER_AUTH = 40;

const VAULT_ABI = [
  {
    name: "nextAuthId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
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
  {
    name: "optionTokens",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "authId", type: "uint256" },
      { name: "strike", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const PRICING_ENGINE_ABI = [
  {
    name: "quote",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "spot", type: "uint256" },
          { name: "strike", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "sigmaGlobal", type: "uint256" },
          { name: "alpha", type: "uint256" },
          { name: "isBuy", type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "premium", type: "uint256" }],
  },
] as const;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export function getPublicClient(chainId?: number): PublicClient {
  const url =
    chainId === 11155111
      ? process.env.COPILOT_RPC_SEPOLIA || "https://ethereum-sepolia-rpc.publicnode.com"
      : chainId === 5042002
        ? process.env.COPILOT_RPC_ARC || "https://rpc.testnet.arc.network" // Circle Arc testnet
        : "http://127.0.0.1:8545"; // Anvil (31337) / Hardhat (1337) local devnet
  return createPublicClient({ transport: http(url) });
}

export interface AuthSummary {
  authId: number;
  lp: string;
  strikeMin: number;
  strikeMax: number;
  expiry: number;
  expiresInDays: number;
  isCall: boolean;
  collateralToken: string;
  maxCollateral: number;
  usedCollateral: number;
  utilizationPct: number;
}

function fromSubgraph(r: SubgraphAuthorization, now: number): AuthSummary {
  const dec = r.isCall ? 1e18 : 1e6;
  const max = Number(r.maxCollateral) / dec;
  const used = Number(r.usedCollateral) / dec;
  return {
    authId: Number(r.authId),
    lp: r.lp,
    strikeMin: Number(r.strikeMin) / WAD,
    strikeMax: Number(r.strikeMax) / WAD,
    expiry: Number(r.expiry),
    expiresInDays: Math.round(((Number(r.expiry) - now) / 86400) * 10) / 10,
    isCall: r.isCall,
    collateralToken: r.collateralToken,
    maxCollateral: max,
    usedCollateral: used,
    utilizationPct: max > 0 ? Math.round((used / max) * 1000) / 10 : 0,
  };
}

export async function readAuths(
  client: PublicClient,
  opts?: { lp?: string; chainId?: number }
): Promise<AuthSummary[]> {
  // Server-side the module-level active chain isn't set by the page; resolve
  // addresses from the request's chain id.
  const vault = (opts?.chainId ? contractsFor(opts.chainId) : CONTRACTS).aquaVault as Address;
  if (!vault) return [];
  const now = Date.now() / 1000;

  // Indexed path: every authorization, one query, no MAX_AUTHS cap
  // (docs/limitations.md L12a). On a public network this is the only path —
  // the bounded RPC scan below exists for the local Anvil chain, where no
  // graph-node runs (plan P1: load-bearing in code, not wording).
  const url = subgraphUrlFor(opts?.chainId);
  if (url) {
    const rows = opts?.lp ? await fetchAuthorizationsByLp(opts.lp, url) : await fetchActiveAuthorizations(url);
    return rows.filter((r) => r.active).map((r) => fromSubgraph(r, now));
  }
  if (!isLocalChain(opts?.chainId)) throw new SubgraphRequiredError(opts?.chainId);

  const nextAuthId = Number(
    await client.readContract({ address: vault, abi: VAULT_ABI, functionName: "nextAuthId" })
  );
  const count = Math.min(nextAuthId, MAX_AUTHS);

  const rows = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      client.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "authorizations",
        args: [BigInt(i)],
      })
    )
  );

  const out: AuthSummary[] = [];
  rows.forEach((row, i) => {
    const [lp, strikeMin, strikeMax, expiry, maxCollateral, usedCollateral, collateralToken, isCall, active] = row;
    if (!active) return;
    if (opts?.lp && lp.toLowerCase() !== opts.lp.toLowerCase()) return;
    // Collateral: WETH (18 dec) backs calls, USDC (6 dec) backs puts.
    const dec = isCall ? 1e18 : 1e6;
    const max = Number(maxCollateral) / dec;
    const used = Number(usedCollateral) / dec;
    out.push({
      authId: i,
      lp,
      strikeMin: Number(strikeMin) / WAD,
      strikeMax: Number(strikeMax) / WAD,
      expiry: Number(expiry),
      expiresInDays: Math.round(((Number(expiry) - now) / 86400) * 10) / 10,
      isCall,
      collateralToken,
      maxCollateral: max,
      usedCollateral: used,
      utilizationPct: max > 0 ? Math.round((used / max) * 1000) / 10 : 0,
    });
  });
  return out;
}

export interface LongOptionPosition {
  authId: number;
  strike: number;
  isCall: boolean;
  expiry: number;
  expiresInDays: number;
  amount: number;
  optionToken: string;
}

export interface WalletPositions {
  /** Where the positions came from — the copilot cites it. */
  source: "subgraph" | "anvil-logs" | "rpc-scan";
  balances: { ethBalance: number; weth?: number; usdc?: number };
  lpAuths: AuthSummary[];
  longOptions: LongOptionPosition[];
}

export async function readWalletPositions(
  client: PublicClient,
  address: string,
  chainId?: number
): Promise<WalletPositions> {
  const vault = (chainId ? contractsFor(chainId) : CONTRACTS).aquaVault as Address;
  const user = address as Address;

  const [ethWei, auths] = await Promise.all([
    client.getBalance({ address: user }),
    readAuths(client, { chainId }),
  ]);

  const balances: WalletPositions["balances"] = { ethBalance: Number(ethWei) / WAD };
  const weth = process.env.NEXT_PUBLIC_WETH_ADDRESS as Address | undefined;
  const usdc = process.env.NEXT_PUBLIC_USDC_ADDRESS as Address | undefined;
  const erc20Balance = (token: Address) =>
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [user] });
  if (weth) balances.weth = Number(await erc20Balance(weth).catch(() => BigInt(0))) / 1e18;
  if (usdc) balances.usdc = Number(await erc20Balance(usdc).catch(() => BigInt(0))) / 1e6;

  // Long options: the Position entity (subgraph) or the event-rebuilt tape
  // (Anvil) — one query, no strike-grid scan. The grid scan below is kept
  // only as the Anvil path's belt-and-braces when the tape read fails.
  const longOptions: LongOptionPosition[] = [];
  let source: WalletPositions["source"] = "rpc-scan";
  try {
    const res = await readPositions(address, { chainId, client, vault });
    source = res.source;
    for (const p of res.positions) {
      longOptions.push({
        authId: p.authId,
        strike: p.strike,
        isCall: p.isCall,
        expiry: p.expiry,
        expiresInDays: Math.round(((p.expiry - Date.now() / 1000) / 86400) * 10) / 10,
        amount: p.balance,
        optionToken: p.optionToken,
      });
    }
  } catch (err) {
    if (err instanceof SubgraphRequiredError) throw err;
    console.warn("copilot: tape read failed, scanning the strike grid:", (err as Error).message);
  }
  if (vault && source === "rpc-scan") {
    for (const auth of auths) {
      const strikes: number[] = [];
      const start = Math.ceil(auth.strikeMin / 50) * 50;
      for (let k = start; k <= auth.strikeMax && strikes.length < MAX_STRIKES_PER_AUTH; k += 50) {
        strikes.push(k);
      }
      const tokenAddrs = await Promise.all(
        strikes.map((k) =>
          client.readContract({
            address: vault,
            abi: VAULT_ABI,
            functionName: "optionTokens",
            args: [BigInt(auth.authId), BigInt(Math.round(k * WAD))],
          })
        )
      );
      const deployed = strikes
        .map((k, i) => ({ strike: k, token: tokenAddrs[i] }))
        .filter((s) => s.token !== ZERO_ADDR);
      const bals = await Promise.all(
        deployed.map((s) =>
          client.readContract({
            address: s.token as Address,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [user],
          })
        )
      );
      deployed.forEach((s, i) => {
        const amount = Number(bals[i]) / WAD;
        if (amount > 0) {
          longOptions.push({
            authId: auth.authId,
            strike: s.strike,
            isCall: auth.isCall,
            expiry: auth.expiry,
            expiresInDays: auth.expiresInDays,
            amount,
            optionToken: s.token,
          });
        }
      });
    }
  }

  // LP side: only the auths this wallet wrote.
  const lpAuths = auths.filter((a) => a.lp.toLowerCase() === address.toLowerCase());

  return { source, balances, lpAuths, longOptions };
}

/** Live call quote from the on-chain pricing engine (the same math the SwapVM instruction runs). */
export async function readOnchainQuote(
  client: PublicClient,
  params: { spot: number; strike: number; expiryDays: number; isBuy: boolean }
): Promise<number> {
  const engine = CONTRACTS.pricingEngine as Address;
  if (!engine) throw new Error("Pricing engine address not configured (NEXT_PUBLIC_PRICING_ENGINE)");
  const nowSec = Math.floor(Date.now() / 1000);
  const premiumWad = await client.readContract({
    address: engine,
    abi: PRICING_ENGINE_ABI,
    functionName: "quote",
    args: [
      {
        spot: BigInt(Math.round(params.spot * WAD)),
        strike: BigInt(Math.round(params.strike * WAD)),
        expiry: BigInt(nowSec + Math.round(params.expiryDays * 86400)),
        sigmaGlobal: BigInt(Math.round(SIGMA_GLOBAL * WAD)),
        alpha: BigInt(Math.round(ALPHA * WAD)),
        isBuy: params.isBuy,
      },
    ],
  });
  return Number(premiumWad) / WAD;
}
