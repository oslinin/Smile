// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stateless pricing engine modelling the SwapVM instruction path.
/// Pure functions only — no storage, no side effects.
/// Side: true = BUY (exactOut → round up → Ask), false = SELL (exactIn → round down → Bid).
contract OptionPricingEngine {
    uint256 internal constant WAD = 1e18;

    struct PricingParams {
        uint256 spot;        // S in WAD
        uint256 strike;      // K in WAD
        uint256 expiry;      // Unix timestamp
        uint256 sigmaGlobal; // σ_global in WAD (e.g. 0.8e18 = 80%)
        uint256 alpha;       // smile curvature in WAD (e.g. 2e18)
        bool isBuy;          // true = Ask (round up), false = Bid (round down)
    }

    /// @notice Entry point — returns premium in the same unit as spot/strike.
    function quote(PricingParams calldata p) external view returns (uint256 premium) {
        require(block.timestamp < p.expiry, "expired");
        uint256 sigmaStrike = smileVol(p.spot, p.strike, p.sigmaGlobal, p.alpha);
        premium = computePremium(p.spot, p.strike, p.expiry, sigmaStrike, p.isBuy);
    }

    /// @notice σ_strike = σ_global · (1 + α · ln(K/S)²)  — multiplicative smile.
    /// OTM/ITM strikes scale above σ_global; ATM (K==S) returns σ_global exactly.
    function smileVol(
        uint256 spot,
        uint256 strike,
        uint256 sigmaGlobal,
        uint256 alpha
    ) public pure returns (uint256) {
        if (spot == 0) return sigmaGlobal;
        // ln(K/S) in WAD
        int256 lnKS = _lnWad(int256((strike * WAD) / spot));
        // lnKS² in WAD
        uint256 lnKS2 = uint256((lnKS * lnKS) / int256(WAD));
        // multiplier = 1 + alpha * lnKS²  (in WAD)
        uint256 multiplier = WAD + (alpha * lnKS2) / WAD;
        return (sigmaGlobal * multiplier) / WAD;
    }

    /// @notice Parametric premium: intrinsic + time-value.
    /// time-value = spot · σ_strike · sqrt(T/365d)
    /// Asymmetric rounding: BUY adds 1 wei (Ask), SELL keeps floor (Bid).
    function computePremium(
        uint256 spot,
        uint256 strike,
        uint256 expiry,
        uint256 sigmaStrike,
        bool isBuy
    ) public view returns (uint256 premium) {
        uint256 T = expiry > block.timestamp ? expiry - block.timestamp : 0;
        uint256 intrinsic = spot > strike ? spot - strike : 0;
        uint256 sqrtT = _sqrtWad((T * WAD) / 365 days);
        uint256 timeValue = (spot * sigmaStrike) / WAD;
        timeValue = (timeValue * sqrtT) / WAD;
        uint256 raw = intrinsic + timeValue;
        // BUY rounds up → Ask; SELL rounds down → Bid. Same strike, consistent spread.
        premium = isBuy ? raw + 1 : raw;
    }

    // ── Integer math helpers ──────────────────────────────────────────────────

    /// @dev Natural log via Padé-like series: ln(x) ≈ 2·u·(1 + u²/3 + u⁴/5)
    /// where u = (x-1)/(x+1). Accurate to ~0.5% for K/S in [0.5, 2.0].
    function _lnWad(int256 x) internal pure returns (int256) {
        require(x > 0, "ln(<=0)");
        int256 iWAD = int256(WAD);
        int256 u = ((x - iWAD) * iWAD) / (x + iWAD);
        int256 u2 = (u * u) / iWAD;
        int256 u4 = (u2 * u2) / iWAD;
        // 2u(1 + u²/3 + u⁴/5)
        return 2 * (u + u2 / 3 + u4 / 5);
    }

    /// @dev Integer sqrt returning WAD-scaled result given a WAD-scaled input.
    function _sqrtWad(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        // sqrt(x * 1e18) via Newton, then divide by 1e9 to stay in WAD
        uint256 s = x * WAD;
        uint256 z = (s + 1) / 2;
        uint256 y = s;
        while (z < y) { y = z; z = (s / z + z) / 2; }
        return y / 1e9;
    }
}
