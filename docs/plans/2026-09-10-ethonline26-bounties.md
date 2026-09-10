# EthOnline 2026 Bounties: Overview

This is the high-level pitch deck for the three Continuity-track bounty
pursuits on this branch — not the implementation plan. Each has its own
detailed task-by-task doc with files, tests, and milestones; this page
exists to hold the *stories* together and give a reader (a judge, a future
contributor, future-you) the shape of all three without reading three full
plans first.

**Branch:** `EthOnline2026_continuation_track`, all three.

**Open gap, flagged honestly:** only the Arc bounty's dates are confirmed
(deadline September 30, mainnet gate September 16 — see
`docs/plans/2026-09-10-arc-bounty.md`). The 1inch and The Graph bounty
deadlines haven't been checked yet. Verify both before treating Arc's
timeline as the pacing constraint for all three.

---

## Circle — Arc (Best DeFi or Agentic Application)

**Full plan:** [`2026-09-10-arc-bounty.md`](./2026-09-10-arc-bounty.md) —
already verified live on Arc testnet: the whole existing stack deploys
unmodified (~0.41 USDC total gas) and a real trade executes end to end.

### FX options — same engine, new market

Mechanically the *exact* same architecture as today's ETH options: same
vault, same pricing engine, same settlement — just pointed at a EUR/USD
feed instead of ETH/USD, with USDC/EURC instead of WETH/USDC. The new thing
isn't the tech, it's the market: ETH options are crowded (Deribit,
Panoptic, ...); FX options are nearly nonexistent in DeFi. The pitch is
"same battle-tested engine, aimed at a market nobody's really serving" —
proof the engine is asset-agnostic, not a new feature. And unlike ETH
options (where only puts are fully stablecoin-collateralized), a USDC/EURC
pair means *every* leg of *every* trade — calls and puts alike — is
stablecoin-backed, since EURC is a stablecoin too.

```solidity
// script/Deploy.s.sol — the whole "port," once X1 confirms a live oracle feed
} else if (block.chainid == 5042002) {   // Arc testnet
    usdcAddr   = ARC_USDC;                 // 0x3600...0000, per Arc's own docs
    wethAddr   = ARC_EURC;                 // reused as the "isCall" collateral slot
    oracleAddr = ARC_EUR_USD_FEED;         // chosen in X1 — Pyth/RedStone, TBD
}
// Everything else — Aqua self-deploy, router, engine, hook, vault,
// settlement, lens — already runs unmodified for any non-mainnet chain.
```

### Circle Gateway — liquidity without pre-migration

Bootstrapping liquidity on a brand-new chain is hard — nobody wants to be
first to park capital there. Gateway's unified cross-chain USDC balance
(<500ms, live on seven chains since August 2025, "planned next" for Arc per
Circle's own blog) means an LP's USDC sitting on Ethereum or Base is
*already* usable as collateral on Smile-on-Arc, no manual bridge-and-wait
step first. Real use of a Circle product, not decoration — solves an actual
cold-start problem this deployment would otherwise have.

```
// Illustrative — exact Gateway SDK shape pending X4 research (confirm Arc
// availability before building against it)
gateway.requestBalance({ chain: "arc", token: "USDC", amount })
// → LP's USDC on Ethereum becomes usable as Arc collateral, no bridge step
//   before authorizeRange() / buy().
```

### RFQ (R6) — stretch, addon not replacement

The actual problem: today's pricing is a public formula computed off
Chainlink's *last published* price. If ETH moves $20 in the two seconds
before the next Chainlink update, Smile is still quoting the old price —
free money for a sniper who sees the real one (`docs/limitations.md` L1/L2,
"stale-quote sniping"). RFQ fixes it by having a market maker sign a quote
off their own live price, valid for a short TTL — the taker gets a fair,
current price instead of an exploitable stale one, because the quote was
never sitting around waiting to be picked off.

Already fully speced as R6 in `docs/solutions.md`, deliberately gated,
never built. It's additive: Tier 1 (today's formula quote) stays the
permanent fallback, and `close()` *always* routes through it — a holder is
never captive to a market maker's uptime.

```solidity
// The R6 spec's quote shape (docs/limitations.md) — Tier 2, optional
struct SignedPremium {
    uint256 strike;
    uint256 expiry;
    uint256 premium;
    uint256 maxAmount;
    uint64  ttl;      // expires before it becomes exploitable, same idea
    uint256 nonce;    // as Chainlink's own staleness bound
}
```

---

## 1inch — Build an Aqua App

**Full plan:** [`2026-09-05-ethonline2026-continuation-track.md`](./2026-09-05-ethonline2026-continuation-track.md)
— two opt-in sibling vaults, Part A (SpreadVault) and Part B (MarginVault).
Both are real product work independent of this bounty; submitting them here
is free reuse, not extra scope.

### Part A — SpreadVault (defined-risk netting)

Today a call credit spread (short K1, long K2) locks collateral as if K1
were naked, even though the structure's true worst case is capped at
`K2−K1`. SpreadVault nets at the true max loss instead.

