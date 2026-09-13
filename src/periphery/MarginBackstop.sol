// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMarginVaultView {
    function nakedNotional() external view returns (uint256);
    function hasExpiredUnfinalized() external view returns (bool);
    function BACKSTOP_MULTIPLE() external view returns (uint256);
}

/// @notice Pre-funded USDC pool that adopts margin positions nobody buys at
/// auction and pays holder shortfalls at settlement (S13, Part B of
/// docs/plans/2026-09-05-aqua.md).
///
/// Share-based. Withdrawals wait 24 h, may not take the pool below
/// `max(poolRequirement, nakedNotional / BACKSTOP_MULTIPLE)` — what the
/// positions it has absorbed could owe, or its share of everything naked
/// in the vault (the same multiple the fill ceiling uses) — and
/// freeze while any expired series is still unfinalized. When a draw
/// empties the pool every share is void and a new epoch starts, so late
/// depositors never inherit a dead cap table.
contract MarginBackstop {
    using SafeERC20 for IERC20;

    struct Request {
        uint256 shares;
        uint64 at;
    }

    uint256 public constant WITHDRAW_DELAY = 24 hours;
    uint256 internal constant DEAD_SHARES = 1000;

    IERC20 public immutable usdc;
    address public immutable vault;

    uint256 public epoch;
    uint256 public totalShares;
    mapping(uint256 => mapping(address => uint256)) public sharesOf; // epoch => holder => shares
    mapping(address => Request) public requests;
    /// @notice Sum of `K * units` over positions the pool has absorbed and
    /// not yet settled — the most it could be asked for.
    uint256 public poolRequirement;

    error OnlyVault();
    error ZeroAmount();
    error NoShares();
    error NothingRequested();
    error TooEarly();
    error Frozen();
    error BelowRequirement(uint256 after_, uint256 floor);

    event Deposited(address indexed from, uint256 epoch, uint256 amount, uint256 shares);
    event WithdrawRequested(address indexed from, uint256 shares, uint64 at);
    event Withdrawn(address indexed to, uint256 shares, uint256 amount);
    event Drawn(address indexed to, uint256 amount);
    event EpochRolled(uint256 epoch);
    event RequirementChanged(uint256 poolRequirement);

    constructor(address usdc_, address vault_) {
        usdc = IERC20(usdc_);
        vault = vault_;
    }

    /// @notice USDC the pool can absorb defaults with. The vault's naked-
    /// notional ceiling is a multiple of this.
    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice What `shares` are worth right now.
    function assetsOf(uint256 shares) public view returns (uint256) {
        return totalShares == 0 ? 0 : (totalAssets() * shares) / totalShares;
    }

    function deposit(uint256 amount) external returns (uint256 shares) {
        require(amount > 0, ZeroAmount());
        _rollEpochIfEmpty();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (totalShares == 0) {
            // First deposit of an epoch: burn a sliver so a 1-wei seed can't
            // be inflated against later depositors.
            shares = amount - DEAD_SHARES;
            sharesOf[epoch][address(0)] = DEAD_SHARES;
            totalShares = DEAD_SHARES;
        } else {
            shares = (amount * totalShares) / (totalAssets() - amount);
        }
        sharesOf[epoch][msg.sender] += shares;
        totalShares += shares;
        emit Deposited(msg.sender, epoch, amount, shares);
    }

    /// @notice Start the 24 h clock on `shares`. A new request replaces the old one.
    function requestWithdraw(uint256 shares) external {
        require(shares > 0 && shares <= sharesOf[epoch][msg.sender], NoShares());
        requests[msg.sender] = Request(shares, uint64(block.timestamp + WITHDRAW_DELAY));
        emit WithdrawRequested(msg.sender, shares, uint64(block.timestamp + WITHDRAW_DELAY));
    }

    /// @notice Redeem a matured request, subject to the floor and the freeze.
    function withdraw() external returns (uint256 amount) {
        Request memory r = requests[msg.sender];
        require(r.shares > 0, NothingRequested());
        require(block.timestamp >= r.at, TooEarly());
        require(!IMarginVaultView(vault).hasExpiredUnfinalized(), Frozen());
        // Shares from a rolled epoch are void.
        require(r.shares <= sharesOf[epoch][msg.sender], NoShares());

        amount = assetsOf(r.shares);
        uint256 floor = IMarginVaultView(vault).nakedNotional() / IMarginVaultView(vault).BACKSTOP_MULTIPLE();
        if (poolRequirement > floor) floor = poolRequirement;
        require(totalAssets() - amount >= floor, BelowRequirement(totalAssets() - amount, floor));

        delete requests[msg.sender];
        sharesOf[epoch][msg.sender] -= r.shares;
        totalShares -= r.shares;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, r.shares, amount);
    }

    // ── Vault-only ───────────────────────────────────────────────────────────

    /// @notice Move `amount` USDC into the vault to cover a shortfall. Draws
    /// at most what the pool holds; returns what moved.
    function draw(uint256 amount) external returns (uint256 drawn) {
        require(msg.sender == vault, OnlyVault());
        drawn = amount > totalAssets() ? totalAssets() : amount;
        if (drawn > 0) usdc.safeTransfer(vault, drawn);
        emit Drawn(vault, drawn);
        _rollEpochIfEmpty();
    }

    /// @notice The vault reports positions the pool now stands behind (+)
    /// and ones that settled (−).
    function noteRequirement(uint256 notional, bool add) external {
        require(msg.sender == vault, OnlyVault());
        poolRequirement = add ? poolRequirement + notional : poolRequirement - notional;
        emit RequirementChanged(poolRequirement);
    }

    function _rollEpochIfEmpty() internal {
        if (totalShares > 0 && totalAssets() == 0) {
            epoch++;
            totalShares = 0;
            emit EpochRolled(epoch);
        }
    }
}
