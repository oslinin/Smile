# User Guide — trading and providing liquidity on Smile

This is the hands-on guide: what each tab does, how to build a trade, how
to earn as a liquidity provider, and what you are risking on each rung.
The [README](../README.md) explains *why* the protocol is built this way;
this page explains *how to use it*. The AI copilot (bottom-right) has read
this guide and can walk you through any step or explain a position you
already hold.

## The one idea to understand first

On Smile a **writer** (liquidity provider, LP) never deposits collateral
up front. They *authorize* a range of strikes and expiries and ship that
allowance to 1inch Aqua; the collateral stays in their wallet. When a
**taker** buys an option, the exact collateral for that fill is pulled
just-in-time (JIT) through Aqua into the vault, and an ERC-20
**OptionToken** is minted to the taker. Premiums are priced by the
protocol's own vol surface (a SwapVM opcode; a Uniswap v4 hook nudges the
surface with demand). At expiry, a Chainlink round fixes the settlement
price permissionlessly; the holder redeems intrinsic value from the
escrowed collateral, and the writer reclaims the rest.

Everything below is a variation on where that collateral comes from and
how much of it is needed.

## Networks

| Network | What is real | How to use it |
|---|---|---|
| **Anvil (local)** | mock USDC / WETH, a settable oracle | `./local.sh`; MetaMask on chain 31337; time can be warped, so expiry, settlement and liquidation demos run in minutes |
| **Sepolia** | Circle USDC, canonical WETH, Chainlink ETH/USD; The Graph subgraph | pick Sepolia in the network menu — the app carries the deployed addresses |
| **Arc Testnet** | Circle's native USDC for premium, collateral, margin and gas | pick Arc Testnet (MetaMask adds chain 5042002) |

The **Overview** tab shows which chain you are on and what is real there.
The **Receipts** tab lists every deployed contract and recorded demo
transaction with explorer links.

## Buying an option (Trade tab)

The tab opens on an ETH/USD candlestick chart (TradingView's open-source
Lightweight Charts engine, fed by Coinbase's public hourly candles with
Kraken as a fallback). The protocol's own spot is the dotted blue line;
as you build a strategy below, each leg's strike appears on the chart —
green for long, red for short — with breakevens dashed in yellow. The
market data is context; every price the protocol charges comes from its
oracle and surface.

1. The option chain shows strikes around spot with the live Ask (buy) and
   Bid (sell-back) for calls and puts, quoted from the surface.
2. Pick a strike and size; approve USDC for the premium once.
3. **Buy**: the premium goes to the writer, the fee to the protocol, the
   collateral is pulled from the writer's wallet at that moment, and you
   receive the OptionToken.
4. **Close early**: sell the option back at the live Bid — the vault pays
   you from the writer's escrow and premium; there is always a formula
   price to exit at.
5. **At expiry**: anyone can settle the series with the first Chainlink
   round after expiry; then **Redeem** pays intrinsic value (calls in
   WETH as `(S−K)/S`, puts in USDC as `K−S`).

The **Strategy Builder** under the chain lets you compose multi-leg
strategies (20 presets by outlook, or custom legs) and shows the P&L
curve today / halfway / at expiry, a price × date P&L heat map,
breakevens, probability of profit, net greeks, and — Smile-specific —
what a writer would have to lock for each sell leg on each vault.

## Earning as a liquidity provider

### One-Click (Earn · One-Click)

The simplest way in: choose *covered calls* (hold WETH) or *cash-secured
puts* (hold USDC), a delta band and a tenor; the app authorizes a range at
those deltas and ships it to Aqua. `keeper/roll.mjs` can roll it every
expiry with your own key.

### Write a Range (Earn · Write a Range)

The full form: strike range, expiry, capacity, optional per-block cap and
your own vol multiplier (your quote versus the surface — competing ranges
*are* the vol discovery). Three steps: approve Aqua for the collateral,
`authorizeRange`, `Aqua.ship`. Nothing leaves your wallet until a fill.
Your positions and fills are on **My Positions** (read from The Graph on
Sepolia, from RPC elsewhere).

### Spreads (SpreadVault)

Write a **credit spread** — call credit (short K1, long K2) or put credit
(short K2, long K1) — and only the structure's true maximum loss is
escrowed: `(K2−K1)/K2` WETH per unit for calls, `K2−K1` USDC for puts.
For a 3000/3200 call credit that is 0.0625 WETH instead of 1 WETH. The
taker buys the whole structure as one SpreadToken and pays Ask(long leg)
− Bid(short leg). Settlement is one price through one formula; the payout
can never exceed the escrow.

### Margin (MarginVault, opt-in)

