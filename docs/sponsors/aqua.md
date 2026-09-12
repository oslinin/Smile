# 1inch Aqua and SwapVM in Smile

## Summary

Smile is a non-custodial marketplace for fixed-expiry, cash-settled European options on ETH. Every option sold on Smile is backed by collateral that a liquidity provider (LP) has committed through **1inch Aqua**, a shared-liquidity layer in which a maker's tokens stay in the maker's own wallet until the moment a trade actually needs them. Smile's pricing for covered calls runs inside **1inch SwapVM**, a small on-chain virtual machine that executes a maker's strategy as a program of opcodes; Smile adds one custom opcode that prices an option.

This page collects everything Smile builds on Aqua and SwapVM: the original vault from before EthOnline 2026, and the three sibling vaults built at the event. Each sibling vault reuses the identical custody model and changes exactly one thing: how much collateral a spread locks (`SpreadVault`), how much margin a put writer posts (`MarginVault`), or who sets the price (`RfqVault`). The main vault's bytecode was never modified during the event.

Terms are defined at first use, and a glossary closes the page.

## Features used

| Feature | Where in the code | Provenance |
|---|---|---|
| Aqua **JIT pull** custody: LP ships a strategy, collateral is pulled from the LP wallet only when a buyer fills | `src/vaults/AquaCollateralVault.sol` (`execPutLeg`, `_putStrategy`, `getShipParams`) | pre-existing |
| `AquaApp` base contract and the `nonReentrantStrategy` guard around every pull | every vault under `src/vaults/` and `src/periphery/` | pre-existing; reused by the three event vaults |
| **SwapVM custom opcode 33**, `OptionPremiumInstruction`, dispatched by `SmileSwapVMRouter` | `src/swapvm/OptionPremiumInstruction.sol`, `src/swapvm/SmileSwapVMRouter.sol` | pre-existing |
| Official SwapVM **fee opcode** grossed up on top of the Ask for call fills | `AquaCollateralVault.buildOrder` (`FeeArgsBuilder.buildProtocolFee`) | pre-existing |
| Two-sided quote: forward swap direction is the Ask, reverse direction is the Bid (`close()` sellbacks) | `OptionPremiumInstruction.sol`, `AquaCollateralVault.close` | pre-existing |
| `FirmEscrow`: a maker wallet that cannot renege on shipped depth (S4 firm tier, MVP scope) | `src/periphery/FirmEscrow.sol` | pre-existing |
| `SmilePremiumLib`: the vault's premium math lifted into a library with an `isCall` flag | `src/periphery/SmilePremiumLib.sol` | EthOnline 2026 |
| **`SpreadVault`**: credit spreads escrow their true maximum loss (S12) | `src/periphery/SpreadVault.sol`, `SpreadToken.sol`, `test/SpreadVault.t.sol` (11), `test/SpreadSettlement.t.sol` (10) | EthOnline 2026 |
| **`MarginVault` + `MarginBackstop`**: opt-in margined puts with a liquidation waterfall (S13) | `src/periphery/MarginVault.sol`, `MarginBackstop.sol`, `test/Margin*.t.sol` (54) | EthOnline 2026 |
| **`RfqVault`**: LP-signed EIP-712 quotes that settle through the same Aqua pull (R6) | `src/periphery/RfqVault.sol`, `test/RfqVault.t.sol` (8) | EthOnline 2026 |
| Frontend tabs: Spreads · Defined Risk, Margin · Opt-in Puts, RFQ · Signed Quotes, Risk Monitor | `frontend/components/SpreadDesk.tsx`, `MarginDesk.tsx`, `RfqDesk.tsx`, `RiskMonitor.tsx` | EthOnline 2026 |
| Lifecycle demos and keeper | `script/spread-lifecycle.sh`, `script/margin-lifecycle.sh`, `script/rfq-lifecycle.sh`, `keeper/margin.mjs` | EthOnline 2026 |

The Foundry suite grew from 82 tests before the event to 200 at the time of writing, all passing.

## Why it is necessary

