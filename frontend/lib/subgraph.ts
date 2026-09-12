// GraphQL client for the Smile subgraph (subgraph/). Runs in the browser
// (LPDashboard, PriceChart) and in the copilot's Node route handler.
//
// URL resolution, in order:
//   1. NEXT_PUBLIC_SUBGRAPH_URL — an explicit override (a Studio dev endpoint
//      or a local graph-node), any chain.
//   2. Server only: SUBGRAPH_URL — a gateway URL carrying an API key; never
//      shipped to the browser. Browser callers reach it via /api/subgraph.
//   3. The recorded per-chain deployment (lib/deployments.ts) — Sepolia and
//      Arc always have a subgraph, so on a public network The Graph is the
//      only position source; there is no RPC path (plan P1).
// Local Anvil chains have no subgraph; lib/tape.ts rebuilds the same
// entities from eth_getLogs there and tags the result "anvil-logs".

import { DEPLOYMENTS } from "@/lib/deployments";

export const isLocalChain = (chainId?: number): boolean => chainId === 31337 || chainId === 1337;

const isServer = typeof window === "undefined";

/** The subgraph endpoint this process should query for `chainId`, or "" if none. */
export function subgraphUrlFor(chainId?: number): string {
  const explicit = process.env.NEXT_PUBLIC_SUBGRAPH_URL ?? "";
  if (explicit) return explicit;
  // Server only: a gateway URL carrying an API key, per chain
  // (SUBGRAPH_URL_11155111) or for every chain (SUBGRAPH_URL).
  const gateway = isServer ? process.env[`SUBGRAPH_URL_${chainId}`] || process.env.SUBGRAPH_URL : "";
  if (gateway) return gateway;
  const recorded = chainId !== undefined ? DEPLOYMENTS[chainId]?.subgraph ?? "" : "";
  if (recorded) {
    // The browser goes through the proxy so a server-side gateway key (if
    // configured) is used without being exposed; the proxy falls back to the
    // recorded URL itself. Static exports have no proxy, so call it directly.
    if (!isServer && !process.env.NEXT_PUBLIC_BASE_PATH) return `/api/subgraph/?chainId=${chainId}`;
    return recorded;
  }
  return "";
}

/** @deprecated kept for older callers; prefer subgraphUrlFor(chainId). */
export const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL ?? "";
export function subgraphEnabled(chainId?: number): boolean {
  return subgraphUrlFor(chainId).length > 0;
}

export async function querySubgraph<T>(
  query: string,
  variables: Record<string, unknown> = {},
  url: string
): Promise<T> {
  if (!url) throw new Error("subgraph: no endpoint for this chain");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`subgraph: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors && json.errors.length > 0) throw new Error(`subgraph: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error("subgraph: empty response");
  return json.data;
}

// ── Entity mirrors (BigInts as decimal strings) ─────────────────────────────

export interface SubgraphAuthorization {
  id: string;
  authId: string;
  lp: string;
  strikeMin: string;
  strikeMax: string;
  expiry: string;
  isCall: boolean;
  collateralToken: string;
  maxCollateral: string;
  usedCollateral: string;
  active: boolean;
  fillCount: number;
  createdAtTimestamp: string;
}

export interface SubgraphInstrument {
  id: string; // optionToken
  authorization: { id: string };
  lp: string;
  strike: string;
  expiry: string;
  isCall: boolean;
  openInterest: string;
  volume: string;
  fillCount: number;
  lastPremiumPerUnit: string;
  lastTradeAt: string;
}

export interface SubgraphFill {
  id: string;
  authorization: { id: string };
  optionToken: string;
  lp: string;
  buyer: string;
  strike: string;
  amount: string;
  premium: string;
  isCall: boolean;
  expiry: string;
  timestamp: string;
  blockNumber: string;
}

export interface SubgraphPosition {
  id: string;
  holder: string;
  optionToken: string;
  balance: string;
  instrument: { id: string; strike: string; expiry: string; isCall: boolean; lp: string; authorization: { id: string } };
}

const AUTH_FIELDS =
  "id authId lp strikeMin strikeMax expiry isCall collateralToken maxCollateral usedCollateral active fillCount createdAtTimestamp";
const INSTRUMENT_FIELDS =
  "id authorization { id } lp strike expiry isCall openInterest volume fillCount lastPremiumPerUnit lastTradeAt";
const FILL_FIELDS = "id authorization { id } optionToken lp buyer strike amount premium isCall expiry timestamp blockNumber";
const POSITION_FIELDS = "id holder optionToken balance instrument { id strike expiry isCall lp authorization { id } }";

export const AUTHORIZATIONS_BY_LP = `query AuthorizationsByLp($lp: Bytes!) {
  authorizations(where: { lp: $lp }, orderBy: authId, orderDirection: desc, first: 1000) { ${AUTH_FIELDS} }
}`;
export const ACTIVE_AUTHORIZATIONS = `query ActiveAuthorizations($first: Int!) {
  authorizations(where: { active: true }, orderBy: authId, orderDirection: desc, first: $first) { ${AUTH_FIELDS} }
}`;
export const INSTRUMENTS = `query Instruments($first: Int!) {
  instruments(orderBy: lastTradeAt, orderDirection: desc, first: $first) { ${INSTRUMENT_FIELDS} }
}`;
export const FILLS = `query Fills($first: Int!, $since: BigInt!) {
  fills(where: { timestamp_gte: $since }, orderBy: timestamp, orderDirection: asc, first: $first) { ${FILL_FIELDS} }
}`;
export const POSITIONS_BY_HOLDER = `query PositionsByHolder($holder: Bytes!) {
  positions(where: { holder: $holder, balance_gt: "0" }, first: 1000) { ${POSITION_FIELDS} }
}`;

export const fetchAuthorizationsByLp = (lp: string, url: string) =>
  querySubgraph<{ authorizations: SubgraphAuthorization[] }>(AUTHORIZATIONS_BY_LP, { lp: lp.toLowerCase() }, url).then(
    (d) => d.authorizations
  );
export const fetchActiveAuthorizations = (url: string, first = 1000) =>
  querySubgraph<{ authorizations: SubgraphAuthorization[] }>(ACTIVE_AUTHORIZATIONS, { first }, url).then(
    (d) => d.authorizations
  );
export const fetchInstruments = (url: string, first = 1000) =>
  querySubgraph<{ instruments: SubgraphInstrument[] }>(INSTRUMENTS, { first }, url).then((d) => d.instruments);
export const fetchFills = (url: string, sinceUnix = 0, first = 1000) =>
  querySubgraph<{ fills: SubgraphFill[] }>(FILLS, { first, since: String(sinceUnix) }, url).then((d) => d.fills);
export const fetchPositionsByHolder = (holder: string, url: string) =>
  querySubgraph<{ positions: SubgraphPosition[] }>(POSITIONS_BY_HOLDER, { holder: holder.toLowerCase() }, url).then(
    (d) => d.positions
  );
