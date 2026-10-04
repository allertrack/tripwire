import type { Exchange } from './config'

/** Every price in the workflow is a USD price with 8 decimals, like Chainlink USD feeds. */
export const PRICE_DECIMALS = 8

/** Parses a decimal string ("2696.115") into a fixed-point bigint without going through floats. */
export const parseDecimal = (value: unknown, decimals = PRICE_DECIMALS): bigint => {
	if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`not a decimal: ${String(value)}`)
	const text = String(value).trim()
	const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
	if (!match) throw new Error(`not a decimal: ${text}`)
	const fraction = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0')
	const result = BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction || '0')
	if (result === 0n) throw new Error('zero price')
	return result
}

/** Rescales a fixed-point integer between decimal precisions (truncating). */
export const rescale = (value: bigint, from: number, to: number): bigint =>
	to >= from ? value * 10n ** BigInt(to - from) : value / 10n ** BigInt(from - to)

export const median = (values: bigint[]): bigint => {
	if (values.length === 0) throw new Error('median of nothing')
	const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	const mid = sorted.length >> 1
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n
}

type ExchangeApi = { url: (symbol: string) => string; parse: (body: unknown, symbol: string) => bigint }

/** Public spot-price endpoints that answer without redirects or API keys. */
export const EXCHANGES: Record<Exchange, ExchangeApi> = {
	coinbase: {
		url: (s) => `https://api.coinbase.com/v2/prices/${s}-USD/spot`,
		parse: (body) => parseDecimal((body as { data?: { amount?: string } }).data?.amount),
	},
	kraken: {
		url: (s) => `https://api.kraken.com/0/public/Ticker?pair=${s}USD`,
		parse: (body) => {
			const { error, result } = body as { error?: string[]; result?: Record<string, { c?: string[] }> }
			if (error?.length) throw new Error(`kraken: ${error.join(',')}`)
			const pairs = Object.values(result ?? {})
			if (pairs.length !== 1) throw new Error('kraken: unexpected pair count')
			return parseDecimal(pairs[0].c?.[0])
		},
	},
	bitstamp: {
		url: (s) => `https://www.bitstamp.net/api/v2/ticker/${s.toLowerCase()}usd/`,
		parse: (body) => parseDecimal((body as { last?: string }).last),
	},
}
