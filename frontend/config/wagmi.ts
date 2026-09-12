import { createConfig, http } from "wagmi";
import { mainnet, sepolia, hardhat } from "wagmi/chains";
import { defineChain } from "viem";
import { walletConnect, injected } from "wagmi/connectors";

// MetaMask's built-in "Localhost 8545" hardcodes chainId 1337 rather than
// auto-detecting from the RPC — add it so wagmi doesn't throw ChainNotConfiguredError
// when the user connects before switching to Anvil (31337).
const localhost1337 = defineChain({
  id: 1337,
  name: "Localhost",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

// Circle's Arc testnet — EVM, gas paid in USDC (18-dec native view; the
// ERC-20 view is 6-dec). docs/plans/2026-09-10-arc-bounty.md. Mainnet
// launches 2026-09-16; add it here once its chain id / RPC are published.
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

// Arc mainnet: defined only once its chain id and RPC are set in env
// (public launch 2026-09-16; docs/arc-mainnet-checklist.md). Addresses for it
// come from the NEXT_PUBLIC_* env map below until docs/arc-mainnet-deployment.md
// records them in DEPLOYED_ADDRESSES.
const arcMainnetId = Number(process.env.NEXT_PUBLIC_ARC_MAINNET_CHAIN_ID ?? 0);
const arcMainnetRpc = process.env.NEXT_PUBLIC_ARC_MAINNET_RPC ?? "";
export const arcMainnet = arcMainnetId && arcMainnetRpc
  ? defineChain({
      id: arcMainnetId,
      name: "Arc",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [arcMainnetRpc] } },
      ...(process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER
        ? { blockExplorers: { default: { name: "Arcscan", url: process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER } } }
        : {}),
    })
  : undefined;

const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";

export const config = createConfig({
  chains: arcMainnet
    ? [mainnet, sepolia, arcTestnet, arcMainnet, hardhat, localhost1337]
    : [mainnet, sepolia, arcTestnet, hardhat, localhost1337],
  connectors: [
    injected(),
    ...(projectId ? [walletConnect({ projectId })] : []),
  ],
  transports: {
    [mainnet.id]:        http(),
    [sepolia.id]:        http(),
    [arcTestnet.id]:     http(),
    ...(arcMainnet ? { [arcMainnet.id]: http() } : {}),
    [hardhat.id]:        http("http://127.0.0.1:8545"),
    [localhost1337.id]:  http("http://127.0.0.1:8545"),
  },
});

type Addr = `0x${string}`;
export type ContractKey =
  | "pricingEngine" | "aquaVault" | "settlement" | "aqua" | "swapvmRouter"
  | "spreadVault" | "marginVault" | "marginBackstop" | "marginSettlement" | "rfqVault"
  | "usdc" | "weth";
type ContractMap = Record<ContractKey, string>;

// Addresses from the environment — what ./local.sh writes for Anvil, or a
// copied .env.*.example. The fallback for any chain not in DEPLOYED_ADDRESSES.
const ENV_CONTRACTS: ContractMap = {
  pricingEngine:    process.env.NEXT_PUBLIC_PRICING_ENGINE    ?? "",
  aquaVault:        process.env.NEXT_PUBLIC_AQUA_VAULT        ?? "",
  settlement:       process.env.NEXT_PUBLIC_SETTLEMENT        ?? "",
  // Official 1inch Aqua registry + custom SwapVM router (the Aqua app)
  aqua:             process.env.NEXT_PUBLIC_AQUA              ?? "",
  swapvmRouter:     process.env.NEXT_PUBLIC_SWAPVM_ROUTER     ?? "",
  // S12 defined-risk netting sibling vault (docs/plans/2026-07-12-s12-defined-risk-netting.md)
  spreadVault:      process.env.NEXT_PUBLIC_SPREAD_VAULT      ?? "",
  // S13 opt-in margin tier (Part B of docs/plans/2026-09-05-aqua.md)
  marginVault:      process.env.NEXT_PUBLIC_MARGIN_VAULT      ?? "",
  marginBackstop:   process.env.NEXT_PUBLIC_MARGIN_BACKSTOP   ?? "",
  marginSettlement: process.env.NEXT_PUBLIC_MARGIN_SETTLEMENT ?? "",
  // R6 hybrid RFQ tier: LP-signed EIP-712 quotes over the formula floor
  rfqVault:         process.env.NEXT_PUBLIC_RFQ_VAULT         ?? "",
  usdc:             process.env.NEXT_PUBLIC_USDC_ADDRESS      ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  weth:             process.env.NEXT_PUBLIC_WETH_ADDRESS      ?? "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
};

