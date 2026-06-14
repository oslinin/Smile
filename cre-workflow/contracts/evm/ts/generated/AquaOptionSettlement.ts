// Code generated — DO NOT EDIT.
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  zeroAddress,
} from 'viem'
import type { Address, Hex } from 'viem'
import {
  bytesToHex,
  encodeCallMsg,
  EVMClient,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  type EVMLog,
  type Runtime,
} from '@chainlink/cre-sdk'

export interface DecodedLog<T> extends Omit<EVMLog, 'data'> { data: T }

const encodeTopicValue = (t: Hex | Hex[] | null): string[] => {
  if (t == null) return []
  if (Array.isArray(t)) return t.map(hexToBase64)
  return [hexToBase64(t)]
}





/**
 * Filter params for CollateralReturned. Only indexed fields can be used for filtering.
 * Indexed string/bytes must be passed as keccak256 hash (Hex).
 */
export type CollateralReturnedTopics = {
  seriesId?: `0x${string}`
}

/**
 * Decoded CollateralReturned event data.
 */
export type CollateralReturnedDecoded = {
  seriesId: `0x${string}`
  lp: `0x${string}`
  amount: bigint
}


/**
 * Filter params for HolderPaid. Only indexed fields can be used for filtering.
 * Indexed string/bytes must be passed as keccak256 hash (Hex).
 */
export type HolderPaidTopics = {
  seriesId?: `0x${string}`
}

/**
 * Decoded HolderPaid event data.
 */
export type HolderPaidDecoded = {
  seriesId: `0x${string}`
  holder: `0x${string}`
  payout: bigint
}


/**
 * Filter params for OwnershipTransferred. Only indexed fields can be used for filtering.
 * Indexed string/bytes must be passed as keccak256 hash (Hex).
 */
export type OwnershipTransferredTopics = {
  previousOwner?: `0x${string}`
  newOwner?: `0x${string}`
}

/**
 * Decoded OwnershipTransferred event data.
 */
export type OwnershipTransferredDecoded = {
  previousOwner: `0x${string}`
  newOwner: `0x${string}`
}


/**
 * Filter params for SeriesRegistered. Only indexed fields can be used for filtering.
 * Indexed string/bytes must be passed as keccak256 hash (Hex).
 */
export type SeriesRegisteredTopics = {
  seriesId?: `0x${string}`
}

/**
 * Decoded SeriesRegistered event data.
 */
export type SeriesRegisteredDecoded = {
  seriesId: `0x${string}`
}


/**
 * Filter params for SeriesSettled. Only indexed fields can be used for filtering.
 * Indexed string/bytes must be passed as keccak256 hash (Hex).
 */
export type SeriesSettledTopics = {
  seriesId?: `0x${string}`
}

/**
 * Decoded SeriesSettled event data.
 */
export type SeriesSettledDecoded = {
  seriesId: `0x${string}`
  settlementPrice: bigint
}


