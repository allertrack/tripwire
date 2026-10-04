import { bytesToHex, hexToBytes } from '@chainlink/cre-sdk'
import { EvmMock, HttpActionsMock, REPORT_METADATA_HEADER_LENGTH } from '@chainlink/cre-sdk/test'
import { type Hex, decodeFunctionData, encodeFunctionResult, pad, toHex } from 'viem'
import { aggregatorV3Abi, guardAbi, marketAbi } from '../src/abi'
import { Level } from '../src/codes'
import type { MarketSnapshot } from '../src/policy'

const b64 = (hex: Hex) => Buffer.from(hexToBytes(hex)).toString('base64')
const readAbi = [...guardAbi, ...marketAbi, ...aggregatorV3Abi]

export type GuardState = {
	level?: Level
	lastObservedAt?: bigint
	lastReportedLevel?: Level
	lastReportedReasons?: number
	relaxPending?: boolean
	relaxReadyAt?: bigint
}

export type ChainState = {
	/** riskSnapshot() per market address (lowercase). */
	markets?: Record<string, MarketSnapshot>
	/** status() per guard address (lowercase). */
	guards?: Record<string, GuardState>
	/** latestRoundData() per feed address (lowercase); `throws` simulates an unreadable feed. */
	feeds?: Record<string, { answer: bigint; updatedAt: bigint } | 'throws'>
	/** Receivers whose onReport reverts (the Forwarder still succeeds). */
	revertingReceivers?: string[]
}

export type Write = { receiver: Hex; payload: Hex; gasLimit?: string }

/** Installs EVM capability mocks for one chain and records every report written. */
export const wireChain = (selector: bigint, state: ChainState) => {
	const mock = EvmMock.testInstance(selector)
	const writes: Write[] = []
	const reads: string[] = []

	mock.callContract = ((input: { call?: { to: Uint8Array; data: Uint8Array } }) => {
		const to = bytesToHex(input.call!.to).toLowerCase()
		const { functionName } = decodeFunctionData({ abi: readAbi, data: bytesToHex(input.call!.data) })
		reads.push(`${functionName}@${to}`)
		let data: Hex
		switch (functionName) {
			case 'riskSnapshot': {
				const m = state.markets?.[to]
				if (!m) throw new Error(`no market at ${to}`)
				data = encodeFunctionResult({ abi: marketAbi, functionName: 'riskSnapshot', result: m })
				break
			}
			case 'status': {
				const g = state.guards?.[to] ?? {}
				data = encodeFunctionResult({
					abi: guardAbi,
					functionName: 'status',
					result: {
						level: g.level ?? Level.Normal,
						effectiveLevel: g.level ?? Level.Normal,
						stale: false,
						reasons: 0,
						epoch: 0,
						lastObservedAt: Number(g.lastObservedAt ?? 0n),
						heartbeat: 600,
						staleLevel: Level.Caution,
						lastReportedLevel: g.lastReportedLevel ?? Level.Normal,
						lastReportedReasons: g.lastReportedReasons ?? 0,
						permissions: 0n,
						relaxPending: g.relaxPending ?? false,
						relaxTarget: 0,
						relaxReadyAt: Number(g.relaxReadyAt ?? 0n),
						trippedAt: 0,
					},
				})
				break
			}
			case 'latestRoundData': {
				const f = state.feeds?.[to]
				if (!f || f === 'throws') throw new Error(`feed ${to} unreadable`)
				data = encodeFunctionResult({
					abi: aggregatorV3Abi,
					functionName: 'latestRoundData',
					result: [1n, f.answer, f.updatedAt, f.updatedAt, 1n],
				})
				break
			}
			default:
				throw new Error(`unexpected call ${functionName}`)
		}
		return { data: b64(data) }
	}) as never

	mock.writeReport = ((input: { receiver: Uint8Array; report?: { rawReport: Uint8Array }; gasConfig?: { gasLimit?: string } }) => {
		const receiver = bytesToHex(input.receiver).toLowerCase() as Hex
		writes.push({
			receiver,
			payload: bytesToHex(input.report!.rawReport.subarray(REPORT_METADATA_HEADER_LENGTH)),
			gasLimit: input.gasConfig?.gasLimit?.toString(),
		})
		return {
			txStatus: 'TX_STATUS_SUCCESS',
			receiverContractExecutionStatus: state.revertingReceivers?.includes(receiver)
				? 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED'
				: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS',
			txHash: b64(pad(toHex(writes.length))),
		}
	}) as never

	return { writes, reads }
}

/** Serves exchange responses by URL substring; unknown URLs answer 503. */
export const wireExchanges = (responses: Record<string, { status?: number; body: unknown } | 'throws'>) => {
	const mock = HttpActionsMock.testInstance()
	const requests: string[] = []
	mock.sendRequest = ((input: { url: string }) => {
		requests.push(input.url)
		const key = Object.keys(responses).find((k) => input.url.includes(k))
		const r = key ? responses[key] : undefined
		if (r === 'throws') throw new Error('connection reset')
		if (!r) return { statusCode: 503, body: Buffer.from('unavailable').toString('base64') }
		return { statusCode: r.status ?? 200, body: Buffer.from(JSON.stringify(r.body)).toString('base64') }
	}) as never
	return { requests }
}

/** Real response shapes (captured from the public APIs), parameterised by price. */
export const exchangeBodies = (coinbase: string, kraken: string, bitstamp: string) => ({
	'api.coinbase.com': { body: { data: { amount: coinbase, base: 'ETH', currency: 'USD' } } },
	'api.kraken.com': {
		body: { error: [], result: { XETHZUSD: { a: ['0', '1', '1.000'], b: ['0', '5', '5.000'], c: [kraken, '0.003'] } } },
	},
	'www.bitstamp.net': { body: { timestamp: '1791119534', last: bitstamp, bid: '0', ask: '0' } },
})