**The problem Aqua solves.** On-chain options venues before Smile fell into two families. DeFi Option Vaults (DOVs) such as Ribbon and Friktion lock collateral into a vault at a strike chosen by the vault manager; every other strike on the chain sits empty, and the locked capital earns nothing while it waits. Request-for-quote venues such as Premia rely on institutional market makers to stream prices off-chain, which reintroduces a dependency on a handful of counterparties. Neither produces a full, standing options chain with real depth at every strike.

Aqua changes the cost structure of quoting. An LP on Smile does not deposit anything. The LP *authorizes a range* (a span of strikes at one expiry) and *ships* an Aqua strategy that describes it. The LP's WETH or USDC remains in the LP's wallet, lendable and yield-bearing, until a taker buys a specific strike. At that moment the vault performs a just-in-time (JIT) pull of exactly the collateral that one fill needs. Quoting an entire strike chain therefore costs an LP nothing in idle capital, which is the precondition for the deep, wide market that standard options require.

**The problem SwapVM solves.** A covered call is a swap of premium (USDC) for collateral (WETH), so it fits SwapVM's shape exactly: the taker sends USDC, the maker's WETH is pulled through Aqua and escrowed by the vault, and an `OptionToken` is minted to the taker. Rather than build a separate quoting contract, Smile expresses the option price as a SwapVM instruction so that the price is computed atomically inside the same swap that executes it. There is no off-chain quote to go stale or to be front-run.

**The problem the sibling vaults solve.** Full collateralization was a deliberate choice (see L8 below), but it is expensive for the users Smile is built for. A 3000/3200 call credit spread has a worst case of 200 USD per unit, yet the main vault margins the short leg as if it were naked and locks a full 1 WETH. A cash-secured put writer must post the entire strike even when the put is far out of the money. Professional makers with their own pricing models had no way to quote inside the protocol's formula. The three event vaults address exactly these three gaps without touching the promise the main vault makes.

## Market value add

**For LPs (option writers).**

- Collateral stays in the LP's wallet and keeps earning until a fill. No other options venue, on-chain or off-chain, lets a maker quote a chain with capital that is simultaneously deployed elsewhere.
- `SpreadVault` escrows a 3000/3200 call credit spread at 0.0625 WETH per unit instead of 1 WETH, a 16× reduction; the put-credit twin escrows 200 USDC instead of 3,200.
- `MarginVault` lets an at-the-money 3000 put writer lock 1,500 USDC of initial margin instead of the 3,000 USDC strike, off a conservative worst-of-hour Chainlink mark that the vol surface cannot influence.
- `RfqVault` lets a maker with a better model quote inside the formula price and win the flow, while the formula tier remains the public floor. This is the structure tradfi calls the national best bid and offer (NBBO) plus price improvement.

**For takers (option buyers).**

- Every strike in an authorized range is quotable, not only the strike a vault manager picked.
- The price is computed on-chain in the block of execution, with a protocol fee grossed up transparently on top of the Ask.
- A written option on the main vault and on `SpreadVault` can always pay: the escrow is the structure's maximum payout to the wei. The margin tier is opt-in and labelled as such.

**Against the alternatives.** Deribit offers firm depth but custody and margin risk on a centralized venue. Panoptic removes the pricing oracle by streaming fees from Uniswap v3 positions, but has no expiries, no upfront credit, and forced liquidations. Ribbon-style DOVs lock capital at one strike. Smile keeps the instrument traders already know, fixed-expiry vanillas with known premiums, and rebuilds the market-making stack around Aqua so that quoting the whole chain is nearly free.

## Technical details

### The custody model: ship, then pull under the reentrancy guard

An LP calls `authorizeRange` on a vault, which records the range and computes a *strategy hash*. For calls this hash is the hash of a SwapVM order; for puts it is the hash of an abi-encoded terms blob, with the vault itself as the Aqua application. The LP then calls `Aqua.ship(app, strategy, tokens, amounts)` with the parameters the vault exposes through `getShipParams`. Nothing moves at ship time.

When a taker buys a put, the vault re-enters itself through an external function so that Aqua's `nonReentrantStrategy` guard brackets the pull. The premium goes straight from the buyer to the LP, the fee to the fee recipient, and then exactly `collateralNeeded` is pulled from the LP wallet into the vault.

