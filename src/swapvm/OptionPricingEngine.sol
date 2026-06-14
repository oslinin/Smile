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

    function smileVol(
        uint256 spot,
        uint256 strike,
        uint256 sigmaGlobal,
        uint256 alpha
    ) public pure virtual returns (uint256) {
        return sigmaGlobal; // stub — implemented in Commit 4
    }

    function computePremium(
        uint256 spot,
        uint256 strike,
        uint256 expiry,
        uint256 sigmaStrike,
        bool isBuy
    ) public view virtual returns (uint256 premium) {
        return 0; // stub — implemented in Commit 4
    }
}
