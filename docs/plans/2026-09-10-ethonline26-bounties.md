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

**Deadline, confirmed:** September 13, 12:00 PM, for all three — one
hackathon, one submission deadline. The only date after that is Arc's
mainnet-bonus grace window (Sept 30), which is a post-submission follow-up
for the extra $2,000, not a second deadline for anything else.

---

## 1inch — Build an Aqua App

**Full plan:** [`2026-09-05-aqua.md`](./2026-09-05-aqua.md)
— two opt-in sibling vaults, Part A (SpreadVault) and Part B (MarginVault).
Both are real product work independent of this bounty; submitting them here
is free reuse, not extra scope. **SpreadVault alone is a complete,
standalone submission** — checked against 1inch's actual qualification
list (official Aqua contracts, onchain execution in the demo, proper git
history), it satisfies all of it without MarginVault as a companion. Given
3 days, Part A is the actual target; Part B is explicitly stretch (see
"Realistic scope" below) — this reverses earlier framing that treated
MarginVault as the stronger
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

### Part B — MarginVault — built after all (2026-09-10, B1–B8 shipped)

> **Status update:** SpreadVault, the subgraph code, and the Arc base
> submission landed with runway to spare, so Part B was attempted on the
> user's call and shipped in full the same day — `dd687dd` → `7098c17`,
> 54 tests, MarginVault 23,463 bytes (no auctioneer split needed), the
> gap-40 solvency test green after lowering the backstop multiple 10× → 7×
> exactly as the source plan's B6 instructs. Demo: `./script/margin-lifecycle.sh`
> (absorb and `MODE=takeover`), `keeper/margin.mjs`, the **Margin · Opt-in
> Puts** tab. What was cut, per the source plan's cut order: partial-unit
> takeover, `test/MarginDemo.t.sol` (the shell script is the demo), per-range
> block caps. Deployed to Sepolia and to Arc testnet, where a real-USDC
> margined put fill locked 1.50 USDC instead of the 3.00 USDC strike
> (`docs/arc-testnet-deployment.md`). The paragraphs below are the
> pre-build framing, kept for the record.

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

### Part C — RfqVault (R6 hybrid RFQ) — built 2026-09-10, beyond the plan

First scoped as the Arc plan's stretch item X7 (the "advanced programmable
money flows" ask was the excuse), but the artifact is a third Aqua app on
any chain, so it is a 1inch submission piece — the same JIT-pull custody
model with a different pricing path. `src/periphery/RfqVault.sol`: the LP
ships a range, signs EIP-712 `Quote(authId, strike, maxAmount,
premiumPerUnit, ttl, nonce)` off-chain from any model, and a taker's
`fill()` recovers the signer, checks ttl / size / nonce, takes premium +
fee and pulls the collateral JIT through Aqua under the strategy
reentrancy guard. `formulaQuote()` exposes the tier-1 Ask the quote is
beating; quotes are single-use and cancellable; no `close()` so holders
are never captive to a market maker's uptime. Built as a vault rather than
a `signedPremium` SwapVM instruction because nonce replay protection needs
state an instruction doesn't have. Eight tests (200 total), the **RFQ ·
Signed Quotes** tab (wallet-signed quotes), `script/rfq-lifecycle.sh`
(formula Ask 691.93 USDC → signed 685.01, 1 WETH pulled JIT, replay
rejected). On Arc testnet with a real-USDC signed fill (0.688860 vs a
0.695819 formula Ask); not on Sepolia. Story for the 1inch judges: tier 1 is the
public floor, tier 2 is price improvement from makers who bring their own
models — tradfi's NBBO — and both settle through the identical Aqua pull.

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
all) is already done. Free bonus if there's time: SpreadVault (built for
the 1inch bounty) is chain-agnostic Solidity — deploying it to Arc
alongside everything else is the same zero-effort broadcast script, and it
makes the Arc submission's actual on-chain surface area look more
substantial. Doesn't replace anything on the must-have list.

### The story is mostly already built — it needs to run on Arc and be framed

An earlier draft of this section read as "just a port," which contradicts
the point this page makes elsewhere: a bare deploy qualifies but doesn't
compete. The reconciliation is that the bounty's own judging language —
"advanced programmable money flows such as conditional payments, onchain
automation or multi-step settlement," plus "yield" and "treasury" as named
categories — is largely satisfied by features that *already exist* and
just need to be deployed on Arc and put on screen in the video/diagram:

- **Conditional payments / programmable money:** Aqua's JIT pull —
  collateral leaves the LP's wallet only at the moment a buyer matches,
  never before. An option itself is a conditional payment instrument
  (premium now, payout contingent on price at expiry).
- **Multi-step settlement:** the README's own six-step walkthrough — buy →
  expiry → permissionless `settleWithChainlinkRound` → `redeem` →
  `reclaimCollateral` — all as real Arc transactions, gas paid in USDC.
- **Onchain automation:** `keeper/roll.mjs`, already built — settle,
  reclaim, revoke, re-ship at the new spot, no human in the loop.
