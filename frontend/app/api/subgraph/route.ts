// Browser → subgraph proxy. Lets a gateway URL that carries an API key
// (SUBGRAPH_URL, server env) serve the app without the key ever reaching a
// browser. With no server-side URL configured it forwards to the recorded
// per-chain Studio endpoint, so the proxy is always safe to call.

import { DEPLOYMENTS } from "@/lib/deployments";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const chainId = Number(new URL(req.url).searchParams.get("chainId") ?? "0");
  const url =
    process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
    process.env[`SUBGRAPH_URL_${chainId}`] ||
    process.env.SUBGRAPH_URL ||
    DEPLOYMENTS[chainId]?.subgraph ||
    "";
  if (!url) return Response.json({ errors: [{ message: `no subgraph for chain ${chainId}` }] }, { status: 404 });
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