`src/vaults/AquaCollateralVault.sol`

```solidity
    function execPutLeg(
        address lp,
        bytes32 strategyHash,
        address premiumToken,
        address collateralToken,
        address feeRecipient_,
        address buyer,
        uint256 lpPremium,
        uint256 fee,
        uint256 collateralNeeded
    ) external nonReentrantStrategy(lp, strategyHash) {
        require(msg.sender == address(this), SelfOnly());
        if (lpPremium > 0) {
            IERC20(premiumToken).safeTransferFrom(buyer, lp, lpPremium);
        }
        if (fee > 0) {
            IERC20(premiumToken).safeTransferFrom(buyer, feeRecipient_, fee);
        }
        AQUA.pull(lp, strategyHash, collateralToken, collateralNeeded, address(this));
    }
```

The vault requires calls and puts to use different token pairings, and this single line is why calls go through SwapVM while puts pull directly: a call swaps two different tokens (USDC in, WETH out), which is a swap; a put is USDC in and USDC out, which is not.

`src/vaults/AquaCollateralVault.sol`

```solidity
        require(isCall ? collateralToken != premiumToken : collateralToken == premiumToken, BadTokenPair());
```

### The SwapVM opcode: pricing inside the swap

`SmileSwapVMRouter` is a SwapVM with the official Aqua opcode set (indices 0 through 32) plus one custom instruction at index 33. The dispatcher tries the custom opcode first and falls through to the official set otherwise.

`src/swapvm/SmileSwapVMRouter.sol`

```solidity
contract SmileSwapVMRouter is Simulator, SwapVM, AquaOpcodes, OptionPremiumInstruction {
    /// @notice Opcode index of the custom option-premium instruction.
    /// Official AquaOpcodes occupy indices 0–32; custom instructions start at 33.
    uint256 public constant OPCODE_OPTION_PREMIUM = 33;

    constructor(
        address aqua,
        address weth,
        address owner
    ) SwapVM(aqua, weth, owner, "SmileSwapVM", "1") AquaOpcodes(aqua) {}

    /// @dev Dispatch custom opcodes first, then fall through to the official set.
    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == OPCODE_OPTION_PREMIUM) {
            OptionPremiumInstruction._optionPremiumXD(ctx, args);
        } else {
            AquaOpcodes._runOpcode(ctx, opcode, args);
        }
    }
}
```

The instruction itself, `_optionPremiumXD`, reads the swap direction, the taker's strike, the oracle spot with a staleness bound, and the live sigma from the Uniswap v4 hook, then prices the trade in whichever of the four exact-in / exact-out branches applies (the pricing branches are elided here; the full function is in the source file).

`src/swapvm/OptionPremiumInstruction.sol`

```solidity
    /// The instruction is TWO-SIDED — direction selects the quote side:
    ///   forward (premium in  → collateral out): buyer opens  → Ask (rounds against taker)
    ///   reverse (collateral in → premium out):  holder closes → Bid (rounds against taker)
    /// One shipped strategy therefore quotes a full two-sided market.
    function _optionPremiumXD(Context memory ctx, bytes calldata args) internal view {
        OptionTerms memory terms = _parseArgs(args);

        QuoteVars memory v;
        if (ctx.query.tokenIn == terms.premiumToken && ctx.query.tokenOut == terms.collateralToken) {
            v.forward = true;
        } else if (ctx.query.tokenIn == terms.collateralToken && ctx.query.tokenOut == terms.premiumToken) {
            v.forward = false;
        } else {
            revert OptionPremiumWrongTokenPair(ctx.query.tokenIn, ctx.query.tokenOut);
        }
        require(block.timestamp < terms.expiry, OptionPremiumExpired(terms.expiry, block.timestamp));

        v.strike = _takerStrike(ctx, terms);
        (v.spot, v.ageSec) = _oracleSpotWad(terms.oracle, terms.maxStaleness);
        v.timeToExpiry = terms.expiry - block.timestamp;
        // Live vol surface: σ per tenor from the sigma source, skewed per strike.
        uint256 sigmaTenor = terms.sigmaSource != address(0)
            ? ISigmaSource(terms.sigmaSource).sigmaFor(v.timeToExpiry)
            : DEFAULT_SIGMA;
        // S5: LP-quoted vol — the maker's own multiplier on the tenor σ
        // (1e4 = 1.0x; 0 = take the protocol surface as-is). Competing ranges
        // with different multipliers form an order book in vol space.
        if (terms.sigmaMulBps != 0) {
            sigmaTenor = (sigmaTenor * terms.sigmaMulBps) / BPS_DENOM;
        }
        v.sigmaStrike = SmileMath.smileVol(v.spot, v.strike, sigmaTenor, terms.alpha, terms.beta);

        if (v.forward) {
            if (ctx.query.isExactIn) {
        // ... four branches: forward exact-in / exact-out price at the Ask (rounds
        // against the taker), reverse exact-in / exact-out price at the Bid.
    }
```

