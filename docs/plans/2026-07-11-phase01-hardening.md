# Implementation Plan: Phase 0 + Phase 1 Hardening

**Goal:** implement Phases 0–1 of [solutions.md](../solutions.md) — markout
instrumentation, honest depth display, adverse-selection hardening (per-block
caps, size-convex pricing, staleness-scaled spread), the firmness bond, and
fill-reliability counters.

**Audience:** this plan is written so it can be executed mechanically, task by
task, without re-deriving any design decisions. Every task states the exact
files, the exact change, the failing test to write first, and the command that
proves it done. If something in the codebase contradicts this plan, STOP and
re-read the referenced source before improvising.

**Branch:** work on `claude/aqua-swapvm-contracts-luef7y`. One commit per
task, message given at the end of each task.

---

## Global rules (read before every task)

1. **Never edit anything under `lib/`** (official 1inch/Uniswap/forge-std
   code) or `src/mocks/` except where a task says so.
2. **`LPAuthorization` struct is append-only.** New fields go at the END of
   the struct (see the comment at `src/vaults/AquaCollateralVault.sol:87-88`);
   the public `authorizations(authId)` tuple prefix must stay ABI-compatible.
3. **The 7-arg `authorizeRange` signature must keep working** — existing
   tests and the frontend call it. New parameters get an overload.
4. **After every task:** run `forge build && forge test`. The full suite
   (82 tests at plan time) must be green before committing. Frontend tasks:
   `cd frontend && npx tsc --noEmit`.
5. **Frontend caution:** read `frontend/AGENTS.md` first — the vendored
   Next.js differs from its usual conventions; consult
   `node_modules/next/dist/docs/` before writing frontend code.
6. Solidity files in `src/` use `pragma solidity 0.8.30` (libraries
   `^0.8.24`). Match the file you're editing.

**Baseline check (do first):**
```bash
cd /home/user/Smile && forge build && forge test   # expect all passing
cd frontend && npx tsc --noEmit                    # expect clean
```

---

## Task 1 — Instruction args v3 plumbing (no behavior change)

New pricing parameters need to travel inside the SwapVM strategy args. This
task ONLY adds the plumbing with zero values, so pricing is bit-identical
before and after — that is the acceptance criterion.

### 1.1 Layout

Args grow from 136 → **148 bytes**. New fields appended after
`maxStaleness` (which ends at offset 136):

| field | type | offset | meaning |
|---|---|---|---|
| `baseSpreadBps` | uint16 | 136–138 | half-spread floor, 1e4 = 100% (R4) |
| `stalenessSpreadBpsPerHour` | uint16 | 138–140 | extra half-spread per hour of oracle age (R3) |
| `impactPerUnit` | uint64 | 140–148 | WAD σ added per option unit traded (R2) |

### 1.2 Changes in `src/swapvm/OptionPremiumInstruction.sol`

- `ARGS_LENGTH`: `136` → `148`.
- `OptionPremiumArgsBuilder.build(...)`: add the three parameters (in the
  order above) and append them in `abi.encodePacked`. Update the layout
  doc-comment ("Packed layout v3 (148 bytes total)").
- `OptionTerms` struct: add `uint256 baseSpreadBps; uint256
  stalenessSpreadBpsPerHour; uint256 impactPerUnit;`.
- `_parseArgs`: after the existing `maxStaleness` line add:
```solidity
terms.baseSpreadBps = uint16(bytes2(args.slice(136, 138, OptionPremiumMissingArgs.selector)));
terms.stalenessSpreadBpsPerHour = uint16(bytes2(args.slice(138, 140, OptionPremiumMissingArgs.selector)));
terms.impactPerUnit = uint64(bytes8(args.slice(140, 148, OptionPremiumMissingArgs.selector)));
```

### 1.3 Changes in `src/vaults/AquaCollateralVault.sol`

