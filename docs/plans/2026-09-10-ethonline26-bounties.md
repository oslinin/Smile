# EthOnline 2026 Bounties: Overview

This is the high-level pitch deck for the three Continuity-track bounty
pursuits on this branch — not the implementation plan. Each has its own
detailed task-by-task doc with files, tests, and milestones; this page
exists to hold the *stories* together and give a reader (a judge, a future
contributor, future-you) the shape of all three without reading three full
plans first.

**Branch:** `EthOnline2026_continuation_track`, all three.

## Status (2026-09-10, updated after deadline confirmation)

**The real deadline is September 13, 12:00 PM — 3 days from today, not
September 30.** September 30 is only the grace window for Arc's extra
$2,000 mainnet bonus specifically (Arc mainnet itself doesn't even launch
until Sept 16, so nobody can be on mainnet for the Sept 13 submission —
that bonus is necessarily a follow-up, not part of the base entry). Every
milestone table in the three detailed plans below was written assuming far
more runway than this and needs to be read with that discount applied —
"Day 3," "Day 5" etc. in those docs do not mean 3-5 actual days from now.

**Execution order, as decided:** SpreadVault (1inch) → The Graph → Arc →
MarginVault (1inch, only if time remains). This page is now organized in
that order, not the order the three bounties were originally scoped in.

**The real risk, stated plainly:** three separate bounty builds in ~2.5
working days is enough rope to ship three half-finished things instead of
one or two solid ones. The order above is the triage: SpreadVault and the
subgraph are both genuinely scoped down to something shippable-correctly in
the time available; Arc's base submission is *already done* (see below);
MarginVault is explicitly the thing that gets cut first if the clock runs
out, because rushing a liquidation engine is how you ship a solvency bug,
not a demo.

**Open gap still:** 1inch's and The Graph's own submission deadlines
haven't been independently confirmed — assumed to be the same Sept 13 event
deadline as everything else (one hackathon, one deadline, is the base
assumption), but if either bounty has its own different date, that changes
this page's priority math. Verify if there's a spare minute.

---

## 1inch — Build an Aqua App

**Full plan:** [`2026-09-05-ethonline2026-continuation-track.md`](./2026-09-05-ethonline2026-continuation-track.md)
— two opt-in sibling vaults, Part A (SpreadVault) and Part B (MarginVault).
Both are real product work independent of this bounty; submitting them here
is free reuse, not extra scope. **Given 3 days, Part A is the actual
target; Part B is explicitly stretch** (see "Realistic scope" below) —
this reverses earlier framing that treated MarginVault as the stronger
story. It *is* the stronger story; SpreadVault is what's actually
finishable correctly in the time available.

### Part A — SpreadVault (defined-risk netting) — the real target

Today a call credit spread (short K₁, long K₂) locks collateral as if K₁
were naked, even though the structure's true worst case is capped. Per the
design doc's own table (`docs/plans/2026-07-12-s12-defined-risk-netting.md`),
the two credit-spread structures are collateralized in **different tokens**,
worth being precise about rather than repeating a flattened formula:

```solidity
// Call credit spread (short K1, long K2): WETH-denominated, per the S12 table
escrowWeth = (K2 - K1) * 1e18 / K2;        // e.g. 3000/3200 → 0.0625 WETH, ~16x tighter

// Put credit spread (short K2, long K1): USDC-denominated
escrowUsdc = K2 - K1;                      // e.g. 3200-3000 = 200 USDC vs 3200 today
```

Realistic 3-day scope: A1-A3 (scaffold + shared premium library + `buy()`
pulling the true net escrow, one structure type — call credit spread only).
A4 (settlement/redeem/reclaim) only if A1-A3 land with a day to spare; A5
(debit-spread-as-collateral) is the first thing cut — it was already marked
optional in the source plan.

### Where the SwapVM scoring bonus is real, and where it isn't

The bounty rewards using SwapVM but doesn't require it — checked the actual
code, not just the plan text:

```solidity
// AquaCollateralVault.sol:276 — the honest reason for the split
require(isCall ? collateralToken != premiumToken    // calls: real swap → uses SwapVM
                : collateralToken == premiumToken,    // puts: same token → execPutLeg skips it
        BadTokenPair());
```

