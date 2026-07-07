// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { OptionPremiumArgsBuilder, OptionPremiumInstruction } from "../src/swapvm/OptionPremiumInstruction.sol";
import { OptionPricingEngine } from "../src/swapvm/OptionPricingEngine.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Exercises the custom option-premium instruction inside the
/// OFFICIAL 1inch SwapVM + Aqua stack: the LP ships one strategy for a whole
/// strike range, and takers swap premium (USDC) for JIT-pulled collateral
/// (WETH) at VM-computed option prices.
contract SmileSwapVMRouterTest is Test {
    Aqua aqua;
    SmileSwapVMRouter router;
    OptionPricingEngine engine;
    MockV3Aggregator oracle;
    MockERC20 usdc;
    MockERC20 weth;

    address lp = address(0x1111);

    uint256 constant SPOT       = 3000e18;
    uint256 constant STRIKE_MIN = 2500e18;
    uint256 constant STRIKE_MAX = 3500e18;
    uint256 constant ALPHA      = 2e18;
    uint256 constant SIGMA      = 0.8e18; // instruction default (no sigma source wired)
    uint256 constant MAX_COLLATERAL = 10e18;
    uint256 constant MAX_STALENESS  = 1 hours;
    uint256 expiry;

    ISwapVM.Order order;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        aqua = new Aqua();
        router = new SmileSwapVMRouter(address(aqua), address(weth), address(this));
        engine = new OptionPricingEngine();
        oracle = new MockV3Aggregator(8, 3000e8);
        expiry = block.timestamp + 30 days;

        order = _buildOrder(0);
        _ship(order);

        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(router), type(uint256).max);
        weth.mint(lp, MAX_COLLATERAL);
        vm.prank(lp);
        weth.approve(address(aqua), type(uint256).max);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _buildOrder(uint64 salt) internal view returns (ISwapVM.Order memory) {
        bytes memory premiumArgs = OptionPremiumArgsBuilder.build(
            address(oracle),
            address(0),
            address(usdc),
            address(weth),
            6,
            uint128(STRIKE_MIN),
            uint128(STRIKE_MAX),
            uint40(expiry),
            uint64(ALPHA),
            int64(0),
            uint16(MAX_STALENESS)
        );
        bytes memory program = abi.encodePacked(
            uint8(20), uint8(8), salt,                                   // Controls._salt
            uint8(13), uint8(5), uint40(expiry),                         // Controls._deadline
            uint8(33), uint8(premiumArgs.length), premiumArgs            // custom option premium
        );
        MakerTraitsLib.Args memory args;
        args.maker = lp;
        args.useAquaInsteadOfSignature = true;
        args.program = program;
        return MakerTraitsLib.build(args);
    }

    function _ship(ISwapVM.Order memory o) internal {
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = MAX_COLLATERAL;
        amounts[1] = 0;
        vm.prank(lp);
        aqua.ship(address(router), abi.encode(o), tokens, amounts);
    }

    function _takerData(bool isExactIn, uint256 strike) internal view returns (bytes memory) {
        TakerTraitsLib.Args memory args;
        args.taker = address(this);
        args.isExactIn = isExactIn;
        args.isFirstTransferFromTaker = true;
        args.useTransferFromAndAquaPush = true;
        args.instructionsArgs = abi.encodePacked(strike);
        return TakerTraitsLib.build(args);
    }

    /// @dev Expected Ask premium in USDC 6-dec for `amount` units — mirrors the
    /// instruction: engine per-unit quote (WAD) → ceil across amount → ceil to 6-dec.
    function _expectedAskUsdc(uint256 strike, uint256 amount) internal view returns (uint256) {
        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: SPOT,
            strike: strike,
            expiry: expiry,
            sigmaGlobal: SIGMA,
            alpha: ALPHA,
            isBuy: true
        });
        uint256 costWad = Math.ceilDiv(amount * engine.quote(p), 1e18);
        return Math.ceilDiv(costWad, 1e12);
    }

    // ── quote ────────────────────────────────────────────────────────────────

    function test_quote_matchesEngineFacade() public {
        (uint256 amountIn, uint256 amountOut,) =
            router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 3000e18));
        assertEq(amountOut, 1e18);
        assertEq(amountIn, _expectedAskUsdc(3000e18, 1e18));
    }

    function test_quote_premiumDecreasesWithStrike() public {
        (uint256 itm,,) = router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 2600e18));
        (uint256 atm,,) = router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 3000e18));
        (uint256 otm,,) = router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 3400e18));
        assertGt(itm, atm);
        assertGt(atm, otm);
    }

    function test_quote_bidAskSpread() public {
        // Ask side (exactOut) rounds the premium UP; Bid side (exactIn) values
        // premium with the rounded-DOWN quote. Ask must never sit below Bid,
        // and spending one Bid premium buys at most one option unit.
        (uint256 ask,,) = router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 3200e18));

        OptionPricingEngine.PricingParams memory p = OptionPricingEngine.PricingParams({
            spot: SPOT,
            strike: 3200e18,
            expiry: expiry,
            sigmaGlobal: SIGMA,
            alpha: ALPHA,
            isBuy: false
        });
        uint256 bid = engine.quote(p) / 1e12; // floor to USDC 6-dec
        assertGe(ask, bid);

        (, uint256 unitsForBid,) = router.quote(order, address(usdc), address(weth), bid, _takerData(true, 3200e18));
        assertLe(unitsForBid, 1e18);
        assertApproxEqRel(unitsForBid, 1e18, 0.01e18);
    }

    function test_quote_strikeOutOfRangeReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                OptionPremiumInstruction.OptionPremiumStrikeOutOfRange.selector,
                5000e18, STRIKE_MIN, STRIKE_MAX
            )
        );
        router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 5000e18));
    }

    function test_quote_wrongTokensReverts() public {
        // Direction flipped: instruction refuses to price WETH-in / USDC-out.
        vm.expectRevert();
        router.quote(order, address(weth), address(usdc), 1e18, _takerData(false, 3000e18));
    }

    function test_quote_afterExpiryReverts() public {
        vm.warp(expiry + 1);
        vm.expectRevert();
        router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 3000e18));
    }

    function test_quote_staleOracleReverts() public {
        // Feed last updated at t0; warp past the strategy's staleness bound.
        vm.warp(block.timestamp + MAX_STALENESS + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                OptionPremiumInstruction.OptionPremiumStaleOraclePrice.selector,
                1, MAX_STALENESS, block.timestamp
            )
        );
        router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 3000e18));
    }

    function test_quote_freshOracleAfterUpdatePasses() public {
        vm.warp(block.timestamp + MAX_STALENESS + 1);
        oracle.setAnswer(3000e8); // refresh updatedAt
        (uint256 amountIn,,) =
            router.quote(order, address(usdc), address(weth), 1e18, _takerData(false, 3000e18));
        assertGt(amountIn, 0);
    }

    // ── swap ─────────────────────────────────────────────────────────────────

    function test_swap_jitPullAndPremiumPush() public {
        uint256 strike = 3000e18;
        uint256 amount = 2e18;
        uint256 lpWethBefore = weth.balanceOf(lp);
        uint256 lpUsdcBefore = usdc.balanceOf(lp);
        bytes32 orderHash = router.hash(order);

        (uint256 amountIn, uint256 amountOut,) =
            router.swap(order, address(usdc), address(weth), amount, _takerData(false, strike));

        // Onchain token transfers: collateral pulled JIT from the LP wallet to
        // the taker; premium pushed into the LP wallet through Aqua.
        assertEq(amountOut, amount);
        assertEq(weth.balanceOf(address(this)), amount);
        assertEq(weth.balanceOf(lp), lpWethBefore - amount);
        assertEq(usdc.balanceOf(lp), lpUsdcBefore + amountIn);

        // Aqua virtual balances track the strategy: collateral down, premium up.
        (uint248 wethBal,) = aqua.rawBalances(lp, address(router), orderHash, address(weth));
        (uint248 usdcBal,) = aqua.rawBalances(lp, address(router), orderHash, address(usdc));
        assertEq(uint256(wethBal), MAX_COLLATERAL - amount);
        assertEq(uint256(usdcBal), amountIn);
    }

    function test_swap_oneStrategyQuotesWholeChain() public {
        // The same shipped Aqua balance backs multiple strikes: the taker
        // chooses the strike per swap via taker instruction args.
        router.swap(order, address(usdc), address(weth), 1e18, _takerData(false, 2600e18));
        router.swap(order, address(usdc), address(weth), 1e18, _takerData(false, 3000e18));
        router.swap(order, address(usdc), address(weth), 1e18, _takerData(false, 3400e18));

        (uint248 wethBal,) = aqua.rawBalances(lp, address(router), router.hash(order), address(weth));
        assertEq(uint256(wethBal), MAX_COLLATERAL - 3e18);
    }

    function test_swap_capacityEnforcedByAqua() public {
        // Over-pulling the shipped balance underflows inside the official Aqua.
        vm.expectRevert(stdError.arithmeticError);
        router.swap(order, address(usdc), address(weth), MAX_COLLATERAL + 1e18, _takerData(false, 3000e18));
    }

    function test_swap_dockedStrategyReverts() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(usdc);
        bytes32 orderHash = router.hash(order); // resolve before prank — args are evaluated first
        vm.prank(lp);
        aqua.dock(address(router), orderHash, tokens);

        vm.expectRevert();
        router.swap(order, address(usdc), address(weth), 1e18, _takerData(false, 3000e18));
    }

    function test_swap_unshippedStrategyReverts() public {
        ISwapVM.Order memory other = _buildOrder(42); // different salt → different hash
        vm.expectRevert();
        router.swap(other, address(usdc), address(weth), 1e18, _takerData(false, 3000e18));
    }
}