The maker's packed arguments carry the oracle, the sigma source (the Uniswap v4 hook), the token pair, the strike range, the expiry, the smile parameters alpha and beta, and the adverse-selection defenses (a staleness-scaled spread, a size-convex impact term, and an LP vol multiplier). The taker selects the exact strike at swap time. The swap direction selects the side of the market: premium in and collateral out is an opening trade priced at the Ask, which rounds up; collateral in and premium out is a sellback priced at the Bid, which rounds down.

The protocol fee on a call fill is an official SwapVM opcode placed in front of the pricing instruction, guarded by a jump so the fee applies only to the opening direction.

`src/vaults/AquaCollateralVault.sol`

```solidity
        if (auth.feeBps > 0) {
            bytes memory jumpArgs = ControlsArgsBuilder.buildJumpIfToken(auth.collateralToken, PC_AFTER_FEE);
            bytes memory feeArgs = FeeArgsBuilder.buildProtocolFee(auth.feeBps, auth.feeRecipient);
            program = abi.encodePacked(
                program,
                uint8(11), uint8(jumpArgs.length), jumpArgs,            // Controls._jumpIfTokenIn
                uint8(28), uint8(feeArgs.length), feeArgs               // Fee._aquaProtocolFeeAmountInXD
            );
```

### The shared premium library

At the event the vault's premium math was lifted into `SmilePremiumLib` so that every sibling vault prices off the same surface. The Ask rounds up and grosses the fee up on top; the Bid rounds down and carries no fee.

`src/periphery/SmilePremiumLib.sol`

```solidity
    function quote(Terms memory t, uint256 amountWad, bool isBuy, uint8 premiumDecimals, uint32 feeBps)
        internal
        view
        returns (uint256 lpPremium, uint256 fee)
    {
        uint256 unit = unitPremiumWad(t, amountWad, isBuy);
        if (isBuy) {
            uint256 totalWad = Math.ceilDiv(unit * amountWad, 1e18);
            lpPremium = SmileMath.scaleFromWad(totalWad, premiumDecimals, true);
            fee = feeBps > 0 ? Math.ceilDiv(lpPremium * feeBps, BPS - feeBps) : 0;
        } else {
            uint256 totalWad = (unit * amountWad) / 1e18;
            lpPremium = SmileMath.scaleFromWad(totalWad, premiumDecimals, false);
        }
    }
```

### SpreadVault: escrow the true maximum loss

A credit spread is a short option plus a long option at the same expiry, where the long leg caps the loss. `SpreadVault` prices the taker's side as the long leg at the Ask minus the short leg at the Bid, and escrows only the structure's maximum loss: `(K2 − K1) / K2` WETH per unit for a call credit spread, `K2 − K1` USDC for a put credit spread. Both round in the writer's favor (`Ceil`).

`src/periphery/SpreadVault.sol`

