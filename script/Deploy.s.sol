// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
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

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        // Second Anvil account — acts as a buyer in manual testing
        address buyer       = vm.envOr("BUYER_ADDRESS", address(0x70997970C51812dc3A010C7d01b50e0d17dc79C8));

        vm.startBroadcast(deployerKey);

        // ── Mock tokens ──────────────────────────────────────────────────────
        MockERC20 usdc = new MockERC20("USD Coin",      "USDC", 6);
        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);

        // Mint to deployer (LP) and buyer
        usdc.mint(deployer, 1_000_000e6);
        weth.mint(deployer,       100e18);
        usdc.mint(buyer,    1_000_000e6);
        weth.mint(buyer,          10e18);

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
        console.log("NEXT_PUBLIC_USDC_ADDRESS=%s",    address(usdc));
        console.log("NEXT_PUBLIC_WETH_ADDRESS=%s",    address(weth));
        console.log("NEXT_PUBLIC_PRICING_ENGINE=%s",  address(engine));
        console.log("NEXT_PUBLIC_PRICING_HOOK=%s",    address(hook));
        console.log("NEXT_PUBLIC_AQUA_VAULT=%s",      address(vault));
        console.log("NEXT_PUBLIC_SETTLEMENT=%s",      address(settlement));
        console.log("NEXT_PUBLIC_CHAIN_ID=31337");
    }
}
