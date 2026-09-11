// What the copilot knows about the tab the user is looking at: a briefing
// for the system prompt (what the tab shows, which guide section explains
// it, which tools/skills fit) and the starter prompts the panel shows there.
// Shared by the client (starters) and the server (prompt).

export type TabId =
  | "story" | "chain" | "income" | "lp-auth" | "spreads" | "margin" | "risk" | "rfq" | "lp-position" | "surface" | "proof";

export interface TabBriefing {
  label: string;
  /** What is on screen, in one or two sentences — the copilot explains THIS. */
  shows: string;
  /** read_docs section ids that explain the tab. */
  docs: string[];
  /** What a good first move is here, tools included. */
  suggest: string;
  starters: string[];
}

export const TABS: Record<TabId, TabBriefing> = {
  story: {
    label: "Overview",
    shows: "The capital-efficiency ladder as live bars from the connected chain (naked → spread → margined collateral for the same trade), live counters across all vaults, the recorded testnet receipts, and which chain the user is on.",
    docs: ["guide/the-one-idea-to-understand-first", "guide/networks", "readme/the-thesis"],
    suggest: "Explain the one idea (collateral stays in the wallet until a buyer fills, pulled JIT through Aqua) with the ladder's live numbers, then offer the two paths: buy an option (Trade tab) or earn as a writer (Earn tabs). Use get_market_state for the live spot/vol.",
    starters: ["Explain what I'm looking at on this Overview", "Which tab should I start with as a buyer? As a writer?", "What does the ladder's 16× mean?"],
  },
  chain: {
    label: "Trade",
    shows: "The ETH/USD price chart (TradingView engine) with the strategy drawn on it and, below it, traded premium + implied vol per instrument from the tape; the option chain (Ask per strike, quoted by the on-chain formula); the payoff builder with today/halfway/expiry curves, heat map, breakevens and per-vault collateral.",
    docs: ["guide/buying-an-option-trade-tab", "guide/trading-with-the-tape"],
    suggest: "Start from the tape: find_opportunities for what is cheap or rich right now (say the source), reference_market for the listed vol, then price_strategy and a propose_trade card the user can load into the builder. If they state a view, suggest_strategies first.",
    starters: ["What's cheap on the chain right now?", "I'm bullish on ETH — build me something", "Explain the premium and IV lines on the chart"],
  },
  income: {
    label: "Earn · One-Click",
    shows: "Thetagang-style presets that write a covered call or cash-secured put at a target delta (e.g. the 15Δ call) in one click; the range and collateral are derived from the preset.",
    docs: ["guide/one-click-earn-one-click", "limitations/l8-full-collateralization-is-capital-inefficient-on-purpose"],
    suggest: "Explain what each preset writes and what the writer earns vs risks (short vol, short gamma, assignment at expiry). Use price_strategy for the premium and yield on collateral at the preset's strike; liquidity_map to say whether the book needs that strike.",
    starters: ["Which preset fits a mildly bullish month?", "What do I earn on the 15Δ covered call, and what's the risk?", "Explain one-click income in plain words"],
  },
  "lp-auth": {
    label: "Earn · Write a Range",
    shows: "The full range-writing form: call/put, strike band on the $50 grid, expiry, max collateral (WETH for calls, USDC for puts); the flow is approve → authorizeRange → Aqua.ship, and collateral stays in the wallet until a fill.",
    docs: ["guide/write-a-range-earn-write-a-range", "guide/risks-plainly"],
    suggest: "Run the lp-market-making skill: liquidity_map to find empty/scarce/stale bands near spot, size vs the wallet's balance (get_positions), price_strategy for the expected premium, then a prepare_lp_range card — its button prefills this very form.",
    starters: ["Where is the book missing depth? Fill this form for me", "What range should I write with 2 WETH?", "What are the risks of writing a range?"],
  },
  spreads: {
    label: "Spreads",
    shows: "SpreadVault: the writer's strategy is a credit spread and the escrow pulled through Aqua is the structure's true max loss (0.0625 WETH instead of 1 WETH on a 3000/3200 call spread — 16×).",
    docs: ["guide/spreads-spreadvault", "readme/spreadvault-in-one-table"],
    suggest: "Explain defined-risk netting with live numbers: price_strategy on the spread vs the naked leg, and the per-leg collateral panel. Propose a spread with propose_trade when the user has a view.",
    starters: ["Explain the 16× with today's numbers", "Build me a call credit spread around spot", "Why is a spread cheaper to write here than a naked call?"],
  },
  margin: {
    label: "Margin",
    shows: "MarginVault: opt-in margined puts — initial margin (1,500 USDC for an ATM 3,000 put, not 3,000), margin calls, the 30-min writer-takeover auction, the backstop pool, the insurance fund, and haircut as the last resort.",
    docs: ["guide/margin-marginvault-opt-in", "limitations/l13-bad-debt-in-the-opt-in-margin-tier"],
    suggest: "Run the explain-margin skill: the waterfall in order, what triggers a call, what the writer must do and by when. scenario_analysis for 'what if ETH drops 20%' on a margined put.",
    starters: ["Explain margin here step by step", "What happens to my margined put if ETH drops 20%?", "What is the backstop pool and who funds it?"],
  },
  risk: {
    label: "Risk Monitor",
    shows: "Per-position health bars for margined positions and the liquidation timeline rebuilt from MarginVault events, with an 'explain with the copilot' button.",
    docs: ["guide/margin-marginvault-opt-in", "guide/trading-with-the-tape"],
    suggest: "Run the risk-management skill: portfolio_greeks for the whole book (long and written), scenario_analysis for the stress grid, hedge_suggestion if delta is the problem, analyze_adjustment if a roll is. Explain any liquidation on the timeline from the docs' waterfall.",
    starters: ["What are my greeks and where am I exposed?", "Hedge my book to delta-neutral", "Explain the last liquidation on the timeline"],
  },
  rfq: {
    label: "RFQ",
    shows: "RfqVault: an LP ships a range, signs EIP-712 quotes off-chain (authId, strike, maxAmount, premiumPerUnit, ttl, nonce) inside the formula ask, and a taker fills one; the desk shows the formula ask the quote is beating.",
    docs: ["guide/rfq-rfqvault", "limitations/phase-3-hybrid-rfq-only-if-flow-data-demands-it"],
    suggest: "Run the rfq-quoting skill: find_opportunities / reference_market for the instrument, propose a premium inside the formula ask, then a prepare_rfq_quote card — its button prefills the signer on this tab. For a taker: explain what fill does and the maxPremium guard.",
    starters: ["Quote the ATM call for me on RFQ", "How do I sign a quote, and what does the taker pay?", "Is the formula ask rich vs Deribit right now?"],
  },
  "lp-position": {
    label: "My Positions",
    shows: "The connected wallet's LP ranges (utilisation, expiry) and long option positions, read from The Graph on public networks (the event log on Anvil).",
    docs: ["guide/trading-with-the-tape", "limitations/l12a-no-indexer-lifted-by-the-subgraph-ethonline-2026"],
    suggest: "get_positions or portfolio_greeks, then say what each position is worth now vs cost, what expires soon, and one concrete next step (roll via analyze_adjustment, hedge via hedge_suggestion, or close).",
    starters: ["Summarise my positions and what to do next", "What expires soonest and what is it worth?", "Roll my nearest short leg out a month — what does it cost?"],
  },
  surface: {
    label: "Vol Surface",
    shows: "The 3-D implied-vol surface (strike × tenor) rendered from the protocol's smile parameters and the hook's live sigma buckets, which move with every trade (the σ feedback loop).",
    docs: ["readme/1-multiparameter-volatility-surface", "readme/3-feedback-loop-tenor-aware"],
    suggest: "Explain the smile (sigma_global, alpha, beta) and how flow bends it; get_market_state for ATM vol, risk reversal and butterfly; reference_market to compare with Deribit's surface.",
    starters: ["Explain this surface and why it moves", "How does Smile's vol compare with Deribit right now?", "What is the 25Δ risk reversal telling me?"],
  },
  proof: {
    label: "Receipts",
    shows: "Every deployed contract and recorded demo transaction on the connected chain with explorer links, plus the subgraph endpoint.",
    docs: ["guide/networks", "readme/deployed-addresses-sepolia"],
    suggest: "Explain what each receipt proves (a real fill, a JIT pull, an indexed event) and how to verify one on the explorer or in the subgraph playground.",
    starters: ["What do these receipts prove?", "How do I verify a fill in the subgraph?", "Which chain am I on and what is real here?"],
  },
};

export const isTabId = (v: unknown): v is TabId => typeof v === "string" && v in TABS;
