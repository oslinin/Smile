// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/StdCheats.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/swapvm/OptionPricingEngine.sol";
import "../src/hooks/OptionPricingHook.sol";
import "../src/vaults/AquaCollateralVault.sol";
import "../src/vaults/AquaOptionSettlement.sol";

contract MockERC20 is ERC20 {
    uint8 private _dec;
    constructor(string memory name, string memory symbol, uint8 dec_) ERC20(name, symbol) { _dec = dec_; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract Deploy is Script, StdCheats {
    address constant USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH_MAINNET = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    // Circle USDC + canonical WETH on Sepolia testnet
    address constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address constant WETH_SEPOLIA = 0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        // Second Anvil account — acts as a buyer in manual testing
        address buyer       = vm.envOr("BUYER_ADDRESS", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));
        bool    forkMainnet = vm.envOr("FORK_MAINNET", false);

        address usdcAddr;
        address wethAddr;

        if (block.chainid == 11155111) {
            // ── Sepolia: use real Circle USDC + canonical WETH ───────────────
            usdcAddr = USDC_SEPOLIA;
            wethAddr = WETH_SEPOLIA;
        } else if (forkMainnet) {
            // ── Mainnet fork: use real tokens, deal balances ─────────────────
            usdcAddr = USDC_MAINNET;
            wethAddr = WETH_MAINNET;
            vm.deal(deployer, 100 ether);
            vm.deal(buyer,     10 ether);
            deal(usdcAddr, deployer, 1_000_000e6);
            deal(usdcAddr, buyer,    1_000_000e6);
        } else {
            // ── Blank Anvil: deploy mock tokens ──────────────────────────────
            vm.startBroadcast(deployerKey);
            MockERC20 usdc = new MockERC20("USD Coin",      "USDC", 6);
            MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
            usdc.mint(deployer, 1_000_000e6);
            weth.mint(deployer,       100e18);
            usdc.mint(buyer,    1_000_000e6);
            weth.mint(buyer,          10e18);
            vm.stopBroadcast();
            usdcAddr = address(usdc);
            wethAddr = address(weth);
        }

        vm.startBroadcast(deployerKey);

        // ── Core contracts ───────────────────────────────────────────────────
        OptionPricingEngine engine = new OptionPricingEngine();

        uint256 initialSigma = 0.8e18;
        // poolManager is unused on Anvil (no live Uniswap v4); pass address(1) as placeholder
        OptionPricingHook hook = new OptionPricingHook(address(engine), address(1), initialSigma);

        AquaCollateralVault vault = new AquaCollateralVault(address(engine), deployer);

        // deployer also acts as CRE forwarder in local testing
        AquaOptionSettlement settlement = new AquaOptionSettlement(deployer, deployer);

        // ── Wire hook ↔ vault ────────────────────────────────────────────────
        vault.setHook(address(hook));
        hook.setVault(address(vault));

        vm.stopBroadcast();

        // ── Output — grep-friendly for shell parsing ──────────────────────
        console.log("NEXT_PUBLIC_USDC_ADDRESS=%s",    usdcAddr);
        console.log("NEXT_PUBLIC_WETH_ADDRESS=%s",    wethAddr);
        console.log("NEXT_PUBLIC_PRICING_ENGINE=%s",  address(engine));
        console.log("NEXT_PUBLIC_PRICING_HOOK=%s",    address(hook));
        console.log("NEXT_PUBLIC_AQUA_VAULT=%s",      address(vault));
        console.log("NEXT_PUBLIC_SETTLEMENT=%s",      address(settlement));
        console.log("NEXT_PUBLIC_CHAIN_ID=%s", block.chainid);
    }
}
