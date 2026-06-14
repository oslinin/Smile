import { createConfig, http } from "wagmi";
import { mainnet, sepolia, hardhat } from "wagmi/chains";
import { walletConnect } from "wagmi/connectors";

const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "";

export const config = createConfig({
  chains: [mainnet, sepolia, hardhat],
  connectors: [
    ...(projectId ? [walletConnect({ projectId })] : []),
  ],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
    [hardhat.id]: http("http://localhost:8545"),
  },
});

/** Deployed contract addresses — update after deploy */
export const CONTRACTS = {
  pricingEngine: process.env.NEXT_PUBLIC_PRICING_ENGINE ?? "",
  aquaVault: process.env.NEXT_PUBLIC_AQUA_VAULT ?? "",
  settlement: "0x96381D3795A73Fc6a982A9B77D51f6d3F392aDCA",
};
