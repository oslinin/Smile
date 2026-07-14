// AI SDK tool definitions for the copilot. Server tools wrap the same pure
// pricing code the UI uses (lib/options.ts) so copilot numbers always agree
// with the visible payoff builder. Client-side UI tools (propose_trade,
// quiz_question) have no execute() — the chat panel renders them and answers
// via addToolOutput. Results returned to the model stay compact: charts are
// recomputed in the browser from tool inputs, never round-tripped as data.

import { tool } from "ai";
import { z } from "zod";
import {
  type BuilderLeg,
  DEFAULT_DTE,
  ALPHA,
  BETA,
  SIGMA_GLOBAL,
  breakevens,
  pnlSeries,
  protocolPremium,
  strategyStats,
  surfaceQuotes,
} from "@/lib/options";
import { STRATEGIES, type Outlook } from "@/lib/strategyCatalog";
import { positionsToLegs, scenarioGrid, subtractLegs } from "./analytics";
import { getPublicClient, readOnchainQuote, readWalletPositions } from "./chain";
import { getSection, SECTION_IDS } from "./knowledge";
import type { CopilotContext } from "./systemPrompt";

const round2 = (v: number) => Math.round(v * 100) / 100;

export const legSchema = z.object({
  direction: z.enum(["buy", "sell"]),
  isCall: z.boolean().describe("true = call, false = put"),
  strike: z.number().positive().describe("Strike in USD, on the $50 grid"),
  amount: z.number().positive().max(1000).describe("Contracts (1 = one unit of ETH)"),
  expiryDays: z
    .number()
    .int()
    .positive()
    .max(365)
    .optional()
    .describe(`Days to expiry (default ${DEFAULT_DTE})`),
});

export type LegInput = z.infer<typeof legSchema>;

const legsSchema = z.array(legSchema).min(1).max(6);

function priceLegs(legs: BuilderLeg[], spot: number) {
  const data = pnlSeries(legs, spot);
  const stats = strategyStats(legs, spot, data);
  return {
    cost: round2(stats.cost),
    maxProfit: stats.maxProfit === null ? "unlimited" : round2(stats.maxProfit),
    maxLoss: stats.maxLoss === null ? "unlimited" : round2(stats.maxLoss),
    probabilityOfProfit: round2(stats.pop),
    breakevens: breakevens(data).map((b) => Math.round(b)),
    greeks: {
      delta: round2(stats.greeks.delta),
      gamma: Math.round(stats.greeks.gamma * 1e4) / 1e4,
      thetaPerDay: round2(stats.greeks.theta),
      vegaPer1Pct: round2(stats.greeks.vega),
    },
    perLegPremiums: legs.map((l) => ({
      leg: `${l.direction} ${l.amount}x ${l.isCall ? "call" : "put"} K=${l.strike} ${l.expiryDays ?? DEFAULT_DTE}d`,
      premiumUsd: round2(protocolPremium(spot, l.strike, l.isCall, (l.expiryDays ?? DEFAULT_DTE) / 365)),
    })),
  };
}

