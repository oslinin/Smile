// Per-chain tx explorer base URLs. Chains absent here (e.g. the local Anvil
// mainnet fork, 31337) have no public explorer, so links are omitted.
export const EXPLORER_TX: Record<number, string> = {
  1:        "https://etherscan.io/tx/",
  11155111: "https://sepolia.etherscan.io/tx/",
};

// Returns a clickable explorer URL for the tx, or null when the chain has no
// public explorer (callers should fall back to plain text in that case).
export function explorerTxUrl(chainId: number, hash: string): string | null {
  const base = EXPLORER_TX[chainId];
  return base ? base + hash : null;
}