- Append to `LPAuthorization` (at the very end):
```solidity
uint16 baseSpreadBps;             // half-spread floor snapshot (R4)
uint16 stalenessSpreadBpsPerHour; // staleness spread slope snapshot (R3)
uint64 impactPerUnit;             // size-impact coefficient snapshot (R2)
```
- Add owner defaults + setter next to `setProtocolFee`:
```solidity
uint16 public defaultBaseSpreadBps;
uint16 public defaultStalenessSpreadBpsPerHour;
uint64 public defaultImpactPerUnit;

function setPricingDefaults(uint16 base_, uint16 perHour_, uint64 impact_) external onlyOwner {
    require(base_ <= 2000 && perHour_ <= 2000, "spread too high"); // 20% cap
    defaultBaseSpreadBps = base_;
    defaultStalenessSpreadBpsPerHour = perHour_;
    defaultImpactPerUnit = impact_;
}
```
- In `authorizeRange` (the existing 7-arg one), snapshot them next to the
  fee snapshot (`auth.feeBps = ...` block):
```solidity
auth.baseSpreadBps = defaultBaseSpreadBps;
auth.stalenessSpreadBpsPerHour = defaultStalenessSpreadBpsPerHour;
auth.impactPerUnit = defaultImpactPerUnit;
```
  IMPORTANT: snapshot BEFORE `auth.strategyHash` is computed (the strategy
  hash must commit to the final args).
- Find every call site of `OptionPremiumArgsBuilder.build(` in the vault
  (`grep -n "OptionPremiumArgsBuilder.build" src/`) and pass
  `auth.baseSpreadBps, auth.stalenessSpreadBpsPerHour, auth.impactPerUnit`
  as the new trailing arguments.
- `script/Deploy.s.sol`: after the existing `setProtocolFee` call add
  `vault.setPricingDefaults(0, 0, 0);` (explicit zeros for now; Task 2/3
  change deploy values).

### 1.4 Other builder call sites

`grep -rn "OptionPremiumArgsBuilder" src/ test/ script/` — update every call
site (tests included) with three trailing zeros so behavior is unchanged.

### 1.5 Test (write FIRST, in new file `test/Phase1Hardening.t.sol`)

Copy the setup pattern from `test/AquaCollateralVault.t.sol` (deploy Aqua,
router, vault, hook, mock oracle, mock tokens; the file shows the full
ceremony — reuse its helper functions by inheritance if it exposes any,
otherwise copy the setUp).

```solidity
function test_argsV3_zeroParams_pricesLikeV2() public {
    // quote a call via router.quote through the vault order, with all three
    // new params at 0, and assert the premium equals OptionPricingEngine
    // .quoteSurface for the same inputs (the pre-existing parity property).
}
```
Run: `forge test --match-contract Phase1Hardening -vv` (red → implement →
green), then the FULL suite (every pre-existing test must still pass — that
is the real acceptance test of this task).

**Commit:** `Instruction args v3: spread + impact parameters (plumbing, zero-valued)`

---

## Task 2 — R3 staleness-scaled spread (+ R4 floor via config)

### 2.1 Design (do not re-derive)

Half-spread in bps, applied symmetrically around the model premium:
```
ageSec        = block.timestamp − oracle.updatedAt
halfSpreadBps = min(2000, baseSpreadBps + stalenessSpreadBpsPerHour · ageSec / 3600)
Ask: premiumWad = ceil(premiumWad · (1e4 + halfSpreadBps) / 1e4)
Bid: premiumWad = floor(premiumWad · (1e4 − halfSpreadBps) / 1e4)
```
R4 ("spread floor ≥ Δ·devThreshold·spot") is implemented **operationally**:
deploy sets `baseSpreadBps = 50` (0.5% — Chainlink ETH/USD deviation
threshold). No on-chain delta computation.

### 2.2 Changes in `src/swapvm/OptionPremiumInstruction.sol`

- `_oracleSpotWad` currently returns only the spot. Change it to also return
  the age: `returns (uint256 spotWad, uint256 ageSec)` where
  `ageSec = updatedAt >= block.timestamp ? 0 : block.timestamp - updatedAt`.
  Update its call site in `_optionPremiumXD`.
- In `_optionPremiumXD`, after `premiumWad` is computed (currently
  `SmileMath.premium(...)` at ~line 126), apply the formula above using
  `terms.baseSpreadBps` / `terms.stalenessSpreadBpsPerHour`. Use
  `Math.ceilDiv` for the Ask side. `forward == true` is Ask.

