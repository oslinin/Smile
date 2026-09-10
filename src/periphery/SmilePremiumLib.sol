// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPriceOracle } from "@1inch/swap-vm/src/instructions/interfaces/IPriceOracle.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

import { SmileMath } from "../swapvm/SmileMath.sol";

interface ISigmaSource {
    function sigmaFor(uint256 timeToExpiry) external view returns (uint256);
}

/// @notice The vault's put-side premium math (`AquaCollateralVault._putUnitPremiumWad`
/// and `_putQuote`), lifted into a library with an `isCall` flag so sibling
/// vaults (SpreadVault) quote off the identical surface — same σ source,
/// same S5 multiplier, same R2 impact, same R3/R4 spread, same fee
/// gross-up — and provably agree with `vault.putQuote` to the wei
/// (test_quote_putLegMatchesVaultPutQuote). One addition the vault doesn't
/// have: MIN_QUOTE_SIGMA. σ can be walked toward zero through the
/// demand-feedback loop (L7), and a two-leg spread quote must never
/// collapse to 0 on the way — the floor is inert at the default σ.
library SmilePremiumLib {
    uint256 internal constant ALPHA = 2e18;
    uint256 internal constant DEFAULT_SIGMA = 0.8e18;
    uint256 internal constant MIN_QUOTE_SIGMA = 0.2e18;
    uint256 internal constant MAX_HALF_SPREAD_BPS = 2000;

    error BadOraclePrice();
    error StaleOraclePrice();

    struct Terms {
        uint256 spotWad;
        uint256 ageSec;
        uint256 strike;
        uint256 expiry;
        address sigmaSource;
        int256 beta;
        uint16 sigmaMulBps;
        uint16 baseSpreadBps;
        uint16 stalenessSpreadBpsPerHour;
        uint64 impactPerUnit;
        bool isCall;
    }

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

    /// @dev Per-unit premium in WAD USD — Ask when `isBuy`, Bid otherwise.
    /// Arithmetic order is copied from the vault verbatim; reordering any of
    /// it breaks the wei-equality the SpreadVault tests depend on.
    function unitPremiumWad(Terms memory t, uint256 amountWad, bool isBuy)
        internal
        view
        returns (uint256 premiumWad)
    {
        uint256 timeToExpiry = t.expiry - block.timestamp;
        uint256 sigma = t.sigmaSource != address(0)
            ? ISigmaSource(t.sigmaSource).sigmaFor(timeToExpiry)
            : DEFAULT_SIGMA;
        if (t.sigmaMulBps != 0) sigma = (sigma * t.sigmaMulBps) / 1e4; // S5
        if (sigma < MIN_QUOTE_SIGMA) sigma = MIN_QUOTE_SIGMA;

        uint256 sigmaStrike = SmileMath.smileVol(t.spotWad, t.strike, sigma, ALPHA, t.beta);

        // R2: size-convex impact.
        uint256 impact = (uint256(t.impactPerUnit) * amountWad) / (2 * 1e18);
        if (isBuy) {
            sigmaStrike += impact;
        } else {
            uint256 floorSigma = sigmaStrike / 10;
            sigmaStrike = sigmaStrike > impact ? sigmaStrike - impact : floorSigma;
            if (sigmaStrike < floorSigma) sigmaStrike = floorSigma;
        }

        premiumWad = SmileMath.premium(t.spotWad, t.strike, timeToExpiry, sigmaStrike, t.isCall, isBuy);

        // R3/R4: half-spread floor + staleness slope, capped at 20%.
        uint256 halfSpreadBps =
            uint256(t.baseSpreadBps) + (uint256(t.stalenessSpreadBpsPerHour) * t.ageSec) / 3600;
        if (halfSpreadBps > MAX_HALF_SPREAD_BPS) halfSpreadBps = MAX_HALF_SPREAD_BPS;
        if (halfSpreadBps > 0) {
            premiumWad = isBuy
                ? Math.ceilDiv(premiumWad * (1e4 + halfSpreadBps), 1e4)
                : (premiumWad * (1e4 - halfSpreadBps)) / 1e4;
        }
    }

    /// @dev Total for `amountWad` units in the premium token's own decimals.
    /// Ask side: ceil everywhere plus the protocol-fee gross-up (same shape
    /// as `_putQuote` and the SwapVM fee opcode). Bid side: floor, fee-free —
    /// sellbacks never pay the protocol fee.
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
}
