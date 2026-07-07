// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed-point option-premium math shared by the on-chain quoting
/// facade (`OptionPricingEngine`) and the custom SwapVM instruction
/// (`OptionPremiumInstruction`), so both paths price identically.
///
/// Model: premium = intrinsic + time-value, where time-value scales with a
/// parametric volatility smile  σ_strike = σ_global · (1 + α · ln(K/S)²).
library SmileMath {
    uint256 internal constant WAD = 1e18;

    error LnNonPositive();

    /// @notice σ_strike = σ_global · (1 + α · ln(K/S)²)  — symmetric smile.
    /// OTM/ITM strikes scale above σ_global; ATM (K==S) returns σ_global exactly.
    function smileVol(
        uint256 spot,
        uint256 strike,
        uint256 sigmaGlobal,
        uint256 alpha
    ) internal pure returns (uint256) {
        return smileVol(spot, strike, sigmaGlobal, alpha, 0);
    }

    /// @notice σ_strike = σ · (1 + α · ln(K/S)² + β · ln(K/S))  — smile + skew.
    /// β < 0 tilts the surface so low strikes (downside) price richer, matching
    /// the empirical equity/crypto skew; β = 0 recovers the symmetric smile.
    /// The multiplier is floored at 0.1 so deep wings can never zero out σ.
    function smileVol(
        uint256 spot,
        uint256 strike,
        uint256 sigma,
        uint256 alpha,
        int256 beta
    ) internal pure returns (uint256) {
        if (spot == 0) return sigma;
        // ln(K/S) in WAD
        int256 lnKS = lnWad(int256((strike * WAD) / spot));
        // lnKS² in WAD
        uint256 lnKS2 = uint256((lnKS * lnKS) / int256(WAD));
        // multiplier = 1 + α·lnKS² + β·lnKS  (in WAD, signed while skew applies)
        int256 multiplier = int256(WAD + (alpha * lnKS2) / WAD) + (beta * lnKS) / int256(WAD);
        int256 floorMultiplier = int256(WAD / 10);
        if (multiplier < floorMultiplier) multiplier = floorMultiplier;
        return (sigma * uint256(multiplier)) / WAD;
    }

    /// @notice Parametric premium per 1e18 option units, in WAD USD.
    /// time-value = spot · σ_strike · sqrt(T/365d) · moneyness-damping
    /// Asymmetric rounding: BUY adds 1 wei (Ask), SELL keeps floor (Bid).
    /// @param isCall true prices a call (intrinsic = S−K), false a put (K−S).
    function premium(
        uint256 spot,
        uint256 strike,
        uint256 timeToExpiry,
        uint256 sigmaStrike,
        bool isCall,
        bool isBuy
    ) internal pure returns (uint256) {
        uint256 intrinsic;
        if (isCall) {
            intrinsic = spot > strike ? spot - strike : 0;
        } else {
            intrinsic = strike > spot ? strike - spot : 0;
        }
        uint256 sqrtT = sqrtWad((timeToExpiry * WAD) / 365 days);
        uint256 timeValue = (spot * sigmaStrike) / WAD;
        timeValue = (timeValue * sqrtT) / WAD;
        // Moneyness damping: time value peaks at-the-money, falls off for OTM/deep-ITM.
        // factor = min(S,K)/max(S,K)  ∈ (0,1], equals 1 when S==K.
        uint256 moneyFactor = spot < strike
            ? (spot * WAD) / strike
            : (strike * WAD) / spot;
        timeValue = (timeValue * moneyFactor) / WAD;
        uint256 raw = intrinsic + timeValue;
        // BUY rounds up → Ask; SELL rounds down → Bid. Same strike, consistent spread.
        return isBuy ? raw + 1 : raw;
    }

    /// @dev Natural log via Padé-like series: ln(x) ≈ 2·u·(1 + u²/3 + u⁴/5)
    /// where u = (x-1)/(x+1). Accurate to ~0.5% for K/S in [0.5, 2.0].
    function lnWad(int256 x) internal pure returns (int256) {
        require(x > 0, LnNonPositive());
        int256 iWAD = int256(WAD);
        int256 u = ((x - iWAD) * iWAD) / (x + iWAD);
        int256 u2 = (u * u) / iWAD;
        int256 u4 = (u2 * u2) / iWAD;
        // 2u(1 + u²/3 + u⁴/5)
        return 2 * (u + u2 / 3 + u4 / 5);
    }

    /// @dev Integer sqrt returning WAD-scaled result given a WAD-scaled input.
    /// sqrt(x/WAD) in WAD = sqrt(x * WAD). Newton converges to this directly.
    function sqrtWad(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 s = x * WAD;
        uint256 z = (s + 1) / 2;
        uint256 y = s;
        while (z < y) { y = z; z = (s / z + z) / 2; }
        return y;
    }

    /// @notice Scale a WAD (18-dec) USD amount into a token's own decimals.
    /// @param roundUp true → ceil (Ask side), false → floor (Bid side).
    function scaleFromWad(uint256 amountWad, uint8 decimals, bool roundUp) internal pure returns (uint256) {
        if (decimals == 18) return amountWad;
        if (decimals < 18) {
            uint256 factor = 10 ** (18 - decimals);
            uint256 scaled = amountWad / factor;
            if (roundUp && scaled * factor != amountWad) scaled += 1;
            return scaled;
        }
        return amountWad * (10 ** (decimals - 18));
    }

    /// @notice Scale a token-decimals amount up to WAD (18-dec).
    function scaleToWad(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        if (decimals == 18) return amount;
        if (decimals < 18) return amount * (10 ** (18 - decimals));
        return amount / (10 ** (decimals - 18));
    }
}