export const AquaOptionSettlementABI = [{"type":"constructor","inputs":[{"name":"creForwarder_","type":"address","internalType":"address"},{"name":"owner_","type":"address","internalType":"address"}],"stateMutability":"nonpayable"},{"type":"function","name":"creForwarder","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"owner","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"reclaimCollateral","inputs":[{"name":"seriesId","type":"bytes32","internalType":"bytes32"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"redeem","inputs":[{"name":"seriesId","type":"bytes32","internalType":"bytes32"},{"name":"amount","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"registerSeries","inputs":[{"name":"seriesId","type":"bytes32","internalType":"bytes32"},{"name":"expiry","type":"uint256","internalType":"uint256"},{"name":"strikePrice","type":"uint256","internalType":"uint256"},{"name":"collateralPerUnit","type":"uint256","internalType":"uint256"},{"name":"collateralToken","type":"address","internalType":"address"},{"name":"optionToken","type":"address","internalType":"address"},{"name":"lp","type":"address","internalType":"address"},{"name":"totalCollateral","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"renounceOwnership","inputs":[],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"series","inputs":[{"name":"","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"expiry","type":"uint256","internalType":"uint256"},{"name":"strikePrice","type":"uint256","internalType":"uint256"},{"name":"collateralPerUnit","type":"uint256","internalType":"uint256"},{"name":"collateralToken","type":"address","internalType":"address"},{"name":"optionToken","type":"address","internalType":"address"},{"name":"lp","type":"address","internalType":"address"},{"name":"totalCollateral","type":"uint256","internalType":"uint256"},{"name":"settled","type":"bool","internalType":"bool"},{"name":"settlementPrice","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"settleSeries","inputs":[{"name":"seriesId","type":"bytes32","internalType":"bytes32"},{"name":"spotPrice","type":"uint256","internalType":"uint256"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"function","name":"transferOwnership","inputs":[{"name":"newOwner","type":"address","internalType":"address"}],"outputs":[],"stateMutability":"nonpayable"},{"type":"event","name":"CollateralReturned","inputs":[{"name":"seriesId","type":"bytes32","indexed":true,"internalType":"bytes32"},{"name":"lp","type":"address","indexed":false,"internalType":"address"},{"name":"amount","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"event","name":"HolderPaid","inputs":[{"name":"seriesId","type":"bytes32","indexed":true,"internalType":"bytes32"},{"name":"holder","type":"address","indexed":false,"internalType":"address"},{"name":"payout","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"event","name":"OwnershipTransferred","inputs":[{"name":"previousOwner","type":"address","indexed":true,"internalType":"address"},{"name":"newOwner","type":"address","indexed":true,"internalType":"address"}],"anonymous":false},{"type":"event","name":"SeriesRegistered","inputs":[{"name":"seriesId","type":"bytes32","indexed":true,"internalType":"bytes32"}],"anonymous":false},{"type":"event","name":"SeriesSettled","inputs":[{"name":"seriesId","type":"bytes32","indexed":true,"internalType":"bytes32"},{"name":"settlementPrice","type":"uint256","indexed":false,"internalType":"uint256"}],"anonymous":false},{"type":"error","name":"OwnableInvalidOwner","inputs":[{"name":"owner","type":"address","internalType":"address"}]},{"type":"error","name":"OwnableUnauthorizedAccount","inputs":[{"name":"account","type":"address","internalType":"address"}]},{"type":"error","name":"SafeERC20FailedOperation","inputs":[{"name":"token","type":"address","internalType":"address"}]}] as const

export class AquaOptionSettlement {
  constructor(
    private readonly client: EVMClient,
    public readonly address: Address,
  ) {}

  creForwarder(
    runtime: Runtime<unknown>,
  ): `0x${string}` {
    const callData = encodeFunctionData({
      abi: AquaOptionSettlementABI,
      functionName: 'creForwarder' as const,
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: AquaOptionSettlementABI,
      functionName: 'creForwarder' as const,
      data: bytesToHex(result.data),
    }) as `0x${string}`
  }

  owner(
    runtime: Runtime<unknown>,
  ): `0x${string}` {
    const callData = encodeFunctionData({
      abi: AquaOptionSettlementABI,
      functionName: 'owner' as const,
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: AquaOptionSettlementABI,
      functionName: 'owner' as const,
      data: bytesToHex(result.data),
    }) as `0x${string}`
  }

  series(
    runtime: Runtime<unknown>,
    arg0: `0x${string}`,
  ): readonly [bigint, bigint, bigint, `0x${string}`, `0x${string}`, `0x${string}`, bigint, boolean, bigint] {
    const callData = encodeFunctionData({
      abi: AquaOptionSettlementABI,
      functionName: 'series' as const,
      args: [arg0],
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: AquaOptionSettlementABI,
      functionName: 'series' as const,
      data: bytesToHex(result.data),
    }) as readonly [bigint, bigint, bigint, `0x${string}`, `0x${string}`, `0x${string}`, bigint, boolean, bigint]
  }

  writeReportFromReclaimCollateral(
    runtime: Runtime<unknown>,
    seriesId: `0x${string}`,
    gasConfig?: { gasLimit?: string },
  ) {
    const callData = encodeFunctionData({
      abi: AquaOptionSettlementABI,
      functionName: 'reclaimCollateral' as const,
      args: [seriesId],
    })

    const reportResponse = runtime
      .report(prepareReportRequest(callData))
      .result()

    return this.client
      .writeReport(runtime, {
        receiver: this.address,
        report: reportResponse,
        gasConfig,
      })
      .result()
  }

  writeReportFromRedeem(
    runtime: Runtime<unknown>,
    seriesId: `0x${string}`,
    amount: bigint,
    gasConfig?: { gasLimit?: string },
  ) {
    const callData = encodeFunctionData({
      abi: AquaOptionSettlementABI,
      functionName: 'redeem' as const,
      args: [seriesId, amount],
    })

    const reportResponse = runtime
      .report(prepareReportRequest(callData))
      .result()

    return this.client
      .writeReport(runtime, {
        receiver: this.address,
        report: reportResponse,
        gasConfig,
      })
      .result()
  }

  writeReportFromRegisterSeries(
    runtime: Runtime<unknown>,
    seriesId: `0x${string}`,
    expiry: bigint,
    strikePrice: bigint,
    collateralPerUnit: bigint,
    collateralToken: `0x${string}`,
    optionToken: `0x${string}`,
    lp: `0x${string}`,
    totalCollateral: bigint,
    gasConfig?: { gasLimit?: string },
  ) {
    const callData = encodeFunctionData({
      abi: AquaOptionSettlementABI,
      functionName: 'registerSeries' as const,
      args: [seriesId, expiry, strikePrice, collateralPerUnit, collateralToken, optionToken, lp, totalCollateral],
    })

    const reportResponse = runtime
      .report(prepareReportRequest(callData))
      .result()

    return this.client
      .writeReport(runtime, {
        receiver: this.address,
        report: reportResponse,
        gasConfig,
      })
      .result()
  }

  writeReportFromSettleSeries(
    runtime: Runtime<unknown>,
    seriesId: `0x${string}`,
    spotPrice: bigint,
    gasConfig?: { gasLimit?: string },
  ) {
    const callData = encodeFunctionData({
      abi: AquaOptionSettlementABI,
      functionName: 'settleSeries' as const,
      args: [seriesId, spotPrice],
    })

    const reportResponse = runtime
      .report(prepareReportRequest(callData))
      .result()

    return this.client
      .writeReport(runtime, {
        receiver: this.address,
        report: reportResponse,
        gasConfig,
      })
      .result()
  }

  writeReportFromTransferOwnership(
    runtime: Runtime<unknown>,
    newOwner: `0x${string}`,
    gasConfig?: { gasLimit?: string },
  ) {
    const callData = encodeFunctionData({
      abi: AquaOptionSettlementABI,
      functionName: 'transferOwnership' as const,
      args: [newOwner],
    })

    const reportResponse = runtime
      .report(prepareReportRequest(callData))
      .result()

    return this.client
      .writeReport(runtime, {
        receiver: this.address,
        report: reportResponse,
        gasConfig,
      })
      .result()
  }

  writeReport(
    runtime: Runtime<unknown>,
    callData: Hex,
    gasConfig?: { gasLimit?: string },
  ) {
    const reportResponse = runtime
      .report(prepareReportRequest(callData))
      .result()

    return this.client
      .writeReport(runtime, {
        receiver: this.address,
        report: reportResponse,
        gasConfig,
      })
      .result()
  }

  /**
   * Creates a log trigger for CollateralReturned events.
   * The returned trigger's adapt method decodes the raw log into CollateralReturnedDecoded,
   * so the handler receives typed event data directly.
   * When multiple filters are provided, topic values are merged with OR semantics (match any).
   */
  logTriggerCollateralReturned(
    filters?: CollateralReturnedTopics[],
  ) {
    let topics: { values: string[] }[]
    if (!filters || filters.length === 0) {
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'CollateralReturned' as const,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else if (filters.length === 1) {
      const f = filters[0]
      const args = {
        seriesId: f.seriesId,
      }
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'CollateralReturned' as const,
        args,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else {
      const allEncoded = filters.map((f) => {
        const args = {
          seriesId: f.seriesId,
        }
        return encodeEventTopics({
          abi: AquaOptionSettlementABI,
          eventName: 'CollateralReturned' as const,
          args,
        })
      })
      topics = allEncoded[0].map((_, i) => ({
        values: [...new Set(allEncoded.flatMap((row) => encodeTopicValue(row[i])))],
      }))
    }
    const baseTrigger = this.client.logTrigger({
      addresses: [hexToBase64(this.address)],
      topics,
    })
    const contract = this
    return {
      capabilityId: () => baseTrigger.capabilityId(),
      method: () => baseTrigger.method(),
      outputSchema: () => baseTrigger.outputSchema(),
      configAsAny: () => baseTrigger.configAsAny(),
      adapt: (rawOutput: EVMLog): DecodedLog<CollateralReturnedDecoded> => contract.decodeCollateralReturned(rawOutput),
    }
  }

  /**
   * Decodes a log into CollateralReturned data, preserving all log metadata.
   */
  decodeCollateralReturned(log: EVMLog): DecodedLog<CollateralReturnedDecoded> {
    const decoded = decodeEventLog({
      abi: AquaOptionSettlementABI,
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    })
    const { data: _, ...rest } = log
    return { ...rest, data: decoded.args as unknown as CollateralReturnedDecoded }
  }

  /**
   * Creates a log trigger for HolderPaid events.
   * The returned trigger's adapt method decodes the raw log into HolderPaidDecoded,
   * so the handler receives typed event data directly.
   * When multiple filters are provided, topic values are merged with OR semantics (match any).
   */
  logTriggerHolderPaid(
    filters?: HolderPaidTopics[],
  ) {
    let topics: { values: string[] }[]
    if (!filters || filters.length === 0) {
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'HolderPaid' as const,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else if (filters.length === 1) {
      const f = filters[0]
      const args = {
        seriesId: f.seriesId,
      }
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'HolderPaid' as const,
        args,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else {
      const allEncoded = filters.map((f) => {
        const args = {
          seriesId: f.seriesId,
        }
        return encodeEventTopics({
          abi: AquaOptionSettlementABI,
          eventName: 'HolderPaid' as const,
          args,
        })
      })
      topics = allEncoded[0].map((_, i) => ({
        values: [...new Set(allEncoded.flatMap((row) => encodeTopicValue(row[i])))],
      }))
    }
    const baseTrigger = this.client.logTrigger({
      addresses: [hexToBase64(this.address)],
      topics,
    })
    const contract = this
    return {
      capabilityId: () => baseTrigger.capabilityId(),
      method: () => baseTrigger.method(),
      outputSchema: () => baseTrigger.outputSchema(),
      configAsAny: () => baseTrigger.configAsAny(),
      adapt: (rawOutput: EVMLog): DecodedLog<HolderPaidDecoded> => contract.decodeHolderPaid(rawOutput),
    }
  }

  /**
   * Decodes a log into HolderPaid data, preserving all log metadata.
   */
  decodeHolderPaid(log: EVMLog): DecodedLog<HolderPaidDecoded> {
    const decoded = decodeEventLog({
      abi: AquaOptionSettlementABI,
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    })
    const { data: _, ...rest } = log
    return { ...rest, data: decoded.args as unknown as HolderPaidDecoded }
  }

  /**
   * Creates a log trigger for OwnershipTransferred events.
   * The returned trigger's adapt method decodes the raw log into OwnershipTransferredDecoded,
   * so the handler receives typed event data directly.
   * When multiple filters are provided, topic values are merged with OR semantics (match any).
   */
  logTriggerOwnershipTransferred(
    filters?: OwnershipTransferredTopics[],
  ) {
    let topics: { values: string[] }[]
    if (!filters || filters.length === 0) {
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'OwnershipTransferred' as const,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else if (filters.length === 1) {
      const f = filters[0]
      const args = {
        previousOwner: f.previousOwner,
        newOwner: f.newOwner,
      }
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'OwnershipTransferred' as const,
        args,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else {
      const allEncoded = filters.map((f) => {
        const args = {
          previousOwner: f.previousOwner,
          newOwner: f.newOwner,
        }
        return encodeEventTopics({
          abi: AquaOptionSettlementABI,
          eventName: 'OwnershipTransferred' as const,
          args,
        })
      })
      topics = allEncoded[0].map((_, i) => ({
        values: [...new Set(allEncoded.flatMap((row) => encodeTopicValue(row[i])))],
      }))
    }
    const baseTrigger = this.client.logTrigger({
      addresses: [hexToBase64(this.address)],
      topics,
    })
    const contract = this
    return {
      capabilityId: () => baseTrigger.capabilityId(),
      method: () => baseTrigger.method(),
      outputSchema: () => baseTrigger.outputSchema(),
      configAsAny: () => baseTrigger.configAsAny(),
      adapt: (rawOutput: EVMLog): DecodedLog<OwnershipTransferredDecoded> => contract.decodeOwnershipTransferred(rawOutput),
    }
  }

  /**
   * Decodes a log into OwnershipTransferred data, preserving all log metadata.
   */
  decodeOwnershipTransferred(log: EVMLog): DecodedLog<OwnershipTransferredDecoded> {
    const decoded = decodeEventLog({
      abi: AquaOptionSettlementABI,
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    })
    const { data: _, ...rest } = log
    return { ...rest, data: decoded.args as unknown as OwnershipTransferredDecoded }
  }

  /**
   * Creates a log trigger for SeriesRegistered events.
   * The returned trigger's adapt method decodes the raw log into SeriesRegisteredDecoded,
   * so the handler receives typed event data directly.
   * When multiple filters are provided, topic values are merged with OR semantics (match any).
   */
  logTriggerSeriesRegistered(
    filters?: SeriesRegisteredTopics[],
  ) {
    let topics: { values: string[] }[]
    if (!filters || filters.length === 0) {
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'SeriesRegistered' as const,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else if (filters.length === 1) {
      const f = filters[0]
      const args = {
        seriesId: f.seriesId,
      }
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'SeriesRegistered' as const,
        args,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else {
      const allEncoded = filters.map((f) => {
        const args = {
          seriesId: f.seriesId,
        }
        return encodeEventTopics({
          abi: AquaOptionSettlementABI,
          eventName: 'SeriesRegistered' as const,
          args,
        })
      })
      topics = allEncoded[0].map((_, i) => ({
        values: [...new Set(allEncoded.flatMap((row) => encodeTopicValue(row[i])))],
      }))
    }
    const baseTrigger = this.client.logTrigger({
      addresses: [hexToBase64(this.address)],
      topics,
    })
    const contract = this
    return {
      capabilityId: () => baseTrigger.capabilityId(),
      method: () => baseTrigger.method(),
      outputSchema: () => baseTrigger.outputSchema(),
      configAsAny: () => baseTrigger.configAsAny(),
      adapt: (rawOutput: EVMLog): DecodedLog<SeriesRegisteredDecoded> => contract.decodeSeriesRegistered(rawOutput),
    }
  }

  /**
   * Decodes a log into SeriesRegistered data, preserving all log metadata.
   */
  decodeSeriesRegistered(log: EVMLog): DecodedLog<SeriesRegisteredDecoded> {
    const decoded = decodeEventLog({
      abi: AquaOptionSettlementABI,
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    })
    const { data: _, ...rest } = log
    return { ...rest, data: decoded.args as unknown as SeriesRegisteredDecoded }
  }

  /**
   * Creates a log trigger for SeriesSettled events.
   * The returned trigger's adapt method decodes the raw log into SeriesSettledDecoded,
   * so the handler receives typed event data directly.
   * When multiple filters are provided, topic values are merged with OR semantics (match any).
   */
  logTriggerSeriesSettled(
    filters?: SeriesSettledTopics[],
  ) {
    let topics: { values: string[] }[]
    if (!filters || filters.length === 0) {
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'SeriesSettled' as const,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else if (filters.length === 1) {
      const f = filters[0]
      const args = {
        seriesId: f.seriesId,
      }
      const encoded = encodeEventTopics({
        abi: AquaOptionSettlementABI,
        eventName: 'SeriesSettled' as const,
        args,
      })
      topics = encoded.map((t) => ({ values: encodeTopicValue(t) }))
    } else {
      const allEncoded = filters.map((f) => {
        const args = {
          seriesId: f.seriesId,
        }
        return encodeEventTopics({
          abi: AquaOptionSettlementABI,
          eventName: 'SeriesSettled' as const,
          args,
        })
      })
      topics = allEncoded[0].map((_, i) => ({
        values: [...new Set(allEncoded.flatMap((row) => encodeTopicValue(row[i])))],
      }))
    }
    const baseTrigger = this.client.logTrigger({
      addresses: [hexToBase64(this.address)],
      topics,
    })
    const contract = this
    return {
      capabilityId: () => baseTrigger.capabilityId(),
      method: () => baseTrigger.method(),
      outputSchema: () => baseTrigger.outputSchema(),
      configAsAny: () => baseTrigger.configAsAny(),
      adapt: (rawOutput: EVMLog): DecodedLog<SeriesSettledDecoded> => contract.decodeSeriesSettled(rawOutput),
    }
  }

  /**
   * Decodes a log into SeriesSettled data, preserving all log metadata.
   */
  decodeSeriesSettled(log: EVMLog): DecodedLog<SeriesSettledDecoded> {
    const decoded = decodeEventLog({
      abi: AquaOptionSettlementABI,
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    })
    const { data: _, ...rest } = log
    return { ...rest, data: decoded.args as unknown as SeriesSettledDecoded }
  }
}