### 2.3 Changes in `src/vaults/AquaCollateralVault.sol` (puts)

Puts are priced vault-side in `_putUnitPremiumWad` (line ~710), which reads
spot via the vault's `_spotWad` (line ~725). Mirror the instruction exactly:
- `_spotWad` also returns `ageSec` (same rule).
- `_putUnitPremiumWad` applies the same halfSpread formula using the auth's
  snapshots, ceil on the ask path (`roundUp == true` parameter), floor on
  the bid path.

### 2.4 `script/Deploy.s.sol`

`vault.setPricingDefaults(50, 25, 0);` — 0.5% base half-spread, +0.25%/hour
of oracle age, impact still 0 (Task 3).

### 2.5 Tests (write FIRST, red → green)

In `test/Phase1Hardening.t.sol` (the mock oracle `MockV3Aggregator` sets
`updatedAt` on `setAnswer` — re-set the answer after `vm.warp` to control
age):
```solidity
function test_spread_askGrowsWithOracleAge() public {}   // quote, warp +2h WITHOUT re-setting answer but within maxStaleness=0 auth, re-quote, assert ask increased
function test_spread_bidShrinksWithOracleAge() public {} // same for bid (close-side quote)
function test_spread_cappedAt20Percent() public {}       // absurd perHour value via setPricingDefaults revert OR capped math with large age
function test_spread_bidNeverExceedsAsk() public {}      // for several ages/strikes assert bid <= ask
function test_put_spreadMirrorsCall() public {}          // put ask/bid widen identically vault-side
```
NOTE: to get a large age without tripping staleness, authorize with
`maxSpotStaleness = 0` (0 = no staleness check — see `_oracleSpotWad`).

**Commit:** `R3+R4: staleness-scaled half-spread with 0.5% base floor`

---

## Task 3 — R2 size-convex pricing (intra-trade impact)

### 3.1 Design (do not re-derive)

A trade of `units` (WAD) executes at the σ it would itself cause, averaged:
```
Ask (forward): sigmaEff = sigmaStrike + impactPerUnit · units / (2·1e18)
Bid (reverse): sigmaEff = sigmaStrike − impactPerUnit · units / (2·1e18),
               floored at sigmaStrike / 10
```
- **exactOut forward** (vault's buy path — units are known): direct.
- **exactIn forward** (units unknown until priced): two fixed-point
  iterations — `units₀` from σ without impact, `units₁` from
  σ(units₀), final output from σ(units₁). Convergence is monotone
  (more impact → fewer units → less impact); two iterations is the spec,
  do not add more.
- **reverse** paths mirror with subtraction (exactIn reverse: units known,
  direct; exactOut reverse: iterate the same way).

### 3.2 Changes in `src/swapvm/OptionPremiumInstruction.sol`

Restructure `_optionPremiumXD` so premium computation is a private helper:
```solidity
function _premiumWadFor(OptionTerms memory terms, uint256 spot, uint256 ageSec,
    uint256 strike, uint256 timeToExpiry, uint256 sigmaTenor,
    bool forward, uint256 unitsWad) private pure returns (uint256)
```
which computes `sigmaStrike` (smileVol), applies the impact adjustment for
`unitsWad`, calls `SmileMath.premium`, then applies the Task-2 spread. The
four branches of `_optionPremiumXD` call it with the correct `unitsWad`
(known amount, or the iteration described above).

### 3.3 Vault (puts)

`_putUnitPremiumWad` is per-unit; its callers know `amount`. Add the same
adjustment there using `auth.impactPerUnit` and the caller's `amount` (ask:
`+`, bid: `−` floored at σ/10).

### 3.4 Deploy value