Calls genuinely dispatch through `router.swap()` (confirmed live in this
session's Arc trace) because they swap two different tokens — exactly
SwapVM's shape. A call-credit SpreadVault is WETH-for-USDC too, so there's
real room for an honest new `SpreadPremiumInstruction` opcode (long leg's
Ask minus short leg's Bid, inside one order dispatch) — literally "modify
SwapVM opcodes and define your own instructions." Worth attempting only
after A1-A3 are solid; a correct-but-SwapVM-free SpreadVault still
qualifies on the base "Aqua contracts used" requirement.

### Part B — MarginVault — stretch only, cut first if time runs out

The story doesn't need SwapVM at all, and it's genuinely the better Aqua
narrative when there's time to build it right: Aqua's differentiator is
unrehypothecated JIT-pull collateral — a maker's balance sits in their own
wallet until the moment it's actually needed. Every other DeFi margin
system makes you pre-deposit up front. MarginVault extends that idea
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

Why it's demoted to stretch, explicitly: it's an 8-task liquidation engine
(margin calls, auto top-up, a takeover auction, a backstop pool, a two-step
settlement waterfall with haircut-as-last-resort) — exactly the kind of
thing that needs real time to not ship with a solvency bug. Only attempt
this after SpreadVault, The Graph, and Arc's base submission are all done
and there's still runway before Sept 13.

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

Realistic 3-day scope: G1-G4 (local subgraph against Anvil + frontend
wiring, `getLogs` kept as fallback) is a solid, demoable submission on its
own. G5 (real Sepolia contract deploy + Graph Studio deployment — the
plan's own "Anvil-only isn't judgeable" task) is real infra work on top;
attempt it if G1-G4 land with time to spare, since a Studio-hosted
deployment is a meaningfully stronger submission than a local-only demo.
G6 (dynamic OptionToken data sources) and G7 (Subgraph MCP docs) are
explicitly cut — they were already stretch in the source plan.

---

## Circle — Arc (Best DeFi or Agentic Application)

**Full plan:** [`2026-09-10-arc-bounty.md`](./2026-09-10-arc-bounty.md) —
**the base submission already exists.** Verified live on Arc testnet today:
the whole existing stack deploys unmodified (~0.41 USDC total gas) and a
real trade executes end to end (authorize → ship → buy, a real OptionToken
minted). That alone is a legitimate "meaningful use of Arc and USDC" demo —
everything below is about making it *competitive*, not making it *exist*.

### What's actually left for Sept 13

A frontend network entry for Arc (so the demo is a real UI, not `cast`
calls) plus the architecture diagram and video — that's the must-have list,
and it's small because the hard part (proving the stack works on Arc at
all) is already done.

### FX options — same engine, new market (bonus, not required)

Mechanically the *exact* same architecture as today's ETH options, just
pointed at a EUR/USD feed instead of ETH/USD, with USDC/EURC instead of
WETH/USDC — proof the engine is asset-agnostic, aimed at a market (FX
options) that's nearly nonexistent in DeFi. Only attempt if oracle research
(confirming a live Pyth/RedStone feed on Arc) goes fast; the base ETH
product is already a complete, working submission without it.

```solidity
// script/Deploy.s.sol — the whole "port," once a live oracle feed is confirmed
} else if (block.chainid == 5042002) {   // Arc testnet
    usdcAddr   = ARC_USDC;                 // 0x3600...0000, per Arc's own docs
    wethAddr   = ARC_EURC;                 // reused as the "isCall" collateral slot
    oracleAddr = ARC_EUR_USD_FEED;         // Pyth/RedStone, unconfirmed
}
```

### Circle Gateway and RFQ (R6) — cut for Sept 13

Both explicitly out of scope for the 3-day submission — Gateway's Arc
availability isn't even confirmed yet, and RFQ was always a bigger,
separate architectural build. Revisit only in the Sept 16-30 window if the
mainnet bonus is being pursued with spare time. Full stories for both are
still in `docs/plans/2026-09-10-arc-bounty.md` for later.

---

## Cross-cutting

- All three share one eligibility gate: registration as a Continuity
  Project under EthGlobal's Continuity Track. That's an EthGlobal-side
  action, not something checkable from this repo — confirm separately.
- SpreadVault (1inch) and the FX product (Circle) both touch
  `AquaCollateralVault`-adjacent design but never the vault's own bytecode
  — every plan here shares the same ground rule: the main vault stays
  untouched.
- **Cut order if the 3 days compress further, in order:** MarginVault
  (whole thing) → Arc's FX pivot, Gateway, RFQ → The Graph's G5-G7 → 1inch's
  A4-A5. What survives every cut: SpreadVault A1-A3, The Graph G1-G4, and
  Arc's already-verified base submission plus its frontend entry.
