import { HTTPClient, type NodeRuntime, type Runtime, consensusMedianAggregation } from '@chainlink/cre-sdk'
import { type Hex, decodeFunctionResult, encodeFunctionData } from 'viem'
import { aggregatorV3Abi, guardAbi, marketAbi, perplExchangeAbi } from './abi'
import { call } from './chain'
import type { Config, Market } from './config'
import type { GuardView, MarketSnapshot, References } from './policy'
import { EXCHANGES, PRICE_DECIMALS, median, rescale } from './prices'

export const readMarket = (runtime: Runtime<Config>, market: Market): MarketSnapshot => {
	const data = call(
		runtime,
		market.chainSelectorName,
		market.market as Hex,
		encodeFunctionData({ abi: marketAbi, functionName: 'riskSnapshot' }),
	)
	const s = decodeFunctionResult({ abi: marketAbi, functionName: 'riskSnapshot', data })
	return { ...s, windowSeconds: Number(s.windowSeconds) }
}

export const readGuard = (runtime: Runtime<Config>, market: Market): GuardView => {
	const data = call(
		runtime,
		market.chainSelectorName,
		market.guard as Hex,
		encodeFunctionData({ abi: guardAbi, functionName: 'status' }),
	)
	const s = decodeFunctionResult({ abi: guardAbi, functionName: 'status', data })
	return {
		level: s.level,
		lastObservedAt: BigInt(s.lastObservedAt),
		lastReportedLevel: s.lastReportedLevel,
		lastReportedReasons: s.lastReportedReasons,
		relaxPending: s.relaxPending,
		relaxReadyAt: BigInt(s.relaxReadyAt),
	}
}

/** Chainlink Data Feed answer as 8-decimal USD, or undefined if unreadable, non-positive or older than allowed. */
export const readChainlink = (runtime: Runtime<Config>, observedAt: bigint): bigint | undefined => {
	const feed = runtime.config.reference.chainlinkFeed
	if (!feed) return undefined
	try {
		const data = call(
			runtime,
			feed.chainSelectorName,
			feed.address as Hex,
			encodeFunctionData({ abi: aggregatorV3Abi, functionName: 'latestRoundData' }),
		)
		const [, answer, , updatedAt] = decodeFunctionResult({ abi: aggregatorV3Abi, functionName: 'latestRoundData', data })
		if (answer <= 0n) return undefined
		if (observedAt > updatedAt && observedAt - updatedAt > BigInt(feed.maxAgeSeconds)) {
			runtime.log(`chainlink feed stale: updated ${observedAt - updatedAt}s ago`)
			return undefined
		}
		return rescale(answer, feed.decimals, PRICE_DECIMALS)
	} catch (error) {
		runtime.log(`chainlink feed unreadable: ${(error as Error).message}`)
		return undefined
	}
}

/**
 * Perpl perpetual on Monad: oracle price (Chainlink Data Streams, verified on-chain by the exchange) and the order
 * book's mark price, as 8-decimal USD. Undefined if unreadable, stale, or the market ignores its oracle.
 */
export const readPerpl = (runtime: Runtime<Config>, observedAt: bigint): References['perpl'] => {
	const perpl = runtime.config.reference.perpl
	if (!perpl) return undefined
	try {
		const data = call(
			runtime,
			perpl.chainSelectorName,
			perpl.exchange as Hex,
			encodeFunctionData({ abi: perplExchangeAbi, functionName: 'getPerpetualInfoV2', args: [BigInt(perpl.perpId)] }),
		)
		const p = decodeFunctionResult({ abi: perplExchangeAbi, functionName: 'getPerpetualInfoV2', data })
		const maxAge = BigInt(perpl.maxAgeSeconds)
		const age = (t: bigint) => (observedAt > t ? observedAt - t : 0n)
		if (p.ignOracle || p.oraclePNS === 0n || p.markPNS === 0n) return undefined
		if (age(p.oracleTimestampSec) > maxAge || age(p.markTimestamp) > maxAge) {
			runtime.log(`perpl ${p.symbol} stale: oracle ${age(p.oracleTimestampSec)}s, mark ${age(p.markTimestamp)}s`)
			return undefined
		}
		const decimals = Number(p.priceDecimals)
		return { oracle: rescale(p.oraclePNS, decimals, PRICE_DECIMALS), mark: rescale(p.markPNS, decimals, PRICE_DECIMALS) }
	} catch (error) {
		runtime.log(`perpl unreadable: ${(error as Error).message}`)
		return undefined
	}
}

/**
 * Runs on every DON node: the median of the exchanges that answered (at least `minExchanges` of them).
 * Throwing reports a node-level failure to consensus instead of a bogus number.
 */
export const fetchExchangeMedian = (nodeRuntime: NodeRuntime<Config>): bigint => {
	const { symbol, exchanges, minExchanges } = nodeRuntime.config.reference
	const http = new HTTPClient()
	const prices: bigint[] = []
	for (const name of exchanges) {
		const api = EXCHANGES[name]
		try {
			const resp = http.sendRequest(nodeRuntime, { url: api.url(symbol), method: 'GET', timeout: '5s' }).result()
			if (resp.statusCode !== 200) continue
			prices.push(api.parse(JSON.parse(new TextDecoder().decode(resp.body)), symbol))
		} catch {
			// One exchange down is expected; the threshold below decides.
		}
	}
	if (prices.length < minExchanges) throw new Error(`only ${prices.length}/${exchanges.length} exchanges answered`)
	return median(prices)
}

/** DON-wide median of the per-node exchange medians, or undefined if consensus could not be reached. */
export const readExchanges = (runtime: Runtime<Config>): bigint | undefined => {
	try {
		return runtime.runInNodeMode(fetchExchangeMedian, consensusMedianAggregation<bigint>())().result()
	} catch (error) {
		runtime.log(`exchange reference unavailable: ${(error as Error).message}`)
		return undefined
	}
}
