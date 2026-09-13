// The vol surface the vault actually prices from: the hook's per-tenor sigma
// for the selected expiry and its skew beta, read live. Falls back to the
// pre-event constants when there is no vault/hook on the connected chain
// (or before the first read lands), so callers always get numbers.
import { useReadContract } from "wagmi";
import { CONTRACTS } from "@/config/wagmi";
import { ALPHA, BETA, SIGMA_GLOBAL, type SmileParams } from "@/lib/options";

const VAULT_HOOK_ABI = [
  { name: "hook", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;
const HOOK_ABI = [
  { name: "sigmaFor", type: "function", stateMutability: "view", inputs: [{ name: "timeToExpiry", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "beta", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int256" }] },
] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export function useLiveSurface(expiry: number): SmileParams & { live: boolean } {
  const vault = (CONTRACTS.aquaVault || ZERO) as `0x${string}`;
  const { data: hook } = useReadContract({
    address: vault, abi: VAULT_HOOK_ABI, functionName: "hook",
    query: { enabled: vault !== ZERO },
  });
  const hookAddr = (hook && hook !== ZERO ? hook : ZERO) as `0x${string}`;
  const ttl = BigInt(Math.max(0, Math.floor(expiry - Date.now() / 1000)));
  const { data: sigma } = useReadContract({
    address: hookAddr, abi: HOOK_ABI, functionName: "sigmaFor", args: [ttl],
    query: { enabled: hookAddr !== ZERO && expiry > 0, refetchInterval: 15_000 },
  });
  const { data: beta } = useReadContract({
    address: hookAddr, abi: HOOK_ABI, functionName: "beta",
    query: { enabled: hookAddr !== ZERO, refetchInterval: 60_000 },
  });
  // alpha (curvature) is a per-range maker parameter, not stored on the hook;
  // every range shipped by the app uses the default.
  return {
    sigma: sigma !== undefined ? Number(sigma) / 1e18 : SIGMA_GLOBAL,
    alpha: ALPHA,
    beta: beta !== undefined ? Number(beta) / 1e18 : BETA,
    live: sigma !== undefined,
  };
}
