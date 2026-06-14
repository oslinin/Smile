// Code generated — DO NOT EDIT.
import type { Address } from 'viem'
import { addContractMock, type ContractMock, type EvmMock } from '@chainlink/cre-sdk/test'

import { AquaOptionSettlementABI } from './AquaOptionSettlement'

export type AquaOptionSettlementMock = {
  creForwarder?: () => `0x${string}`
  owner?: () => `0x${string}`
  series?: (arg0: `0x${string}`) => readonly [bigint, bigint, bigint, `0x${string}`, `0x${string}`, `0x${string}`, bigint, boolean, bigint]
} & Pick<ContractMock<typeof AquaOptionSettlementABI>, 'writeReport'>

export function newAquaOptionSettlementMock(address: Address, evmMock: EvmMock): AquaOptionSettlementMock {
  return addContractMock(evmMock, { address, abi: AquaOptionSettlementABI }) as AquaOptionSettlementMock
}