// The recorded public-testnet deployments (docs/sepolia-deployment.md,
// docs/arc-testnet-deployment.md, deployments/). One build serves every
// chain: the connected chain picks its own addresses; Anvil comes from env.
const DEPLOYED_ADDRESSES: Record<number, ContractMap> = {
  11155111: {
    pricingEngine:    "0x681Bd7583B6612FFf1539781e8d5d7Db565994B3",
    aquaVault:        "0x82AcBBFE5E03510d5407d8C50435B08e6d2d0a4D",
    settlement:       "0x17aAAf612cB5b7b3749Cf22b0b2e0CB1AdA77ca1",
    aqua:             "0x915Bc53936Ecb14A18dB8270A4a648E8dE248749",
    swapvmRouter:     "0x44E2213838913aeC52410ec815b07D15Fcf0a72c",
    spreadVault:      "0x94eE3E1747e96fd643f464ae42db5899Ce878391",
    marginVault:      "0x23F9a08F44fBBCABe9Fdf0d458f226ABb3A84742",
    marginBackstop:   "0x6eEE1ec5F1AFA7Fb8353016a50fBA9C50791FdA2",
    marginSettlement: "0x04D174775d651ecB467C70A31166C491aB69FDE9",
    rfqVault:         "",   // not deployed to Sepolia
    usdc:             "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    weth:             "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
  },
  5042002: {
    pricingEngine:    "0x9BaA6F9EED3C1Cb0BB50222a2Ba65edfC15eBe1C",
    aquaVault:        "0xE37ED711F7D1dc5aC045206b4A6367C55229C789",
    settlement:       "0xA52Dc13F4E05807bB316Bc39604cC099Cc7B29af",
    aqua:             "0x641970C7D4534d983Aa7BB9E2c7700ea3007bb7d",
    swapvmRouter:     "0x8B295cfB8276b5044A95b4b8BA9eFa28b8F17cA5",
    spreadVault:      "0x70E2639b5F374eB023aFaaC0647b0bDee84A227e",
    marginVault:      "0x98AE8EA40e1DB38360a7DE4e547F1Ccb516415Ce",
    marginBackstop:   "0x65e3aeDD095b5735C5eeF046AFe107B3552f19a6",
    marginSettlement: "0x92e66758Fdd79A592aF2443e7A9Ce299743419aD",
    rfqVault:         "0x269E7008951A01C38FF46e38f2f51009AC4e1879",
    usdc:             "0x3600000000000000000000000000000000000000",
    weth:             "0x9A963e6D53b70C2a6F0F90C0E98877a97B9e0abe",
  },
};

let activeChainId = 0;
/// Called by the page on every render with the connected chain, so every
/// `CONTRACTS.x` read below resolves against that chain's deployment.
export function setActiveChainId(id: number) { activeChainId = id; }
export function contractsFor(chainId: number): ContractMap { return DEPLOYED_ADDRESSES[chainId] ?? ENV_CONTRACTS; }

/// Chain-aware address map. Reads like a plain object (`CONTRACTS.aquaVault`)
/// but resolves against the connected chain; `usdc` / `weth` are typed as
/// addresses because every caller passes them straight to wagmi.
export const CONTRACTS = new Proxy(ENV_CONTRACTS, {
  get(target, key: string) {
    const table = DEPLOYED_ADDRESSES[activeChainId];
    return (table ?? target)[key as ContractKey];
  },
}) as Omit<ContractMap, "usdc" | "weth"> & { usdc: Addr; weth: Addr };

// Minimal ABI of the official 1inch Aqua registry (ship/dock). LPs call it
// directly: the collateral allowance lives on the official protocol, and the
// tokens stay in the LP wallet until a swap pulls them just-in-time.
export const AQUA_ABI = [
  {
    name: "ship",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategy", type: "bytes" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [{ name: "strategyHash", type: "bytes32" }],
  },
  {
    name: "dock",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "tokens", type: "address[]" },
    ],
    outputs: [],
  },
] as const;

// Vault helper returning the exact official Aqua.ship() calldata for a range.
export const SHIP_PARAMS_ABI = [
  {
    name: "getShipParams",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "authId", type: "uint256" }],
    outputs: [
      { name: "app", type: "address" },
      { name: "strategy", type: "bytes" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
  },
] as const;

// Default to Anvil/Hardhat for local dev; override with NEXT_PUBLIC_CHAIN_ID=11155111 for Sepolia.
export const TARGET_CHAIN_ID = parseInt(
  process.env.NEXT_PUBLIC_CHAIN_ID ?? String(hardhat.id)
);