```solidity
        if (s.kind == Kind.CallCredit) {
            // Taker: long the K1 call at Ask, short the K2 call at Bid.
            (ask,) = SmilePremiumLib.quote(_terms(authId, s.strikes[2], true), units, true, usdcDecimals, 0);
            (bid,) = SmilePremiumLib.quote(_terms(authId, s.strikes[3], true), units, false, usdcDecimals, 0);
            // (K2-K1)/K2 WETH per unit.
            escrow = Math.mulDiv(units, s.strikes[3] - s.strikes[2], s.strikes[3], Math.Rounding.Ceil);
        } else if (s.kind == Kind.PutCredit) {
            // Taker: long the K2 put at Ask, short the K1 put at Bid.
            (ask,) = SmilePremiumLib.quote(_terms(authId, s.strikes[1], false), units, true, usdcDecimals, 0);
            (bid,) = SmilePremiumLib.quote(_terms(authId, s.strikes[0], false), units, false, usdcDecimals, 0);
            // K2-K1 USDC per unit.
            escrow = SmileMath.scaleFromWad(Math.ceilDiv(units * (s.strikes[1] - s.strikes[0]), 1e18), usdcDecimals, true);
        }
```

The pull has the same shape as the main vault's put leg, and pulls exactly the netted escrow.

`src/periphery/SpreadVault.sol`

```solidity
    function execPull(
        address lp,
        bytes32 strategyHash,
        address buyer,
        address feeRecipient_,
        uint256 premium,
        uint256 fee,
        address collateralToken,
        uint256 escrow
    ) external nonReentrantStrategy(lp, strategyHash) {
        require(msg.sender == address(this), SelfOnly());
        IERC20(usdc).safeTransferFrom(buyer, lp, premium);
        if (fee > 0) {
            IERC20(usdc).safeTransferFrom(buyer, feeRecipient_, fee);
        }
        AQUA.pull(lp, strategyHash, collateralToken, escrow, address(this));
    }
```

Settlement uses one price and one floored payout formula whose maximum over the settlement price equals the escrow exactly, so `holder payout + writer reclaim == escrow` to the wei. `test/SpreadSettlement.t.sol` fuzzes this conservation over 256 settlement prices. The Anvil lifecycle at a 3,100 settlement pulled 62,500,000,000,000,000 wei, paid holders 32,258,064,516,129,032, and returned 30,241,935,483,870,968 to the writer.

### MarginVault: initial margin, then a waterfall

`MarginVault` is puts-only and USDC-only, so margin, premium, penalties, the backstop and the insurance fund are all one token and the waterfall needs no swap. The margin requirement reads the Chainlink oracle only, never the vol hook: intrinsic value plus a spot buffer of 50% for initial margin (IM) or 30% for maintenance margin (MM), capped at the strike. The mark is the lowest Chainlink answer in the last hour.

`src/periphery/MarginVault.sol`

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

The contract's own worked example: strike 3000, one unit, spot 3000 gives IM 1,500 and MM 900; spot 2,000 gives 2,000 and 1,600; spot 0 gives 3,000 and 3,000.

When a position falls below maintenance it is flagged. The vault first sweeps the writer's free balance and, if the writer opted in, an Aqua credit line bounded by what is still shipped, in the wallet, and approved. After a one-hour grace period a 30-minute takeover auction opens with a bonus rising linearly from 1% to 10% of notional; a bidder posts fresh margin and the holder's token is untouched. Whatever nobody buys is absorbed by the backstop pool.

`src/periphery/MarginVault.sol`

```solidity
    function absorb(bytes32 sid, address writer) external nonReentrant returns (uint256 drawn) {
        Position storage pos = positions[sid][writer];
        require(pos.auctionStart != 0, AuctionNotStarted());
        require(block.timestamp >= pos.auctionStart + AUCTION_LENGTH, AuctionNotOver());
        Series storage s = seriesOf[sid];
        require(block.timestamp < s.expiry, Expired());

        uint256 notional = (s.strike * pos.units) / 1e30;
        (uint256 spot,,) = markSpot();
        uint256 mm = marginRequirement(s.strike, pos.units, spot, false);
        uint256 tip = (notional * KEEPER_TIP_BPS) / 1e4;
        uint256 penalty = (notional * PENALTY_BPS) / 1e4;

        (uint256 moved, uint256 seed) = _detach(writer, pos, mm + tip + penalty, tip, penalty, msg.sender);
        accounts[msg.sender].free += tip > moved ? moved : tip;

        if (seed < mm) {
            drawn = backstop.draw(mm - seed);
            s.backstopDrawn += drawn;
        }
        uint256 units = pos.units;
        _attach(sid, address(backstop), units, seed + drawn);
        backstop.noteRequirement(notional, true);
        _closeOut(sid, writer, pos);
        emit Absorbed(sid, writer, units, moved, drawn, tip, penalty);
    }
```

