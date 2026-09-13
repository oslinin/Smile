#!/usr/bin/env node
// Fund MarginBackstop on Arc from a Circle developer-controlled wallet
// (Circle Wallets kit): the treasury that backs margined puts is a wallet
// Circle custodies and signs for through its API — no private key in this
// repo, the entity secret is the only credential. Every call is an ordinary
// contract execution: USDC.approve(backstop) then MarginBackstop.deposit.
//
//   node backstop-wallet.mjs setup     # generate + register the entity secret (once)
//   node backstop-wallet.mjs wallet    # create (or show) the ARC-TESTNET wallet, print its address + USDC
//   node backstop-wallet.mjs deposit   # approve + deposit AMOUNT USDC into the backstop
//   node backstop-wallet.mjs withdraw  # requestWithdraw all shares (withdraw() after the delay)
//
// Env: CIRCLE_API_KEY (required; console.circle.com), CIRCLE_ENTITY_SECRET
//   (required after setup), AMOUNT (USDC, default 1), BACKSTOP / USDC
//   (default: the Arc deployment). State (wallet set + wallet ids) lives in
//   keeper/.circle-wallet.json, gitignored.
//
// ponytail: one wallet, one chain; a wallet set per environment when there
// is more than one pool to run.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, http, parseAbi } from "viem";
import {
  generateEntitySecret,
  initiateDeveloperControlledWalletsClient,
  registerEntitySecretCiphertext,
} from "@circle-fin/developer-controlled-wallets";

const env = (k, d) => process.env[k] ?? d;
const cmd = process.argv[2] ?? "wallet";
const apiKey = env("CIRCLE_API_KEY");
if (!apiKey) { console.error("missing CIRCLE_API_KEY"); process.exit(1); }
const BACKSTOP = env("BACKSTOP", "0x65e3aeDD095b5735C5eeF046AFe107B3552f19a6");
const USDC = env("USDC", "0x3600000000000000000000000000000000000000");
const ARC_RPC = "https://rpc.testnet.arc.network";
const EXPLORER = "https://testnet.arcscan.app/tx/";
const STATE = new URL("./.circle-wallet.json", import.meta.url);
const amount = BigInt(Math.round(Number(env("AMOUNT", "1")) * 1e6));
const usd = (v) => (Number(v) / 1e6).toFixed(6);

if (cmd === "setup") {
  // Prints a fresh entity secret; register it (Circle encrypts it with the
  // entity's public key) and keep it: it is the signing credential.
  const secret = env("CIRCLE_ENTITY_SECRET") ?? (console.log("generated entity secret (save it as CIRCLE_ENTITY_SECRET):"), generateEntitySecret(), process.exit(0));
  await registerEntitySecretCiphertext({ apiKey, entitySecret: secret, recoveryFileDownloadPath: new URL("./", import.meta.url).pathname });
  console.log("entity secret registered; recovery file written next to this script (keep it out of git)");
  process.exit(0);
}

const entitySecret = env("CIRCLE_ENTITY_SECRET");
if (!entitySecret) { console.error("missing CIRCLE_ENTITY_SECRET — run `node backstop-wallet.mjs setup` first"); process.exit(1); }
const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const pub = createPublicClient({ transport: http(ARC_RPC) });
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const POOL = parseAbi(["function totalAssets() view returns (uint256)", "function epoch() view returns (uint256)", "function sharesOf(uint256,address) view returns (uint256)"]);

async function wallet() {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8"));
  const set = (await client.createWalletSet({ name: "Smile treasury" })).data.walletSet;
  const w = (await client.createWallets({ walletSetId: set.id, blockchains: ["ARC-TESTNET"], count: 1, accountType: "EOA" })).data.wallets[0];
  const state = { walletSetId: set.id, walletId: w.id, address: w.address, blockchain: w.blockchain };
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  return state;
}

// A contract call through Circle: they build, sign and broadcast it; we poll
// until it is on chain and return the hash.
async function exec(walletId, contractAddress, abiFunctionSignature, abiParameters) {
  const { data } = await client.createContractExecutionTransaction({
    walletId, contractAddress, abiFunctionSignature, abiParameters,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  for (;;) {
    const tx = (await client.getTransaction({ id: data.id })).data?.transaction;
    if (tx?.state === "COMPLETE" || tx?.state === "CONFIRMED") return tx.txHash;
    if (tx?.state === "FAILED" || tx?.state === "DENIED" || tx?.state === "CANCELLED") throw new Error(`${abiFunctionSignature}: ${tx.state} ${tx.errorReason ?? ""} ${tx.errorDetails ?? ""}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const w = await wallet();
const balance = await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [w.address] });
console.log(`Circle wallet ${w.address} (${w.blockchain}, id ${w.walletId}) · ${usd(balance)} USDC`);

if (cmd === "wallet") {
  if (balance === 0n) console.log("fund it: USDC on Arc is both gas and deposit — https://faucet.circle.com (Arc Testnet) or a transfer from the deployer");
  process.exit(0);
}
if (cmd === "deposit") {
  if (balance < amount + 200_000n) { console.error(`wallet holds ${usd(balance)} USDC; needs ${usd(amount)} + gas`); process.exit(1); }
  const before = await pub.readContract({ address: BACKSTOP, abi: POOL, functionName: "totalAssets" });
  const a = await exec(w.walletId, USDC, "approve(address,uint256)", [BACKSTOP, amount.toString()]);
  console.log(`USDC.approve(backstop) → ${EXPLORER}${a}`);
  const d = await exec(w.walletId, BACKSTOP, "deposit(uint256)", [amount.toString()]);
  const after = await pub.readContract({ address: BACKSTOP, abi: POOL, functionName: "totalAssets" });
  console.log(`MarginBackstop.deposit ${usd(amount)} → ${EXPLORER}${d} · totalAssets ${usd(before)} → ${usd(after)} USDC`);
  process.exit(0);
}
if (cmd === "withdraw") {
  const epoch = await pub.readContract({ address: BACKSTOP, abi: POOL, functionName: "epoch" });
  const shares = await pub.readContract({ address: BACKSTOP, abi: POOL, functionName: "sharesOf", args: [epoch, w.address] });
  if (shares === 0n) { console.log("no shares"); process.exit(0); }
  const h = await exec(w.walletId, BACKSTOP, "requestWithdraw(uint256)", [shares.toString()]);
  console.log(`MarginBackstop.requestWithdraw ${shares} shares → ${EXPLORER}${h}; withdraw() opens after the 24 h delay`);
  process.exit(0);
}
console.error(`unknown command ${cmd}`);
process.exit(1);
