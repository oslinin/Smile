// Thin GraphQL client for the Smile subgraph (subgraph/). Active only when
// NEXT_PUBLIC_SUBGRAPH_URL is set; every caller keeps its RPC/getLogs path
// as the fallback, so local Anvil dev without an indexer keeps working
// (docs/plans/2026-09-09-theGraph.md, ground rule 2). Runs in both the
// browser (LPDashboard) and the copilot's Node route handler (chain.ts).

export const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL ?? "";

export function subgraphEnabled(): boolean {
  return SUBGRAPH_URL.length > 0;
}

export async function querySubgraph<T>(
  query: string,
  variables: Record<string, unknown> = {},
  url: string = SUBGRAPH_URL
): Promise<T> {
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

/** Mirrors the Authorization entity in subgraph/schema.graphql (BigInts as decimal strings). */
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
}

const AUTHORIZATION_FIELDS =
  "id authId lp strikeMin strikeMax expiry isCall collateralToken maxCollateral usedCollateral active fillCount";

export const AUTHORIZATIONS_BY_LP = `query AuthorizationsByLp($lp: Bytes!) {
  authorizations(where: { lp: $lp }, orderBy: authId, orderDirection: desc, first: 1000) { ${AUTHORIZATION_FIELDS} }
}`;

export const ACTIVE_AUTHORIZATIONS = `query ActiveAuthorizations($first: Int!) {
  authorizations(where: { active: true }, orderBy: authId, orderDirection: desc, first: $first) { ${AUTHORIZATION_FIELDS} }
}`;

export async function fetchAuthorizationsByLp(lp: string): Promise<SubgraphAuthorization[]> {
  const data = await querySubgraph<{ authorizations: SubgraphAuthorization[] }>(AUTHORIZATIONS_BY_LP, {
    lp: lp.toLowerCase(),
  });
  return data.authorizations;
}

export async function fetchActiveAuthorizations(first = 1000): Promise<SubgraphAuthorization[]> {
  const data = await querySubgraph<{ authorizations: SubgraphAuthorization[] }>(ACTIVE_AUTHORIZATIONS, { first });
  return data.authorizations;
}
