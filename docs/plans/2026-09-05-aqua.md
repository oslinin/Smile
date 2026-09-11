# EthOnline 2026 Continuation Track: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use superpowers:executing-plans (or superpowers:subagent-driven-development). Write the failing test first. One task, one commit.

**Goal:** Two opt-in sibling vaults. SpreadVault escrows a spread at its true worst case (Part A). MarginVault lets a put writer post part of the strike, with liquidation and a backstop behind it (Part B). The main vault is not touched.

**Branch:** `EthOnline2026_continuation_track`, cut from `main` (5b4cc63).

**Architecture.** Both vaults are new AquaApps under `src/periphery/`, the FirmEscrow pattern: LPs ship to the sibling, the sibling does the JIT pull. Each gets its own `AquaOptionSettlement` (the deployed one has a single one-time registrar). `src/vaults/AquaCollateralVault.sol` stays at 24,364 bytes, unchanged. Part A keeps the promise that a written option always pays. Part B can break it, but only inside the opt-in vault, only after writer margin, a takeover buyer, the backstop pool and the insurance fund are all empty, and never because sigma moved.

**Stack:** Solidity 0.8.30, Foundry, vendored 1inch Aqua and SwapVM, Next.js frontend, viem keeper.

## Ground rules

- Never edit `lib/`, `src/mocks/`, or `AquaCollateralVault.sol`.
- `forge build && forge test` green before every commit. Frontend changes also pass `cd frontend && npx tsc --noEmit`.
- New tests copy the `test/FirmEscrow.t.sol` setUp recipe. There is no shared harness.
- Baseline today: `forge test` prints `127 tests passed`.
- Every Part B commit body records `forge build --sizes` for MarginVault.

## Words used

- **Writer** sells the option and posts collateral. **Holder** buys it.
- **Spread**: a short option plus a long option, same expiry; the long leg caps the loss. **Credit** spread: the writer receives net premium. **Debit** spread: the holder pays net premium. **Iron condor**: a put credit and a call credit sold together.
- **K, S, u**: strike, settlement price, units (all 1e18). **Intrinsic**: what an option is worth right now, `max(K-S,0)` for a put.
- **Sigma**: the volatility number behind premiums; trades move it. **Notional**: `K x units`. **Naked notional**: notional not backed by locked collateral.
- **IM / MM**: initial margin posted at fill / maintenance margin, the floor below which liquidation starts. **Mark**: the price margin math uses. **Worst-of**: the lowest price in a window.
- **Backstop**: a pre-funded USDC pool that adopts positions nobody buys. **Waterfall**: the fixed order money is taken from. **Haircut**: holders get less than owed; last resort.
- **JIT**: collateral is pulled from the LP wallet at fill, never parked in advance. **Heartbeat**: Chainlink posts at least hourly on mainnet.

## Part A: Defined-risk netting (rungs 2 and 3)

The S12 formulas are right in exact arithmetic but not in integers: rounding each leg down can leave a payout 1 wei above escrow, and two legs settled by two paths can see two prices. So every structure is one series, one settlement price, one token (USDC), one net payout formula, capped at escrow. Derivation: `docs/plans/2026-07-12-s12-defined-risk-netting.md`.

