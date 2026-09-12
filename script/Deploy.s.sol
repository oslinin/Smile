// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "forge-std/Script.sol";
import "forge-std/StdCheats.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";

import { OptionPricingEngine } from "../src/swapvm/OptionPricingEngine.sol";
import { SmileSwapVMRouter } from "../src/swapvm/SmileSwapVMRouter.sol";
import { OptionPricingHook } from "../src/hooks/OptionPricingHook.sol";
import { AquaCollateralVault } from "../src/vaults/AquaCollateralVault.sol";
import { AquaOptionSettlement } from "../src/vaults/AquaOptionSettlement.sol";
import { MockV3Aggregator } from "../src/mocks/MockV3Aggregator.sol";
import { PythSpotAdapter } from "../src/oracles/PythSpotAdapter.sol";
import { OptionTokenFactory } from "../src/OptionTokenFactory.sol";
import { SmileQuoteLens } from "../src/periphery/SmileQuoteLens.sol";
import { FirmEscrowFactory } from "../src/periphery/FirmEscrow.sol";
import { SpreadVault } from "../src/periphery/SpreadVault.sol";
import { MarginVault } from "../src/periphery/MarginVault.sol";
import { MarginBackstop } from "../src/periphery/MarginBackstop.sol";
import { RfqVault } from "../src/periphery/RfqVault.sol";

