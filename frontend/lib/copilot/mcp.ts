// MCP servers for the copilot: any server the user adds in Settings (sent
// per request in the x-copilot-mcp header, like the BYOK key) plus the ones
// the operator seeds in COPILOT_MCP_SERVERS. Each request opens the servers,
// merges their tools with the built-in ones, and closes them when the stream
// ends. The Graph's Subgraph MCP is the preset the settings UI offers.

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

export interface McpServerConfig {
  name: string;
  url: string;
  token?: string;
  transport?: "http" | "sse";
}

const MAX_SERVERS = 5;

function parseConfigs(raw: string | null | undefined): McpServerConfig[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (c): c is McpServerConfig =>
          c && typeof c.name === "string" && c.name.trim() !== "" && typeof c.url === "string" && c.url.startsWith("https://")
      )
      .slice(0, MAX_SERVERS)
      .map((c) => ({
        name: c.name.trim(),
        url: c.url,
        token: typeof c.token === "string" && c.token ? c.token : undefined,
        transport: c.transport === "sse" ? "sse" : "http",
      }));
  } catch {
    return [];
  }
}

/** Header `x-copilot-mcp`: JSON array of McpServerConfig from the browser. */
export function parseMcpHeader(req: Request): McpServerConfig[] {
  return parseConfigs(req.headers.get("x-copilot-mcp"));
}

/** Env `COPILOT_MCP_SERVERS`: same JSON shape, seeds the hosted demo. */
export function serverMcpConfigs(): McpServerConfig[] {
  return parseConfigs(process.env.COPILOT_MCP_SERVERS);
}

/** env + header, header wins on an equal name. */
export function mergeMcpConfigs(env: McpServerConfig[], header: McpServerConfig[]): McpServerConfig[] {
  const byName = new Map(env.map((c) => [c.name, c]));
  for (const c of header) byName.set(c.name, c);
  return [...byName.values()].slice(0, MAX_SERVERS);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Open every server; a server that fails to connect is logged and skipped. */
export async function openMcpTools(configs: McpServerConfig[]): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  for (const c of configs) {
    try {
      const client = await createMCPClient({
        transport: {
          type: c.transport ?? "http",
          url: c.url,
          headers: c.token ? { Authorization: `Bearer ${c.token}` } : undefined,
        },
        // Bound the handshake so a dead server cannot stall the chat.
        initializationOptions: { timeout: 8000 },
      });
      clients.push(client);
      for (const [name, t] of Object.entries(await client.tools())) {
        // Prefix only on collision so the common case keeps the server's names.
        // Cast: @ai-sdk/mcp pins a newer provider-utils than `ai`, so the
        // schema brand symbol differs; the runtime shape is the same Tool.
        tools[name in tools ? `${slug(c.name)}_${name}` : name] = t as ToolSet[string];
      }
    } catch (e) {
      console.warn(`copilot mcp: skipping "${c.name}" (${c.url}):`, e instanceof Error ? e.message : e);
    }
  }
  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
