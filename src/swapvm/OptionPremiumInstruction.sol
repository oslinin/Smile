// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";
import { IPriceOracle } from "@1inch/swap-vm/src/instructions/interfaces/IPriceOracle.sol";

import { SmileMath } from "./SmileMath.sol";

/// @notice Live vol-surface source (the Uniswap v4 `OptionPricingHook`
/// implements this — σ per tenor bucket, demand feedback bumps it).
interface ISigmaSource {
    function sigmaFor(uint256 timeToExpiry) external view returns (uint256);
}

/// @notice Builder for the packed maker args of `_optionPremiumXD`, mirroring
/// the official SwapVM `*ArgsBuilder` style (e.g. ControlsArgsBuilder).
library OptionPremiumArgsBuilder {
    /// @dev Packed layout v3 (150 bytes total):
    ///   oracle          | 20 bytes — Chainlink-style aggregator for spot
    ///   sigmaSource     | 20 bytes — ISigmaSource (0 → DEFAULT_SIGMA)
    ///   premiumToken    | 20 bytes — the premium leg of the pair
    ///   collateralToken | 20 bytes — the collateral leg of the pair
    ///   premiumDecimals |  1 byte
    ///   strikeMin       | 16 bytes — uint128, WAD USD
    ///   strikeMax       | 16 bytes — uint128, WAD USD
    ///   expiry          |  5 bytes — uint40 unix timestamp
    ///   alpha           |  8 bytes — uint64, WAD smile curvature
    ///   beta            |  8 bytes — int64, WAD skew tilt (signed)
    ///   maxStaleness    |  2 bytes — uint16 seconds; 0 = no staleness check
    ///   baseSpreadBps   |  2 bytes — uint16, half-spread floor (1e4 = 100%)
    ///   stalenessSpreadBpsPerHour | 2 bytes — uint16, extra half-spread per
    ///                     hour of oracle age (staleness-scaled spread)
    ///   impactPerUnit   |  8 bytes — uint64, WAD σ added per option unit
    ///                     traded (size-convex intra-trade impact)
    ///   sigmaMulBps     |  2 bytes — uint16, LP vol multiplier (1e4 = 1.0x;
    ///                     0 = protocol default surface)
    function build(
        address oracle,
        address sigmaSource,
        address premiumToken,
        address collateralToken,
        uint8 premiumDecimals,
        uint128 strikeMin,
        uint128 strikeMax,
        uint40 expiry,
        uint64 alpha,
        int64 beta,
        uint16 maxStaleness,
        uint16 baseSpreadBps,
        uint16 stalenessSpreadBpsPerHour,
        uint64 impactPerUnit,
        uint16 sigmaMulBps
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            abi.encodePacked(
                oracle, sigmaSource, premiumToken, collateralToken,
                premiumDecimals, strikeMin, strikeMax, expiry, alpha, beta, maxStaleness
            ),
            baseSpreadBps, stalenessSpreadBpsPerHour, impactPerUnit, sigmaMulBps
        );
    }
}