contract MockERC20 is ERC20 {
    uint8 private _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract Deploy is Script, StdCheats {
    address constant USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH_MAINNET = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    // Official production Aqua deployment (mainnet)
    address constant AQUA_MAINNET = 0x499943E74FB0cE105688beeE8Ef2ABec5D936d31;
    // Chainlink ETH/USD feeds
    address constant ETH_USD_FEED_MAINNET = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;
    address constant ETH_USD_FEED_SEPOLIA = 0x694AA1769357215DE4FAC081bf1f309aDC325306;
    // Circle USDC + canonical WETH on Sepolia testnet
    address constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant WETH_SEPOLIA = 0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9;

    /// @dev S12 SpreadVault: sibling AquaApp with its own settlement (the
    /// main settlement's registrar is one-time and already the vault).
    /// Split out of run() to keep that function's stack shallow.
    function _deploySpread(
        address aquaAddr,
        address oracleAddr,
        address hookAddr,
        address wethAddr,
        address usdcAddr,
        address chainlinkFeed,
        address dao,
        address deployer
    ) internal returns (address) {
        SpreadVault spread = new SpreadVault(aquaAddr, oracleAddr, hookAddr, deployer, wethAddr, usdcAddr);
        AquaOptionSettlement spreadSettlement = new AquaOptionSettlement(deployer, deployer, chainlinkFeed);
        spreadSettlement.setRegistrar(address(spread));
        spread.setSettlement(address(spreadSettlement));
        spread.setPricingDefaults(50, 25, 0.001e18);
        spread.setProtocolFee(0.01e9, dao);
        return address(spread);
    }

    /// @dev R6 RfqVault: signed-quote tier, own settlement, same Aqua pull.
    function _deployRfq(
        address aquaAddr,
        address oracleAddr,
        address hookAddr,
        address wethAddr,
        address usdcAddr,
        address chainlinkFeed,
        address tokenFactory,
        address dao,
        address deployer
    ) internal returns (address) {
        RfqVault rfq = new RfqVault(aquaAddr, oracleAddr, hookAddr, deployer, tokenFactory, wethAddr, usdcAddr);
        AquaOptionSettlement rfqSettlement = new AquaOptionSettlement(deployer, deployer, chainlinkFeed);
        rfqSettlement.setRegistrar(address(rfq));
        rfq.setSettlement(address(rfqSettlement));
        rfq.setPricingDefaults(50, 25, 0.001e18);
        rfq.setProtocolFee(0.01e9, dao);
        return address(rfq);
    }

    /// @dev S13 MarginVault: opt-in margined puts, own settlement, own
    /// backstop pool. On Anvil the backstop and insurance are seeded from
    /// the deployer's mock USDC, otherwise the first fill would hit the
    /// backstop-coupled naked-notional ceiling at zero.
    function _deployMargin(
        address aquaAddr,
        address oracleAddr,
        address hookAddr,
        address usdcAddr,
        address chainlinkFeed,
        address tokenFactory,
        address dao,
        address deployer,
        bool seed
    ) internal returns (address, address, address) {
        MarginVault mv = new MarginVault(aquaAddr, oracleAddr, hookAddr, deployer, tokenFactory, usdcAddr);
        AquaOptionSettlement marginSettlement = new AquaOptionSettlement(deployer, deployer, chainlinkFeed);
        marginSettlement.setRegistrar(address(mv));
        mv.setSettlement(address(marginSettlement));
        MarginBackstop backstop = new MarginBackstop(usdcAddr, address(mv));
        mv.setBackstop(address(backstop));
        mv.setPricingDefaults(50, 25, 0.001e18);
        mv.setProtocolFee(0.01e9);
        mv.setFeeSplit(5000, 3000, dao);
        mv.setNotionalCeiling(250_000e6);
        if (seed) {
            MockERC20(usdcAddr).mint(deployer, 30_000e6);
            MockERC20(usdcAddr).approve(address(backstop), 25_000e6);
            backstop.deposit(25_000e6);
            MockERC20(usdcAddr).approve(address(mv), 5_000e6);
            mv.fundInsurance(5_000e6);
        }
        return (address(mv), address(backstop), address(marginSettlement));
    }

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        // Second Anvil account — acts as a buyer in manual testing
        address buyer       = vm.envOr("BUYER_ADDRESS", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));
        bool    forkMainnet = vm.envOr("FORK_MAINNET", false);
        // Arc mainnet chain id is not published as of 2026-09-12; it must be
        // supplied, never guessed (docs/arc-mainnet-checklist.md).
        uint256 arcMainnetId = vm.envOr("ARC_MAINNET_CHAIN_ID", uint256(0));

        address usdcAddr;
        address wethAddr;
        address oracleAddr;
        address aquaAddr;

        if (block.chainid == 11155111) {
            // ── Sepolia: real Circle USDC + canonical WETH + Chainlink feed ──
            usdcAddr   = USDC_SEPOLIA;
            wethAddr   = WETH_SEPOLIA;
            oracleAddr = ETH_USD_FEED_SEPOLIA;
        } else if (block.chainid == 5042002) {
            // ── Arc testnet: Circle's REAL USDC — the chain's native asset,
            //    6-dec ERC-20 view — for premiums, fees, and put collateral.
            //    No canonical WETH on Arc and no Chainlink-style ETH/USD feed
            //    documented there yet (docs/plans/2026-09-10-arc-bounty.md X1),
            //    so the call-side collateral and the spot oracle stay mock. ──
            vm.startBroadcast(deployerKey);
            MockERC20 arcWeth = new MockERC20("Wrapped Ether", "WETH", 18);
            arcWeth.mint(deployer, 100e18);
            MockV3Aggregator arcOracle = new MockV3Aggregator(8, 3000e8);
            vm.stopBroadcast();
            usdcAddr   = 0x3600000000000000000000000000000000000000; // Arc USDC (docs.arc.io contract addresses)
            wethAddr   = address(arcWeth);
            oracleAddr = address(arcOracle);
        } else if (arcMainnetId != 0 && block.chainid == arcMainnetId) {
            // ── Arc mainnet (public from 2026-09-16): everything from env —
            //    docs/arc-mainnet-checklist.md. Real USDC (the native asset's
            //    ERC-20 view, overridable), canonical WETH and a Chainlink
            //    ETH/USD feed if Arc has them on day one; mocks only when
            //    ARC_MAINNET_ALLOW_MOCKS=true, never silently. ─────────────
            usdcAddr   = vm.envOr("ARC_MAINNET_USDC", address(0x3600000000000000000000000000000000000000));
            wethAddr   = vm.envOr("ARC_MAINNET_WETH", address(0));
            oracleAddr = vm.envOr("ARC_MAINNET_ETH_USD_FEED", address(0));
            aquaAddr   = vm.envOr("ARC_MAINNET_AQUA", address(0)); // official 1inch Aqua if deployed there, else ours below
            bool allowMocks = vm.envOr("ARC_MAINNET_ALLOW_MOCKS", false);
            require(wethAddr != address(0) || allowMocks, "Arc mainnet: set ARC_MAINNET_WETH or ARC_MAINNET_ALLOW_MOCKS=true");
            require(oracleAddr != address(0) || allowMocks, "Arc mainnet: set ARC_MAINNET_ETH_USD_FEED or ARC_MAINNET_ALLOW_MOCKS=true");
            if (wethAddr == address(0) || oracleAddr == address(0)) {
                vm.startBroadcast(deployerKey);
                if (wethAddr == address(0)) {
                    MockERC20 mainnetWeth = new MockERC20("Wrapped Ether", "WETH", 18);
                    mainnetWeth.mint(deployer, 100e18);
                    wethAddr = address(mainnetWeth);
                }
                if (oracleAddr == address(0)) oracleAddr = address(new MockV3Aggregator(8, 3000e8));
                vm.stopBroadcast();
            }
        } else if (forkMainnet) {
            // ── Mainnet fork: real tokens, real Chainlink feed, and the
            //    OFFICIAL production Aqua deployment ─────────────────────────
            usdcAddr   = USDC_MAINNET;
            wethAddr   = WETH_MAINNET;
            oracleAddr = ETH_USD_FEED_MAINNET;
            aquaAddr   = AQUA_MAINNET;
            // NOTE: token/ETH funding for the fork is done post-deploy in local.sh
            // via real `cast` txs (wrap WETH, set USDC storage). forge cheatcodes
            // like `deal`/`vm.deal` only mutate the script's simulation EVM and do
            // NOT broadcast to the Anvil node, so they cannot fund accounts here.
        } else {
            // ── Blank Anvil: deploy mock tokens + settable spot oracle ───────
            vm.startBroadcast(deployerKey);
            MockERC20 usdc = new MockERC20("USD Coin",      "USDC", 6);
            MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
            usdc.mint(deployer, 1_000_000e6);
            weth.mint(deployer,       100e18);
            usdc.mint(buyer,    1_000_000e6);
            weth.mint(buyer,          10e18);
            MockV3Aggregator mockOracle = new MockV3Aggregator(8, 3000e8);
            vm.stopBroadcast();
            usdcAddr   = address(usdc);
            wethAddr   = address(weth);
            oracleAddr = address(mockOracle);
        }

        vm.startBroadcast(deployerKey);

        // ── Official 1inch Aqua (shared liquidity registry) ──────────────────
        // On a mainnet fork the production deployment is reused; elsewhere the
        // official contract is deployed fresh.
        if (aquaAddr == address(0)) {
            aquaAddr = address(new Aqua());
        }

        // ── Custom Aqua app: official SwapVM + custom option-premium opcode ──
        SmileSwapVMRouter router = new SmileSwapVMRouter(aquaAddr, wethAddr, deployer);

        // ── Pricing facade + Uniswap v4 hook ─────────────────────────────────
        OptionPricingEngine engine = new OptionPricingEngine();

        uint256 initialSigma = 0.8e18;
        // poolManager is unused on Anvil (no live Uniswap v4); pass address(1) as placeholder
        OptionPricingHook hook = new OptionPricingHook(address(engine), address(1), initialSigma);

        // R5: optional Pyth pull-oracle for QUOTING — takers post a signed
        // Hermes update in their own tx and price against a ~400ms-fresh
        // spot. Settlement stays on the Chainlink feed below (round history
        // is what makes permissionless expiry bracketing verifiable).
        address chainlinkFeed = oracleAddr;
        address pythAddr = vm.envOr("PYTH", address(0));
        if (pythAddr != address(0)) {
            bytes32 pythPriceId = vm.envBytes32("PYTH_PRICE_ID");
            oracleAddr = address(new PythSpotAdapter(pythAddr, pythPriceId, 8));
        }

        OptionTokenFactory tokenFactory = new OptionTokenFactory();

        AquaCollateralVault vault = new AquaCollateralVault(
            aquaAddr,
            payable(address(router)),
            oracleAddr,
            deployer,
            address(tokenFactory)
        );

        // S4 (MVP scope): firm-tier escrow factory — LPs who park collateral
        // in a FirmEscrow become makers whose displayed depth cannot be
        // reneged; the lens prefers them at equal price.
        FirmEscrowFactory firmFactory = new FirmEscrowFactory(address(vault), aquaAddr);

        // S6: best-quote routing periphery — scans all ranges, skips phantom
        // depth, routes buys to the tightest executable vol quote (firm wins
        // price ties).
        SmileQuoteLens lens = new SmileQuoteLens(
            address(vault), payable(address(router)), aquaAddr, address(firmFactory)
        );

        // deployer also acts as CRE forwarder in local testing; the Chainlink
        // feed enables PERMISSIONLESS settlement (anyone supplies the round
        // covering expiry)
        AquaOptionSettlement settlement = new AquaOptionSettlement(deployer, deployer, chainlinkFeed);

        // ── Wire hook ↔ vault ↔ settlement (before any range is authorized,
        //    so strategies snapshot the hook as their live σ source) ────────
        vault.setHook(address(hook));
        hook.setVault(address(vault));
        settlement.setRegistrar(address(vault));
        vault.setSettlement(address(settlement));

        // ── Protocol fee: 1% of every premium, grossed up on the Ask and
        //    routed through the official SwapVM fee opcode to the DAO
        //    treasury (FEE_RECIPIENT env; deployer placeholder locally) ─────
        address dao = vm.envOr("FEE_RECIPIENT", deployer);
        vault.setProtocolFee(0.01e9, dao);

        // ── Adverse-selection hardening defaults (docs/solutions.md R1–R4):
        //    0.5% base half-spread (Chainlink deviation-threshold floor),
        //    +0.25%/hour of oracle age, and 0.1 vol-points of intra-trade
        //    impact per whole option bought. Snapshotted into new ranges. ──
        vault.setPricingDefaults(50, 25, 0.001e18);
        // ── S2: firmness bond — bps of maxCollateral staked at authorize
        //    time, slashed to compensate buyers if a JIT pull is dishonored.
        //    Default 0 (opt-in): LPs must ERC-20 approve the VAULT for the
        //    bond before authorizeRange once this is non-zero. ──────────────
        uint16 bondBps = uint16(vm.envOr("FIRMNESS_BOND_BPS", uint256(0)));
        if (bondBps > 0) vault.setFirmnessBondBps(bondBps);

        // ── S12 SpreadVault: sibling AquaApp, own settlement ─────────────
        address spreadAddr = _deploySpread(
            aquaAddr, oracleAddr, address(hook), wethAddr, usdcAddr, chainlinkFeed, dao, deployer
        );

        // ── S13 MarginVault: opt-in margin tier, own settlement + backstop ─
        (address marginAddr, address backstopAddr, address marginSettlementAddr) = _deployMargin(
            aquaAddr, oracleAddr, address(hook), usdcAddr, chainlinkFeed, address(tokenFactory), dao, deployer,
            block.chainid == 31337 && !forkMainnet // mock USDC only: seed the backstop + insurance
        );

        // ── R6 RfqVault: signed-quote tier over the formula floor ─────────
        address rfqAddr = _deployRfq(
            aquaAddr, oracleAddr, address(hook), wethAddr, usdcAddr, chainlinkFeed, address(tokenFactory), dao, deployer
        );

        vm.stopBroadcast();

        // ── Output — grep-friendly for shell parsing ──────────────────────
        console.log("NEXT_PUBLIC_USDC_ADDRESS=%s",    usdcAddr);
        console.log("NEXT_PUBLIC_WETH_ADDRESS=%s",    wethAddr);
        console.log("NEXT_PUBLIC_AQUA=%s",            aquaAddr);
        console.log("NEXT_PUBLIC_SWAPVM_ROUTER=%s",   address(router));
        console.log("NEXT_PUBLIC_SPOT_ORACLE=%s",     oracleAddr);
        console.log("NEXT_PUBLIC_PRICING_ENGINE=%s",  address(engine));
        console.log("NEXT_PUBLIC_PRICING_HOOK=%s",    address(hook));
        console.log("NEXT_PUBLIC_AQUA_VAULT=%s",      address(vault));
        console.log("NEXT_PUBLIC_SETTLEMENT=%s",      address(settlement));
        console.log("NEXT_PUBLIC_QUOTE_LENS=%s",      address(lens));
        console.log("NEXT_PUBLIC_FIRM_ESCROW_FACTORY=%s", address(firmFactory));
        console.log("NEXT_PUBLIC_SPREAD_VAULT=%s",    spreadAddr);
        console.log("NEXT_PUBLIC_MARGIN_VAULT=%s",    marginAddr);
        console.log("NEXT_PUBLIC_MARGIN_BACKSTOP=%s", backstopAddr);
        console.log("NEXT_PUBLIC_MARGIN_SETTLEMENT=%s", marginSettlementAddr);
        console.log("NEXT_PUBLIC_RFQ_VAULT=%s",       rfqAddr);
        console.log("NEXT_PUBLIC_CHAIN_ID=%s", block.chainid);
    }
}