- **Yield / treasury:** One-Click Income (covered-call / cash-secured-put
  presets with estimated APR) is literally the bounty's listed "yield"
  category, already built.
- **Stablecoin-native flows:** puts, premiums, and protocol fees are
  already 100% USDC; on Arc, gas is USDC too — one asset end to end on the
  put side. Plus SpreadVault's defined-risk netting once it lands.

None of that is new code. What it needs is the Arc network entry so it
can be demoed in the real UI, and a video/diagram that names these flows
in the bounty's own vocabulary instead of leaving the judge to infer them.

### FX options — checked 2026-09-10, cut for Sept 13

Mechanically the *exact* same architecture as today's ETH options, just
pointed at a EUR/USD feed instead of ETH/USD, with USDC/EURC instead of
WETH/USDC — proof the engine is asset-agnostic, aimed at a market (FX
options) that's nearly nonexistent in DeFi, and the single most
Arc-specific story available. Its cost was always decided by one
~30-minute check — does a Chainlink-compatible EUR/USD feed exist on Arc
testnet — and the check came back **no**: Pyth doesn't list Arc,
Chainlink/RedStone show nothing for it, Arc's docs list no oracles. The
only oracle actually deployed there is Stork (pull model: adapter +
update-posting flow + API key needed), which is not a one-branch pivot.
So FX is out of the Sept 13 submission by the plan's own rule, with Stork
recorded as the lead for the Sept 16–30 window (details: the Arc plan's
X1 result). What shipped instead is the real-USDC deploy below.

### Real Arc USDC, not a mock — the stablecoin-native story made literal

The Arc deploy branch uses Circle's actual USDC on Arc (`0x3600…0000`,
the 6-decimal ERC-20 view of the chain's native asset) for premiums,
protocol fees, and put collateral — while gas is the same USDC. WETH and
the ETH/USD spot oracle stay mock on Arc (no canonical WETH, no confirmed
feed), and the submission says so plainly. That keeps the demo honest and
still makes "one asset end to end on the put side" an on-chain fact rather
than a slide.

```solidity
// script/Deploy.s.sol — the Arc branch as actually shipped
} else if (block.chainid == 5042002) {
    // real Circle USDC; mock WETH + mock ETH/USD feed, stated as such
    usdcAddr   = 0x3600000000000000000000000000000000000000;
    wethAddr   = address(new MockERC20("Wrapped Ether", "WETH", 18));
    oracleAddr = address(new MockV3Aggregator(8, 3000e8));
}
```

```solidity
// script/Deploy.s.sol — the whole "port," once a live oracle feed is confirmed
} else if (block.chainid == 5042002) {   // Arc testnet
    usdcAddr   = ARC_USDC;                 // 0x3600...0000, per Arc's own docs
    wethAddr   = ARC_EURC;                 // reused as the "isCall" collateral slot
    oracleAddr = ARC_EUR_USD_FEED;         // Pyth/RedStone, unconfirmed
}
```

### Circle App Kits — built after all (2026-09-11/12)

Written off above as "cut for Sept 13"; built once the rest had landed.
`keeper/insurance-gateway.mjs` (Gateway: Sepolia deposit → signed
BurnIntent → attestation → `gatewayMint` on Arc → `fundInsurance`) and
`keeper/backstop-wallet.mjs` (a Circle developer-controlled wallet on
ARC-TESTNET that approves and deposits into `MarginBackstop` through
Circle's API — no treasury key in the repo). Both ran for real on
2026-09-12: insurance fund 4 → 7 USDC, backstop 30 → 31 USDC; hashes in
`docs/arc-testnet-deployment.md`, receipts on the Margin tab, story in
`docs/sponsors/arc.md`. The RFQ tier that used to share this section
belongs to the 1inch track — see **Part C — RfqVault** above.

---

## Cross-cutting

- All three share one eligibility gate: registration as a Continuity
  Project under EthGlobal's Continuity Track. That's an EthGlobal-side
  action, not something checkable from this repo — confirm separately.
- SpreadVault (1inch) and the FX product (Circle) both touch
  `AquaCollateralVault`-adjacent design but never the vault's own bytecode
  — every plan here shares the same ground rule: the main vault stays
  untouched.
- **Cut order if the 3 days compress further, in order** (as written before
  the build; by 2026-09-10 evening MarginVault had shipped, the FX pivot had
  been cut on X1's "no feed" answer, and only The Graph's Studio deployment
  G5 remained open, blocked on a deploy key): MarginVault
  (whole thing) → Gateway, RFQ → Arc's FX pivot (only after X1's oracle
  check has actually been done — cut it on a "no feed" answer, not
  preemptively) → The Graph's G5-G7 → 1inch's A4-A5. What survives every
  cut: SpreadVault A1-A3, The Graph G1-G4, and Arc's already-verified base
  submission plus its frontend entry and the video/diagram that frame the
  existing flows.
