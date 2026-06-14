import { createConfig, http } from "wagmi";
import { mainnet, sepolia, hardhat } from "wagmi/chains";
import { injected, metaMask } from "wagmi/connectors";

export const config = createConfig({
  chains: [mainnet, sepolia, hardhat],
  connectors: [injected(), metaMask()],
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
  settlement: process.env.NEXT_PUBLIC_SETTLEMENT ?? "",
};
