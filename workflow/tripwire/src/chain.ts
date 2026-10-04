import {
	EVMClient,
	LAST_FINALIZED_BLOCK_NUMBER,
	type Runtime,
	TxStatus,
	bytesToHex,
	encodeCallMsg,
	getNetwork,
	prepareReportRequest,
} from '@chainlink/cre-sdk'
import { type Hex, zeroAddress } from 'viem'

/** `ReceiverContractExecutionStatus.REVERTED` (not re-exported by the SDK). */
const RECEIVER_EXECUTION_REVERTED = 1

const clients = new Map<string, EVMClient>()

export const selectorOf = (chainSelectorName: string): bigint => {
	const network = getNetwork({ chainFamily: 'evm', chainSelectorName })
	if (!network) throw new Error(`Unsupported chain: ${chainSelectorName}`)
	return network.chainSelector.selector
}

export const clientFor = (chainSelectorName: string): EVMClient => {
	let client = clients.get(chainSelectorName)
	if (!client) {
		client = new EVMClient(selectorOf(chainSelectorName))
		clients.set(chainSelectorName, client)
	}
	return client
}

/** eth_call at the finalized head, so every DON node reads the same state. */
export const call = (runtime: Runtime<unknown>, chain: string, to: Hex, data: Hex): Hex => {
	const reply = clientFor(chain)
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to, data }),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()
	return bytesToHex(reply.data)
}

/**
 * Signs `payload` with the DON and delivers it to `receiver` through the Chainlink Forwarder.
 * The Forwarder does not revert when the receiver does, so the receiver status is checked explicitly.
 */
export const writeReport = (runtime: Runtime<unknown>, chain: string, receiver: Hex, payload: Hex, gasLimit: string): Hex => {
	const report = runtime.report(prepareReportRequest(payload)).result()
	const reply = clientFor(chain).writeReport(runtime, { receiver, report, gasConfig: { gasLimit } }).result()
	if (reply.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`report to ${receiver} on ${chain} failed: ${reply.errorMessage ?? `txStatus ${reply.txStatus}`}`)
	}
	if ((reply.receiverContractExecutionStatus as number | undefined) === RECEIVER_EXECUTION_REVERTED) {
		throw new Error(`receiver ${receiver} on ${chain} reverted: ${reply.errorMessage ?? 'no reason'}`)
	}
	return bytesToHex(reply.txHash ?? new Uint8Array(32))
}
