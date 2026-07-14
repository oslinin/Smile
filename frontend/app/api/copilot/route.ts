// Smile Copilot chat endpoint. The only server-side entry point: receives the
// UI message history plus a per-request context (spot/chain/wallet from the
// client, so copilot numbers match the visible UI), runs a single model loop
// with tools, and streams UI-message parts back.
//
// Note: this route only exists on server builds. The GitHub Pages deployment
// is a static export (NEXT_PUBLIC_BASE_PATH set → output:"export" in
// next.config.ts) where POST route handlers are unsupported — the copilot
// widget hides itself there via NEXT_PUBLIC_COPILOT.

import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import {
  getModel,
  isCopilotConfigured,
  parseProvider,
  type ProviderOverride,
} from "@/lib/copilot/provider";
import { buildSystemPrompt, type CopilotContext } from "@/lib/copilot/systemPrompt";
import { buildTools } from "@/lib/copilot/tools";

export const runtime = "nodejs";
export const maxDuration = 60;

interface CopilotRequestBody {
  messages: UIMessage[];
  context?: Partial<CopilotContext>;
}

/** BYOK: the user's own key, sent per-request from their browser via headers.
 *  Used only to construct this request's model client — never stored, logged,
 *  or echoed. */
function parseOverride(req: Request): ProviderOverride | null {
  const apiKey = req.headers.get("x-copilot-api-key");
  const provider = parseProvider(req.headers.get("x-copilot-provider"));
  if (!apiKey || !provider) return null;
  return { provider, apiKey, model: req.headers.get("x-copilot-model") || undefined };
}

export async function POST(req: Request) {
  const override = parseOverride(req);
  if (!isCopilotConfigured(override)) {
    return Response.json(
      {
        error:
          "Copilot is not configured. Either set COPILOT_PROVIDER and the matching API key (e.g. ANTHROPIC_API_KEY) in frontend/.env.local and restart, or add your own API key in the copilot's settings (gear icon).",
      },
      { status: 503 }
    );
  }

  const { messages, context }: CopilotRequestBody = await req.json();

  const ctx: CopilotContext = {
    spot: typeof context?.spot === "number" && context.spot > 0 ? context.spot : 3420,
    chainId: context?.chainId,
    address: context?.address,
  };

  const result = streamText({
    model: getModel(override),
    system: buildSystemPrompt(ctx),
    // ignoreIncompleteToolCalls: a quiz card the user never answered must not
    // poison the next turn with a dangling tool call.
    messages: await convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }),
    tools: buildTools(ctx),
    stopWhen: isStepCount(10),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      onError: (error) =>
        error instanceof Error ? error.message : "Copilot request failed",
    }),
  });
}