export function buildTools(ctx: CopilotContext) {
  return {
    read_docs: tool({
      description:
        "Read a full section of the Smile protocol documentation (README, limitations, solutions). Use for questions about protocol economics, design trade-offs, limitations (L1-L12), planned solutions (S1-S12), and competitor comparisons. Cite the section id in your answer.",
      inputSchema: z.object({
        sectionId: z
          .string()
          .describe(`Section id from the TOC in your instructions, e.g. "${SECTION_IDS[3] ?? "readme/the-thesis"}"`),
      }),
      execute: async ({ sectionId }) => {
        const body = getSection(sectionId);
        if (body) return { sectionId, markdown: body };
        return {
          error: `Unknown section "${sectionId}"`,
          availableIds: SECTION_IDS,
        };
      },
    }),

    get_market_state: tool({
      description:
        "Get the live market state: ETH spot, smile parameters, ATM vol, expected move, 25-delta risk reversal and butterfly (trader-native surface quotes). Call before discussing vol, market conditions, or picking strikes.",
      inputSchema: z.object({
        expiryDays: z.number().int().positive().max(365).optional()
          .describe(`Expiry the surface quotes are measured at (default ${DEFAULT_DTE})`),
      }),
      execute: async ({ expiryDays }) => {
        const t = (expiryDays ?? DEFAULT_DTE) / 365;
        const q = surfaceQuotes(ctx.spot, t);
        return {
          spotUsd: ctx.spot,
          smileParams: { sigmaGlobal: SIGMA_GLOBAL, alpha: ALPHA, beta: BETA },
          expiryDays: expiryDays ?? DEFAULT_DTE,
          atmVol: round2(q.atmVol),
          expectedMovePct: round2(q.expectedMovePct * 100),
          riskReversal25d: Math.round(q.rr25 * 1e4) / 1e4,
          butterfly25d: Math.round(q.bf25 * 1e4) / 1e4,
          strike25dCall: Math.round(q.k25call),
          strike25dPut: Math.round(q.k25put),
        };
      },
    }),

    price_strategy: tool({
      description:
        "Price a multi-leg option strategy at the protocol's smile: entry cost, max profit/loss, probability of profit, breakevens, net Greeks, per-leg premiums. A payoff chart renders automatically in the chat from this call.",
      inputSchema: z.object({ legs: legsSchema }),
      execute: async ({ legs }) => priceLegs(legs as BuilderLeg[], ctx.spot),
    }),

    suggest_strategies: tool({
      description:
        "Get candidate strategies from the protocol's catalog for a market outlook, with concrete strikes (snapped to the $50 grid at current spot) and live pricing. Use when the user states a view (bullish/bearish/neutral/expecting volatility); then refine with price_strategy and present the best with propose_trade.",
      inputSchema: z.object({
        outlook: z.enum(["bullish", "bearish", "neutral", "volatile"]),
        maxCount: z.number().int().positive().max(10).optional().describe("Default 4"),
      }),
      execute: async ({ outlook, maxCount }) => {
        const picks = STRATEGIES.filter((s) => s.outlook === (outlook as Outlook)).slice(
          0,
          maxCount ?? 4
        );
        return picks.map((s) => {
          const legs = s.build(ctx.spot);
          const priced = priceLegs(legs, ctx.spot);
          return { name: s.name, description: s.description, legs, ...priced };
        });
      },
    }),

    scenario_analysis: tool({
      description:
        "Stress-test a strategy: P&L grid across spot shifts (%) and implied-vol shifts (absolute vol points), optionally rolled forward in time. Use for risk management questions ('what if ETH drops 10%?', 'what does theta do to this over a week?').",
      inputSchema: z.object({
        legs: legsSchema,
        spotShiftsPct: z.array(z.number().min(-90).max(300)).max(9).optional()
          .describe("Default [-20,-10,-5,0,5,10,20]"),
        volShiftsPts: z.array(z.number().min(-70).max(200)).max(7).optional()
          .describe("Absolute vol points, e.g. 20 = +20 pts. Default [-20,0,20]"),
        daysForward: z.number().int().min(0).max(365).optional()
          .describe("Days of time decay to apply (default 0)"),
      }),
      execute: async ({ legs, spotShiftsPct, volShiftsPts, daysForward }) =>
        scenarioGrid(legs as BuilderLeg[], ctx.spot, { spotShiftsPct, volShiftsPts, daysForward }),
    }),

    analyze_adjustment: tool({
      description:
        "Compute the economics of ROLLING or MODIFYING an existing position: cash flow of closing legs at current marks, cost of new legs, net credit/debit, and before/after risk (Greeks, max P/L, breakevens, PoP). Use for every roll (out/up/down), leg into a spread, close the tested side, or partial close — never estimate roll numbers without this tool. Before/after payoff charts render automatically.",
      inputSchema: z.object({
        currentLegs: legsSchema.describe("The FULL current position (kept + to-be-closed legs)"),
        closeLegs: z
          .array(legSchema)
          .max(6)
          .describe("Legs being closed — must be a subset of currentLegs (direction = as held)"),
        openLegs: z
          .array(legSchema)
          .max(6)
          .describe("New legs being opened (empty for a pure close)"),
      }),
      execute: async ({ currentLegs, closeLegs, openLegs }) => {
        let afterLegs: BuilderLeg[];
        try {
          afterLegs = [...subtractLegs(currentLegs as BuilderLeg[], closeLegs as BuilderLeg[]), ...(openLegs as BuilderLeg[])];
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        // Closing a long leg sells it back (+cash); closing a short buys it back (−cash).
        const closeCashFlow = (closeLegs as BuilderLeg[]).reduce((sum, l) => {
          const mark = protocolPremium(ctx.spot, l.strike, l.isCall, (l.expiryDays ?? DEFAULT_DTE) / 365);
          return sum + (l.direction === "buy" ? 1 : -1) * l.amount * mark;
        }, 0);
        const after = afterLegs.length > 0 ? priceLegs(afterLegs, ctx.spot) : null;
        const openCost = after && (openLegs as BuilderLeg[]).length > 0
          ? (openLegs as BuilderLeg[]).reduce((sum, l) => {
              const mark = protocolPremium(ctx.spot, l.strike, l.isCall, (l.expiryDays ?? DEFAULT_DTE) / 365);
              return sum + (l.direction === "buy" ? 1 : -1) * l.amount * mark;
            }, 0)
          : 0;
        const netCashFlow = round2(closeCashFlow - openCost);
        return {
          closeCashFlow: round2(closeCashFlow),
          openCost: round2(openCost),
          netCashFlow,
          netDirection: netCashFlow >= 0 ? "credit (you receive)" : "debit (you pay)",
          before: priceLegs(currentLegs as BuilderLeg[], ctx.spot),
          after,
          afterLegs,
        };
      },
    }),

    get_onchain_quote: tool({
      description:
        "Query the DEPLOYED pricing engine contract for a live call quote (pricingEngine.quote — the exact math the SwapVM instruction runs on-chain, calls only) and cross-check it against the frontend model. Use to demonstrate that copilot pricing matches the chain, or when asked what the contract would actually charge.",
      inputSchema: z.object({
        strike: z.number().positive(),
        expiryDays: z.number().int().positive().max(365),
        isBuy: z.boolean().describe("true = ask (buyer pays), false = bid"),
      }),
      execute: async ({ strike, expiryDays, isBuy }) => {
        const client = getPublicClient(ctx.chainId);
        const onchain = await readOnchainQuote(client, {
          spot: ctx.spot,
          strike,
          expiryDays,
          isBuy,
        });
        const model = protocolPremium(ctx.spot, strike, true, expiryDays / 365);
        return {
          onchainPremiumUsd: round2(onchain),
          frontendModelPremiumUsd: round2(model),
          diffPct: model > 0 ? round2(((onchain - model) / model) * 100) : null,
          note: "On-chain quote() prices calls; difference comes from the contract's ln/sqrt fixed-point approximations and bid/ask rounding.",
        };
      },
    }),

    get_positions: tool({
      description:
        "Read the connected wallet's on-chain state: ETH/WETH/USDC balances, LP range authorizations it wrote (with utilization), and long option positions (OptionToken balances). Requires a connected wallet.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!ctx.address) {
          return { error: "No wallet connected — ask the user to connect their wallet first." };
        }
        const client = getPublicClient(ctx.chainId);
        return await readWalletPositions(client, ctx.address);
      },
    }),

    portfolio_risk: tool({
      description:
        "Aggregate risk for the connected wallet's long option positions: net Greeks, cost basis vs current value, max loss, breakevens, plus a spot/vol stress grid. Use for 'analyze my positions', hedging advice, and portfolio management questions. Requires a connected wallet.",
      inputSchema: z.object({
        includeScenarios: z.boolean().optional().describe("Also run the stress grid (default true)"),
      }),
      execute: async ({ includeScenarios }) => {
        if (!ctx.address) {
          return { error: "No wallet connected — ask the user to connect their wallet first." };
        }
        const client = getPublicClient(ctx.chainId);
        const positions = await readWalletPositions(client, ctx.address);
        if (positions.longOptions.length === 0) {
          return {
            balances: positions.balances,
            lpAuths: positions.lpAuths,
            note: "No long option positions found. LP authorizations (short-side exposure) are listed above if any.",
          };
        }
        const legs = positionsToLegs(positions.longOptions);
        const priced = priceLegs(legs, ctx.spot);
        return {
          balances: positions.balances,
          lpAuths: positions.lpAuths,
          longOptions: positions.longOptions,
          aggregate: priced,
          scenarios:
            includeScenarios === false ? undefined : scenarioGrid(legs, ctx.spot),
        };
      },
    }),

    // ── Client-side UI tools (no execute — rendered by the chat panel) ────────

    propose_trade: tool({
      description:
        "Present a concrete trade proposal to the user as an interactive card with a payoff chart and a 'Load into Payoff Builder' button. Call AFTER pricing the strategy with price_strategy. The user reviews and executes through the existing UI — you cannot trade.",
      inputSchema: z.object({
        name: z.string().describe("Strategy name, e.g. 'Bull Call Spread'"),
        rationale: z.string().describe("One or two sentences: why this trade fits the user's view"),
        legs: legsSchema,
      }),
      // no execute: the CopilotPanel renders the card and acknowledges via addToolOutput
    }),

    quiz_question: tool({
      description:
        "Ask the user ONE interactive multiple-choice quiz question (rendered as clickable choices). For numeric questions, derive the correct answer from a pricing tool call FIRST. The user's pick comes back as the tool result — then explain and update the running score.",
      inputSchema: z.object({
        question: z.string(),
        choices: z.array(z.string()).min(2).max(5),
        correctIndex: z.number().int().min(0).max(4),
        explanation: z.string().describe("Shown after the user answers"),
        topic: z.string().describe("e.g. 'Greeks', 'smile model', 'strategies'"),
      }),
      // no execute: the QuizCard renders choices and answers via addToolOutput
    }),
  };
}

export type CopilotTools = ReturnType<typeof buildTools>;
export type { BuilderLeg };
