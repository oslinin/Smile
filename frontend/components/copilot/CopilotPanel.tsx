"use client";

// Smile Copilot chat panel: floating button (bottom-right) + slide-over chat.
// Talks to /api/copilot, sending {spot, chainId, address} with every request
// so server-side pricing matches the visible UI exactly. Hidden unless
// NEXT_PUBLIC_COPILOT=1 (the GitHub Pages static export has no API server).

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import type { BuilderLeg } from "@/lib/options";
import { ChatMessage } from "./ChatMessage";
import { CopilotSettings, loadByok, type ByokSettings } from "./CopilotSettings";
import type { QuizAnswer } from "./QuizCard";

const STARTERS = [
  "Explain the volatility smile in this protocol",
  "I'm bullish on ETH — show me trade ideas",
  "How does Smile compare to Panoptic?",
  "Quiz me on the Greeks",
];

export interface CopilotPanelProps {
  spot: number;
  chainId?: number;
  address?: string;
  /** Load proposed legs into the Payoff Builder (page switches to the chain tab). */
  onProposeLegs?: (legs: BuilderLeg[], name: string) => void;
}

export function CopilotPanel({ spot, chainId, address, onProposeLegs }: CopilotPanelProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [byok, setByok] = useState<ByokSettings | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Hydration-safe localStorage read: the server render has no key, the
    // client syncs after mount (same pattern as page.tsx's `setMounted`).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setByok(loadByok());
  }, []);

  // Latest context via refs: the transport is created once, but its body()
  // and headers() callbacks run per request (an event, not render) and must
  // see the current spot/chain/wallet and BYOK key.
  const ctxRef = useRef({ spot, chainId, address });
  const byokRef = useRef<ByokSettings | null>(null);
  useEffect(() => {
    ctxRef.current = { spot, chainId, address };
  }, [spot, chainId, address]);
  useEffect(() => {
    byokRef.current = byok;
  }, [byok]);

  const { messages, sendMessage, addToolOutput, status, error } = useChat({
    // eslint-disable-next-line react-hooks/refs -- body()/headers() run at request time (fetch), not during render
    transport: new DefaultChatTransport({
      api: "/api/copilot/", // trailing slash: next.config has trailingSlash:true
      body: () => ({ context: ctxRef.current }),
      // BYOK: the user's own key rides each request; the server uses it for
      // this request only and never stores it.
      headers: () => {
        const b = byokRef.current;
        if (!b?.apiKey) return {};
        return {
          "x-copilot-provider": b.provider,
          "x-copilot-api-key": b.apiKey,
          ...(b.model ? { "x-copilot-model": b.model } : {}),
        };
      },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;
      // propose_trade is display-only: acknowledge immediately so the model can
      // wrap up in text. The "Load into Builder" button is pure UI on top.
      if (toolCall.toolName === "propose_trade") {
        addToolOutput({
          tool: "propose_trade",
          toolCallId: toolCall.toolCallId,
          output: { displayed: true },
        });
      }
      // quiz_question stays pending until the user clicks a choice.
    },
  });

  const busy = status === "submitted" || status === "streaming";

  // Running quiz score, derived from answered quiz tool parts in the transcript.
  const score = useMemo(() => {
    let correct = 0;
    let total = 0;
    for (const m of messages) {
      for (const part of m.parts) {
        if (part.type === "tool-quiz_question" && "state" in part && part.state === "output-available") {
          total++;
          if ((part.output as QuizAnswer)?.correct) correct++;
        }
      }
    }
    return { correct, total };
  }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  if (process.env.NEXT_PUBLIC_COPILOT !== "1") return null;

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    sendMessage({ text: t });
    setInput("");
  };

  const answerQuiz = (toolCallId: string, answer: QuizAnswer) => {
    addToolOutput({ tool: "quiz_question", toolCallId, output: answer });
  };

  return (
    <>
      {/* Floating toggle button */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Toggle Smile Copilot"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-blue-700 hover:bg-blue-600 text-white text-sm font-semibold pl-3 pr-4 py-2.5 shadow-xl shadow-blue-950/50 transition-colors"
      >
        <span className="text-base leading-none">✦</span>
        Copilot
      </button>

      {/* Slide-over panel */}
      {open && (
        <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[420px] bg-gray-900 border-l border-gray-800 flex flex-col shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <span className="text-blue-400">✦</span>
              <span className="text-sm font-semibold text-white">Smile Copilot</span>
              {score.total > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-300 border border-purple-900">
                  quiz {score.correct}/{score.total}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-gray-600 font-mono">${spot.toLocaleString()}</span>
              {byok && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 border border-green-900"
                  title={`Using your own ${byok.provider} key`}
                >
                  own key
                </span>
              )}
              <button
                onClick={() => setSettingsOpen((o) => !o)}
                className={`transition-colors ${settingsOpen ? "text-white" : "text-gray-500 hover:text-white"}`}
                aria-label="Copilot settings"
                title="Use your own API key"
              >
                ⚙
              </button>
              <button
                onClick={() => setOpen(false)}
                className="text-gray-500 hover:text-white transition-colors"
                aria-label="Close copilot"
              >
                ✕
              </button>
            </div>
          </div>

          {settingsOpen && (
            <CopilotSettings value={byok} onChange={setByok} onClose={() => setSettingsOpen(false)} />
          )}

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
            {messages.length === 0 && (
              <div className="space-y-3 pt-4">
                <p className="text-xs text-gray-500">
                  Ask about the smile model, protocol economics, trade-offs, competitors — or get trade
                  ideas, rolls and adjustments, risk analysis, and portfolio advice. I can also teach
                  options concepts and quiz you. Proposals load into the Payoff Builder; you always
                  review and sign yourself. Bring your own API key via the ⚙ icon.
                </p>
                <div className="space-y-1.5">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="block w-full text-left text-xs px-3 py-2 rounded border border-gray-800 bg-gray-950 text-gray-400 hover:text-white hover:border-blue-800 transition-colors"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <ChatMessage
                key={m.id}
                message={m}
                spot={spot}
                onLoadLegs={onProposeLegs}
                onQuizAnswer={answerQuiz}
              />
            ))}

            {busy && (
              <div className="text-[10px] text-gray-600 flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                thinking…
              </div>
            )}
            {error && (
              <div className="text-xs text-red-400 border border-red-900/50 bg-red-950/30 rounded px-3 py-2">
                {error.message || "Something went wrong — is the copilot configured? (COPILOT_PROVIDER + API key in frontend/.env.local)"}
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="border-t border-gray-800 p-3 flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about strategies, risk, the protocol…"
              className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-600"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="text-xs px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white font-semibold transition-colors"
            >
              Send
            </button>
          </form>
          <p className="px-3 pb-2 text-[9px] text-gray-700">
            Educational tool — not financial advice. Trades execute only through the existing UI after your review.
          </p>
        </div>
      )}
    </>
  );
}
