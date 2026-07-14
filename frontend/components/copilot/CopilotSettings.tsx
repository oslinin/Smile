"use client";

// BYOK settings for the copilot: provider + the user's own API key (+ optional
// model override), persisted in localStorage only. The key is sent per-request
// in a header; the server uses it for that chat request and never stores it.

import { useState } from "react";

export interface ByokSettings {
  provider: "anthropic" | "openai" | "google";
  apiKey: string;
  model?: string;
}

const STORAGE_KEY = "smile.copilot.byok";

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
] as const;

export function CopilotSettings({
  value,
  onChange,
  onClose,
}: {
  value: ByokSettings | null;
  onChange: (v: ByokSettings | null) => void;
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

  return (
    <div className="absolute right-2 top-12 z-10 w-[340px] rounded-lg border border-gray-700 bg-gray-950 p-3 shadow-2xl space-y-2">
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
    </div>
  );
}
