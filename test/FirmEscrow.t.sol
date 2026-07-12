// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { SmileQuoteLens } from "../src/periphery/SmileQuoteLens.sol";
import { FirmEscrow, FirmEscrowFactory } from "../src/periphery/FirmEscrow.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice S4 MVP scope (docs/solutions.md): the FirmEscrow wrapper makes a
/// maker's displayed ASK depth impossible to renege — collateral has no exit
/// other than Aqua's pull — and the lens prefers firm makers at equal price.
contract FirmEscrowTest is Test {
    Aqua aqua;
    SmileSwapVMRouter router;
    AquaCollateralVault vault;
    OptionTokenFactory tokenFactory;
    FirmEscrowFactory firmFactory;
    SmileQuoteLens lens;
    MockV3Aggregator oracle;
    MockERC20 usdc;
    MockERC20 weth;

    address owner   = address(this);
    address softLp  = address(0x1111);
    address firmLp  = address(0x3333);
    address buyer   = address(0x2222);

    uint256 constant STRIKE     = 3000e18;
    uint256 constant STRIKE_MIN = 2500e18;
    uint256 constant STRIKE_MAX = 3500e18;
    uint256 constant SIZE       = 1e18;
    uint256 expiry;

    function setUp() public {
        usdc   = new MockERC20("USD Coin", "USDC", 6);
        weth   = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua   = new Aqua();
        router = new SmileSwapVMRouter(address(aqua), address(weth), owner);
        oracle = new MockV3Aggregator(8, 3000e8);
        tokenFactory = new OptionTokenFactory();
        vault  = new AquaCollateralVault(address(aqua), payable(address(router)), address(oracle), owner, address(tokenFactory));
        firmFactory = new FirmEscrowFactory(address(vault), address(aqua));
        lens   = new SmileQuoteLens(address(vault), payable(address(router)), address(aqua), address(firmFactory));
        expiry = block.timestamp + 30 days;

        usdc.mint(buyer, 10_000_000e6);
        vm.startPrank(buyer);
        usdc.approve(address(vault), type(uint256).max);
        usdc.approve(address(lens), type(uint256).max);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _newFirmEscrow(address lpAddr) internal returns (FirmEscrow escrow) {
        vm.prank(lpAddr);
        escrow = FirmEscrow(firmFactory.create());
    }

    function _firmCall(address lpAddr, uint256 maxCollateral, uint16 sigmaMulBps)
        internal
        returns (FirmEscrow escrow, uint256 authId)
    {
        escrow = _newFirmEscrow(lpAddr);
        weth.mint(address(escrow), maxCollateral); // deposit = plain transfer
        vm.prank(lpAddr);
        authId = escrow.authorizeAndShip(
            STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(weth), address(usdc), true, 0, sigmaMulBps
        );
    }

    function _softCall(address lpAddr, uint256 maxCollateral, uint16 sigmaMulBps)
        internal
        returns (uint256 authId)
    {
        weth.mint(lpAddr, maxCollateral);
        vm.startPrank(lpAddr);
        authId = vault.authorizeRange(
            STRIKE_MIN, STRIKE_MAX, expiry, maxCollateral, address(weth), address(usdc), true, 0, sigmaMulBps
        );
        weth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        (address app, bytes memory strategy, address[] memory tokens, uint256[] memory amounts) =
            vault.getShipParams(authId);
        aqua.ship(app, strategy, tokens, amounts);
        vm.stopPrank();
    }

    // ── the escrow is a working Aqua maker ───────────────────────────────────

    function test_buyFromFirmEscrow() public {
        (FirmEscrow escrow, uint256 authId) = _firmCall(firmLp, 10e18, 0);

        vm.prank(buyer);
        (address optionToken, uint256 premiumPaid) = vault.buy(authId, STRIKE, SIZE, type(uint256).max);

        assertTrue(optionToken != address(0), "mint failed");
        assertGt(premiumPaid, 0);
        // JIT pull drew the collateral out of the escrow…
        assertEq(weth.balanceOf(address(escrow)), 9e18);
        // …and the premium landed in it.
        assertEq(usdc.balanceOf(address(escrow)), premiumPaid);
    }

    function test_firmPut() public {
        FirmEscrow escrow = _newFirmEscrow(firmLp);
        usdc.mint(address(escrow), 30_000e6);
        vm.prank(firmLp);
        uint256 authId = escrow.authorizeAndShip(
            STRIKE_MIN, STRIKE_MAX, expiry, 30_000e6, address(usdc), address(usdc), false, 0, 0
        );

        vm.prank(buyer);
        (address optionToken,) = vault.buy(authId, STRIKE, SIZE, type(uint256).max);
        assertTrue(optionToken != address(0), "put mint failed");
    }

    function test_onlyOwnerOperates() public {
        (FirmEscrow escrow, uint256 authId) = _firmCall(firmLp, 10e18, 0);
        vm.startPrank(softLp);
        vm.expectRevert(FirmEscrow.NotOwner.selector);
        escrow.withdraw(address(weth), 1e18, softLp);
        vm.expectRevert(FirmEscrow.NotOwner.selector);
        escrow.revoke(authId);
        vm.stopPrank();
    }

    // ── the firm invariant: no exit but Aqua's pull ──────────────────────────

    function test_authorizeRevertsWhenUnderfunded() public {
        FirmEscrow escrow = _newFirmEscrow(firmLp);
        weth.mint(address(escrow), 5e18); // range wants 10
        vm.prank(firmLp);
        vm.expectRevert(FirmEscrow.NotBacked.selector);
        escrow.authorizeAndShip(
            STRIKE_MIN, STRIKE_MAX, expiry, 10e18, address(weth), address(usdc), true, 0, 0
        );
    }

    function test_withdrawBlockedWhileActive_freedByRevoke() public {
        (FirmEscrow escrow, uint256 authId) = _firmCall(firmLp, 10e18, 0);

        // the L11 front-run is structurally unavailable to a firm LP
        vm.prank(firmLp);
        vm.expectRevert(FirmEscrow.WouldUnbackRange.selector);
        escrow.withdraw(address(weth), 1, firmLp);

        // cancelling the quote first is legitimate — then funds are free
        vm.startPrank(firmLp);
        escrow.revoke(authId);
        escrow.withdraw(address(weth), 10e18, firmLp);
        vm.stopPrank();
        assertEq(weth.balanceOf(firmLp), 10e18);

        // and the revoked range no longer quotes
        (uint256 bestId,) = lens.bestQuote(STRIKE, expiry, true, SIZE);
        assertEq(bestId, type(uint256).max, "revoked range still quoting");
    }

    function test_premiumIncomeWithdrawableWhileActive() public {
        (FirmEscrow escrow, uint256 authId) = _firmCall(firmLp, 10e18, 0);
        vm.prank(buyer);
        (, uint256 premiumPaid) = vault.buy(authId, STRIKE, SIZE, type(uint256).max);

        // premium is NOT committed (firm tier promises firm ASK depth) —
        // income is the LP's to sweep even while the range quotes
        vm.prank(firmLp);
        escrow.withdraw(address(usdc), premiumPaid, firmLp);
        assertEq(usdc.balanceOf(firmLp), premiumPaid);
    }

    // ── routing: firm wins ties, price still wins outright ───────────────────

    function test_lensPrefersFirmAtEqualPrice() public {
        // identical ranges, identical pricing params → identical Ask
        uint256 softId = _softCall(softLp, 10e18, 0);
        (, uint256 firmId) = _firmCall(firmLp, 10e18, 0);

        (uint256 bestId,) = lens.bestQuote(STRIKE, expiry, true, SIZE);
        assertEq(bestId, firmId, "firm should win the price tie");
        assertTrue(bestId != softId);
    }

    function test_cheaperSoftStillWins() public {
        // soft LP undercuts on vol (0.5x sigma) — price improvement beats firmness
        uint256 softId = _softCall(softLp, 10e18, 5000);
        _firmCall(firmLp, 10e18, 0);

        (uint256 bestId,) = lens.bestQuote(STRIKE, expiry, true, SIZE);
        assertEq(bestId, softId, "cheaper soft quote must win");
    }

    function test_firmFillsAfterSoftWalletDrain() public {
        uint256 softId = _softCall(softLp, 10e18, 5000); // soft is cheaper…
        (, uint256 firmId) = _firmCall(firmLp, 10e18, 0);

        // …but the soft LP front-runs by emptying their wallet (L11)
        uint256 softBal = weth.balanceOf(softLp);
        vm.prank(softLp);
        weth.transfer(address(0xdead), softBal);

        (uint256 bestId,) = lens.bestQuote(STRIKE, expiry, true, SIZE);
        assertEq(bestId, firmId, "drained soft range must be skipped");
        assertTrue(bestId != softId);

        vm.prank(buyer);
        (address optionToken,) = lens.buyBest(STRIKE, expiry, true, SIZE, type(uint256).max);
        assertTrue(optionToken != address(0), "firm fill failed");
    }
}