```solidity
// Call credit spread: escrow the true worst case, not K1 as if naked
escrow = ceilDiv(units * (K2 - K1), 1e30);   // ~16x tighter than today
```

### Part B — MarginVault (Aqua's own idea, extended to margin)

The story here doesn't need SwapVM at all. Aqua's differentiator is
unrehypothecated JIT-pull collateral — a maker's balance sits in their own
wallet, earning yield, until the moment it's actually needed. Every other
DeFi margin system makes you pre-deposit up front. MarginVault takes that
somewhere nobody has: a writer's margin stays in their own wallet the whole
time they're solvent, and only gets pulled at the actual moment of
liquidation.

```solidity
// Margin lives in the writer's wallet until a real liquidation event —
// the JIT idea from ship()/buy(), applied to a margin call
function absorb(uint256 sid, address writer) external {
    uint256 shortfall = requiredMargin(sid, writer) - transferred(sid, writer);
    AQUA.pull(writer, strategyHash, USDC, shortfall, address(backstop));
}
```

Sophisticated by the bounty's own bar: worst-of-hour Chainlink marks,
margin calls with auto top-up and covered-position immunity, a 30-minute
writer-takeover auction, a backstop pool, a two-step settlement waterfall
with haircut as a last resort — proven solvent under a fuzzed 40% crash
test. Demoable with zero extra work: `test/MarginDemo.t.sol` and
`keeper/margin.mjs` already walk the full lifecycle.

### Where the SwapVM scoring bonus is real, and where it isn't

The bounty rewards using SwapVM, but doesn't require it. Checked the actual
code, not just the plan text:

```solidity
// AquaCollateralVault.sol:276 — the honest reason for the split
require(isCall ? collateralToken != premiumToken    // calls: real swap → uses SwapVM
                : collateralToken == premiumToken,    // puts: same token → execPutLeg skips it
        BadTokenPair());
```

Calls genuinely dispatch through `router.swap()` (confirmed live in this
session's Arc trace) because they swap two different tokens — exactly
SwapVM's shape. Puts compute the same σ-based premium via a direct
`_putQuote()` call and skip SwapVM entirely, because a same-token operation
has nothing for a swap abstraction to do. MarginVault v1 is puts-only,
single-token by design (matches B3's "as `execPutLeg` does") — forcing
SwapVM in there would mean building a fake USDC-for-USDC "swap" just to
check a box. **Don't.** The bonus is real for SpreadVault's call-credit
path instead (task A3) — that side is genuinely WETH-for-USDC, room for an
honest new `SpreadPremiumInstruction` opcode (long leg's Ask minus short
leg's Bid, inside one order dispatch) rather than a forced one.

---

## The Graph — Best AI Tooling or AI Use Case

**Full plan:** [`2026-09-09-theGraph.md`](./2026-09-09-theGraph.md) —
Continuity pool, since this extends the existing repo rather than starting
fresh.

### The real gap it fixes (L12a)

`frontend/lib/copilot/chain.ts:17` hard-caps at `MAX_AUTHS = 50` — past 50
authorizations ever created, the copilot silently stops seeing new ones,
including its own connected wallet's position. A subgraph replaces that
capped, brute-force scan with a real indexed query. Not bounty-chasing —
this is the actual, correct fix for a bug found and partially patched
earlier today (`LPDashboard.tsx`'s `getLogs` stopgap).

```typescript
// subgraph/src/vault.ts — sketch, not final
export function handleRangeAuthorized(event: RangeAuthorized): void {
  let auth = new Authorization(event.params.authId.toString())
  auth.lp = event.params.lp
  auth.strikeMin = event.params.strikeMin
  auth.strikeMax = event.params.strikeMax
  auth.active = true
  auth.save()
}
```

### Copilot + subgraph — the "AI agent, live chain data" story

`CopilotPanel` + `/api/copilot` already exist and answer questions from
whatever context they're given. Wiring `get_positions`/`get_market_state`
to query the subgraph instead of the capped RPC scan is exactly the
bounty's "portfolio copilot / risk monitor" framing — not a stretch, a
direct fit for tooling that's already there.

```graphql
# what the copilot's get_positions tool would query instead of scanning
query MyActiveRanges($lp: Bytes!) {
  authorizations(where: { lp: $lp, active: true }) {
    id
    strikeMin
    strikeMax
    expiry
    isCall
  }
}
```

Real tradeoff, not free: a subgraph manifest + mappings, deployed to Graph
Studio, plus wiring the copilot to query it. A few hours, not a few
minutes — but it's the right fix regardless of the bounty.

---

## Cross-cutting

- All three share one eligibility gate: registration as a Continuity
  Project under EthGlobal's Continuity Track. That's an EthGlobal-side
  action, not something checkable from this repo — confirm separately.
- Parts A/B (1inch) and the FX product (Circle) both touch
  `AquaCollateralVault`-adjacent design but never the vault's own bytecode
  — all three plans share the same ground rule: the main vault stays
  untouched.
- If time gets scarce across all three at once: Arc's mainnet deploy (X6 in
  its plan) is the one deadline-gated, cannot-cut task known so far. Revisit
  this section once 1inch's and The Graph's actual deadlines are confirmed.
