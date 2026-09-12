# Chainlink in Smile

## Summary

Smile is a non-custodial marketplace for cash-settled European options on ETH. Every such option needs two prices from the outside world: a *spot price* while the option is being quoted, and a single *settlement price* at expiry that decides every payout. Chainlink supplies both. The Chainlink ETH/USD *data feed* (an on-chain price aggregator updated by a decentralized oracle network) is read for live quoting and for the margin mark, and its on-chain round history is what makes expiry settlement *permissionless*: anyone can settle a series by naming the first Chainlink round after expiry, and the contract verifies that claim itself. The Chainlink Runtime Environment (CRE) provides a second, scheduled settlement path in which a decentralized oracle network (DON) reads the same feed and writes the settlement price through a signed report.

Chainlink was part of Smile before EthOnline 2026 and is reused, unchanged, by every vault built at the event. Each new vault (`SpreadVault`, `MarginVault`, `RfqVault`) is deployed with its own instance of the settlement registry pointed at the same feed. The one piece of Chainlink-facing logic that is new at the event is `MarginVault`'s worst-of-hour mark, which walks the feed's round history to compute a margin price that trading activity cannot move.

## Features used

| Feature | Where in the code | Pre-existing or EthOnline 2026 |
|---|---|---|
| ETH/USD data feed read for call quoting, with a staleness guard | `src/swapvm/OptionPremiumInstruction.sol` (`_oracleSpotWad`) | Pre-existing |
| ETH/USD data feed read for put quoting in the main vault | `src/vaults/AquaCollateralVault.sol` (`_spotWad`) | Pre-existing |
| Same read, factored into a shared library for the new vaults | `src/periphery/SmilePremiumLib.sol` (`readSpot`) | EthOnline 2026 |
| Staleness-scaled spread (the feed's age widens the quote) | `AquaCollateralVault.sol`, `SmilePremiumLib.sol` (`stalenessSpreadBpsPerHour`) | Pre-existing (R3) |
| Permissionless settlement against the first post-expiry round | `src/vaults/AquaOptionSettlement.sol` (`settleWithChainlinkRound`) | Pre-existing |
| CRE scheduled settlement: cron trigger, finalized-block read, DON-signed report | `cre-workflow/settlement/workflow.ts`, `AquaOptionSettlement.settleSeries` | Pre-existing |
| One settlement registry per new vault, all on the same feed | `script/Deploy.s.sol` (`spreadSettlement`, `rfqSettlement`, `marginSettlement`) | EthOnline 2026 |
| Worst-of-hour margin mark from the feed's round history | `src/periphery/MarginVault.sol` (`markSpot`, `_worstOf`, `isMarkStale`) | EthOnline 2026 |
| Keeper that finds the covering round and settles, then unwinds | `keeper/roll.mjs` (`roundCovering`, `settleAndUnwind`) | Pre-existing |
| Optional Pyth pull-oracle adapter behind the same interface, quoting only | `src/oracles/PythSpotAdapter.sol` | Pre-existing (R5) |
| Frontend: the displayed ETH/USD spot falls back to a direct `latestRoundData` read of the Sepolia feed when no Uniswap Trading API key is configured; the Margin and Risk Monitor tabs show `MarginVault.markSpot` (the worst-of-hour Chainlink mark) and its staleness | `frontend/hooks/useUniswapSpot.ts` (`CHAINLINK_FEEDS`), `frontend/components/MarginDesk.tsx`, `RiskMonitor.tsx` | Pre-existing (spot); EthOnline 2026 (mark) |
| Chainlink feed on Sepolia; mock aggregator on Arc and Anvil | `script/Deploy.s.sol`, `docs/sepolia-deployment.md`, `docs/arc-testnet-deployment.md` | Sepolia redeploy and Arc: EthOnline 2026 |

The Sepolia deployment reads the canonical Chainlink ETH/USD feed at `0x694AA1769357215DE4FAC081bf1f309aDC325306`. The CRE workflow configuration points at the same feed.

## Why it is necessary

A parametric option is a contract that pays a formula of one number: the price of the underlying at expiry. A holder of a 3,000 call expiring today is owed `max(S − 3000, 0)` per unit, where `S` is the settlement price. If `S` can be chosen by anyone with an interest in the outcome, the option is worthless as an instrument, because the writer and the holder disagree about `S` in exactly the cases where money is at stake. The settlement price therefore has to come from somewhere neither party controls, and the *choice* of which price counts has to be verifiable by the contract rather than asserted by a caller.

Chainlink's data feeds solve the first half. The ETH/USD feed is an *aggregator*: a contract whose answer is the median of independent node reports, updated whenever the price moves more than a deviation threshold or a heartbeat interval elapses. Its history is kept on-chain as numbered *rounds*, each with the answer and the timestamp at which it was updated.

The on-chain round history solves the second half. Because every round is retrievable by number, a contract can check a caller's claim that "round N is the first round at or after expiry" without trusting the caller: it reads round N and confirms its timestamp is at or after expiry, then reads round N − 1 and confirms its timestamp is before expiry. Two reads prove the claim. Nobody can *cherry-pick* a later, more favorable round, because the predecessor check fails for any round after the first.

Liveness is the remaining concern. If settlement required a specific party to act, a series could stay open indefinitely. With permissionless settlement, the liveness of expiry reduces to the liveness of the feed itself: as long as Chainlink keeps publishing, anyone (the holder, the writer, a keeper, or the CRE) can close the series. The CRE path exists so that a series settles on schedule even when nobody races to call the permissionless function.

Quoting has the same dependency in a weaker form. The premium formula needs the current spot. A stale spot is a free option for whoever notices first, so every read is guarded by a maximum age, and the spread widens with the age of the round.

## Market value add

**Trustless expiry for both sides.** A holder does not need the writer, the protocol team, or any keeper to be honest or online to be paid. The holder can settle the series against the feed's own history and redeem. A writer can likewise settle and reclaim the unowed remainder of their collateral. This is the property that lets Smile promise that a written option always pays: collateral is fully escrowed at the fill, and the price that unlocks it is verified by the contract.

**A margin mark that trading cannot move.** `MarginVault`, the opt-in margined-put tier built at the event, prices the writer's margin off the *lowest* Chainlink answer in the last hour, never off the vault's own volatility surface. The implied volatility that Smile's pricing hook maintains is bumped by every trade, so a margin rule based on it could be pushed around by anyone willing to trade. A rule based only on the oracle's round history cannot be. The test suite includes a check that four hundred sigma bumps leave the margin requirement bit-identical.

**A single, auditable settlement number per series.** Every series is registered once with the settlement registry and its settlement price is written exactly once, by either path, with an event naming the settler. Holders, writers, the subgraph, and the AI copilot all read the same number.

**A scheduled closer without a trusted operator.** The CRE workflow is not a privileged server. It is a workflow executed by a decentralized oracle network that reads the feed at the last finalized block, so every node observes the same value, and delivers a signed report. The only address that can write through that path is the forwarder fixed at deployment.

## Technical details

### Quoting: the staleness-guarded feed read

Every quote begins with a read of `latestRoundData()`. The read is rejected if the answer is not positive or if the round is older than `maxStaleness` seconds. The age is returned as well, so that the spread can widen with it. The three copies of this read are deliberately identical; the library comment records that the new vaults' wei-exact tests depend on the arithmetic order.

`src/swapvm/OptionPremiumInstruction.sol`

```solidity
function _oracleSpotWad(address oracle, uint256 maxStaleness)
    private
    view
    returns (uint256 spotWad, uint256 ageSec)
{
    (, int256 answer,, uint256 updatedAt,) = IPriceOracle(oracle).latestRoundData();
    require(answer > 0, OptionPremiumBadOraclePrice(answer));
    require(
        maxStaleness == 0 || (updatedAt != 0 && block.timestamp <= updatedAt + maxStaleness),
        OptionPremiumStaleOraclePrice(updatedAt, maxStaleness, block.timestamp)
    );
    uint8 decimals = IPriceOracle(oracle).decimals();
    spotWad = SmileMath.scaleToWad(uint256(answer), decimals);
    ageSec = updatedAt >= block.timestamp ? 0 : block.timestamp - updatedAt;
}
```

`src/periphery/SmilePremiumLib.sol`

```solidity
/// @dev Mirrors AquaCollateralVault._spotWad exactly.
function readSpot(IPriceOracle oracle, uint256 maxStaleness)
    internal
    view
    returns (uint256 spotWad, uint256 ageSec)
{
    (, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
    require(answer > 0, BadOraclePrice());
    require(
        maxStaleness == 0 || (updatedAt != 0 && block.timestamp <= updatedAt + maxStaleness),
        StaleOraclePrice()
    );
    spotWad = SmileMath.scaleToWad(uint256(answer), oracle.decimals());
    ageSec = updatedAt >= block.timestamp ? 0 : block.timestamp - updatedAt;
}
```

The main vault then uses `ageSec` to widen the half-spread, capped at 20%:

`src/vaults/AquaCollateralVault.sol`

```solidity
// R3/R4: half-spread floor + staleness slope, capped at 20%.
uint256 halfSpreadBps = uint256(pricing.baseSpreadBps) + (uint256(pricing.stalenessSpreadBpsPerHour) * ageSec) / 3600;
if (halfSpreadBps > MAX_HALF_SPREAD_BPS) halfSpreadBps = MAX_HALF_SPREAD_BPS;
```

### Settlement, path A: permissionless round bracketing

The settlement registry stores one record per series and accepts a settlement price exactly once. The permissionless path takes a round identifier from the caller and verifies, on-chain, that it is the first round at or after expiry. The predecessor lookup is wrapped in `try`, because Chainlink proxies renumber rounds at a *phase boundary* (a change of the underlying aggregator), and the round before a boundary may not resolve.

`src/vaults/AquaOptionSettlement.sol`

```solidity
function settleWithChainlinkRound(bytes32 seriesId, uint80 roundId) external {
    Series storage s = _pendingSeries(seriesId);

    (, int256 answer,, uint256 updatedAt,) = feed.getRoundData(roundId);
    require(answer > 0, "bad round answer");
    require(updatedAt >= s.expiry, "round before expiry");

    if (roundId > 0) {
        try feed.getRoundData(roundId - 1) returns (uint80, int256, uint256, uint256 prevUpdatedAt, uint80) {
            require(prevUpdatedAt == 0 || prevUpdatedAt < s.expiry, "not first round after expiry");
        } catch {
            // phase boundary / missing predecessor — accept the round
        }
    }

    uint256 priceWad = SmileMath.scaleToWad(uint256(answer), feed.decimals());
    s.settled = true;
    s.settlementPrice = priceWad;
    emit SeriesSettled(seriesId, priceWad, msg.sender);
}

function _pendingSeries(bytes32 seriesId) internal view returns (Series storage s) {
    s = series[seriesId];
    require(s.expiry > 0, "unknown series");
    require(block.timestamp >= s.expiry, "not yet expired");
    require(!s.settled, "already settled");
}
```

`test/AquaOptionSettlement.t.sol` covers the bracketing rule directly: `test_settleWithChainlinkRound_anyoneCanSettle`, `_preExpiryRoundRejected`, `_laterRoundRejected`, `_beforeExpiryReverts`, `_doubleSettleReverts`, and `_unknownSeriesReverts`.

The keeper finds the covering round off-chain with the same rule, walking back from the latest round until it meets a round updated before expiry:

`keeper/roll.mjs`

```javascript
async function roundCovering(expiry) {
  let [roundId, , , updatedAt] = await pub.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "latestRoundData" });
  if (Number(updatedAt) < expiry) return null;
  let candidate = roundId;
  while (roundId > 0n) {
    roundId -= 1n;
    try {
      const [, , , prevUpdated] = await pub.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: "getRoundData", args: [roundId] });
      if (Number(prevUpdated) === 0 || Number(prevUpdated) < expiry) break;
      candidate = roundId;
    } catch { break; }
  }
  return candidate;
}
```

`script/spread-lifecycle.sh` exercises the same call for `SpreadVault` on Anvil, and the keeper's `settleAndUnwind` follows settlement with `reclaimCollateral` and a fresh range at the new spot.

### Settlement, path B: the CRE workflow

The CRE workflow is a cron-triggered program compiled to WebAssembly and executed by a DON. It reads the feed at the last finalized block, scales the eight-decimal answer to eighteen decimals, and delivers a DON-signed report that calls `settleSeries`.

`cre-workflow/settlement/workflow.ts`

```typescript
const callResult = evmClient
    .callContract(runtime, {
        call: encodeCallMsg({
            from: zeroAddress,
            to: evm.priceFeedAddress as Address,
            data: encodeFunctionData({ abi: ETH_USD_FEED_ABI, functionName: 'latestRoundData' }),
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()

// ...

// 3. Chainlink ETH/USD is 8-decimal fixed-point; the settlement registry
// stores prices in WAD (18-dec) — scale up by 10^10.
const spotWad = answer * 10n ** 10n

// 4. DON-signed report → settleSeries on-chain (the required state change).
const settlement = new AquaOptionSettlement(evmClient, evm.settlementAddress as Address)

const resp = settlement.writeReportFromSettleSeries(
    runtime,
    seriesId as Hex,
    spotWad,
    { gasLimit: evm.gasLimit },
)
```

```typescript
export function initWorkflow(config: Config) {
    const cron = new cre.capabilities.CronCapability()
    return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}
```

The receiving function is guarded by the forwarder address fixed at deployment:

`src/vaults/AquaOptionSettlement.sol`

```solidity
modifier onlyCRE() {
    require(msg.sender == creForwarder, "only CRE forwarder");
    _;
}

/// @notice CRE path: the forwarder writes the DON's consensus price (WAD).
function settleSeries(bytes32 seriesId, uint256 settlementPriceWad) external onlyCRE {
    Series storage s = _pendingSeries(seriesId);
    s.settled = true;
    s.settlementPrice = settlementPriceWad;
    emit SeriesSettled(seriesId, settlementPriceWad, msg.sender);
}
```

`docs/cre-simulation.md` holds the verified transcript of `cre workflow simulate settlement` against the live Sepolia feed (CLI v1.11.0, exit code 0). The schedule in `cre-workflow/settlement/config.json` is every six hours.

### The margin mark: worst of the last hour

`MarginVault` computes its mark by walking the feed's rounds backwards from the latest, keeping the lowest positive answer among rounds updated within `MARK_WINDOW` (one hour), and stopping at the first round outside the window, at a phase boundary, or after `MAX_MARK_ROUNDS` (sixty-four) rounds. The function never reverts on staleness; instead, `isMarkStale` reports whether the newest round is older than `MARK_STALE_AFTER` (ninety minutes), and `buy` and the margin-call path require a fresh mark.

`src/periphery/MarginVault.sol`

```solidity
function markSpot() public view returns (uint256 spotWad, uint256 latestUpdatedAt, uint256 roundsUsed) {
    return _worstOf(block.timestamp > MARK_WINDOW ? block.timestamp - MARK_WINDOW : 0);
}

/// @dev Lowest answer among rounds updated at/after `cutoff`, newest first.
function _worstOf(uint256 cutoff) internal view returns (uint256 spotWad, uint256 latestUpdatedAt, uint256 roundsUsed) {
    (uint80 roundId, int256 answer,, uint256 updatedAt,) = oracle.latestRoundData();
    if (answer <= 0) return (0, updatedAt, 0);
    latestUpdatedAt = updatedAt;
    uint256 lowest = uint256(answer);
    roundsUsed = 1;
    while (roundId > 0 && roundsUsed < MAX_MARK_ROUNDS) {
        roundId--;
        try oracle.getRoundData(roundId) returns (uint80, int256 a, uint256, uint256 u, uint80) {
            if (u == 0 || u < cutoff) break;
            if (a > 0 && uint256(a) < lowest) lowest = uint256(a);
            roundsUsed++;
        } catch {
            break; // phase boundary / missing predecessor — the window ends here
        }
    }
    spotWad = SmileMath.scaleToWad(lowest, oracle.decimals());
}

/// @notice True when the newest round is older than {MARK_STALE_AFTER}.
function isMarkStale() public view returns (bool) {
    (, uint256 latestUpdatedAt,) = markSpot();
    return block.timestamp > latestUpdatedAt + MARK_STALE_AFTER;
}
```

The margin rule then applies to that mark. Initial margin uses a 50% buffer of spot per unit and maintenance margin a 30% buffer, each added to intrinsic value and capped at the strike (a put's maximum loss). The docstring's worked example: strike 3,000, one unit, spot 3,000 gives initial margin 1,500 and maintenance 900; spot 2,000 gives 2,000 and 1,600.

```solidity
function marginRequirement(uint256 strike, uint256 units, uint256 spotWad, bool initial)
    public
    view
    returns (uint256)
{
    uint256 cap = (strike * units) / 1e30;
    uint256 intrinsic = spotWad < strike ? ((strike - spotWad) * units) / 1e30 : 0;
    uint256 buffer = (units * spotWad * (initial ? imBufferBps : mmBufferBps)) / 1e4 / 1e30;
    uint256 req = intrinsic + buffer;
    return req > cap ? cap : req;
}
```

When an auction is started after a margin call, the vault re-marks using only rounds published *after* the flag, so a position cannot be auctioned on the strength of the same stale round that flagged it (`startAuction` requires `latestAt > pos.flaggedAt`). Tests: `test_markSpot_isWorstOfHour`, `test_markSpot_ignoresRoundsOlderThanTheWindow`, `test_markSpot_staleFlagButNoRevert`, `test_buy_revertsOnStaleMark` in `test/MarginVault.t.sol`.

### One registry per vault

Each vault built at the event is wired to its own `AquaOptionSettlement`, constructed with the same Chainlink feed. The vault is the registry's sole registrar and registers a series on its first mint.

`script/Deploy.s.sol`

```solidity
SpreadVault spread = new SpreadVault(aquaAddr, oracleAddr, hookAddr, deployer, wethAddr, usdcAddr);
AquaOptionSettlement spreadSettlement = new AquaOptionSettlement(deployer, deployer, chainlinkFeed);
// ...
spread.setSettlement(address(spreadSettlement));
```

The Sepolia addresses of the three additional registries are listed in `docs/sepolia-deployment.md`; the Arc addresses in `docs/arc-testnet-deployment.md`.

### The contrast: a pull oracle for quoting only

Chainlink's data feed is a *push* oracle: nodes publish updates on their own schedule and a contract reads the last one. Pyth is a *pull* oracle: prices are signed off-chain roughly every 400 milliseconds and the trader posts the update inside their own transaction. `PythSpotAdapter` exposes a Pyth feed through the Chainlink `latestRoundData()` shape so that the instruction and the vaults need no change, and it is enabled per deployment by setting `PYTH` and `PYTH_PRICE_ID`. Settlement is deliberately excluded: only Chainlink's on-chain round history supports verifiable expiry bracketing.

`src/oracles/PythSpotAdapter.sol`

```solidity
/// @notice Chainlink-compatible read of the freshest posted Pyth price.
/// Round ids are meaningless for a pull oracle and returned as zero;
/// consumers key their staleness checks off `updatedAt` (= publishTime).
function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
{
    IPyth.Price memory p = pyth.getPriceUnsafe(priceId);
    require(p.price > 0, BadPythPrice(p.price));
    require(p.expo == -int32(uint32(priceDecimals)), UnexpectedExponent(p.expo, priceDecimals));
    return (0, int256(p.price), 0, p.publishTime, 0);
}
```

## Limitations

The numbered items refer to `docs/limitations.md`.

- **L1, stale-quote sniping.** A quote is priced off the last published round. The staleness guard rejects an *old* round, but it cannot reject a *fresh round that is already wrong*. The staleness-scaled spread (R3) prices this continuously rather than removing it.
- **L2, the invisible window.** The ETH/USD feed updates on a 0.5% deviation or a heartbeat. Inside that threshold the real price can drift with no on-chain signal at all. No contract check can see it; only the spread can charge for it.
- **L9, settlement depends on one oracle.** Round bracketing prevents cherry-picking, but the *value* settled is whatever Chainlink published. A wrong feed settles wrong, trustlessly. This risk is shared with essentially every oracle-settled derivative.
- **The live CRE write path is not wired.** The CRE forwarder delivers reports through a `KeystoneForwarder` that calls `onReport(bytes,bytes)` on the receiver, whereas the registry exposes a plain `settleSeries` guarded by `onlyCRE`. The CRE CLI simulation is the demonstrated path; the on-chain report entrypoint is a documented follow-up (README, section 5 notes). In local deployments the deployer stands in as the forwarder.
- **No Chainlink feed on Arc.** Arc testnet has no documented Chainlink-compatible ETH/USD or EUR/USD feed, so the Arc deployment uses a `MockV3Aggregator` fixed at 3,000 for both quoting and settlement, and says so. Because the mock does not tick, `MarginVault.buy` and `RfqVault.formulaQuote` revert a few hours after the last posted round until anyone posts a new one.
- **Phase boundaries are accepted, not resolved.** Both the settlement bracketing and the worst-of-hour walk stop at a proxy phase boundary and accept what they have. This is correct for the first post-expiry round but means a window straddling a boundary is shorter than one hour.
- **Bounded round walk.** The mark inspects at most sixty-four rounds. On a feed that updates more than sixty-four times an hour, the window is effectively shorter than an hour.
- **L13, the margin tier's bad debt.** The mark is manipulation-resistant, but a gap larger than the maintenance buffer between rounds can still leave a shortfall; the waterfall behind the holder (backstop, insurance, haircut) is the answer, not the oracle.

## Plans

The numbered items refer to `docs/limitations.md` Part 3 and `docs/solutions.md`.

- **R5, pull-oracle quoting.** `PythSpotAdapter` is built and deploy-opt-in. Enabling it on a public deployment closes most of the L1 latency gap and shrinks L2 from "0.5% deviation" to sub-second drift, at the cost of the taker posting an update. Chainlink Data Streams is named as the alternative pull source.
- **R3 and R4, spread calibration.** The staleness slope exists; the deviation-threshold floor (spread at least delta times 0.5% of spot) is specified as the explicit L2 insurance premium and remains to be calibrated against markouts (R8).
- **CRE live path.** Add an `onReport(bytes,bytes)` entrypoint to the settlement registry and deploy with the registered forwarder address, so the workflow's signed report lands on-chain rather than in simulation.
- **An oracle on Arc.** The only oracle found deployed on Arc testnet is Stork, a pull oracle that would need an adapter of the same shape as `PythSpotAdapter` plus an update-posting flow. It is recorded as the lead for the post-submission window (Arc plan, task X1). A live feed would also unblock the USDC/EURC FX-options variant that was cut.
- **S7, an external volatility anchor.** Not an oracle for price but for implied volatility; it is gated on evidence that the passive surface drifts, because it adds an oracle dependency.
- **Cut at the event, on purpose.** FX options on Arc (no feed), and any change to the main vault's oracle path; every new vault reuses the existing read unchanged.

## Glossary

- **Aggregator.** The Chainlink contract that holds a feed's answer. Its value is the median of independent node reports, exposed through `latestRoundData()` and `getRoundData(roundId)`.
- **Data feed.** A Chainlink price feed such as ETH/USD: an aggregator, updated by a decentralized oracle network, that publishes a price on-chain.
- **Round.** One published update of a feed, identified by a `roundId`, carrying the answer and the timestamp (`updatedAt`) at which it was written. Rounds form the feed's on-chain history.
- **Phase boundary.** The point at which a Chainlink proxy switches to a new underlying aggregator; round identifiers are renumbered, so the round "before" the boundary may not resolve.
- **Heartbeat and deviation threshold.** The two triggers for a new round: a maximum interval between updates, and a price move larger than a fixed percentage (0.5% for ETH/USD).
- **Staleness.** The age of the latest round, `block.timestamp − updatedAt`. Smile rejects reads older than a per-strategy `maxStaleness` and widens the spread with age.
- **Push oracle.** An oracle whose operators publish updates on their own schedule; a contract reads the last one. Chainlink data feeds are push oracles.
- **Pull oracle.** An oracle whose signed prices are fetched off-chain and posted by the user inside their own transaction. Pyth is a pull oracle; `PythSpotAdapter` wraps one behind the push-oracle interface.
- **Spot price.** The current price of the underlying, used to quote a premium.
- **Settlement price.** The single price, fixed at expiry, that determines every payout for a series. Written exactly once per series.
- **Series.** All options sharing the same strike, expiry, and type (call or put). Smile registers each series with the settlement registry at its first mint.
- **Settlement registry.** `AquaOptionSettlement`: the contract that records the settlement price per series. Collateral custody and payouts live in the vaults.
- **Round bracketing.** Verifying that a round is the first at or after expiry by checking its timestamp and its predecessor's timestamp on-chain.
- **Cherry-picking.** Choosing, among several post-expiry rounds, the one most favorable to the caller. Bracketing makes it impossible.
- **Intrinsic value.** The amount an option is in the money: `max(S − K, 0)` for a call and `max(K − S, 0)` for a put, per unit.
- **Mark price.** The price against which margin is measured. In `MarginVault` it is the lowest Chainlink answer in the last hour.
- **Initial margin and maintenance margin.** The margin required to open a position and the minimum below which a position is flagged. Smile uses intrinsic value plus a 50% and 30% buffer of spot respectively, capped at the strike.
- **Keeper.** An automated, permissionless actor that performs maintenance transactions, such as settling a series or rolling a range. `keeper/roll.mjs` is Smile's keeper.
- **CRE.** The Chainlink Runtime Environment: a platform for workflows executed by a decentralized oracle network with triggers, consensus, and signed on-chain writes.
- **DON.** A decentralized oracle network: the set of independent nodes that execute a CRE workflow and sign its result.
- **Forwarder.** The contract through which a DON-signed report reaches the receiving contract. `AquaOptionSettlement` accepts `settleSeries` only from its forwarder address.
- **Finalized block.** A block that can no longer be reorganized. The CRE workflow reads the feed at the last finalized block so every node observes the same value.
- **WAD.** A fixed-point number with eighteen decimals. Chainlink's ETH/USD answer has eight decimals and is scaled by 10^10 before storage.
- **Mock aggregator.** `MockV3Aggregator`, a settable stand-in for a Chainlink feed used on Anvil and, for want of a live feed, on Arc testnet.
