// OptionStrat-style strategy catalog: data-driven leg templates, grouped by
// market outlook. Each builder receives the current spot and returns legs
// with strikes snapped to the $50 grid the option matrix quotes on.

import type { BuilderLeg } from "./options";

export type Outlook = "bullish" | "bearish" | "neutral" | "volatile";

export interface StrategyDef {
  name: string;
  outlook: Outlook;
  description: string;
  build: (spot: number) => BuilderLeg[];
}

const snap = (v: number) => Math.round(v / 50) * 50;
const leg = (
  direction: "buy" | "sell",
  isCall: boolean,
  strike: number,
  amount = 1,
  expiryDays = 30
): BuilderLeg => ({ direction, isCall, strike: snap(strike), amount, expiryDays });

export const OUTLOOKS: { key: Outlook; label: string; icon: string }[] = [
  { key: "bullish", label: "Bullish", icon: "▲" },
  { key: "bearish", label: "Bearish", icon: "▼" },
  { key: "neutral", label: "Neutral", icon: "▬" },
  { key: "volatile", label: "Volatile", icon: "◆" },
];

export const STRATEGIES: StrategyDef[] = [
  // ── Bullish ────────────────────────────────────────────────────────────────
  {
    name: "Long Call",
    outlook: "bullish",
    description: "Unlimited upside, risk capped at the premium.",
    build: (s) => [leg("buy", true, s)],
  },
  {
    name: "Bull Call Spread",
    outlook: "bullish",
    description: "Buy a call, sell a higher call — cheaper, capped upside.",
    build: (s) => [leg("buy", true, s), leg("sell", true, s * 1.1)],
  },
  {
    name: "Bull Put Spread",
    outlook: "bullish",
    description: "Credit spread: sell a put, buy a lower put as protection.",
    build: (s) => [leg("sell", false, s * 0.95), leg("buy", false, s * 0.85)],
  },
  {
    name: "Call Ratio Backspread",
    outlook: "bullish",
    description: "Sell 1 call, buy 2 higher calls — profits on a big rally.",
    build: (s) => [leg("sell", true, s), leg("buy", true, s * 1.08, 2)],
  },
  {
    name: "Risk Reversal",
    outlook: "bullish",
    description: "Sell a put to finance a call — synthetic long exposure.",
    build: (s) => [leg("sell", false, s * 0.92), leg("buy", true, s * 1.08)],
  },
  // ── Bearish ────────────────────────────────────────────────────────────────
  {
    name: "Long Put",
    outlook: "bearish",
    description: "Profits as price falls, risk capped at the premium.",
    build: (s) => [leg("buy", false, s)],
  },
  {
    name: "Bear Put Spread",
    outlook: "bearish",
    description: "Buy a put, sell a lower put — cheaper, capped payout.",
    build: (s) => [leg("buy", false, s), leg("sell", false, s * 0.9)],
  },
  {
    name: "Bear Call Spread",
    outlook: "bearish",
    description: "Credit spread: sell a call, buy a higher call as protection.",
    build: (s) => [leg("sell", true, s * 1.05), leg("buy", true, s * 1.15)],
  },
  {
    name: "Put Ratio Backspread",
    outlook: "bearish",
    description: "Sell 1 put, buy 2 lower puts — profits on a crash.",
    build: (s) => [leg("sell", false, s), leg("buy", false, s * 0.92, 2)],
  },
  // ── Neutral ────────────────────────────────────────────────────────────────
  {
    name: "Iron Condor",
    outlook: "neutral",
    description: "Sell an OTM strangle, buy wings — income if price stays in range.",
    build: (s) => [
      leg("buy", false, s * 0.85),
      leg("sell", false, s * 0.92),
      leg("sell", true, s * 1.08),
      leg("buy", true, s * 1.15),
    ],
  },
  {
    name: "Iron Butterfly",
    outlook: "neutral",
    description: "Sell an ATM straddle, buy wings — max profit exactly at spot.",
    build: (s) => [
      leg("buy", false, s * 0.9),
      leg("sell", false, s),
      leg("sell", true, s),
      leg("buy", true, s * 1.1),
    ],
  },
  {
    name: "Long Call Butterfly",
    outlook: "neutral",
    description: "Buy-sell-sell-buy calls — cheap bet on price pinning the middle strike.",
    build: (s) => [
      leg("buy", true, s * 0.95),
      leg("sell", true, s, 2),
      leg("buy", true, s * 1.05),
    ],
  },
  {
    name: "Short Straddle",
    outlook: "neutral",
    description: "Sell ATM call + put — harvest premium, unlimited tail risk.",
    build: (s) => [leg("sell", true, s), leg("sell", false, s)],
  },
  {
    name: "Short Strangle",
    outlook: "neutral",
    description: "Sell OTM call + put — wider profit zone than the straddle.",
    build: (s) => [leg("sell", true, s * 1.1), leg("sell", false, s * 0.9)],
  },
  {
    name: "Calendar Spread",
    outlook: "neutral",
    description: "Sell a near-dated call, buy a longer-dated one — harvest time decay.",
    build: (s) => [leg("sell", true, s, 1, 7), leg("buy", true, s, 1, 60)],
  },
  // ── Volatile ───────────────────────────────────────────────────────────────
  {
    name: "Long Straddle",
    outlook: "volatile",
    description: "Buy ATM call + put — profits on a big move either way.",
    build: (s) => [leg("buy", true, s), leg("buy", false, s)],
  },
  {
    name: "Long Strangle",
    outlook: "volatile",
    description: "Buy OTM call + put — cheaper than the straddle, needs a bigger move.",
    build: (s) => [leg("buy", true, s * 1.1), leg("buy", false, s * 0.9)],
  },
  {
    name: "Strip",
    outlook: "volatile",
    description: "Straddle with 2 puts — volatile with a bearish tilt.",
    build: (s) => [leg("buy", true, s), leg("buy", false, s, 2)],
  },
  {
    name: "Strap",
    outlook: "volatile",
    description: "Straddle with 2 calls — volatile with a bullish tilt.",
    build: (s) => [leg("buy", true, s, 2), leg("buy", false, s)],
  },
  {
    name: "Reverse Iron Condor",
    outlook: "volatile",
    description: "Buy the strangle, sell the wings — defined-risk volatility bet.",
    build: (s) => [
      leg("sell", false, s * 0.85),
      leg("buy", false, s * 0.92),
      leg("buy", true, s * 1.08),
      leg("sell", true, s * 1.15),
    ],
  },
];
