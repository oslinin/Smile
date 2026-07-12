// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { AquaCollateralVault } from "../vaults/AquaCollateralVault.sol";

/// @title FirmEscrow — a maker wallet that cannot renege (MVP-scoped S4)
/// @notice The firm tier of the two-tier liquidity design (docs/solutions.md
/// S4), scoped to its essence: FIRM ASK DEPTH. Instead of adding an escrowed
/// path to the vault (no EIP-170 headroom, new custody surface), the escrow
/// simply BECOMES the LP's wallet from Aqua's point of view: it holds plain
/// collateral, it is the `msg.sender` that authorizes and ships the range, so
/// `auth.lp == address(this)` and every JIT `Aqua.pull()` draws on a balance
/// that has no other exit. L11's one-block front-run — quote displayed, wallet
/// emptied before the fill — is impossible by construction, because the only
/// code paths that move collateral out are Aqua's pull and {withdraw}, and
/// {withdraw} refuses to dip below the total still committed to live ranges.
///
/// Deliberately deferred from full S4: yield-bearing collateral (wstETH/sDAI
/// settlement FX reads) — a firm LP accepts dead capital for now; and firm
/// BID depth — premium income above `committed` is freely withdrawable, so a
/// sellback can still bounce exactly like the soft tier (the holder keeps the
/// option; docs/limitations.md close() economics are unchanged).
///
/// Wind-down flow after expiry: settle → {reclaim} → {revoke} (frees the
/// commitment) → {withdraw}.
contract FirmEscrow {
    using SafeERC20 for IERC20;

    address public immutable owner;
    AquaCollateralVault public immutable vault;
    IAqua public immutable aqua;

    /// @notice Collateral pledged to still-active ranges, per token. The firm
    /// invariant: escrow balance never drops below this except via Aqua pulls
    /// (which consume range capacity in step).
    mapping(address => uint256) public committed;
    /// @notice maxCollateral pledged per authorization created here (0 = none).
    mapping(uint256 => uint256) public committedOf;
    /// @dev Collateral token per authorization, to unwind `committed` on revoke.
    mapping(uint256 => address) private collateralTokenOf;

    event RangeOpened(uint256 indexed authId, address collateralToken, uint256 maxCollateral);
    event RangeClosed(uint256 indexed authId);
    event Withdrawn(address indexed token, address to, uint256 amount);

    error NotOwner();
    error NotBacked();
    error UnknownAuthId();
    error WouldUnbackRange();

    modifier onlyOwner() {
        require(msg.sender == owner, NotOwner());
        _;
    }

    constructor(address owner_, address vault_, address aqua_) {
        owner = owner_;
        vault = AquaCollateralVault(vault_);
        aqua = IAqua(aqua_);
    }

    /// @notice Authorize a range on the vault and ship it on Aqua, with this
    /// escrow as the maker. Reverts unless the escrow already holds enough
    /// collateral to back the ENTIRE range on top of everything previously
    /// committed — a firm range is fully funded from its first block. Deposit
    /// by plain ERC-20 transfer to this address beforehand (plus the S2 bond,
    /// if the vault has one enabled — it is pulled from this escrow too).
    function authorizeAndShip(
        uint256 strikeMin,
        uint256 strikeMax,
        uint256 expiry,
        uint256 maxCollateral,
        address collateralToken,
        address premiumToken,
        bool isCall,
        uint128 maxBlockNotional,
        uint16 sigmaMulBps
    ) external onlyOwner returns (uint256 authId) {
        IERC20(collateralToken).forceApprove(address(vault), type(uint256).max); // S2 bond
        IERC20(collateralToken).forceApprove(address(aqua), type(uint256).max);  // JIT pulls
        IERC20(premiumToken).forceApprove(address(aqua), type(uint256).max);     // fee + Bid pulls

        authId = vault.authorizeRange(
            strikeMin, strikeMax, expiry, maxCollateral, collateralToken, premiumToken, isCall,
            maxBlockNotional, sigmaMulBps
        );

        committed[collateralToken] += maxCollateral;
        committedOf[authId] = maxCollateral;
        collateralTokenOf[authId] = collateralToken;
        require(IERC20(collateralToken).balanceOf(address(this)) >= committed[collateralToken], NotBacked());

        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            vault.getShipParams(authId);
        aqua.ship(app, strategy, tokens, amounts);

        emit RangeOpened(authId, collateralToken, maxCollateral);
    }

    /// @notice Revoke a range (vault registry + Aqua dock) and free its
    /// commitment. Publicly visible and atomic — cancelling a displayed quote
    /// is legitimate on any firm book; what the escrow forbids is keeping the
    /// quote live while removing its backing. Matched positions are unaffected.
    function revoke(uint256 authId) external onlyOwner {
        uint256 pledged = committedOf[authId];
        require(pledged != 0, UnknownAuthId());
        committedOf[authId] = 0;
        committed[collateralTokenOf[authId]] -= pledged;

        vault.revokeAuthorization(authId); // refunds the S2 bond to this escrow
        (address app, bytes32 strategyHash, address[] memory tokens) = vault.getDockParams(authId);
        aqua.dock(app, strategyHash, tokens);

        emit RangeClosed(authId);
    }

    /// @notice Pull the post-settlement remainder of a series back into the
    /// escrow (the vault pays `auth.lp`, which is this contract).
    function reclaim(address optionToken) external onlyOwner returns (uint256 amount) {
        return vault.reclaimCollateral(optionToken);
    }

    /// @notice Withdraw anything NOT backing a live range: premium income,
    /// refunded bonds, reclaimed collateral of revoked ranges. Refuses any
    /// amount that would take the token's balance below `committed[token]` —
    /// to withdraw range collateral, {revoke} the range first.
    function withdraw(address token, uint256 amount, address to) external onlyOwner {
        require(IERC20(token).balanceOf(address(this)) >= committed[token] + amount, WouldUnbackRange());
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }
}

/// @title FirmEscrowFactory — registry the router trusts
/// @notice Deploys FirmEscrow instances and remembers them. `SmileQuoteLens`
/// treats any maker registered here as FIRM and prefers it at equal price —
/// soft (plain-wallet Aqua) quotes must be strictly cheaper to win flow,
/// which is how the two-tier design prices softness instead of banning it.
contract FirmEscrowFactory {
    address public immutable vault;
    address public immutable aqua;

    mapping(address => bool) public isFirmEscrow;
    mapping(address => address) public escrowOf; // owner → most recent escrow

    event FirmEscrowCreated(address indexed owner, address escrow);

    constructor(address vault_, address aqua_) {
        vault = vault_;
        aqua = aqua_;
    }

    function create() external returns (address escrow) {
        escrow = address(new FirmEscrow(msg.sender, vault, aqua));
        isFirmEscrow[escrow] = true;
        escrowOf[msg.sender] = escrow;
        emit FirmEscrowCreated(msg.sender, escrow);
    }
}
