// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AquaApp } from "@1inch/aqua/src/AquaApp.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

/// @notice Defined-risk netting sibling vault (S12, rung 2 of the capital-
/// efficiency ladder — design: docs/plans/2026-07-12-s12-defined-risk-netting.md).
/// A call credit spread (short K1, long K2) escrows only its true worst
/// case, `(K2-K1)/K2` WETH, instead of a full WETH as if the short leg were
/// naked. A separate AquaApp, same pattern as FirmEscrow/SmileQuoteLens —
/// `AquaCollateralVault` is never touched.
///
/// A1 scope: scaffold + call credit spreads only. Put credit and iron
/// condor strike validation is included for the enum's forward shape but
/// their collateral/premium paths are not wired yet (A2+).
contract SpreadVault is AquaApp, Ownable {
    enum Kind { CallCredit, PutCredit, IronCondor }

    /// @dev strikes layout: CallCredit uses [2]=K1,[3]=K2; PutCredit uses
    /// [0]=K1,[1]=K2; IronCondor uses all four (put K1<K2 <= call K1<K2).
    struct Structure {
        address lp;
        Kind kind;
        uint256[4] strikes;
        uint256 expiry;
        uint256 maxCollateral;
        bool active;
        bytes32 strategyHash;
        uint32 feeBps;
        address feeRecipient;
    }

    bytes32 private constant SPREAD_STRATEGY_TYPE = keccak256("SMILE-SPREAD-1");

    address public immutable weth;
    address public immutable usdc;
    address public immutable oracle;
    address public settlement;

    uint256 public nextAuthId;
    mapping(uint256 => Structure) public structures;

    error ExpiryInPast();
    error ZeroCapacity();
    error InvalidStrikes();
    error UnknownStructure();
    error NotLp();
    error AlreadySet();

    event StructureOpened(
        uint256 indexed authId, address indexed lp, Kind kind, uint256[4] strikes, uint256 expiry, uint256 maxCollateral
    );
    event StructureRevoked(uint256 indexed authId);

    constructor(address aqua_, address oracle_, address owner_, address weth_, address usdc_)
        AquaApp(IAqua(aqua_))
        Ownable(owner_)
    {
        oracle = oracle_;
        weth = weth_;
        usdc = usdc_;
    }

    /// @notice One-time wiring, mirrors AquaCollateralVault.setSettlement.
    function setSettlement(address settlement_) external onlyOwner {
        require(settlement == address(0), AlreadySet());
        settlement = settlement_;
    }

    /// @notice Opens a defined-risk structure. `maxCollateral` is the true
    /// net requirement per the S12 table (caller computes it off-chain or
    /// via a future on-chain helper — A1 does not derive it, only escrows
    /// what's asked, same as the main vault's authorizeRange).
    function openStructure(Kind kind, uint256[4] calldata strikes, uint256 expiry, uint256 maxCollateral)
        external
        returns (uint256 authId)
    {
        require(expiry > block.timestamp, ExpiryInPast());
        require(maxCollateral > 0, ZeroCapacity());
        if (kind == Kind.CallCredit) {
            require(strikes[2] < strikes[3], InvalidStrikes());
        } else if (kind == Kind.PutCredit) {
            require(strikes[0] < strikes[1], InvalidStrikes());
        } else {
            require(strikes[0] < strikes[1] && strikes[1] <= strikes[2] && strikes[2] < strikes[3], InvalidStrikes());
        }

        authId = nextAuthId++;
        Structure storage s = structures[authId];
        s.lp = msg.sender;
        s.kind = kind;
        s.strikes = strikes;
        s.expiry = expiry;
        s.maxCollateral = maxCollateral;
        s.active = true;
        s.strategyHash = keccak256(_strategy(authId));

        emit StructureOpened(authId, msg.sender, kind, strikes, expiry, maxCollateral);
    }

    /// @notice LP revokes in this vault's registry. The Aqua allowance
    /// itself is revoked separately via `Aqua.dock()` with {getDockParams},
    /// same two-step pattern as the main vault's revokeAuthorization.
    function revokeStructure(uint256 authId) external {
        require(structures[authId].lp == msg.sender, NotLp());
        structures[authId].active = false;
        emit StructureRevoked(authId);
    }

    /// @notice Everything needed for `Aqua.ship(app, strategy, tokens, amounts)`.
    function getShipParams(uint256 authId)
        external
        view
        returns (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts)
    {
        Structure storage s = structures[authId];
        require(s.lp != address(0), UnknownStructure());
        app = address(this);
        strategy = _strategy(authId);
        tokens = new address[](1);
        tokens[0] = _collateralToken(s.kind);
        amounts = new uint256[](1);
        amounts[0] = s.maxCollateral;
    }

    /// @notice Everything needed for `Aqua.dock(app, strategyHash, tokens)`.
    function getDockParams(uint256 authId)
        external
        view
        returns (address app, bytes32 strategyHash, address[] memory tokens)
    {
        Structure storage s = structures[authId];
        require(s.lp != address(0), UnknownStructure());
        app = address(this);
        strategyHash = s.strategyHash;
        tokens = new address[](1);
        tokens[0] = _collateralToken(s.kind);
    }

    /// @dev Call credit spreads escrow WETH (the S12 table's `(K2-K1)/K2`
    /// WETH); put credit and iron condor escrow USDC. Condor's collateral
    /// token isn't fully correct yet (max-not-sum needs both legs' pricing
    /// wired first, A2+) — A1 only exercises the CallCredit path.
    function _collateralToken(Kind kind) internal view returns (address) {
        return kind == Kind.CallCredit ? weth : usdc;
    }

    /// @dev Self-hosted AquaApp strategy (this vault is `app`), same pattern
    /// as AquaCollateralVault._putStrategy — a plain encoded terms blob, no
    /// SwapVM order. Full terms included for Aqua's data-availability
    /// requirement per Aqua docs.
    function _strategy(uint256 authId) internal view returns (bytes memory) {
        Structure storage s = structures[authId];
        return abi.encode(
            SPREAD_STRATEGY_TYPE, authId, s.lp, s.kind, s.strikes, s.expiry, s.maxCollateral, _collateralToken(s.kind)
        );
    }
}
