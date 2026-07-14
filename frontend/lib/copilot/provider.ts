// Provider-agnostic LLM selection for the copilot. Two key sources:
//  1. Operator-configured: COPILOT_PROVIDER + key env vars (server-side only —
//     this module is only imported by the API route, so env keys never reach
//     the client bundle).
//  2. BYOK: a per-request override from the x-copilot-* headers, carrying the
//     user's own key from their browser (used for that request only, never
//     stored or logged).

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export type CopilotProvider = "anthropic" | "openai" | "google";

export interface ProviderOverride {
  provider: CopilotProvider;
  apiKey: string;
  model?: string;
}

const DEFAULT_MODELS: Record<CopilotProvider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5-mini",
  google: "gemini-2.5-pro",
};

const KEY_VARS: Record<CopilotProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export function parseProvider(p: string | null | undefined): CopilotProvider | null {
  const v = (p ?? "").toLowerCase();
  return v === "anthropic" || v === "openai" || v === "google" ? v : null;
}

function serverProvider(): CopilotProvider {
  const p = parseProvider(process.env.COPILOT_PROVIDER ?? "anthropic");
  if (!p) {
    throw new Error(
      `Unknown COPILOT_PROVIDER "${process.env.COPILOT_PROVIDER}" — use anthropic | openai | google`
    );
  }
  return p;
}

export function isCopilotConfigured(override?: ProviderOverride | null): boolean {
  if (override?.apiKey) return true;
  try {
    return Boolean(process.env[KEY_VARS[serverProvider()]]);
  } catch {
    return false;
  }
}

export function getModel(override?: ProviderOverride | null): LanguageModel {
  if (override?.apiKey) {
    const modelId = override.model || DEFAULT_MODELS[override.provider];
    switch (override.provider) {
      case "anthropic":
        return createAnthropic({ apiKey: override.apiKey })(modelId);
      case "openai":
        return createOpenAI({ apiKey: override.apiKey })(modelId);
      case "google":
        return createGoogleGenerativeAI({ apiKey: override.apiKey })(modelId);
    }
  }
  const provider = serverProvider();
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
