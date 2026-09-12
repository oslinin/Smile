#!/usr/bin/env node
// Fund MarginVault's insurance fund on Arc from USDC held on another chain,
// through Circle Gateway (a unified USDC balance: deposit on any supported
// chain, Circle attests a burn intent, mint on the destination). No bridge
// contract of ours, no wrapped token: the USDC that lands on Arc is Circle's
// native USDC, and it goes straight into `fundInsurance`.
//
//   source chain (Sepolia)                    Circle               Arc testnet
//   USDC.approve(GatewayWallet) ─┐
//   GatewayWallet.deposit(USDC) ─┴─ finality ─► /v1/transfer ─► GatewayMinter.gatewayMint(att, sig)
//                                     (signed BurnIntent, EIP-712)          └─► MarginVault.fundInsurance(amount)
//
// Usage (deployer key holds USDC + gas on both chains):
//   cd keeper && PRIVATE_KEY=0x… AMOUNT=5 node insurance-gateway.mjs
// Env: PRIVATE_KEY (required), AMOUNT (USDC, default 5), SOURCE (sepolia |
//   base-sepolia, default sepolia), MARGIN_VAULT (default: the Arc deployment).
// Idempotent-ish: a Gateway balance already sitting on the source domain is
// used before a new deposit is made.

import { createPublicClient, createWalletClient, http, pad, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const GATEWAY_API = "https://gateway-api-testnet.circle.com";
const GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"; // same on every EVM testnet
const GATEWAY_MINTER = "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B";
const SOURCES = {
  sepolia: { domain: 0, rpc: "https://ethereum-sepolia-rpc.publicnode.com", usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", explorer: "https://sepolia.etherscan.io/tx/" },
  "base-sepolia": { domain: 6, rpc: "https://sepolia.base.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", explorer: "https://sepolia.basescan.org/tx/" },
};
const ARC = { domain: 26, rpc: "https://rpc.testnet.arc.network", usdc: "0x3600000000000000000000000000000000000000", explorer: "https://testnet.arcscan.app/tx/" };

const env = (k, d) => process.env[k] ?? d;
const key = env("PRIVATE_KEY");
if (!key) { console.error("missing PRIVATE_KEY"); process.exit(1); }
const account = privateKeyToAccount(key);
const src = SOURCES[env("SOURCE", "sepolia")];
const amount = BigInt(Math.round(Number(env("AMOUNT", "5")) * 1e6));
const MARGIN_VAULT = env("MARGIN_VAULT", "0x98AE8EA40e1DB38360a7DE4e547F1Ccb516415Ce");

const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const WALLET = parseAbi(["function deposit(address token, uint256 amount)"]);
const MINTER = parseAbi(["function gatewayMint(bytes attestation, bytes signature)"]);
const VAULT = parseAbi(["function fundInsurance(uint256 amount)", "function insuranceFund() view returns (uint256)"]);

const srcPub = createPublicClient({ transport: http(src.rpc) });
const srcWal = createWalletClient({ account, transport: http(src.rpc) });
const arcPub = createPublicClient({ transport: http(ARC.rpc) });
const arcWal = createWalletClient({ account, transport: http(ARC.rpc) });
const usd = (v) => (Number(v) / 1e6).toFixed(6);
// Gateway's API returns USDC amounts as decimal strings ("5.000000"); on-chain
// values are integer micro-units. Accept either.
const micro = (v) => (typeof v === "string" && v.includes(".") ? BigInt(Math.round(Number(v) * 1e6)) : BigInt(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gatewayBalance() {
  const r = await fetch(`${GATEWAY_API}/v1/balances`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "USDC", sources: [{ depositor: account.address, domain: src.domain }] }) });
  const j = await r.json();
  return micro(j.balances?.[0]?.balance ?? "0");
}

// ── 1. deposit on the source chain (skipped if the Gateway already holds enough) ──
let available = await gatewayBalance();
console.log(`gateway balance on domain ${src.domain}: ${usd(available)} USDC`);
if (available < amount) {
  const bal = await srcPub.readContract({ address: src.usdc, abi: ERC20, functionName: "balanceOf", args: [account.address] });
  if (bal < amount) { console.error(`source USDC balance ${usd(bal)} < ${usd(amount)}`); process.exit(1); }
  const allowance = await srcPub.readContract({ address: src.usdc, abi: ERC20, functionName: "allowance", args: [account.address, GATEWAY_WALLET] });
  if (allowance < amount) {
    const h = await srcWal.writeContract({ address: src.usdc, abi: ERC20, functionName: "approve", args: [GATEWAY_WALLET, amount], chain: null });
    await srcPub.waitForTransactionReceipt({ hash: h });
    console.log(`approve → ${src.explorer}${h}`);
  }
  const h = await srcWal.writeContract({ address: GATEWAY_WALLET, abi: WALLET, functionName: "deposit", args: [src.usdc, amount], chain: null });
  await srcPub.waitForTransactionReceipt({ hash: h });
  console.log(`GatewayWallet.deposit ${usd(amount)} USDC → ${src.explorer}${h}`);
  // Circle credits the balance once the source chain is final (Sepolia: ~19 min).
  process.stdout.write("waiting for finality");
  while ((available = await gatewayBalance()) < amount) { process.stdout.write("."); await sleep(30_000); }
  console.log(` ${usd(available)} USDC available`);
}

// ── 2. sign the burn intent, get Circle's attestation ────────────────────────
const b32 = (a) => pad(a, { size: 32 });
const spec = {
  version: 1,
  sourceDomain: src.domain,
  destinationDomain: ARC.domain,
  sourceContract: b32(GATEWAY_WALLET),
  destinationContract: b32(GATEWAY_MINTER),
  sourceToken: b32(src.usdc),
  destinationToken: b32(ARC.usdc),
  sourceDepositor: b32(account.address),
  destinationRecipient: b32(account.address),
  sourceSigner: b32(account.address),
  destinationCaller: b32("0x0000000000000000000000000000000000000000"),
  value: amount,
  salt: toHex(randomBytes(32)),
  hookData: "0x",
};
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
// Fee + expiry from Circle's estimate; the fee is taken out of `value`.
const est = await fetch(`${GATEWAY_API}/v1/estimate`, { method: "POST", headers: { "content-type": "application/json" }, body: json([{ spec }]) }).then((r) => r.json());
const estimated = est.body?.[0]?.burnIntent;
const maxFee = micro(estimated?.maxFee ?? 2_010000);
const maxBlockHeight = BigInt(estimated?.maxBlockHeight ?? (1n << 256n) - 1n);
console.log(`estimate: maxFee ${usd(maxFee)} USDC, maxBlockHeight ${maxBlockHeight}`);
const types = {
  TransferSpec: [
    { name: "version", type: "uint32" }, { name: "sourceDomain", type: "uint32" }, { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" }, { name: "destinationContract", type: "bytes32" }, { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" }, { name: "sourceDepositor", type: "bytes32" }, { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" }, { name: "destinationCaller", type: "bytes32" }, { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" }, { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [{ name: "maxBlockHeight", type: "uint256" }, { name: "maxFee", type: "uint256" }, { name: "spec", type: "TransferSpec" }],
};
const burnIntent = { maxBlockHeight, maxFee, spec };
const signature = await account.signTypedData({ domain: { name: "GatewayWallet", version: "1" }, types, primaryType: "BurnIntent", message: burnIntent });
const res = await fetch(`${GATEWAY_API}/v1/transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: json([{ burnIntent, signature }]) });
const transfer = await res.json();
if (!transfer.attestation) { console.error("transfer failed:", transfer); process.exit(1); }
console.log(`attestation ${transfer.transferId} · fees ${usd(micro(transfer.fees?.total ?? 0))} USDC`);

// ── 3. mint on Arc, fund the insurance pool ──────────────────────────────────
const before = await arcPub.readContract({ address: ARC.usdc, abi: ERC20, functionName: "balanceOf", args: [account.address] });
const mintHash = await arcWal.writeContract({ address: GATEWAY_MINTER, abi: MINTER, functionName: "gatewayMint", args: [transfer.attestation, transfer.signature], chain: null });
await arcPub.waitForTransactionReceipt({ hash: mintHash });
const after = await arcPub.readContract({ address: ARC.usdc, abi: ERC20, functionName: "balanceOf", args: [account.address] });
const minted = after - before;
console.log(`GatewayMinter.gatewayMint → ${ARC.explorer}${mintHash} · +${usd(minted)} USDC on Arc`);

const fundAmount = minted > 0n ? minted : amount - maxFee;
const a = await arcWal.writeContract({ address: ARC.usdc, abi: ERC20, functionName: "approve", args: [MARGIN_VAULT, fundAmount], chain: null });
await arcPub.waitForTransactionReceipt({ hash: a });
const f = await arcWal.writeContract({ address: MARGIN_VAULT, abi: VAULT, functionName: "fundInsurance", args: [fundAmount], chain: null });
await arcPub.waitForTransactionReceipt({ hash: f });
const fund = await arcPub.readContract({ address: MARGIN_VAULT, abi: VAULT, functionName: "insuranceFund" });
console.log(`MarginVault.fundInsurance ${usd(fundAmount)} → ${ARC.explorer}${f} · insuranceFund now ${usd(fund)} USDC`);