`vault.setPricingDefaults(50, 25, 0.001e18);` — σ rises 0.1 vol-points per
whole option bought within a single trade (10 units → +0.5 vol points on
average, matching the post-trade `GAMMA` bump's order of magnitude).

### 3.5 Tests (write FIRST)

```solidity
function test_impact_perUnitPremiumIncreasesWithSize() public {} // ask premium per unit for 10 units > for 1 unit
function test_impact_bidPerUnitDecreasesWithSize() public {}
function test_impact_exactInConsistentWithExactOut() public {}   // buy N units exactOut, then quote exactIn with that premium: units within 1% of N
function test_impact_zeroCoefficientUnchanged() public {}        // impact=0 auth prices exactly as Task-2 build
function test_impact_bidSigmaFloored() public {}                 // huge sellback size cannot push sigma below sigmaStrike/10 (bid stays > 0 for ITM)
```

**Commit:** `R2: size-convex pricing — trades execute at their own average impact`

---

## Task 4 — R1 per-block notional cap

### 4.1 Changes in `src/vaults/AquaCollateralVault.sol`

- Append to `LPAuthorization`:
```solidity
uint128 maxBlockNotional; // 0 = uncapped; collateral units per block
uint128 blockNotional;    // running total for lastTradeBlock
uint64  lastTradeBlock;
```
- New 8-arg overload; the existing 7-arg body moves into it, 7-arg delegates:
```solidity
function authorizeRange(..., bool isCall) external returns (uint256) {
    return authorizeRange(..., isCall, 0);
}
function authorizeRange(..., bool isCall, uint128 maxBlockNotional) public returns (uint256 authId) {
    // existing body + auth.maxBlockNotional = maxBlockNotional;
}
```
- In `buy()`, immediately after the existing `require(amount > 0, ...)`:
```solidity
if (auth.maxBlockNotional > 0) {
    if (auth.lastTradeBlock != uint64(block.number)) {
        auth.lastTradeBlock = uint64(block.number);
        auth.blockNotional = 0;
    }
}
```
  and after `collateralNeeded` is computed:
```solidity
if (auth.maxBlockNotional > 0) {
    require(auth.blockNotional + collateralNeeded <= auth.maxBlockNotional, "block cap");
    auth.blockNotional += SafeCast.toUint128(collateralNeeded);
}
```

### 4.2 Tests (write FIRST)

```solidity
function test_blockCap_secondBuySameBlockReverts() public {}  // cap = 1 WETH; buy 0.7 then 0.5 same block → revert "block cap"
function test_blockCap_resetsNextBlock() public {}            // vm.roll(block.number + 1); second buy succeeds
function test_blockCap_zeroMeansUncapped() public {}          // 7-arg authorize; large buys fine
```

### 4.3 Frontend

`frontend/components/AuthorizeRange.tsx`: add an optional "Max per block"
input (default 25% of max collateral) and call the 8-arg overload when set.
(Wagmi overloads: give the 8-arg entry its own ABI array entry; select by
args length.) Keep the 7-arg path when the field is empty.
`cd frontend && npx tsc --noEmit` must pass.

**Commit:** `R1: per-block notional cap bounds loss per staleness event`

---

## Task 5 — S2 firmness bond + S3 reliability counters

### 5.1 Design (do not re-derive)

- LP posts a bond in the **collateral token** at authorize time:
  `bond = maxCollateral · firmnessBondBps / 1e4` (owner-set
  `firmnessBondBps`, default 25 = 0.25%; 0 disables bonds globally).
  Transferred `LP → vault` inside `authorizeRange` (LP must ERC-20 approve
  the VAULT — document in the `getShipParams` natspec and README).
- If a fill fails because Aqua cannot pull the LP's collateral (balance
  moved / allowance revoked): the buyer is made whole (premium refunded on
  the call path), paid `compensation = bond / 2` from the bond, the
  authorization is **deactivated** (`active = false`), the LP's
  `failedPulls` counter increments, and `buy()` returns
  `(address(0), 0)` instead of reverting (a revert would undo the
  compensation). Remaining bond returns to the LP on `revokeAuthorization`
  (find the existing revoke function; add bond refund there and in the
  failure path refund `bond − compensation`... NO — keep it simple: on
  failure, pay `bond/2` to buyer and `bond/2` back to the LP immediately,
  zero the stored bond).
- Successful `buy()` increments `fills[lp]`.

### 5.2 Changes in `src/vaults/AquaCollateralVault.sol`