Write puts posting **initial margin** instead of the strike: intrinsic
plus a 50% buffer of the *worst-of-hour* Chainlink mark, capped at the
strike — 1,500 USDC for an at-the-money 3,000 put. This is the one tier
where "the option always pays" can break, so read the waterfall:

- Fall below the 30% **maintenance** floor and anyone may flag you. The
  vault first sweeps your free balance and, if you opted in, pulls a
  top-up from your Aqua allowance; only if that is not enough are you
  flagged. You have **1 hour** to top up to initial margin.
- Then a **30-minute takeover auction**: another writer can take your
  position with a rising bonus; what travels is `min(locked, MM + bonus +
  penalty)`. The holder's option is untouched.
- Unsold, the **backstop pool** (USDC deposited by anyone, 24 h withdrawal
  delay) adopts the position.
- At expiry each writer settles through locked → free → bad debt; the
  series then draws the backstop, then the insurance fund, and only then
  do holders take a **haircut** — announced by an event, after which the
  initial-margin buffer ratchets up.

The **Risk Monitor** tab shows every position's health bar, the mark, the
backstop and insurance, and a live timeline of flags, auctions, absorbs,
settlements and haircuts. "Explain with the copilot" turns the timeline
into a paragraph.

Deposits and withdrawals of free balance go through `deposit` /
`withdraw`; a withdrawal is refused while you are flagged, in debt, or if
it would take any position below initial margin.

### RFQ (RfqVault)

Ship a range as above, then **sign quotes** in your wallet — no gas — for
a strike, size cap, price, and time-to-live. Price them off any model you
like; the tab shows the formula Ask next to your quote. A taker fills the
quote and the collateral is pulled exactly as on the other rungs. Quotes
are single-use (nonce) and cancellable; there is no sell-back on this
vault — holders exit through the formula tier.

## Risks, plainly

- **Main vault, spreads**: fully collateralized at the true maximum loss;
  the risk is the option's own P&L and the oracle at settlement.
- **Margin**: liquidation risk for writers, and a bounded bad-debt risk
  for holders after the backstop and insurance are exhausted
  ([L13](limitations.md)). Naked notional is capped at 7× the backstop.
- **Everywhere**: premiums come from a model with a demand-driven sigma;
  displayed depth is only as firm as the writer's wallet — the firm-escrow
  tier and the S1 firmness checks exist for that ([limitations](limitations.md)).

## Asking the copilot

Try: *"walk me through selling a 30-day cash-secured put"*, *"what does my
range look like right now?"*, *"build me an iron condor around spot"*
(it loads the builder), *"what happens to my margined put if ETH drops
20%?"*, *"explain the last liquidation"* (from the Risk Monitor), *"how do
I sign an RFQ quote?"*. It reads the connected chain, The Graph (on Sepolia
and Arc), Deribit for reference vol, and these docs.

### Trading with the tape

On Sepolia and Arc every range, fill and position is indexed by The Graph
(`subgraph/`), and the copilot's trading tools read that tape — with no
cap on how many ranges exist. Ask it:

- *"What's cheap right now?"* — it screens every live strike, compares
  Smile's implied vol with the nearest listed Deribit instrument and with
  the last fill, and ranks the edge; then it prices the trade and proposes
  it as a card you can load into the builder.
- *"Where is liquidity thin?"* / *"where should I write a range?"* — the
  liquidity map: every range's capacity, how full it is, open interest,
  when it last traded, and the strikes near spot nobody quotes. The card
  it proposes opens **Earn · Write a Range** with the band, expiry and
  size filled in; you review and sign.
- *"What are my greeks?"* / *"hedge my short puts with short calls"* — the
  whole book (long positions and the ranges you wrote) as net delta, gamma,
  theta and vega, then the exact quantity of spot or options that flattens
  the delta.
- *"Quote the 3,000 call for me on RFQ"* — recent fills and reference IV
  for that instrument, a premium inside the formula ask, and a card that
  opens the **RFQ** desk with the quote ready to sign (EIP-712, in your
  wallet — the copilot never holds a key).
- *"Anything on the calendar this week?"* — FOMC, CPI and listed expiries
  with the usual vol behaviour around each.

The **Skills** button in the copilot lists what it knows how to do
(opportunities, risk management, delta hedging, margin, market making,
RFQ quoting, macro context, calendar spreads) with a starter prompt each,
and lets you add your own skill as a markdown note. The gear lets you add
MCP servers, including The Graph's Subgraph MCP, so the copilot can query
any indexed subgraph in natural language.

On the local Anvil chain there is no indexer; the app rebuilds the same
tape from the vault's events, and `./local.sh` seeds 100 trades so the
chart and the screens have something to show. The Trade tab's price chart
draws the traded premium and implied vol of any instrument next to the
ETH candles.
