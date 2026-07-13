// Provider-agnostic LLM selection for the copilot. All secrets live in
// non-NEXT_PUBLIC_ env vars and this module is only imported by the API route,
// so keys can never reach the client bundle. Swap providers by editing
// COPILOT_PROVIDER / COPILOT_MODEL in frontend/.env.local — no code change.

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

type Provider = "anthropic" | "openai" | "google";

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5-mini",
  google: "gemini-2.5-pro",
};

const KEY_VARS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

function currentProvider(): Provider {
  const p = (process.env.COPILOT_PROVIDER ?? "anthropic").toLowerCase();
  if (p === "anthropic" || p === "openai" || p === "google") return p;
  throw new Error(`Unknown COPILOT_PROVIDER "${p}" — use anthropic | openai | google`);
}

export function isCopilotConfigured(): boolean {
  try {
    return Boolean(process.env[KEY_VARS[currentProvider()]]);
  } catch {
    return false;
  }
}

export function getModel(): LanguageModel {
  const provider = currentProvider();
  const modelId = process.env.COPILOT_MODEL || DEFAULT_MODELS[provider];
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
  }
}
