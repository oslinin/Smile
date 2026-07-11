// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { AquaCollateralVault } from "../vaults/AquaCollateralVault.sol";
import { SmileSwapVMRouter } from "../swapvm/SmileSwapVMRouter.sol";

/// @title SmileQuoteLens — best-quote routing periphery (S6)
/// @notice Scans every vault authorization covering (strike, expiry, side)
/// and returns the cheapest EXECUTABLE Ask — skipping sold-out or docked
/// ranges, phantom depth the LP wallet can't honor (S1), and ranges out of
/// per-block capacity (R1). Overlapping ranges quoting different vols (S5)
/// compete here: the touch IS the discovered market vol.
///
/// Periphery by design: the vault stays under the EIP-170 size limit and the
/// scan can be upgraded (indexing, pagination) without touching custody.
contract SmileQuoteLens {
    using SafeERC20 for IERC20;

    AquaCollateralVault public immutable vault;
    SmileSwapVMRouter public immutable router;
    IAqua public immutable aqua;

    uint256 private constant NO_QUOTE = type(uint256).max;

    constructor(address vault_, address payable router_, address aqua_) {
        vault = AquaCollateralVault(vault_);
        router = SmileSwapVMRouter(router_);
        aqua = IAqua(aqua_);
    }

    /// @dev Everything about one authorization the scan needs, loaded once.
    struct Candidate {
        address lp;
        uint256 strikeMin;
        uint256 strikeMax;
        uint256 expiry;
        address collateralToken;
        bool isCall;
        bool active;
        address premiumToken;
        bytes32 strategyHash;
    }

    /// @notice Cheapest executable Ask for `amount` at (strike, expiry, side).
    /// @dev O(nextAuthId) with an external quote per candidate — meant for
    /// eth_call (static-callable) and small on-chain marketplaces. Returns
    /// (type(uint256).max, type(uint256).max) when nothing quotes.
    function bestQuote(uint256 strike, uint256 expiry, bool isCall, uint256 amount)
        public
        returns (uint256 bestAuthId, uint256 bestPremium)
    {
        bestAuthId = NO_QUOTE;
        bestPremium = NO_QUOTE;
        uint256 n = vault.nextAuthId();
        for (uint256 i = 0; i < n; i++) {
            Candidate memory c = _load(i);
            if (!c.active || c.isCall != isCall || c.expiry != expiry) continue;
            if (strike < c.strikeMin || strike > c.strikeMax) continue;

            uint256 collateralNeeded = isCall ? amount : (strike * amount) / 1e30;
            if (_shippedCapacity(c) < collateralNeeded) continue;   // sold out / docked
            if (_lpCannotCover(c, collateralNeeded)) continue;      // S1: phantom depth
            if (_blockCapExhausted(i, collateralNeeded)) continue;  // R1

            uint256 premium = _askOf(i, c, strike, amount);
            if (premium < bestPremium) {
                bestPremium = premium;
                bestAuthId = i;
            }
        }
    }

    /// @notice Buy `amount` options at (strike, expiry, side) from whichever
    /// LP quotes the best executable Ask. The caller must ERC-20 approve THIS
    /// lens for the premium token. If the fill still dies on a dishonored
    /// pull, the vault's firmness compensation and the unspent premium are
    /// both forwarded to the caller and (address(0), 0) is returned.
    function buyBest(uint256 strike, uint256 expiry, bool isCall, uint256 amount, uint256 maxPremium)
        external
        returns (address optionToken, uint256 premiumPaid)
    {
        (uint256 authId, uint256 premium) = bestQuote(strike, expiry, isCall, amount);
        require(authId != NO_QUOTE, "no executable quote");
        require(premium <= maxPremium, "premium above max");

        Candidate memory c = _load(authId);
        IERC20(c.premiumToken).safeTransferFrom(msg.sender, address(this), premium);
        IERC20(c.premiumToken).forceApprove(address(vault), premium);

        (optionToken, premiumPaid) = vault.buy(authId, strike, amount, premium);

        if (optionToken == address(0)) {
            // Firmness failure: the vault compensated this lens from the LP's
            // bond — forward compensation and the unspent premium to the caller.
            uint256 comp = IERC20(c.collateralToken).balanceOf(address(this));
            if (comp > 0) IERC20(c.collateralToken).safeTransfer(msg.sender, comp);
            IERC20(c.premiumToken).safeTransfer(msg.sender, premium);
            return (address(0), 0);
        }

        IERC20(optionToken).safeTransfer(msg.sender, amount);
        uint256 leftover = IERC20(c.premiumToken).balanceOf(address(this));
        if (leftover > 0) IERC20(c.premiumToken).safeTransfer(msg.sender, leftover);
    }

    // ── internals ────────────────────────────────────────────────────────────

    function _load(uint256 authId) internal view returns (Candidate memory c) {
        (
            c.lp, c.strikeMin, c.strikeMax, c.expiry,,,
            c.collateralToken, c.isCall, c.active,
            c.premiumToken,,, c.strategyHash,,,,
        ) = vault.authorizations(authId);
    }

    /// @dev Collateral capacity still shipped on the strategy (Aqua virtual
    /// balance) — zero once sold out or docked.
    function _shippedCapacity(Candidate memory c) internal view returns (uint256) {
        address app = c.isCall ? address(router) : address(vault);
        (uint248 virtualBal,) = aqua.rawBalances(c.lp, app, c.strategyHash, c.collateralToken);
        return uint256(virtualBal);
    }

    /// @dev S1: quoted depth is phantom unless the LP wallet + Aqua allowance
    /// can actually deliver the pull right now.
    function _lpCannotCover(Candidate memory c, uint256 collateralNeeded) internal view returns (bool) {
        IERC20 t = IERC20(c.collateralToken);
        return t.balanceOf(c.lp) < collateralNeeded || t.allowance(c.lp, address(aqua)) < collateralNeeded;
    }

    function _blockCapExhausted(uint256 authId, uint256 collateralNeeded) internal view returns (bool) {
        (,,,, uint128 maxBlockNotional, uint128 blockNotional, uint64 lastTradeBlock) = vault.pricingOf(authId);
        if (maxBlockNotional == 0) return false;
        uint256 usedThisBlock = lastTradeBlock == uint64(block.number) ? blockNotional : 0;
        return usedThisBlock + collateralNeeded > maxBlockNotional;
    }

    /// @dev Ask for `amount` units: calls quote through the SwapVM program,
    /// puts through the vault's twin. NO_QUOTE when the candidate reverts.
    function _askOf(uint256 authId, Candidate memory c, uint256 strike, uint256 amount)
        internal
        returns (uint256)
    {
        if (c.isCall) {
            try router.quote(
                vault.buildOrder(authId), c.premiumToken, c.collateralToken, amount,
                _takerData(strike)
            ) returns (uint256 amountIn, uint256, bytes32) {
                return amountIn;
            } catch {
                return NO_QUOTE;
            }
        }
        try vault.putQuote(authId, strike, amount) returns (uint256 lpPremium, uint256 fee) {
            return lpPremium + fee;
        } catch {
            return NO_QUOTE;
        }
    }

    function _takerData(uint256 strike) internal view returns (bytes memory) {
        TakerTraitsLib.Args memory args;
        args.taker = address(this);
        args.instructionsArgs = abi.encodePacked(strike); // exactOut Ask side
        return TakerTraitsLib.build(args);
    }
}