- Storage:
```solidity
uint16 public firmnessBondBps; // of maxCollateral, 1e4 scale; 0 = disabled
mapping(uint256 => uint256) public bondOf;        // authId => remaining bond
mapping(address => uint64) public fills;          // lp => successful fills
mapping(address => uint64) public failedPulls;    // lp => failed JIT pulls
event PullFailed(uint256 indexed authId, address indexed lp, address indexed buyer, uint256 compensation);
function setFirmnessBondBps(uint16 bps_) external onlyOwner { require(bps_ <= 500, "bond too high"); firmnessBondBps = bps_; }
```
- `authorizeRange` (8-arg body): after the struct is populated,
  `bond = maxCollateral * firmnessBondBps / 1e4`; if > 0,
  `safeTransferFrom(msg.sender, address(this), bond)` of
  `collateralToken` and record `bondOf[authId]`.
- Revoke path: refund `bondOf[authId]` to the LP, zero it.
- **Call path** — in `buy()`, wrap the call-leg execution:
```solidity
try this.externalBuyCall(authId, strike, amount, maxPremium) returns (uint256 p) {
    premiumPaid = p;
} catch {
    _handlePullFailure(authId, auth);
    return (address(0), 0);
}
```
  where `externalBuyCall` is a thin `external` wrapper around
  `_buyCallViaSwapVM` guarded by `require(msg.sender == address(this))`.
  CAREFUL: `_buyCallViaSwapVM` does `safeTransferFrom(msg.sender, ...)` for
  the premium — inside the self-call `msg.sender` is the vault, so the
  premium pull from the buyer must move OUT of `_buyCallViaSwapVM` into
  `buy()` before the try (and be refunded inside the catch branch). Pass the
  buyer address through explicitly.
- **Put path** — same pattern: an external self-call wrapper around
  `_buyPutViaAquaPull` (premium `safeTransferFrom` uses `msg.sender` there
  too — hoist the buyer transfers into `buy()` the same way, or pass the
  buyer address in; keep the `nonReentrantStrategy` modifier on the wrapped
  function).
- `_handlePullFailure`: deactivate auth, `failedPulls[auth.lp]++`, split
  `bondOf[authId]` half to buyer / half to LP, zero it, refund the buyer's
  premium if already collected, emit `PullFailed`.
- Success path (both legs): `fills[auth.lp]++`.

### 5.3 Tests (write FIRST)

```solidity
function test_bond_collectedOnAuthorize_refundedOnRevoke() public {}
function test_pullFailure_call_buyerRefundedAndCompensated() public {}
    // ship + authorize, then as LP: WETH.approve(aqua, 0); buy → returns (0,0),
    // buyer USDC balance unchanged, buyer WETH balance +bond/2, auth inactive,
    // failedPulls[lp] == 1
function test_pullFailure_put_symmetric() public {}
function test_fills_incrementOnSuccess() public {}
function test_bond_zeroBpsDisablesBond() public {}
function test_buy_revertsNormallyOnPremiumAboveMax() public {}
    // slippage failures must NOT eat the bond: maxPremium=1 → whole tx reverts
    // (require the slippage check happens BEFORE/OUTSIDE the try, on the quote)
```
The last test pins an important subtlety: quote first (`router.quote` /
put quote), check `maxPremium` OUTSIDE the try, so only genuine pull
failures trigger compensation.

**Commit:** `S2+S3: firmness bond, pull-failure compensation, LP reliability counters`

---

## Task 6 — Honest depth display (frontend, S1)

### 6.1 New hook `frontend/hooks/useFirmDepth.ts`

Inputs: `lp`, `collateralToken`, `maxCollateral`, `usedCollateral`. Reads,
via wagmi `useReadContracts` with a 10s `refetchInterval` (match the polling
style in `frontend/app/page.tsx:106-119`):
- `IERC20(collateralToken).balanceOf(lp)`
- `IERC20(collateralToken).allowance(lp, AQUA)`

Returns `firmDepth = min(maxCollateral − usedCollateral, balance, allowance)`
plus a `soft: boolean` flag (`firmDepth < maxCollateral − usedCollateral`).

The Aqua address: add `aqua` to `CONTRACTS` in `frontend/config/wagmi.ts`
following the exact pattern of the existing entries (env var
`NEXT_PUBLIC_AQUA`); add the export to `local.sh` next to where the other
contract addresses are exported (grep `NEXT_PUBLIC_AQUA_VAULT` there and in
`script/Deploy.s.sol` logs to find the address source).

