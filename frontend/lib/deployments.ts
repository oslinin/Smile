// Recorded testnet deployments and demo transactions, per chain — the
// receipts the Story and Proof tabs link to. Sources of truth:
// docs/sepolia-deployment.md, docs/arc-testnet-deployment.md, deployments/.

export type DemoTx = { label: string; hash: string; note?: string };
export type Deployment = {
  chainId: number;
  name: string;
  explorer: string;
  contracts: { label: string; address: string }[];
  demo: DemoTx[];
  subgraph?: string;
  realMoney: string;
};

export const DEPLOYMENTS: Record<number, Deployment> = {
  11155111: {
    chainId: 11155111,
    name: "Sepolia",
    explorer: "https://sepolia.etherscan.io",
    realMoney: "Circle USDC · canonical WETH · Chainlink ETH/USD",
    subgraph: "https://api.studio.thegraph.com/query/44448/smile-sepolia/v0.0.4",
    contracts: [
      { label: "Aqua (official registry)", address: "0x915Bc53936Ecb14A18dB8270A4a648E8dE248749" },
      { label: "AquaCollateralVault", address: "0x82AcBBFE5E03510d5407d8C50435B08e6d2d0a4D" },
      { label: "SpreadVault", address: "0x94eE3E1747e96fd643f464ae42db5899Ce878391" },
      { label: "MarginVault", address: "0x23F9a08F44fBBCABe9Fdf0d458f226ABb3A84742" },
      { label: "MarginBackstop", address: "0x6eEE1ec5F1AFA7Fb8353016a50fBA9C50791FdA2" },
      { label: "SmileSwapVMRouter", address: "0x44E2213838913aeC52410ec815b07D15Fcf0a72c" },
      { label: "OptionPricingHook", address: "0xCa84Df6F9317FABDE1fD21f4bee25Cb2a8ba1676" },
      { label: "AquaOptionSettlement", address: "0x17aAAf612cB5b7b3749Cf22b0b2e0CB1AdA77ca1" },
    ],
    demo: [
      { label: "authorizeRange · calls $2,300–$2,800", hash: "0x98e4e922e57d7fad0902089767c7b108e6485c03527c4c00f90f8e68a59d03e7" },
      { label: "Aqua.ship", hash: "0x878d8bb535045acb4c20da3ae491e681c1e7c8993ac4479476168eec2a2227c1", note: "collateral stays in the LP wallet" },
      { label: "buy 0.01 × $2,500 call", hash: "0x505285ff96be5a576a4c1895a163cc462d777517a8c421989b504cb3701c7bca", note: "0.01 WETH pulled JIT through Aqua · indexed by The Graph one block later · a self-fill by the deployer (L15)" },
    ],
  },
  5042002: {
    chainId: 5042002,
    name: "Arc Testnet",
    explorer: "https://testnet.arcscan.app",
    realMoney: "Circle's native USDC — premium, collateral, margin, backstop, and gas",
    subgraph: "https://api.studio.thegraph.com/query/44448/smile-arc-testnet/v0.0.1",
    contracts: [
      { label: "Aqua (official registry)", address: "0x641970C7D4534d983Aa7BB9E2c7700ea3007bb7d" },
      { label: "AquaCollateralVault", address: "0xE37ED711F7D1dc5aC045206b4A6367C55229C789" },
      { label: "SpreadVault", address: "0x70E2639b5F374eB023aFaaC0647b0bDee84A227e" },
      { label: "MarginVault", address: "0x98AE8EA40e1DB38360a7DE4e547F1Ccb516415Ce" },
      { label: "MarginBackstop", address: "0x65e3aeDD095b5735C5eeF046AFe107B3552f19a6" },
      { label: "RfqVault", address: "0x269E7008951A01C38FF46e38f2f51009AC4e1879" },
      { label: "USDC (native)", address: "0x3600000000000000000000000000000000000000" },
    ],
    demo: [
      { label: "buy 0.01 × $3,000 call (main vault)", hash: "0x3563dc099723ccd01d7953160a598e8a5a82fdd3cbbae6840593f2caf245989a", note: "real-USDC premium · a self-fill by the deployer (L15)" },
      { label: "SpreadVault.buy · 3000/3200 call credit", hash: "0x73a8e48888b4fe77969fdcc05b6cb51c529d0ab80c4f40ff6f2f1991fe0996a5", note: "0.000625 WETH pulled — 16× less than a naked leg" },
      { label: "MarginVault.buy · 0.001 × $3,000 put", hash: "0x0938c5be639e8daf30b88d15b82d5ec80dd5d3a68096e5b796051f00791a4d02", note: "1.50 USDC of initial margin, not the 3.00 USDC strike" },
      { label: "RfqVault.fill · LP-signed quote", hash: "0x257a8fd1c638dc8590dac048abc12ef85ce78249a3f3df7a6a36d725b89bad29", note: "0.688860 vs a 0.695819 formula Ask · 0.001 WETH pulled JIT" },
      // Circle App Kits (2026-09-12): the treasury funds the margin tier with no private key in the repo.
      { label: "Treasury · Wallets kit → MarginBackstop.deposit 1 USDC", hash: "0xbfd2db0a0b5f3be1bd8b0bd240859fe95608ee5656420ff5b1312a35706a4d95", note: "Circle-custodied wallet 0x61bd…3368 signs through Circle's API · pool 30.00 → 31.00 USDC" },
      { label: "Treasury · Gateway → GatewayMinter.gatewayMint 2.997 USDC", hash: "0xa5baa3e5880b59b68c4561298cbf8f107d40591ee8cf9b3d0ec71aadf35fc057", note: "Sepolia USDC → signed BurnIntent → Circle attestation → native USDC on Arc" },
      { label: "Treasury · Gateway → MarginVault.fundInsurance 2.997 USDC", hash: "0xc5493a8e121b52b7e9c6c52ef894ce96cc5a1b3d42e343bfd687b872ec6ac61b", note: "insurance fund 4.00 → 7.00 USDC" },
    ],
  },
};