| Structure (writer's view) | Escrow per unit | Holder payout at S |
|---|---|---|
| Call credit: short K1, long K2 | `ceilDiv(u*(K2-K1), 1e30)` | `floor(u*(min(max(S,K1),K2)-K1)/1e30)` |
| Put credit: short K2, long K1 | `ceilDiv(u*(K2-K1), 1e30)` | `floor(u*(K2-max(min(S,K2),K1))/1e30)` |
| Iron condor (K2p < K1c) | `max(put side, call side)`, not the sum | the two rows summed; at most one is non-zero |
| Debit: long OptionToken as collateral | 0 USDC; the long token itself | `units * owedPerUnit` from the redeemed long leg (A5) |

### A1: SpreadVault scaffold, ranges, own settlement
**Files:** create `src/periphery/SpreadVault.sol`, `src/periphery/SpreadToken.sol`; test `test/SpreadVault.t.sol`.
**Test first:** `test_open_shipHashMatchesAqua` (Aqua `rawBalances` equals `maxCollateral`, the vault's USDC balance stays 0); `test_setSettlement_onlyOnce`.
**Implement:**
- `contract SpreadVault is AquaApp, Ownable`; `constructor(aqua, spotOracle, hook, owner, usdc)`; `enum Kind { CallCredit, PutCredit, IronCondor }`; `struct Structure { lp, kind, strikes[4], expiry, maxCollateral, active, strategyHash, feeBps, feeRecipient }`.
- `openStructure(kind, strikes, expiry, maxCollateral) returns (authId)` with `K1 < K2` (condor: `K2p < K1c`); `getShipParams`, `getDockParams`, `revokeStructure`; `seriesId(authId) = keccak256(abi.encode("SMILE-SPREAD-1", authId))`.
- `setSettlement(address)` one-time. Tests wire `new AquaOptionSettlement(address(0), owner, chainlinkMock)` plus `setRegistrar(spread)`. The feed must expose `getRoundData` (Chainlink-style, never `PythSpotAdapter`).
**Verify:** `forge test --match-contract SpreadVaultTest` passes.
**Commit:** `feat(spread): SpreadVault scaffold with own Aqua strategy and settlement`

### A2: Shared premium library, two-leg quote
**Files:** create `src/periphery/SmilePremiumLib.sol`; modify `SpreadVault.sol`; test `test/SpreadVault.t.sol`.
**Test first:** `test_quote_putLegMatchesVaultPutQuote` (library Ask equals `vault.putQuote` to the wei, terms built from `vault.authorizations` and `vault.pricingOf`); `test_quote_spreadIsAskMinusBid`.
**Implement:**
- Port `_putUnitPremiumWad` into `SmilePremiumLib` with an `isCall` flag and the same fee gross-up as `_putQuote`; `MIN_QUOTE_SIGMA = 0.2e18`, because sigma can be walked to zero (L7).
- `SpreadVault.quote(authId, units) returns (premium, fee, escrow)`: long leg at Ask minus short leg at Bid, floored at 1 USDC unit.
**Verify:** `forge test --match-contract SpreadVaultTest` passes.
**Commit:** `feat(spread): SmilePremiumLib and spread quote`

### A3: buy() pulls exactly max loss, mints one series token
**Files:** modify `SpreadVault.sol`; test `test/SpreadVault.t.sol`.
**Test first:** `test_buy_callCreditPulls200not3200` (K1 3000, K2 3200, 1 unit: the LP wallet drops by exactly 200e6); `test_buy_condorPullsMaxNotSum`; `test_buy_revertsAfterExpiry`.
**Implement:**
- `buy(authId, units, maxPremium) returns (token, premiumPaid)`: `require(block.timestamp < expiry)`; escrow per the table; one self-call `execPull` under `nonReentrantStrategy` that moves premium and fee, then `AQUA.pull(lp, hash, usdc, escrow, this)`. A failed pull reverts. There is no firmness bond here, so never return `(0, 0)` silently.
- Lazy `new SpreadToken`; `settlement.registerSeries(seriesId, token, expiry, strikes[0], isCall)`; `positions[token][lp].escrow += escrow`; emit the main vault's `OptionBought` ABI.
**Verify:** `forge test --match-contract SpreadVaultTest` passes.
**Commit:** `feat(spread): buy pulls closed-form max loss and mints the series token`

### A4: Settle, redeem, reclaim
**Files:** modify `SpreadVault.sol`, `script/Deploy.s.sol`, `local.sh`; test `test/SpreadSettlement.t.sol`.
**Test first:** `test_redeem_conservationAtPin` (warp to expiry, `setAnswer(K2)`, settle with `oracle.latestRound()`; `holder payout + lp reclaim == escrow` to the wei); `test_redeem_matchesFormula` (fuzz S; the escrow cap never binds); `test_condor_bothSidesOTMReturnsAll`.
**Implement:**
- `redeem(token, units)`: read `settlement.series(seriesId)`, apply the table's single floored expression, `min(payout, escrow)`, burn.
- `reclaim(token)`: the LP takes `escrow - owedToOutstanding`, like `reclaimCollateral`.
- Deploy, after `vault.setProtocolFee` (line 152; `dao` is declared just above): `new SpreadVault(...)`, `new AquaOptionSettlement(address(0), deployer, chainlinkFeed)` (Chainlink, not `oracleAddr`, which may be Pyth), `setRegistrar`, `setSettlement`, `setProtocolFee(0.01e9, dao)`. Print `NEXT_PUBLIC_SPREAD_VAULT` and thread it through `local.sh`.
**Verify:** `forge test --match-contract "SpreadVaultTest|SpreadSettlementTest"` passes; Deploy prints the address.
**Commit:** `feat(spread): settlement, redeem and reclaim with wei-exact conservation`

### A5: Long OptionToken as collateral (debit spreads, optional)
**Files:** modify `SpreadVault.sol`; test `test/SpreadSettlement.t.sol`.
**Test first:** `test_coveredByLong_crystallizeThenPay`; `test_coveredByLong_rejectsNonDominantStrike`; `test_coveredByLong_buyCappedAtLongUnits`.
**Implement:**
- `openCoveredByLong(longToken, shortStrike, units)`: the token must be a main-vault series with matching expiry, side and collateral token, and a dominant strike (`shortStrike >= longStrike` for calls, `<=` for puts). Custody the token; never `close()` it. `buy` caps sold units at long units.
- `crystallize(authId)`: once the main-vault series is settled, redeem the whole long leg into a pot; `owedTotal = floor(sold * short intrinsic)`; revert `EscrowInvariant` if the pot is short (dominance makes this impossible; keep it loud). Holders draw `units * owedPerUnit`; the writer reclaims only the remainder.
**Verify:** `forge test --match-contract SpreadSettlementTest` passes.
**Commit:** `feat(spread): debit spreads collateralized by the long OptionToken`

### A6 (built beyond this plan, 2026-09-10): RfqVault — R6 hybrid RFQ tier
**Files:** `src/periphery/RfqVault.sol`, `test/RfqVault.t.sol`, `frontend/components/RfqDesk.tsx`, `script/rfq-lifecycle.sh`; `script/Deploy.s.sol` (`_deployRfq`), `local.sh`, `wagmi.ts`.
**What:** a third sibling AquaApp. The LP ships a range (calls WETH / puts USDC, tier-1 collateral rules), signs EIP-712 `Quote(authId, strike, maxAmount, premiumPerUnit, ttl, nonce)` off-chain, and `fill()` recovers the signer, checks ttl / size / nonce, takes premium + fee and pulls the collateral JIT through this vault's Aqua strategy. `formulaQuote()` is the tier-1 Ask for the same range; nonces are single-use and cancellable; no `close()`. Own settlement; `redeem` / `reclaim` as the main vault.
**Why here:** it was first written up as the Arc plan's stretch X7, but it is chain-agnostic Aqua work — the same custody model as A1–A4 with a signed price instead of a formula price — so it belongs with Part A.
**Verified:** 8 tests; `./script/rfq-lifecycle.sh` on Anvil (formula 691.93 USDC → signed 685.01, 1 WETH pulled JIT at the fill, second fill of the nonce reverts `QuoteUsed`).
**Commits:** `feat(rfq): RfqVault — EIP-712 signed-quote tier settling through the same Aqua pull`, `feat(rfq): deploy wiring, RFQ tab with wallet-signed quotes, Anvil lifecycle script`.

## Part B: MarginVault (rung 4), opt-in true margin

Scope for v1: short puts, USDC only. The main vault already forces `collateralToken == premiumToken` for puts, so margin, premium, penalties, backstop and insurance are one token and the waterfall needs no swap. Calls follow once a WETH shortfall can be paid. No `close()` in v1: a buyback priced off sigma and paid from locked margin would let a manipulated sigma drain margin (L7).

| Decision | Choice |
|---|---|
| Mark | Chainlink intrinsic plus a spot buffer: 50% of spot for IM, 30% for MM, never above K per unit. Reads only the oracle, never `hook.sigmaFor`. |
| Trigger price | Lowest Chainlink answer in the last hour (one heartbeat). Past 90 minutes it is stale: fills and withdrawals stop, liquidation keeps working. |
| Health, top-up | The writer's free USDC is swept first; an opt-in Aqua credit line pulls `min(deficit, shipped, wallet, allowance)`, best effort. A cure requires IM. |
| Liquidation | Flag, 1 h grace, 30 min writer-takeover auction (bonus 1% rising to 10% of notional), judged only on rounds posted after the flag. The holder's token is untouched; collateral travels with the position. |
| Backstop | A pre-funded USDC pool adopts unsold positions. Withdrawals wait 24 h, cannot drop below the pool's requirement or 10% of naked notional, and freeze while any expired series is unfinalized. |
| Insurance fund | Half of MarginVault's 1% fee plus liquidation penalties. The DAO share is pull-claimed. |
| Hedge recognition | `positions[sid][writer].locked >= K*units/1e30` makes a position covered and unflaggable. Wallet and Aqua balances never count. |
| Ceiling | Naked notional `<= min(owner ceiling, 10 x backstop assets)`, the Maker debt-ceiling idea. |

Governance only tightens: buffer raises hit IM at once and MM after 24 h, at most +1000 bps per step. Settlement is two-step (a per-writer waterfall, then one series finalization) because marks stop at expiry while the settlement round can land a heartbeat later.

### B1: MarginVault scaffold, ranges, own settlement, size gate
**Files:** create `src/periphery/MarginVault.sol`, `src/periphery/MarginBackstop.sol` (stub); test `test/MarginVault.t.sol`.
**Test first:** `test_openRange_shipHashMatchesAqua`; `test_scheduleVolBuffer_onlyRatchetsUpWithDelay`.
**Implement:**
- `contract MarginVault is AquaApp, Ownable, ReentrancyGuard`; structs `Range`, `Series { strike, expiry, token, totalUnits, positionCount, settledPositions, owedTotal, pot, backstopDrawn, finalized, payoutPerUnit, haircutBps }`, `Position { authId, units, locked, flaggedAt, auctionStart, flagger }`, `Account { free, badDebt }`.
- `openRange(strikeMin, strikeMax, expiry, maxCapacity, lpMarginBps, autoTopUp, sigmaMulBps)`, `getShipParams`, `getDockParams`, `closeRange`. Series are pooled per `(strike, expiry)` so takeovers are fungible.
- `setSettlement`, `setBackstop` one-time; `scheduleVolBuffer(im, mm)` and `applyVolBuffer()`.
**Verify:** `forge test --match-contract MarginVaultTest` passes; `forge build --sizes`. If B3 pushes past 16 KB, move the auction into `MarginAuctioneer`.
**Commit:** `feat(margin): MarginVault scaffold, ranges, timelocked vol buffer`

### B2: Worst-of mark and margin rule
**Files:** modify `MarginVault.sol`; test `test/MarginVault.t.sol`.
**Test first:** `test_markSpot_isWorstOfHour` (3000, 2700, 2950 within the hour gives 2700); `test_marginRequirement_numbers` (K 3000, 1 unit: S 3000 gives IM 1500 and MM 900; S 2000 gives 2000 and 1600; S 0 caps both at 3000).
**Implement:**
- `markSpot() returns (spotWad, latestUpdatedAt, roundsUsed)`: walk `getRoundData` back one hour with the stop rule of `settleWithChainlinkRound`; never reverts on staleness. `buy` and `withdraw` revert `StaleMark` past 90 minutes; `flag`, `startAuction`, `takeOver`, `absorb` do not.
- `marginRequirement(strike, units, spot, initial) = min(K*u/1e30, intrinsic + u*spot*bufferBps/1e4/1e30)`.
**Verify:** `forge test --match-contract MarginVaultTest` passes.
**Commit:** `feat(margin): worst-of-hour Chainlink mark and sigma-free margin rule`

### B3: buy() locks only initial margin
**Files:** modify `MarginVault.sol`; test `test/MarginVault.t.sol`, `test/GasProbe.t.sol`.
**Test first:** `test_buy_pullsOnlyInitialMargin` (ATM put: the LP wallet drops 1500e6, not 3000e6); `test_buy_nakedCeilingBinds`; `test_buy_revertsOnStaleMark`; GasProbe `test_marginRepeatBuyGas` under 450k with its own inline fixture (the main vault's 400k bound is untouched).
**Implement:**
- `buy(authId, strike, units, maxPremium) nonReentrant`: at least 3 hours to expiry; IM from `accounts[lp].free` first, `execPull` for the rest (premium moves inside the same self-call, as `execPutLeg` does); token from the deployed token factory; `registerSeries`; emit `OptionBought`.
- Ceiling at fill: `nakedNotional + (K*u/1e30 - IM) <= min(notionalCeiling, backstop.totalAssets() * 10)`; per-range `maxBlockNotional` as in the main vault.
- Fees: 50% insurance, 30% backstop, 20% `claimable[dao]`. Setters `setProtocolFee`, `setFeeSplit`, `setNotionalCeiling`; `fundInsurance` open to anyone.
**Verify:** `forge test --match-contract "MarginVaultTest|GasProbeTest"` passes.
**Commit:** `feat(margin): buy pulls only initial margin, naked-notional ceiling, pull-based fees`

### B4: Margin calls, covered immunity, withdrawals
**Files:** modify `MarginVault.sol`; test `test/MarginCall.t.sol`.
**Test first:** `test_flag_autoAnswersFromAquaCreditLine`; `test_startAuction_ignoresRoundsBeforeFlag`; `test_withdraw_keepsEveryPositionAtIM`; `test_coverShort_burnsOwnLongsAgainstShort`.
**Implement:**
- `deposit` (repays `badDebt` first). `withdraw(amount)`: settle the caller's settled positions first, then require IM across all open positions at the current mark; revert while flagged, in debt, or stale.
- `flag(sid, writer)`: sweep free, try the Aqua credit line if the range opted in, flag only if still below MM. `startAuction` after 1 h grace, with health judged on rounds where `updatedAt > flaggedAt` only.
- `topUp` (anyone; clears the flag at IM), `isCovered`, `health`, `coverShort(sid, units)` (burn own series tokens against the short).
**Verify:** `forge test --match-contract MarginCallTest` passes.
**Commit:** `feat(margin): margin calls with free sweep, bounded auto top-up, covered immunity`

### B5: Writer-takeover auction and backstop pool
**Files:** modify `MarginVault.sol`, `MarginBackstop.sol`; test `test/MarginAuction.t.sol`.
**Test first:** `test_takeOver_collateralTravelsWithPosition` (token supply and holder balance unchanged; `min(locked, MM + bonus + penalty)` moves with the position; the bidder posts only `IM - transferred`; all USDC conserved); `test_absorb_backstopDrawsOnlyShortfall`; `test_backstop_withdrawGuards`; `test_backstop_epochAfterFullDraw`.
**Implement:**
- `takeOver(sid, writer, units)` and `absorb(sid, writer)` (the position moves to the backstop, which draws `MM - transferred`; 0.5% keeper tip); both require `now < expiry`. The old writer pays the bonus plus a 2% penalty (0.25% of it to the flagger) and gets any remainder as free. Forfeit applies only to the excess over liability, so a losing writer cannot self-liquidate at a discount.
- `MarginBackstop`: share-based `deposit` (dead shares; epoch bump when assets hit zero), `requestWithdraw` (24 h), `withdraw` guarded by `max(poolRequirement, nakedNotional/10)` and frozen while any expired series is unfinalized; `draw` only by the vault. `poolRequirement` is an O(1) running sum of `K*units` over absorbed positions.
**Verify:** `forge test --match-contract MarginAuctionTest` passes; `forge build --sizes`.
**Commit:** `feat(margin): writer-takeover auction, backstop absorb, pool withdrawal guard`

### B6: Settlement waterfall, haircut, ratchet
**Files:** modify `MarginVault.sol`; test `test/MarginSettlement.t.sol`.
**Test first:** `test_settle_waterfallConservation` (two writers, crash to 1200; every balance sums to the start); `test_gap40_holdersWhole` (writers exactly at MM, credit line off, backstop at 10% of naked notional, oracle drops 40% before settlement; holders still get 100%. If it fails, lower the 10x multiplier in B3, not the test); `test_haircut_isLastResortAndRatchets`.
**Implement:**
- `settlePosition(sid, writer)`: locked, then free, then the 2% penalty (junior to the holder shortfall), into `owedTotal` and `pot`. After finalization, a late settlement repays the backstop first, then insurance, then the holder pot, then the writer.
- `finalizeSeries(sid)`: after all positions settle or expiry + 6 h; draws backstop then insurance for the remaining shortfall; sets `payoutPerUnit` and `haircutBps`; emits `HolderHaircut` when it must; ratchets IM +500 bps.
- `redeem(sid, units)`: requires `finalized`.
**Verify:** `forge test --match-contract MarginSettlementTest` passes.
**Commit:** `feat(margin): two-step settlement with funded waterfall and loud last-resort haircut`

### B7: Invariants
**Files:** test `test/MarginInvariants.t.sol`.
**Test first:** `test_marginIndependentOfSigma` (bump sigma 400 times through the hook as the main vault; `marginRequirement` and `health` stay bit-identical while `quote` moves); `test_bytecodeGuards` (`address(vault).code.length == 24364`, `address(mv).code.length < 24576`).
**Implement:** no production code; fix whatever the invariant exposes.
**Verify:** `forge test` passes; `git diff main --stat -- src/vaults/AquaCollateralVault.sol` is empty.
**Commit:** `test(margin): sigma-independence and EIP-170 guards`

### B8: Deploy, keeper, demo, docs
**Files:** modify `script/Deploy.s.sol`, `local.sh`, `frontend/config/wagmi.ts`, `.env.example`; create `keeper/margin.mjs`, `script/DemoMargin.s.sol`, `test/MarginDemo.t.sol`; docs per the last section.
**Test first:** `MarginDemoTest.test_walkthrough`: fill, crash, flag, takeover, absorb, settle, finalize, redeem, logging every balance.
**Implement:**
- Deploy, after line 152: `new MarginVault(aquaAddr, chainlinkFeed, hook, deployer, tokenFactory, usdcAddr)`, `new MarginBackstop(usdcAddr, mv)`, `new AquaOptionSettlement(address(0), deployer, chainlinkFeed)`; wire registrar, settlement, backstop, 1% fee, 50/30 split, 50/30 buffers, 250k USDC ceiling. Anvil only: seed the backstop with 25k and insurance with 5k, or the first buy hits the ceiling.
- Print `NEXT_PUBLIC_MARGIN_VAULT`, `_BACKSTOP`, `_SETTLEMENT`; thread them through `local.sh` and `wagmi.ts` like the main vault.
- `keeper/margin.mjs`: poll series from `OptionBought`, read `health`, call `flag`, `startAuction`, `absorb`, `settlePosition`, `finalizeSeries`.
**Verify:** `./local.sh` then `node keeper/margin.mjs` completes the demo; `npx tsc --noEmit` clean.
**Commit:** `feat(margin): deploy wiring, seeded backstop, keeper watcher, Anvil demo`

## Milestones

| | Demoable on Anvil | Tasks | Target |
|---|---|---|---|
| M1 | A call credit spread pulls 200 USDC, not 3200 | A1 to A3 | Day 3 |
| M2 | Pin settlement conserves escrow to the wei; Deploy prints the SpreadVault | A4, A5 | Day 6 |
| M3 | An ATM put fills with 1500 USDC pulled, not 3000 | B1 to B3 | Day 9 |
| M4 | Crash, margin call, takeover, absorb into the backstop | B4, B5 | Day 11 |
| M5 | Holders whole after a 40% gap; keeper demo; docs updated | B6 to B8 | Day 13 |

**Cut order if time compresses:** A5, `keeper/margin.mjs` (demo via the script instead), partial-unit takeover, `lpMarginBps`. Never cut: single-price settlement in Part A, the backstop-coupled ceiling, the two-step waterfall, the sigma-independence test.

## Definition of done

- **Part A:** A1 to A4 merged, the fuzz test green, `NEXT_PUBLIC_SPREAD_VAULT` printed by Deploy, main vault bytecode unchanged.
- **Part B:** B1 to B7 merged, `test_gap40_holdersWhole` green, MarginVault under 24,576 bytes, the demo runs on a fresh `./local.sh`.
- **Size kill switch:** if MarginVault still does not fit after the auctioneer split, ship Part A plus B1 to B3 and document MarginVault as designed, size-blocked.
- **Quote kill switch:** if A2's quote test is off by even 1 wei, compare `SmileMath.premium` inputs one field at a time; never loosen the assertion.

## Docs to update on completion

- `README.md`: ladder rows for rung 2 (S12 implemented, USDC cash-settled) and rung 4 (S13 MarginVault: opt-in, puts only, IM 50% / MM 30% of the worst-of-hour spot); stale test counts.
- `docs/solutions.md`: S12 status; new `S13. MarginVault`; phase 5 row.
- `docs/limitations.md`: new `L13. Bad debt in the opt-in margin tier`: the haircut path, the heartbeat-wide expiry window, the credit line as revocable consent, sigma still moving the trade price, SpreadVault's `releaseCollateral` admin risk.
- `docs/reference-table.html`: L13 and S13 rows; `frontend/lib/copilot/tools.ts` ranges become `L1-L13` and `S1-S13`.
- Regenerate: `cd frontend && pnpm run gen-help && node scripts/gen-knowledge.mjs`, then commit the outputs.