/// @title OptionPremiumInstruction — custom SwapVM instruction
/// @notice Prices a covered-call option inside the official 1inch SwapVM.
/// The maker (LP) ships one strategy for an entire strike RANGE; the taker
/// selects the exact strike at swap time via taker instruction args. The swap
/// is premiumToken (tokenIn, e.g. USDC) → collateralToken (tokenOut, e.g.
/// WETH), where tokenOut is pulled just-in-time from the maker wallet through
/// Aqua and escrowed by the taker-side vault, which mints the OptionToken.
///
/// The strategy quotes a TWO-SIDED market — swap direction selects the side:
///   forward (premium → collateral): open a position  → priced at Ask (rounds up)
///   reverse (collateral → premium): sell back / close → priced at Bid (rounds down)
///
/// Adverse-selection defenses baked into the quote (see docs/limitations.md
/// and docs/solutions.md):
///   - staleness-scaled spread: the Ask−Bid half-spread widens continuously
///     with the oracle answer's age on top of a base floor (R3+R4);
///   - size-convex impact: a trade executes at the σ it would itself cause,
///     averaged over the fill — large informed orders pay their own price
///     impact at execution time instead of the pre-bump price (R2);
///   - LP-quoted vol: an optional per-strategy σ multiplier lets makers
///     compete on vol, turning overlapping ranges into vol discovery (S5).
contract OptionPremiumInstruction {
    using Calldata for bytes;
    using ContextLib for Context;

    error OptionPremiumMissingArgs();
    error OptionPremiumRecomputeDetected();
    error OptionPremiumExpired(uint256 expiry, uint256 nowTimestamp);
    error OptionPremiumWrongTokenPair(address tokenIn, address tokenOut);
    error OptionPremiumStrikeMissing();
    error OptionPremiumStrikeOutOfRange(uint256 strike, uint256 strikeMin, uint256 strikeMax);
    error OptionPremiumBadOraclePrice(int256 answer);
    error OptionPremiumStaleOraclePrice(uint256 updatedAt, uint256 maxStaleness, uint256 nowTimestamp);

    /// @dev Fallback σ when no sigma source is wired (80% IV).
    uint256 internal constant DEFAULT_SIGMA = 0.8e18;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant ARGS_LENGTH = 150;
    /// @dev Spread math scale: 1e4 bps = 100%.
    uint256 internal constant BPS_DENOM = 1e4;
    /// @dev Hard cap on the half-spread — quotes never widen past 20%.
    uint256 internal constant MAX_HALF_SPREAD_BPS = 2000;

    struct OptionTerms {
        address oracle;
        address sigmaSource;
        address premiumToken;
        address collateralToken;
        uint8 premiumDecimals;
        uint256 strikeMin;
        uint256 strikeMax;
        uint256 expiry;
        uint256 alpha;
        int256 beta;
        uint256 maxStaleness;
        uint256 baseSpreadBps;
        uint256 stalenessSpreadBpsPerHour;
        uint256 impactPerUnit;
        uint256 sigmaMulBps;
    }

    /// @dev Everything the per-side pricing needs, bundled to keep the
    /// four exact-in/out branches readable under the stack limit.
    struct QuoteVars {
        uint256 spot;
        uint256 ageSec;
        uint256 strike;
        uint256 timeToExpiry;
        uint256 sigmaStrike;
        bool forward;
    }

    /// @dev Custom instruction body. Maker args are the packed option terms
    /// (see OptionPremiumArgsBuilder); taker instruction args carry the chosen
    /// strike as 32 bytes (optional when strikeMin == strikeMax).
    ///
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
                // Buyer fixed the premium budget; option units round DOWN at Ask.
                // Units depend on impact which depends on units — two
                // fixed-point iterations, biased maker-safe (the first pass
                // over-estimates units, so the priced impact is an upper bound).
                require(ctx.swap.amountOut == 0, OptionPremiumRecomputeDetected());
                uint256 paidWad = SmileMath.scaleToWad(ctx.swap.amountIn, terms.premiumDecimals);
                uint256 units = (paidWad * WAD) / _unitPremiumWad(terms, v, 0);
                ctx.swap.amountOut = (paidWad * WAD) / _unitPremiumWad(terms, v, units);
            } else {
                // Buyer fixed the option units; premium rounds UP at Ask.
                require(ctx.swap.amountIn == 0, OptionPremiumRecomputeDetected());
                uint256 costWad = Math.ceilDiv(ctx.swap.amountOut * _unitPremiumWad(terms, v, ctx.swap.amountOut), WAD);
                ctx.swap.amountIn = SmileMath.scaleFromWad(costWad, terms.premiumDecimals, true);
            }
        } else {
            if (ctx.query.isExactIn) {
                // Holder sells a fixed number of units; premium out rounds DOWN at Bid.
                require(ctx.swap.amountOut == 0, OptionPremiumRecomputeDetected());
                uint256 valueWad = (ctx.swap.amountIn * _unitPremiumWad(terms, v, ctx.swap.amountIn)) / WAD;
                ctx.swap.amountOut = SmileMath.scaleFromWad(valueWad, terms.premiumDecimals, false);
            } else {
                // Holder wants fixed premium out; units in round UP at Bid.
                require(ctx.swap.amountIn == 0, OptionPremiumRecomputeDetected());
                uint256 outWad = SmileMath.scaleToWad(ctx.swap.amountOut, terms.premiumDecimals);
                uint256 units = Math.ceilDiv(outWad * WAD, _unitPremiumWad(terms, v, 0));
                ctx.swap.amountIn = Math.ceilDiv(outWad * WAD, _unitPremiumWad(terms, v, units));
            }
        }
    }

    /// @dev Per-unit premium (WAD) for a trade of `unitsWad`, with the
    /// size-convex impact (R2) and the staleness-scaled spread (R3/R4)
    /// applied on top of the raw surface premium.
    function _unitPremiumWad(
        OptionTerms memory terms,
        QuoteVars memory v,
        uint256 unitsWad
    ) private pure returns (uint256 premiumWad) {
        // R2: the trade executes at the σ it would itself cause, averaged
        // over the fill. Ask walks σ up; Bid walks it down, floored at 10%
        // of the surface σ so huge sellbacks can't zero the quote.
        uint256 impact = (terms.impactPerUnit * unitsWad) / (2 * WAD);
        uint256 sigmaEff;
        if (v.forward) {
            sigmaEff = v.sigmaStrike + impact;
        } else {
            uint256 floorSigma = v.sigmaStrike / 10;
            sigmaEff = v.sigmaStrike > impact ? v.sigmaStrike - impact : floorSigma;
            if (sigmaEff < floorSigma) sigmaEff = floorSigma;
        }

        premiumWad = SmileMath.premium(v.spot, v.strike, v.timeToExpiry, sigmaEff, true, v.forward);

        // R3/R4: half-spread = base floor + slope · oracle age, capped at 20%.
        // A fresh round quotes tight; a stale-but-within-bounds round quotes
        // wide, pricing the latency risk continuously instead of cliffing.
        uint256 halfSpreadBps = terms.baseSpreadBps + (terms.stalenessSpreadBpsPerHour * v.ageSec) / 3600;
        if (halfSpreadBps > MAX_HALF_SPREAD_BPS) halfSpreadBps = MAX_HALF_SPREAD_BPS;
        if (halfSpreadBps > 0) {
            premiumWad = v.forward
                ? Math.ceilDiv(premiumWad * (BPS_DENOM + halfSpreadBps), BPS_DENOM)
                : (premiumWad * (BPS_DENOM - halfSpreadBps)) / BPS_DENOM;
        }
    }

    function _parseArgs(bytes calldata args) private pure returns (OptionTerms memory terms) {
        require(args.length == ARGS_LENGTH, OptionPremiumMissingArgs());
        terms.oracle = address(bytes20(args.slice(0, 20, OptionPremiumMissingArgs.selector)));
        terms.sigmaSource = address(bytes20(args.slice(20, 40, OptionPremiumMissingArgs.selector)));
        terms.premiumToken = address(bytes20(args.slice(40, 60, OptionPremiumMissingArgs.selector)));
        terms.collateralToken = address(bytes20(args.slice(60, 80, OptionPremiumMissingArgs.selector)));
        terms.premiumDecimals = uint8(bytes1(args.slice(80, 81, OptionPremiumMissingArgs.selector)));
        terms.strikeMin = uint128(bytes16(args.slice(81, 97, OptionPremiumMissingArgs.selector)));
        terms.strikeMax = uint128(bytes16(args.slice(97, 113, OptionPremiumMissingArgs.selector)));
        terms.expiry = uint40(bytes5(args.slice(113, 118, OptionPremiumMissingArgs.selector)));
        terms.alpha = uint64(bytes8(args.slice(118, 126, OptionPremiumMissingArgs.selector)));
        terms.beta = int64(uint64(bytes8(args.slice(126, 134, OptionPremiumMissingArgs.selector))));
        terms.maxStaleness = uint16(bytes2(args.slice(134, 136, OptionPremiumMissingArgs.selector)));
        terms.baseSpreadBps = uint16(bytes2(args.slice(136, 138, OptionPremiumMissingArgs.selector)));
        terms.stalenessSpreadBpsPerHour = uint16(bytes2(args.slice(138, 140, OptionPremiumMissingArgs.selector)));
        terms.impactPerUnit = uint64(bytes8(args.slice(140, 148, OptionPremiumMissingArgs.selector)));
        terms.sigmaMulBps = uint16(bytes2(args.slice(148, 150, OptionPremiumMissingArgs.selector)));
    }

    /// @dev Reads the taker-chosen strike (32 bytes) from taker instruction
    /// args. A maker strategy spans a whole strike range — this is what lets
    /// one Aqua balance quote the entire option chain.
    function _takerStrike(Context memory ctx, OptionTerms memory terms) private pure returns (uint256 strike) {
        bytes calldata strikeArg = ctx.tryChopTakerArgs(32);
        if (strikeArg.length == 32) {
            strike = uint256(bytes32(strikeArg));
        } else {
            require(terms.strikeMin == terms.strikeMax, OptionPremiumStrikeMissing());
            strike = terms.strikeMin;
        }
        require(
            strike >= terms.strikeMin && strike <= terms.strikeMax,
            OptionPremiumStrikeOutOfRange(strike, terms.strikeMin, terms.strikeMax)
        );
    }

    /// @dev Chainlink-style spot read, normalized to WAD, with a staleness
    /// guard mirroring the official SwapVM OraclePriceAdjuster instruction.
    /// Also returns the answer's age so the spread can scale with it (R3).
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
}
