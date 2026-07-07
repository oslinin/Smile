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
    /// @dev Packed layout v2 (136 bytes total):
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
        uint16 maxStaleness
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            oracle, sigmaSource, premiumToken, collateralToken,
            premiumDecimals, strikeMin, strikeMax, expiry, alpha, beta, maxStaleness
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
/// Sides map onto SwapVM's amount semantics:
///   exactOut (taker fixes collateral/options wanted) → premium rounds UP  → Ask
///   exactIn  (taker fixes premium spent)             → options round DOWN → Bid
contract OptionPremiumInstruction {
    using Calldata for bytes;
    using ContextLib for Context;

    error OptionPremiumMissingArgs();
    error OptionPremiumRecomputeDetected();
    error OptionPremiumExpired(uint256 expiry, uint256 nowTimestamp);
    error OptionPremiumWrongTokenIn(address tokenIn, address premiumToken);
    error OptionPremiumWrongTokenOut(address tokenOut, address collateralToken);
    error OptionPremiumStrikeMissing();
    error OptionPremiumStrikeOutOfRange(uint256 strike, uint256 strikeMin, uint256 strikeMax);
    error OptionPremiumBadOraclePrice(int256 answer);
    error OptionPremiumStaleOraclePrice(uint256 updatedAt, uint256 maxStaleness, uint256 nowTimestamp);

    /// @dev Fallback σ when no sigma source is wired (80% IV).
    uint256 internal constant DEFAULT_SIGMA = 0.8e18;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant ARGS_LENGTH = 136;

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
    }

    /// @dev Custom instruction body. Maker args are the packed option terms
    /// (see OptionPremiumArgsBuilder); taker instruction args carry the chosen
    /// strike as 32 bytes (optional when strikeMin == strikeMax).
    function _optionPremiumXD(Context memory ctx, bytes calldata args) internal view {
        OptionTerms memory terms = _parseArgs(args);

        require(ctx.query.tokenIn == terms.premiumToken, OptionPremiumWrongTokenIn(ctx.query.tokenIn, terms.premiumToken));
        require(ctx.query.tokenOut == terms.collateralToken, OptionPremiumWrongTokenOut(ctx.query.tokenOut, terms.collateralToken));
        require(block.timestamp < terms.expiry, OptionPremiumExpired(terms.expiry, block.timestamp));

        uint256 strike = _takerStrike(ctx, terms);
        uint256 spot = _oracleSpotWad(terms.oracle, terms.maxStaleness);
        uint256 timeToExpiry = terms.expiry - block.timestamp;
        // Live vol surface: σ per tenor from the sigma source, skewed per strike.
        uint256 sigmaTenor = terms.sigmaSource != address(0)
            ? ISigmaSource(terms.sigmaSource).sigmaFor(timeToExpiry)
            : DEFAULT_SIGMA;
        uint256 sigmaStrike = SmileMath.smileVol(spot, strike, sigmaTenor, terms.alpha, terms.beta);

        if (ctx.query.isExactIn) {
            // Bid side: taker fixed the premium; options received round DOWN.
            require(ctx.swap.amountOut == 0, OptionPremiumRecomputeDetected());
            uint256 premiumWad = SmileMath.premium(spot, strike, timeToExpiry, sigmaStrike, true, false);
            uint256 paidWad = SmileMath.scaleToWad(ctx.swap.amountIn, terms.premiumDecimals);
            ctx.swap.amountOut = (paidWad * WAD) / premiumWad;
        } else {
            // Ask side: taker fixed the collateral (option units); premium rounds UP.
            require(ctx.swap.amountIn == 0, OptionPremiumRecomputeDetected());
            uint256 premiumWad = SmileMath.premium(spot, strike, timeToExpiry, sigmaStrike, true, true);
            uint256 costWad = Math.ceilDiv(ctx.swap.amountOut * premiumWad, WAD);
            ctx.swap.amountIn = SmileMath.scaleFromWad(costWad, terms.premiumDecimals, true);
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
    function _oracleSpotWad(address oracle, uint256 maxStaleness) private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = IPriceOracle(oracle).latestRoundData();
        require(answer > 0, OptionPremiumBadOraclePrice(answer));
        require(
            maxStaleness == 0 || (updatedAt != 0 && block.timestamp <= updatedAt + maxStaleness),
            OptionPremiumStaleOraclePrice(updatedAt, maxStaleness, block.timestamp)
        );
        uint8 decimals = IPriceOracle(oracle).decimals();
        return SmileMath.scaleToWad(uint256(answer), decimals);
    }
}
