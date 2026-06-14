/**
 * Chainlink CRE Workflow — Option Series Settlement
 *
 * On a cron schedule, the DON reads the same Chainlink ETH/USD price feed the app
 * uses for live spot, builds a DON-signed report, and writes it on-chain by calling
 * AquaOptionSettlement.settleSeries(seriesId, spotPrice).
 *
 * Reading the feed at the last finalized block means every node observes the same
 * value, so consensus is deterministic — no per-node aggregation needed. CRE here
 * acts as the trust-minimized, scheduled settlement keeper: it picks the official
 * expiry mark off the canonical Chainlink feed and performs the on-chain state
 * change that flips a series from open to settled.
 *
 * This is the required Chainlink on-chain state change.
 *
 * Build:    cre workflow build    settlement   (compiles main.ts → WASM, no auth)
 * Simulate: cre workflow simulate settlement   (requires `cre login` / CRE_API_KEY)
 * Deploy:   cre workflow deploy   settlement   (requires auth + deploy access)
 *
 * NOTE: `writeReportFromSettleSeries` delivers a DON-signed report through the CRE
 * forwarder. For the live on-chain write to succeed end-to-end, the receiver must
 * accept the forwarder's report (a KeystoneForwarder `onReport(bytes,bytes)`
 * entrypoint). The current AquaOptionSettlement exposes a plain
 * `settleSeries(bytes32,uint256)` guarded by `onlyCRE`; wiring the live report path
 * is tracked separately (see README §6). Compilation and feed read simulate cleanly.
 */

import {
	bytesToHex,
	cre,
	type CronPayload,
	encodeCallMsg,
	getNetwork,
	LAST_FINALIZED_BLOCK_NUMBER,
	type Runtime,
	TxStatus,
} from '@chainlink/cre-sdk'
import { type Address, decodeFunctionResult, encodeFunctionData, type Hex, zeroAddress } from 'viem'
import { z } from 'zod'
import { AquaOptionSettlement } from '../contracts/evm/ts/generated/AquaOptionSettlement'

// ── Config schema ─────────────────────────────────────────────────────────────

export const configSchema = z.object({
	schedule: z.string(),
	seriesId: z.string(),
	evm: z.object({
		chainName: z.string(),
		settlementAddress: z.string(),
		// Chainlink ETH/USD aggregator — the same feed the frontend reads for spot.
		priceFeedAddress: z.string(),
		gasLimit: z.string(),
	}),
})

export type Config = z.infer<typeof configSchema>

// ── Chainlink aggregator interface ──────────────────────────────────────────────

const ETH_USD_FEED_ABI = [
	{
		name: 'latestRoundData',
		type: 'function',
		stateMutability: 'view',
		inputs: [],
		outputs: [
			{ name: 'roundId', type: 'uint80' },
			{ name: 'answer', type: 'int256' },
			{ name: 'startedAt', type: 'uint256' },
			{ name: 'updatedAt', type: 'uint256' },
			{ name: 'answeredInRound', type: 'uint80' },
		],
	},
] as const

// ── Settlement ──────────────────────────────────────────────────────────────────

const settle = (runtime: Runtime<Config>): string => {
	const { seriesId, evm } = runtime.config

	// 1. Resolve the target chain.
	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: evm.chainName,
		isTestnet: true,
	})
	if (!network) throw new Error(`Unknown chain: ${evm.chainName}`)

	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)

	// 2. Read the Chainlink ETH/USD feed at the last finalized block. Reading a
	//    finalized value means every DON node sees the same answer, so the DON
	//    consensus over the read is deterministic.
	const callResult = evmClient
		.callContract(runtime, {
			call: encodeCallMsg({
				from: zeroAddress,
				to: evm.priceFeedAddress as Address,
				data: encodeFunctionData({ abi: ETH_USD_FEED_ABI, functionName: 'latestRoundData' }),
			}),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()

	const [, answer] = decodeFunctionResult({
		abi: ETH_USD_FEED_ABI,
		functionName: 'latestRoundData',
		data: bytesToHex(callResult.data),
	}) as readonly [bigint, bigint, bigint, bigint, bigint]

	if (answer <= 0n) throw new Error(`Bad feed answer: ${answer}`)

	runtime.log(`[CRE] Chainlink ETH/USD: $${(Number(answer) / 1e8).toFixed(2)}`)

	// 3. Chainlink ETH/USD is 8-decimal fixed-point; settlement stores USDC 6-decimal.
	const spotUsdc6 = answer / 100n

	// 4. DON-signed report → settleSeries on-chain (the required state change).
	const settlement = new AquaOptionSettlement(evmClient, evm.settlementAddress as Address)

	const resp = settlement.writeReportFromSettleSeries(
		runtime,
		seriesId as Hex,
		spotUsdc6,
		{ gasLimit: evm.gasLimit },
	)

	if (resp.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`settleSeries failed: ${resp.errorMessage || resp.txStatus}`)
	}

	const txHash = bytesToHex(resp.txHash ?? new Uint8Array(32))
	runtime.log(`[CRE] settleSeries(${seriesId}, ${spotUsdc6}) submitted — tx ${txHash}`)
	return spotUsdc6.toString()
}

// ── Trigger handler ───────────────────────────────────────────────────────────

export const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
	runtime.log('[CRE] Option settlement workflow triggered')
	return settle(runtime)
}

// ── Workflow definition ─────────────────────────────────────────────────────────

export function initWorkflow(config: Config) {
	const cron = new cre.capabilities.CronCapability()
	return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}