Exposure is capped in the manner of MakerDAO's debt ceiling: naked notional may never exceed seven times the backstop pool's assets. The constant is seven rather than ten because a writer sitting exactly at maintenance who gaps 40% before settlement leaves a shortfall of one seventh of naked notional, and the gap-40 solvency test holds holders whole at exactly that multiple.

`src/periphery/MarginVault.sol`

```solidity
    uint256 public constant BACKSTOP_MULTIPLE = 7;
```

Settlement is two-step: a per-writer waterfall, then one series finalization that draws the backstop, then the insurance fund, and only then imposes a pro-rata holder haircut, emitted loudly, with the IM buffer ratcheting up 500 basis points.

`src/periphery/MarginVault.sol`

```solidity
        if (shortfall > 0) {
            s.haircutBps = uint16((shortfall * 1e4) / owed);
            uint16 im = imBufferBps + HAIRCUT_RATCHET_BPS > 1e4 ? 1e4 : imBufferBps + HAIRCUT_RATCHET_BPS;
            imBufferBps = im;
            emit HolderHaircut(sid, owed, s.pot, s.haircutBps, im);
        }
```

`MarginBackstop` is a share-based USDC pool with a 24-hour withdrawal delay; withdrawals cannot drop below the pool's standing requirement and freeze while any expired series is unfinalized. The Anvil lifecycle fills a put locking 1,500 USDC, crashes spot to 2,000, flags, auctions, absorbs drawing only 175 USDC, settles at 2,000, and pays the holder exactly 1,000 USDC of intrinsic.

### RfqVault: a signed price, the same custody

`RfqVault` implements the hybrid request-for-quote (RFQ) tier. The LP ships a range exactly as on tier 1 and then signs EIP-712 typed-data quotes off-chain, with no gas and from any pricing model. A taker submits the quote and signature to `fill`, which checks the range, the size cap, the time-to-live and the single-use nonce, recovers the signer, and only then pulls collateral through the vault's Aqua strategy. The event records the formula price alongside the signed price so the improvement is auditable on-chain.

`src/periphery/RfqVault.sol`

```solidity
        require(amount <= q.maxAmount, OverQuoteSize());
        require(block.timestamp <= q.ttl, QuoteExpired());
        require(!nonceUsed[r.lp][q.nonce], QuoteUsed());

        bytes32 digest = quoteHash(q);
        address signer = ECDSA.recover(digest, signature);
        require(signer == r.lp, BadSigner(signer, r.lp));
        nonceUsed[r.lp][q.nonce] = true;

        (uint256 lpPremium, uint256 fee) = fillCost(q, amount);
        premiumPaid = lpPremium + fee;
        require(premiumPaid <= maxPremium, PremiumAboveMax());

        uint256 collateral = r.isCall ? amount : (q.strike * amount) / 1e30;
        this.execPull(r.lp, r.strategyHash, msg.sender, r.feeRecipient, r.premiumToken, r.collateralToken, lpPremium, fee, collateral);
```

The quote type is `Quote(uint256 authId,uint256 strike,uint256 maxAmount,uint256 premiumPerUnit,uint256 ttl,uint256 nonce)`. Nonces are cancellable by the LP at any time. There is deliberately no `close()` in this vault, so holders are never captive to a market maker's uptime; sellbacks stay on tier 1. The Anvil lifecycle shows a formula Ask of 691.93 USDC beaten by a signed quote of 685.01, 1 WETH pulled just-in-time at the fill, and the second fill of the same nonce reverting with `QuoteUsed`. On Arc testnet a real-USDC signed fill executed at 0.688860 against a 0.695819 formula Ask.

## Limitations

The relevant entries in [docs/limitations.md](../limitations.md) are:

