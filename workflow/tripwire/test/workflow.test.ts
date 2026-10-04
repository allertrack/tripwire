import { describe, expect } from 'bun:test'
import type { CronPayload } from '@chainlink/cre-sdk'
import { newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { type Hex, decodeAbiParameters } from 'viem'
import { reportParams } from '../src/abi'
import { Level, Reason } from '../src/codes'
import type { Config } from '../src/config'
import { unpackMetrics } from '../src/policy'
import { initWorkflow, onTick } from '../workflow'
import {
	ETH,
	FEED,
	GUARD,
	GUARD_2,
	MARKET,
	MARKET_2,
	MONAD_TESTNET,
	NOW,
	config,
	healthyMarket,
	market,
} from './fixtures'
import { type ChainState, exchangeBodies, wireChain, wireExchanges } from './harness'

const payload = { scheduledExecutionTime: { seconds: NOW, nanos: 0 } } as unknown as CronPayload
const lc = (a: Hex) => a.toLowerCase() as Hex

const healthyChain = (overrides: Partial<ChainState> = {}): ChainState => ({
	markets: { [lc(MARKET)]: healthyMarket() },
	guards: { [lc(GUARD)]: { lastObservedAt: NOW - 30n } },
	feeds: { [lc(FEED)]: { answer: ETH, updatedAt: NOW - 600n } },
	...overrides,
})

type Exchanges = Parameters<typeof wireExchanges>[0]

const run = (chain: ChainState, exchanges: Exchanges = exchangeBodies('2700.10', '2699.90', '2700.00'), cfg: Config = config()) => {
	const monad = wireChain(MONAD_TESTNET, chain)
	const http = wireExchanges(exchanges)
	const runtime = newTestRuntime(null, { timeProvider: () => Number(NOW) * 1000 }, cfg)
	const result = onTick(runtime, payload)
	const reports = monad.writes.map((w) => {
		const [chainSelector, target, observedAt, level, reasons, evidenceHash, metrics] = decodeAbiParameters(
			reportParams,
			w.payload,
		)
		return { receiver: w.receiver, gasLimit: w.gasLimit, chainSelector, target, observedAt, level, reasons, evidenceHash, metrics }
	})
	return { result, reports, monad, http, logs: runtime.getLogs().join('\n') }
}

describe('onTick', () => {
	test('healthy market inside the refresh interval: reads, but writes nothing', () => {
		const { result, reports, monad, http } = run(healthyChain())
		expect(result).toBe('tWETH/tUSDC:skip')
		expect(reports).toHaveLength(0)
		expect(monad.reads.sort()).toEqual([`latestRoundData@${lc(FEED)}`, `riskSnapshot@${lc(MARKET)}`, `status@${lc(GUARD)}`])
		expect(http.requests).toHaveLength(3)
	})

	test('healthy market past the refresh interval: heartbeat report', () => {
		const { result, reports } = run(healthyChain({ guards: { [lc(GUARD)]: { lastObservedAt: NOW - 300n } } }))
		expect(result).toStartWith('tWETH/tUSDC:heartbeat:Normal:0x')
		expect(reports).toHaveLength(1)
		expect(reports[0].level).toBe(Level.Normal)
		expect(reports[0].reasons).toBe(0)
	})

	test('oracle manipulation: trips the guard to Frozen with a report bound to (chain, guard)', () => {
		const { result, reports, logs } = run(healthyChain({ markets: { [lc(MARKET)]: healthyMarket({ price: (ETH * 13n) / 10n }) } }))
		expect(result).toStartWith('tWETH/tUSDC:trip:Frozen:0x')
		expect(reports).toHaveLength(1)
		const r = reports[0]
		expect(r.receiver).toBe(lc(GUARD))
		expect(r.gasLimit).toBe('400000')
		expect(r.chainSelector).toBe(MONAD_TESTNET)
		expect(lc(r.target)).toBe(lc(GUARD))
		expect(BigInt(r.observedAt)).toBe(NOW)
		expect(r.level).toBe(Level.Frozen)
		expect(r.reasons).toBe(Reason.ORACLE_DEVIATION)
		const m = unpackMetrics(r.metrics)
		expect(m.deviationBps).toBe(3_000n)
		expect(m.marketPrice).toBe((ETH * 13n) / 10n)
		expect(m.sources).toBe(3)
		expect(logs).toContain('Frozen [ORACLE_DEVIATION]')
	})

	test('the exchange reference is the median of the exchanges that answered', () => {
		// Chainlink unreadable; Coinbase down. Median of Kraken/Bitstamp = 2,710 => market at 2,700 deviates 0.37%.
		const { reports } = run(
			healthyChain({ feeds: { [lc(FEED)]: 'throws' }, guards: { [lc(GUARD)]: { lastObservedAt: NOW - 300n } } }),
			{ ...exchangeBodies('0', '2705.00', '2715.00'), 'api.coinbase.com': 'throws' },
		)
		const m = unpackMetrics(reports[0].metrics)
		expect(m.referencePrice).toBe(271_000_000_000n)
		expect(m.sources).toBe(2)
		expect(m.deviationBps).toBe(36n)
		expect(reports[0].level).toBe(Level.Normal)
	})

	test('too few exchanges answer: falls back to Chainlink alone', () => {
		const { reports } = run(healthyChain({ guards: { [lc(GUARD)]: { lastObservedAt: NOW - 300n } } }), {
			'api.kraken.com': exchangeBodies('1', '2700', '1')['api.kraken.com'],
		})
		expect(unpackMetrics(reports[0].metrics).sources).toBe(1)
		expect(reports[0].level).toBe(Level.Normal)
	})

	test('a stale Chainlink answer is not used as a reference', () => {
		const { reports } = run(
			healthyChain({ feeds: { [lc(FEED)]: { answer: ETH * 2n, updatedAt: NOW - 90_001n } }, guards: { [lc(GUARD)]: { lastObservedAt: NOW - 300n } } }),
		)
		expect(unpackMetrics(reports[0].metrics).sources).toBe(2)
		expect(reports[0].level).toBe(Level.Normal)
	})

	test('no reference at all: fails safe to Caution', () => {
		const { result, reports } = run(healthyChain({ feeds: {} }), {})
		expect(result).toStartWith('tWETH/tUSDC:trip:Caution')
		expect(reports[0].reasons).toBe(Reason.REFERENCE_UNAVAILABLE)
	})

	test('recovery is reported so governance has evidence to relax', () => {
		const { result, reports } = run(
			healthyChain({ guards: { [lc(GUARD)]: { level: Level.Frozen, lastReportedLevel: Level.Frozen, lastObservedAt: NOW - 30n } } }),
		)
		expect(result).toStartWith('tWETH/tUSDC:change:Normal')
		expect(reports[0].level).toBe(Level.Normal)
	})

	test('a reverting receiver fails the execution loudly', () => {
		expect(() =>
			run(
				healthyChain({
					markets: { [lc(MARKET)]: healthyMarket({ price: ETH * 2n }) },
					revertingReceivers: [lc(GUARD)],
				}),
			),
		).toThrow(/reverted/)
	})

	test('markets are isolated: one failing market does not stop the others from being protected', () => {
		const cfg = config({ markets: [market('broken', GUARD_2, MARKET_2), market('tWETH/tUSDC', GUARD, MARKET)] })
		const chain = healthyChain({ markets: { [lc(MARKET)]: healthyMarket({ price: ETH * 2n }) } }) // MARKET_2 unreadable
		const monad = wireChain(MONAD_TESTNET, chain)
		wireExchanges(exchangeBodies('2700', '2700', '2700'))
		const runtime = newTestRuntime(null, { timeProvider: () => Number(NOW) * 1000 }, cfg)
		expect(() => onTick(runtime, payload)).toThrow(/broken: .*ok: tWETH\/tUSDC:trip:Frozen/)
		expect(monad.writes).toHaveLength(1)
		expect(monad.writes[0].receiver).toBe(lc(GUARD))
	})

	test('uses DON time when the trigger carries no scheduled time', () => {
		const monad = wireChain(MONAD_TESTNET, healthyChain({ guards: { [lc(GUARD)]: { lastObservedAt: 0n } } }))
		wireExchanges(exchangeBodies('2700', '2700', '2700'))
		const runtime = newTestRuntime(null, { timeProvider: () => Number(NOW + 7n) * 1000 }, config())
		onTick(runtime)
		const [, , observedAt] = decodeAbiParameters(reportParams, monad.writes[0].payload)
		expect(BigInt(observedAt)).toBe(NOW + 7n)
	})
})

describe('initWorkflow', () => {
	test('registers one cron handler with the configured schedule', () => {
		const handlers = initWorkflow(config())
		expect(handlers).toHaveLength(1)
		expect((handlers[0].trigger as unknown as { config: { schedule: string } }).config.schedule).toBe('*/30 * * * * *')
	})
})
