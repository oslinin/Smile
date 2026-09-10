// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { SpreadVault } from "../src/periphery/SpreadVault.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice A1: scaffold + own settlement. Test-first per the plan — proves
/// the shipped Aqua strategy backs exactly `maxCollateral` (no more, no
/// less) and that settlement can only be wired once.
contract SpreadVaultTest is Test {
    Aqua aqua;
    SpreadVault spread;
    MockV3Aggregator oracle;
    MockERC20 weth;
    MockERC20 usdc;

    address owner = address(this);
    address lp = address(0xA11CE);

    uint256 constant K1 = 3000e18;
    uint256 constant K2 = 3200e18;
    // S12 table: call credit escrow = (K2-K1)/K2 WETH
    uint256 constant ESCROW_WETH = (K2 - K1) * 1e18 / K2;

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        aqua = new Aqua();
        oracle = new MockV3Aggregator(8, 3000e8);
        spread = new SpreadVault(address(aqua), address(oracle), owner, address(weth), address(usdc));
    }

    function _openAndShip(uint256 maxCollateral) internal returns (uint256 authId) {
        uint256[4] memory strikes;
        strikes[2] = K1;
        strikes[3] = K2;
        uint256 expiry = block.timestamp + 30 days;

        weth.mint(lp, maxCollateral);
        vm.startPrank(lp);
        authId = spread.openStructure(SpreadVault.Kind.CallCredit, strikes, expiry, maxCollateral);
        weth.approve(address(aqua), maxCollateral);
        vm.stopPrank();

        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            spread.getShipParams(authId);
        vm.prank(lp);
        aqua.ship(app, strategy, tokens, amounts);
    }

    function test_open_shipHashMatchesAqua() public {
        uint256 authId = _openAndShip(ESCROW_WETH);

        // Struct getters skip array members (`strikes`), so the tuple here
        // is (lp, kind, expiry, maxCollateral, active, strategyHash, feeBps, feeRecipient).
        (,,,, , bytes32 strategyHash,,) = spread.structures(authId);
        (uint248 balance,) = aqua.rawBalances(lp, address(spread), strategyHash, address(weth));
        assertEq(balance, ESCROW_WETH, "Aqua backs exactly the true max loss, not a full WETH");

        assertEq(weth.balanceOf(address(spread)), 0, "collateral stays in the LP wallet until a real pull");
    }

    function test_setSettlement_onlyOnce() public {
        AquaOptionSettlement settlement = new AquaOptionSettlement(address(0), owner, address(oracle));
        spread.setSettlement(address(settlement));
        assertEq(spread.settlement(), address(settlement));

        AquaOptionSettlement other = new AquaOptionSettlement(address(0), owner, address(oracle));
        vm.expectRevert(SpreadVault.AlreadySet.selector);
        spread.setSettlement(address(other));
    }

    function test_openStructure_revertsOnBadStrikes() public {
        uint256[4] memory strikes;
        strikes[2] = K2; // K1 > K2 — invalid
        strikes[3] = K1;
        vm.expectRevert(SpreadVault.InvalidStrikes.selector);
        spread.openStructure(SpreadVault.Kind.CallCredit, strikes, block.timestamp + 30 days, ESCROW_WETH);
    }
}