- **L8, full collateralization is capital-inefficient on purpose.** The main vault locks 1 WETH per call unit and the full strike per put unit. Aqua softens this because the collateral is unrehypothecated and keeps earning until the fill, but it does not remove it. `SpreadVault` and `MarginVault` are the two rungs of the capital-efficiency ladder built to address it.
- **L11, Aqua liquidity is soft.** Because the balance behind a quote sits in the LP's own wallet, it can be spent or de-approved before the fill, and the JIT pull then reverts. Displayed depth is indicative, not firm. `FirmEscrow` (S4, MVP scope) makes a range firm by becoming the LP's wallet from Aqua's point of view; honest depth display and firmness bonds are the other mitigations (S1 through S3).
- **L7, the demand-feedback loop is nudgeable.** Sigma moves with every trade. This is why `MarginVault` reads margin off the oracle only and has no `close()`: a buyback priced off sigma and paid from margin would let a manipulated sigma drain margin.
- **L4, one transaction can drain a whole range.** The main vault carries R1's per-authorization block cap (`maxBlockNotional`, checked in `AquaCollateralVault.buy`), which bounds the drain per block. The three sibling vaults do not: a single fill on `SpreadVault`, `MarginVault` or `RfqVault` can pull an authorization's entire remaining collateral at one price. Per-range block caps were on `MarginVault`'s plan and were cut; there the loss per event is bounded by the range's `maxCollateral`.
- **L5, on-chain rules cannot reject informed traders.** Every check a vault performs is public and can be simulated before submission, so no vault can filter informed flow; the remedy is pricing (R1 through R4), which is why the formula tier carries a spread and a staleness charge rather than an allow-list.
- **L10, the off-chain alternative has its own price.** `RfqVault` is the R6 hybrid precisely because a pure RFQ market gives up the passive-LP thesis, composability, and permissionless quoting: a signed quote is frozen for its time-to-live while the market moves, and makers respond with shorter TTLs and last look. `RfqVault` keeps quotes single-use, keeps the formula tier as the always-live floor, and offers no `close()` so holders are never captive to a market maker's uptime; it does not make the quote-fading problem disappear for the maker who signs.
- **L12, the per-trade gas floor.** A repeat fill costs about 198,000 gas, in the range of an ordinary Uniswap v3 swap; the first fill in a series costs about 1,040,000 because it deploys that series' ERC-20 token. The premium arithmetic is a rounding error inside that; the floor is series bootstrapping, and EIP-1167 clones or keeper pre-deployment are the mitigations. Aqua's pull adds one external call per fill and does not change this picture.
- **L13, bad debt in the opt-in margin tier.** The haircut path exists. The seven-times ceiling and the gap-40 test bound it, they do not eliminate it: a gap larger than 40% from the maintenance point within one heartbeat can exceed the pool. The credit line is consent, not collateral. Takeover and absorb move whole positions only.
- **Scope cuts recorded in the code.** `SpreadVault` validates iron-condor strikes but does not price or fill them. `MarginVault` covers puts only; a call shortfall is in WETH and has no USDC waterfall yet. A full liquidation run has been demonstrated on Anvil only, since public testnets cannot be time-warped; the fill itself is live on Sepolia and Arc.

## Plans

The entries in [docs/solutions.md](../solutions.md) and the plan in [docs/plans/2026-09-05-aqua.md](../plans/2026-09-05-aqua.md):

- **S12, defined-risk netting.** Implemented at the event as `SpreadVault` (tasks A1 through A4). Task A5, debit spreads collateralized by the long `OptionToken` under the dominance result, was optional in the plan and was cut first. Iron condor pricing (max-not-sum escrow of the two sides) is designed and strike-validated but not yet fillable. The optional SwapVM opcode for the call-credit leg was scoped and not attempted; a correct SwapVM-free `SpreadVault` still qualifies as an Aqua app.
- **S13, MarginVault.** Implemented as tasks B1 through B8. Remaining items in the plan's cut order: partial-unit takeover, per-range block caps (`maxBlockNotional`, R1), and calls once a WETH shortfall can be paid.
- **R6, hybrid RFQ.** Implemented as `RfqVault` (task A6, beyond the original plan). The interpolation of sigma across tenor buckets, which the README's design note defers to an RFQ-style quoting layer, is a natural next step now that a signed-quote path exists.
- **S4, the firm tier.** `FirmEscrow` ships the MVP (plain collateral, firm Ask depth). The full version, yield-bearing escrow in wstETH and sDAI, is gated on fill-reliability data (S3) and firm-tier uptake.
- **S10, distribution through the 1inch ecosystem**, remains a plan item and is not addressed by any code on this branch.

