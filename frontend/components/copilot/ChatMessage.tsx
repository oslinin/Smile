"use client";

// Renders one UIMessage: text parts as GFM markdown (tables!), tool parts as
// typed cards/charts. Charts are recomputed client-side from tool inputs —
// the model only ever sees compact numbers.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIMessage } from "ai";
import type { BuilderLeg } from "@/lib/options";
import type { ScenarioGridResult } from "@/lib/copilot/analytics";
import { ChatPayoffChart } from "./ChatPayoffChart";
import { ChatSmileChart } from "./ChatSmileChart";
import { StrategyCard } from "./StrategyCard";
import { QuizCard, type QuizAnswer } from "./QuizCard";

// Structural view of a UI tool part — the generated tool-part union is only
// available when the route's tool types are threaded through useChat; the
// runtime shape is stable and documented (type, state, input, output).
interface ToolPartLike {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

const isToolPart = (part: { type: string }): part is ToolPartLike =>
  part.type.startsWith("tool-");

const TOOL_LABELS: Record<string, string> = {
  "tool-read_docs": "reading docs",
  "tool-get_market_state": "checking market state",
  "tool-price_strategy": "pricing strategy",
  "tool-suggest_strategies": "screening strategies",
  "tool-scenario_analysis": "running scenarios",
  "tool-get_onchain_quote": "querying on-chain quote",
  "tool-analyze_adjustment": "analyzing adjustment",
  "tool-get_positions": "reading wallet positions",
  "tool-portfolio_risk": "aggregating portfolio risk",
};

function ToolChip({ label, pending }: { label: string; pending: boolean }) {
  return (
    <div className="text-[10px] text-gray-600 flex items-center gap-1.5 my-1">
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${pending ? "bg-blue-500 animate-pulse" : "bg-gray-700"}`} />
      {label}
    </div>
  );
}

function ScenarioGrid({ grid }: { grid: ScenarioGridResult }) {
  return (
    <div className="overflow-x-auto my-1">
      <table className="text-[10px] font-mono border-collapse">
        <thead>
          <tr>
            <th className="text-gray-600 font-normal pr-2 text-left">vol \ spot</th>
            {grid.spotShiftsPct.map((sp) => (
              <th key={sp} className="text-gray-500 font-normal px-1.5 text-right">
                {sp > 0 ? `+${sp}` : sp}%
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.volShiftsPts.map((vp, r) => (
            <tr key={vp}>
              <td className="text-gray-500 pr-2">{vp > 0 ? `+${vp}` : vp} pts</td>
              {grid.pnl[r].map((p, c) => (
                <td
                  key={c}
                  className={`px-1.5 py-0.5 text-right ${p >= 0 ? "text-green-400 bg-green-900/15" : "text-red-400 bg-red-900/15"}`}
                >
                  {p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(0)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {grid.daysForward > 0 && (
        <div className="text-[9px] text-gray-600 mt-0.5">after {grid.daysForward} days of decay</div>
      )}
    </div>
  );
}

function MarketStateCard({ output, spot }: { output: Record<string, unknown>; spot: number }) {
  const stats: [string, string][] = [
    ["ATM vol", `${((output.atmVol as number) * 100).toFixed(0)}%`],
    ["exp. move", `±${(output.expectedMovePct as number).toFixed(1)}%`],
    ["25Δ RR", `${((output.riskReversal25d as number) * 100).toFixed(1)}pts`],
    ["25Δ fly", `${((output.butterfly25d as number) * 100).toFixed(1)}pts`],
  ];
  return (
    <div className="space-y-1 my-1">
      <ChatSmileChart spot={spot} expiryDays={(output.expiryDays as number) || undefined} />
      <div className="grid grid-cols-4 gap-1 text-center">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded bg-gray-950 px-1 py-1">
            <div className="text-[8px] uppercase tracking-wide text-gray-600">{label}</div>
            <div className="text-[11px] font-mono text-gray-200">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const md = {
  p: (props: React.ComponentProps<"p">) => <p className="my-1.5" {...props} />,
  ul: (props: React.ComponentProps<"ul">) => <ul className="list-disc pl-4 my-1.5 space-y-0.5" {...props} />,
  ol: (props: React.ComponentProps<"ol">) => <ol className="list-decimal pl-4 my-1.5 space-y-0.5" {...props} />,
  h1: (props: React.ComponentProps<"h1">) => <div className="font-semibold text-white mt-2 mb-1" {...props} />,
  h2: (props: React.ComponentProps<"h2">) => <div className="font-semibold text-white mt-2 mb-1" {...props} />,
  h3: (props: React.ComponentProps<"h3">) => <div className="font-semibold text-gray-200 mt-2 mb-1" {...props} />,
  a: (props: React.ComponentProps<"a">) => <a className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer" {...props} />,
  code: (props: React.ComponentProps<"code">) => (
    <code className="bg-gray-950 border border-gray-800 rounded px-1 text-[11px] text-pink-300" {...props} />
  ),
  pre: (props: React.ComponentProps<"pre">) => (
    <pre className="bg-gray-950 border border-gray-800 rounded p-2 overflow-x-auto text-[11px] my-1.5" {...props} />
  ),
  table: (props: React.ComponentProps<"table">) => (
    <div className="overflow-x-auto my-1.5">
      <table className="border-collapse text-[11px]" {...props} />
    </div>
  ),
  th: (props: React.ComponentProps<"th">) => (
    <th className="border border-gray-800 bg-gray-950 px-2 py-1 text-left text-gray-300" {...props} />
  ),
  td: (props: React.ComponentProps<"td">) => <td className="border border-gray-800 px-2 py-1" {...props} />,
  blockquote: (props: React.ComponentProps<"blockquote">) => (
    <blockquote className="border-l-2 border-gray-700 pl-2 text-gray-500 my-1.5" {...props} />
  ),
};

export function ChatMessage({
  message,
  spot,
  onLoadLegs,
  onQuizAnswer,
}: {
  message: UIMessage;
  spot: number;
  onLoadLegs?: (legs: BuilderLeg[], name: string) => void;
  onQuizAnswer?: (toolCallId: string, answer: QuizAnswer) => void;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`text-xs leading-relaxed ${isUser ? "text-white" : "text-gray-300"}`}>
      {isUser ? (
        <div className="bg-blue-900/40 border border-blue-900/60 rounded-lg px-3 py-2 ml-8">
          {message.parts.map((part, i) => (part.type === "text" ? <span key={i}>{part.text}</span> : null))}
        </div>
      ) : (
        <div className="space-y-0.5">
          {message.parts.map((part, i) => {
            if (part.type === "text") {
              return (
                <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={md}>
                  {part.text}
                </ReactMarkdown>
              );
            }
            if (!isToolPart(part)) return null;

            const pending = part.state === "input-streaming" || part.state === "input-available";

            if (part.type === "tool-propose_trade" && part.state !== "input-streaming") {
              const input = part.input as { name: string; rationale: string; legs: BuilderLeg[] } | undefined;
              if (!input?.legs?.length) return null;
              return (
                <StrategyCard
                  key={part.toolCallId}
                  name={input.name}
                  rationale={input.rationale}
                  legs={input.legs}
                  spot={spot}
                  onLoad={onLoadLegs}
                />
              );
            }

            if (part.type === "tool-quiz_question" && part.state !== "input-streaming") {
              const input = part.input as
                | { question: string; choices: string[]; correctIndex: number; explanation: string; topic: string }
                | undefined;
              if (!input?.choices?.length) return null;
              const answer =
                part.state === "output-available" ? (part.output as QuizAnswer) : undefined;
              return (
                <QuizCard
                  key={part.toolCallId}
                  {...input}
                  answer={answer}
                  onAnswer={onQuizAnswer ? (a) => onQuizAnswer(part.toolCallId, a) : undefined}
                />
              );
            }

            if (part.type === "tool-price_strategy" && part.state === "output-available") {
              const legs = (part.input as { legs?: BuilderLeg[] } | undefined)?.legs;
              return legs?.length ? (
                <ChatPayoffChart key={part.toolCallId} legs={legs} spot={spot} />
              ) : null;
            }

            if (part.type === "tool-get_market_state" && part.state === "output-available") {
              return (
                <MarketStateCard
                  key={part.toolCallId}
                  output={part.output as Record<string, unknown>}
                  spot={spot}
                />
              );
            }

            if (part.type === "tool-analyze_adjustment" && part.state === "output-available") {
              const input = part.input as { currentLegs?: BuilderLeg[] } | undefined;
              const output = part.output as
                | { afterLegs?: BuilderLeg[]; netCashFlow?: number; error?: string }
                | undefined;
              if (!input?.currentLegs?.length || output?.error) return null;
              return (
                <div key={part.toolCallId} className="space-y-1 my-1">
                  <div className="text-[9px] uppercase tracking-wide text-gray-600">before</div>
                  <ChatPayoffChart legs={input.currentLegs} spot={spot} />
                  <div className="text-[9px] uppercase tracking-wide text-gray-600">
                    after{" "}
                    {typeof output?.netCashFlow === "number" && (
                      <span className={output.netCashFlow >= 0 ? "text-green-400" : "text-red-400"}>
                        · net {output.netCashFlow >= 0 ? "credit" : "debit"} $
                        {Math.abs(output.netCashFlow).toFixed(0)}
                      </span>
                    )}
                  </div>
                  {output?.afterLegs?.length ? (
                    <ChatPayoffChart legs={output.afterLegs} spot={spot} />
                  ) : (
                    <div className="text-[10px] text-gray-600">position fully closed</div>
                  )}
                </div>
              );
            }

            if (part.type === "tool-scenario_analysis" && part.state === "output-available") {
              return <ScenarioGrid key={part.toolCallId} grid={part.output as ScenarioGridResult} />;
            }

            const label = TOOL_LABELS[part.type] ?? part.type.replace("tool-", "").replaceAll("_", " ");
            if (part.state === "output-error") {
              return (
                <div key={part.toolCallId} className="text-[10px] text-red-400 my-1">
                  {label} failed: {part.errorText}
                </div>
              );
            }
            return <ToolChip key={part.toolCallId} label={label} pending={pending} />;
          })}
        </div>
      )}
    </div>
  );
}
