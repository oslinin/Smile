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

const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";

export const config = createConfig({
  chains: [mainnet, sepolia, hardhat, localhost1337],
  connectors: [
    injected(),
    ...(projectId ? [walletConnect({ projectId })] : []),
  ],
  transports: {
    [mainnet.id]:        http(),
    [sepolia.id]:        http(),
    [hardhat.id]:        http("http://127.0.0.1:8545"),
    [localhost1337.id]:  http("http://127.0.0.1:8545"),
  },
});

export const CONTRACTS = {
  pricingEngine: process.env.NEXT_PUBLIC_PRICING_ENGINE ?? "",
  aquaVault:     process.env.NEXT_PUBLIC_AQUA_VAULT     ?? "",
  settlement:    process.env.NEXT_PUBLIC_SETTLEMENT      ?? "",
  // Official 1inch Aqua registry + custom SwapVM router (the Aqua app)
  aqua:          process.env.NEXT_PUBLIC_AQUA            ?? "",
  swapvmRouter:  process.env.NEXT_PUBLIC_SWAPVM_ROUTER   ?? "",
};

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