## Glossary

- **Aqua.** 1inch's shared-liquidity protocol. A maker registers a strategy with an application and keeps the tokens in the maker's own wallet; the application may pull tokens against that strategy when a trade executes.
- **AquaApp.** The base contract an application inherits to interact with Aqua. Every Smile vault is an AquaApp; for puts and for the three sibling vaults, the vault itself is the application.
- **Strategy hash.** The identifier under which Aqua tracks a maker's shipped balances for one strategy. For Smile calls it is the hash of the SwapVM order; for puts and the sibling vaults it is the hash of an abi-encoded terms blob.
- **Ship / dock.** `Aqua.ship` activates a strategy and declares the tokens and amounts the maker commits to it; `Aqua.dock` deactivates it. Neither moves tokens.
- **JIT pull.** A just-in-time `Aqua.pull` that moves collateral out of the maker's wallet only in the transaction that needs it. The collateral is unrehypothecated: it was never lent or reused while it waited.
- **`nonReentrantStrategy`.** Aqua's reentrancy guard, keyed on the maker and strategy hash, that brackets every pull.
- **SwapVM.** 1inch's on-chain virtual machine that executes a maker's order as a program of opcodes.
- **Opcode / instruction.** One step of a SwapVM program. The official Aqua set occupies indices 0 through 32; Smile's `OptionPremiumInstruction` is index 33.
- **Order.** The SwapVM structure a maker signs or hashes that carries the program and its arguments. Smile's call strategies are orders.
- **Ask / Bid.** The price at which a taker opens a position (rounded up, fee grossed up on top) and the price at which a taker sells back (rounded down, no fee). One strategy quotes both; the swap direction selects the side.
- **Escrow.** Collateral held by a vault against a written option. On the main vault and `SpreadVault` the escrow equals the option's maximum payout.
- **Credit spread.** A short option plus a long option at the same expiry where the writer receives net premium; the long leg caps the writer's loss.
- **Initial margin (IM) / maintenance margin (MM).** The collateral a `MarginVault` writer posts at the fill, and the floor below which liquidation begins.
- **Worst-of-hour mark.** The lowest Chainlink answer in the last hour, used by `MarginVault` as the price for margin arithmetic.
- **Naked notional.** Strike times units minus the margin locked at the fill; the exposure the backstop must be able to absorb.
- **Backstop.** `MarginBackstop`, a pre-funded, share-based USDC pool that adopts positions nobody bought at auction and pays the residual shortfall at finalization.
- **Insurance fund.** A balance inside `MarginVault` funded by half of the protocol fee and by liquidation penalties, drawn after the backstop.
- **Waterfall.** The fixed order in which a holder is made whole: writer margin, writer free balance and credit line, takeover bidder, backstop, insurance, and finally a haircut.
- **Haircut.** Holders receive less than owed, pro rata, because every earlier layer of the waterfall was exhausted; `HolderHaircut` is emitted and the IM buffer is raised.
- **RFQ (request-for-quote).** A model in which a maker signs short-lived prices off-chain and the chain verifies and settles them.
- **EIP-712.** The Ethereum standard for signing typed, human-readable structured data; `RfqVault` quotes are EIP-712 messages.
- **Nonce.** A single-use number inside a quote that prevents the same quote from being filled twice; the LP can cancel a nonce at any time.
- **TTL (time to live).** The timestamp after which a signed quote is no longer fillable.
- **NBBO plus price improvement.** The tradfi structure in which a public best price is the floor and competing makers may beat it; the model for the RFQ tier.
- **Firm versus indicative depth.** Firm depth is guaranteed to fill; indicative depth is an intention that may fail at fill time. Aqua depth is indicative; `FirmEscrow` depth is firm.
- **EIP-170.** The 24,576-byte contract size limit; the reason the sibling vaults are separate contracts rather than additions to the main vault.