### 6.2 Use it in `frontend/components/OptionMatrix.tsx`

Where the chain displays available size for the active auth: show
`firmDepth`, render a yellow "soft" badge with tooltip ("LP wallet holds
less than the authorized size — fills may fail") when `soft`, and disable
the Buy button when the requested amount exceeds `firmDepth`.

### 6.3 Verify

`cd frontend && npx tsc --noEmit`. If an Anvil demo environment is
available (`local.sh`, `script/DemoTrade.s.sol`), run it, move WETH out of
the LP wallet, and confirm the badge appears.

**Commit:** `S1: honest depth — display min(authorized, balance, allowance)`

---

## Task 7 — Markout instrumentation (S8, off-chain)

### 7.1 New script `analytics/markouts.mjs`

Plain Node + `viem` (add a minimal `analytics/package.json`; do NOT touch
the frontend's package.json). Env: `RPC_URL`, `VAULT`, `ENGINE`
(OptionPricingEngine), `HOOK`, `ORACLE`.

Loop:
1. Backfill + watch `OptionBought(authId, optionToken, buyer, strike,
   amount, premium)` events on the vault (`getLogs` from a checkpoint block
   stored in `analytics/state.json`).
2. For each fill, schedule re-quotes at +60s, +300s, +1800s. A re-quote
   calls `OptionPricingEngine.quote(PricingParams)` — read
   `src/swapvm/OptionPricingEngine.sol` (quote is at line 24) for the exact
   `PricingParams` fields and mirror how `test/OptionPricingEngine.t.sol`
   constructs them (spot from the oracle, sigma from `hook.sigmaFor`,
   alpha/beta from the hook).
3. Append rows to `analytics/markouts.csv`:
   `txHash,blockTime,authId,strike,amount,side,tradePremiumPerUnit,quote1m,quote5m,quote30m,markout1m,markout5m,markout30m`
   where `markoutN = side == ASK ? tradePremiumPerUnit − quoteN : quoteN −
   tradePremiumPerUnit` (positive = LP won).
4. Also watch `OptionClosed` for the bid side.

### 7.2 Verify

Run the Anvil demo (`script/DemoTrade.s.sol`), run the script against it,
confirm a CSV row with all three markout columns appears for the demo's buy
(use short intervals via env override `MARKOUT_INTERVALS=5,10,15` seconds
for the test).

**Commit:** `S8: markout instrumentation — per-fill re-quotes at 1/5/30 minutes`

---

## Task 8 — Documentation sync + final verification

1. `README.md`: add the new LP steps (approve VAULT for the bond; optional
   per-block cap), the spread/impact parameters, and the honest-depth
   behavior. Keep edits surgical — the README was recently overhauled.
2. `docs/solutions.md`: mark S1, S2, S3, S8, R1–R4 as **implemented** in the
   phase table (add a Status column).
3. Regenerate help: `cd frontend && npm run gen-help` (this repo's README →
   help.html pipeline).
4. Full verification:
```bash
forge build && forge test          # everything green
cd frontend && npx tsc --noEmit    # clean
```
5. If an Anvil environment works, run `script/DemoTrade.s.sol` end-to-end
   as the final smoke test (the repo's previous PRs document the expected
   flow: buy → sellback → settle → redeem).

**Commit:** `Docs: phase 0-1 hardening — README, solutions status, help.html`

Then push (`git push -u origin claude/aqua-swapvm-contracts-luef7y`) — the
commits land on the open PR #7 (or the current branch PR).

---

## Explicitly OUT of scope (do not start these)

- S5/S6 (LP-quoted vol, best-quote routing) — Phase 2, needs its own plan.
- R5 (Pyth) — Phase 2.
- S4 (firm tier / yield-bearing collateral escrow) — Phase 3.
- Anything touching `lib/`, the CRE workflow, or settlement contracts.

## If a task fails in a way this plan didn't predict

Do not improvise a different architecture. Record exactly what failed (test
output, revert reason), check the referenced line numbers against the actual
file (they may have drifted), and if the contradiction is real, stop and
surface it in the PR description instead of forcing the plan through.
