"use client";

// BYOK settings for the copilot: provider + the user's own API key (+ optional
// model override), persisted in localStorage only. The key is sent per-request
// in a header; the server uses it for that chat request and never stores it.

import { useState } from "react";

export interface ByokSettings {
  provider: "anthropic" | "openai" | "google" | "openrouter";
  apiKey: string;
  model?: string;
}

const STORAGE_KEY = "smile.copilot.byok";
const MCP_KEY = "smile.copilot.mcp";

/** An MCP server the copilot may call tools on; same shape the server parses. */
export interface McpServer {
  name: string;
  url: string;
  token?: string;
  transport?: "http" | "sse";
}

export function loadMcp(): McpServer[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MCP_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const THEGRAPH_MCP: McpServer = { name: "thegraph", url: "https://subgraphs.mcp.thegraph.com/sse", transport: "sse" };

export function loadByok(): ByokSettings | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ByokSettings;
    return parsed.apiKey ? parsed : null;
  } catch {
    return null;
  }
}

const PROVIDERS = [
  { key: "anthropic", label: "Claude (Anthropic)", keyHint: "sk-ant-…, from console.anthropic.com" },
  { key: "openai", label: "GPT (OpenAI)", keyHint: "sk-…, from platform.openai.com" },
  { key: "google", label: "Gemini (Google)", keyHint: "from aistudio.google.com" },
  { key: "openrouter", label: "OpenRouter (many models)", keyHint: "sk-or-…, from openrouter.ai/keys" },
] as const;

export function CopilotSettings({
  value,
  onChange,
  mcp,
  onMcpChange,
  onClose,
}: {
  value: ByokSettings | null;
  onChange: (v: ByokSettings | null) => void;
  mcp: McpServer[];
  onMcpChange: (v: McpServer[]) => void;
  onClose: () => void;
}) {
  // The popover is unmounted when closed, so initializers re-read the stored
  // value on every open — no sync effect needed.
  const [provider, setProvider] = useState<ByokSettings["provider"]>(value?.provider ?? "anthropic");
  const [apiKey, setApiKey] = useState(value?.apiKey ?? "");
  const [model, setModel] = useState(value?.model ?? "");

  const save = () => {
    if (apiKey.trim()) {
      const v: ByokSettings = { provider, apiKey: apiKey.trim(), model: model.trim() || undefined };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
      onChange(v);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
      onChange(null);
    }
    onClose();
  };

  const clear = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setApiKey("");
    setModel("");
    onChange(null);
    onClose();
  };

  const hint = PROVIDERS.find((p) => p.key === provider)?.keyHint;

  // MCP servers: saved immediately (no Save button needed), max 5.
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpToken, setMcpToken] = useState("");
  const [mcpSse, setMcpSse] = useState(false);
  const setMcp = (list: McpServer[]) => {
    window.localStorage.setItem(MCP_KEY, JSON.stringify(list));
    onMcpChange(list);
  };
  const addMcp = (s: McpServer) => {
    if (!s.name.trim() || !s.url.startsWith("https://")) return;
    setMcp([...mcp.filter((m) => m.name !== s.name), { ...s, token: s.token || undefined }].slice(0, 5));
    setMcpName("");
    setMcpUrl("");
    setMcpToken("");
    setMcpSse(false);
  };
  const addTheGraph = () => {
    const token = window.prompt("The Graph Gateway API key (thegraph.com/studio → API Keys):")?.trim();
    if (token) addMcp({ ...THEGRAPH_MCP, token });
  };
  const inputCls =
    "w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 font-mono focus:outline-none focus:border-blue-600";

  return (
    <div className="absolute right-2 top-12 z-10 w-[340px] max-h-[75vh] overflow-y-auto rounded-lg border border-gray-700 bg-gray-950 p-3 shadow-2xl space-y-2">
      <div className="text-xs font-semibold text-white">Use your own API key</div>
      <p className="text-[10px] text-gray-500 leading-relaxed">
        Your key is stored only in this browser and sent per-request to the app server, which uses it
        for this chat and does not store it. Leave empty to use the server&apos;s configured key.
      </p>

      <div className="flex gap-1">
        {PROVIDERS.map((p) => (
          <button
            key={p.key}
            onClick={() => setProvider(p.key)}
            className={`flex-1 text-[10px] px-1 py-1.5 rounded border transition-colors ${
              provider === p.key
                ? "border-blue-600 bg-blue-900/40 text-white"
                : "border-gray-800 bg-gray-900 text-gray-500 hover:text-white"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={`API key (${hint})`}
        autoComplete="off"
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 font-mono focus:outline-none focus:border-blue-600"
      />
      <input
        type="text"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder="Model override (optional)"
        autoComplete="off"
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 font-mono focus:outline-none focus:border-blue-600"
      />

      <div className="flex gap-2 pt-1">
        <button
          onClick={save}
          className="flex-1 text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white font-semibold transition-colors"
        >
          Save
        </button>
        <button
          onClick={clear}
          className="text-xs px-3 py-1.5 rounded border border-gray-700 text-gray-400 hover:text-white transition-colors"
        >
          Clear
        </button>
      </div>

      <div className="border-t border-gray-800 pt-2 space-y-1.5">
        <div className="text-xs font-semibold text-white">MCP servers</div>
        <p className="text-[10px] text-gray-500 leading-relaxed">
          Tools from these servers are offered to the copilot on every request. Stored only in this
          browser; the bearer token is sent per request and never stored on the server.
        </p>
        {mcp.map((m) => (
          <div key={m.name} className="flex items-center gap-2 text-[10px] font-mono text-gray-300">
            <span className="text-white">{m.name}</span>
            <span className="flex-1 truncate text-gray-500">{m.url}</span>
            <button
              onClick={() => setMcp(mcp.filter((x) => x.name !== m.name))}
              className="text-gray-500 hover:text-red-400"
              aria-label={`Remove ${m.name}`}
            >
              remove
            </button>
          </div>
        ))}
        <button
          onClick={addTheGraph}
          className="w-full text-[10px] px-2 py-1.5 rounded border border-purple-900 bg-purple-900/30 text-purple-200 hover:text-white transition-colors"
        >
          Add The Graph Subgraph MCP
        </button>
        <input value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="Name" className={inputCls} />
        <input value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} placeholder="https://… (MCP endpoint)" className={inputCls} />
        <input
          type="password"
          value={mcpToken}
          onChange={(e) => setMcpToken(e.target.value)}
          placeholder="Bearer token (optional)"
          autoComplete="off"
          className={inputCls}
        />
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-gray-500 flex items-center gap-1">
            <input type="checkbox" checked={mcpSse} onChange={(e) => setMcpSse(e.target.checked)} /> SSE transport
          </label>
          <button
            onClick={() => addMcp({ name: mcpName.trim(), url: mcpUrl.trim(), token: mcpToken.trim(), transport: mcpSse ? "sse" : "http" })}
            disabled={!mcpName.trim() || !mcpUrl.startsWith("https://") || mcp.length >= 5}
            className="ml-auto text-xs px-3 py-1 rounded border border-gray-700 text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
          >
            Add server
          </button>
        </div>
      </div>
    </div>
  );
}
