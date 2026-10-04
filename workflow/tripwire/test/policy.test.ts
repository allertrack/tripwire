import { describe, expect, test } from 'bun:test'
import { Level, Reason, reasonNames } from '../src/codes'
import { configSchema } from '../src/config'
import { type GuardView, type Observation, assess, decideWrite, ladderLevel, packMetrics, unpackMetrics } from '../src/policy'
import { EXCHANGES, median, parseDecimal, rescale } from '../src/prices'
import { E6, ETH, NOW, config, healthyMarket, thresholds } from './fixtures'

const obs = (overrides: Partial<Observation> = {}): Observation => ({
	observedAt: NOW,
	market: healthyMarket(),
	references: { chainlink: ETH, exchanges: ETH },
	maxSpreadBps: 150,
	...overrides,
})

const pct = (p: bigint, num: bigint) => (p * num) / 100n

describe('prices', () => {
	test('parseDecimal is exact and never uses floats', () => {
		expect(parseDecimal('2696.115')).toBe(269_611_500_000n)
		expect(parseDecimal('2696')).toBe(269_600_000_000n)
		expect(parseDecimal('0.000000019')).toBe(1n) // truncates past 8 decimals
		expect(parseDecimal('123456789012.12345678')).toBe(12_345_678_901_212_345_678n)
	})

	test('parseDecimal rejects garbage, negatives and zero', () => {
		for (const bad of ['', 'abc', '-1', '1e3', '0', '0.00', '1,5', undefined, null, {}]) {
			expect(() => parseDecimal(bad as never)).toThrow()
		}
	})

	test('median and rescale', () => {
		expect(median([3n, 1n, 2n])).toBe(2n)
		expect(median([4n, 1n, 3n, 2n])).toBe(2n) // (2+3)/2 truncated
		expect(() => median([])).toThrow()
		expect(rescale(1n, 0, 8)).toBe(100_000_000n)
		expect(rescale(2_700n * 10n ** 18n, 18, 8)).toBe(270_000_000_000n)
	})

	test('exchange parsers read the real response shapes', () => {
		expect(EXCHANGES.coinbase.parse({ data: { amount: '2696.115', base: 'ETH', currency: 'USD' } }, 'ETH')).toBe(269_611_500_000n)
		expect(EXCHANGES.kraken.parse({ error: [], result: { XETHZUSD: { c: ['2696.38000', '0.0037'] } } }, 'ETH')).toBe(
			269_638_000_000n,
		)
		expect(EXCHANGES.bitstamp.parse({ last: '2696.01' }, 'ETH')).toBe(269_601_000_000n)
		expect(() => EXCHANGES.kraken.parse({ error: ['EQuery:Unknown asset pair'], result: {} }, 'ETH')).toThrow()
		expect(EXCHANGES.bitstamp.url('ETH')).toBe('https://www.bitstamp.net/api/v2/ticker/ethusd/')
	})
})

describe('risk model', () => {
	test('a healthy market is Normal with no reasons', () => {
		const a = assess(obs(), thresholds)
		expect(a.level).toBe(Level.Normal)
		expect(a.reasons).toBe(0)
		expect(a.metrics.utilizationBps).toBe(2_000n)
		expect(a.metrics.sources).toBe(3)
	})

	test('ladder steps', () => {
		const ladder = [200, 500, 1_000] as const
		expect(ladderLevel(199n, ladder)).toBe(Level.Normal)
		expect(ladderLevel(200n, ladder)).toBe(Level.Caution)
		expect(ladderLevel(500n, ladder)).toBe(Level.Restricted)
		expect(ladderLevel(1_000n, ladder)).toBe(Level.Frozen)
	})

	test.each([
		[101n, Level.Normal],
		[103n, Level.Caution],
		[106n, Level.Restricted],
		[130n, Level.Frozen],
		[70n, Level.Frozen],
	])('market oracle at %d%% of the references -> level %d', (percent, expected) => {
		const a = assess(obs({ market: healthyMarket({ price: pct(ETH, percent) }) }), thresholds)
		expect(a.level).toBe(expected)
		if (expected !== Level.Normal) expect(a.reasons).toBe(Reason.ORACLE_DEVIATION)
	})

	test('deviation is measured against the closest reference, so one bad reference cannot trip a healthy market', () => {
		const a = assess(obs({ references: { chainlink: ETH, exchanges: pct(ETH, 120n) } }), thresholds)
		expect(a.metrics.deviationBps).toBe(0n)
		expect(a.metrics.referencePrice).toBe(ETH)
		// ...but the references disagreeing with each other is itself a (milder) signal.
		expect(a.level).toBe(Level.Caution)
		expect(a.reasons).toBe(Reason.REFERENCE_DIVERGENCE)
		expect(a.metrics.spreadBps).toBe(2_000n)
	})

	test('normalises market oracle decimals', () => {
		const a = assess(obs({ market: healthyMarket({ price: 2_700n * 10n ** 18n, priceDecimals: 18 }) }), thresholds)
		expect(a.level).toBe(Level.Normal)
		expect(a.metrics.marketPrice).toBe(ETH)
	})

	test('a non-positive market price freezes', () => {
		for (const price of [0n, -1n]) {
			const a = assess(obs({ market: healthyMarket({ price }) }), thresholds)
			expect(a.level).toBe(Level.Frozen)
			expect(a.reasons).toBe(Reason.ORACLE_DEVIATION)
		}
	})

	test('no reference at all -> referenceUnavailableLevel, never a silent pass', () => {
		const a = assess(obs({ references: {} }), thresholds)
		expect(a.level).toBe(Level.Caution)
		expect(a.reasons).toBe(Reason.REFERENCE_UNAVAILABLE)
		expect(a.metrics.sources).toBe(0)
	})

	test('a single reference is enough to judge the market', () => {
		const a = assess(obs({ references: { exchanges: ETH }, market: healthyMarket({ price: pct(ETH, 112n) }) }), thresholds)
		expect(a.level).toBe(Level.Frozen)
		expect(a.metrics.sources).toBe(2)
	})

	test('Perpl oracle is a third reference; spread is measured across all references', () => {
		const a = assess(obs({ references: { chainlink: ETH, exchanges: ETH, perpl: { oracle: pct(ETH, 102n), mark: pct(ETH, 102n) } } }), thresholds)
		expect(a.metrics.sources).toBe(7)
		expect(a.metrics.spreadBps).toBe(200n)
		expect(a.reasons).toBe(Reason.REFERENCE_DIVERGENCE)
	})

	test('Perpl alone can judge the market when the others are down', () => {
		const a = assess(obs({ references: { perpl: { oracle: ETH, mark: ETH } }, market: healthyMarket({ price: pct(ETH, 107n) }) }), thresholds)
		expect(a.level).toBe(Level.Restricted)
		expect(a.metrics.sources).toBe(4)
	})

	test.each([
		[100_14n, Level.Normal],
		[101_50n, Level.Caution],
		[104_00n, Level.Restricted],
		[110_00n, Level.Frozen],
	])('perp mark at %d/10000 of its oracle -> level %d', (ratio, expected) => {
		const a = assess(obs({ references: { chainlink: ETH, perpl: { oracle: ETH, mark: (ETH * ratio) / 10_000n } } }), thresholds)
		expect(a.level).toBe(expected)
		if (expected !== Level.Normal) expect(a.reasons).toBe(Reason.PERP_DISLOCATION)
	})

	test('perp dislocation is only a signal when the market configures a ladder for it', () => {
		const { perpDislocationBps: _, ...noLadder } = thresholds
		const a = assess(obs({ references: { chainlink: ETH, perpl: { oracle: ETH, mark: pct(ETH, 120n) } } }), noLadder)
		expect(a.level).toBe(Level.Normal)
		expect(a.metrics.perpDislocationBps).toBe(2_000n)
	})

	test('stale market oracle', () => {
		const a = assess(obs({ market: healthyMarket({ priceUpdatedAt: NOW - 3_601n }) }), thresholds)
		expect(a.level).toBe(Level.Restricted)
		expect(a.reasons).toBe(Reason.ORACLE_STALE)
		expect(a.metrics.oracleAgeSeconds).toBe(3_601n)
	})

	test('utilization ladder', () => {
		const at = (borrowed: bigint) =>
			assess(obs({ market: healthyMarket({ totalBorrowed: borrowed * E6 }) }), thresholds)
		expect(at(449_000n).level).toBe(Level.Normal)
		expect(at(450_000n).level).toBe(Level.Caution)
		expect(at(490_000n).level).toBe(Level.Restricted)
		expect(at(500_000n).reasons).toBe(Reason.UTILIZATION)
	})

	test('outflow velocity ladder (relative to supply before the outflow)', () => {
		const at = (out: bigint) =>
			assess(obs({ market: healthyMarket({ totalSupplied: 1_000_000n * E6 - out * E6, windowOutflow: out * E6, totalBorrowed: 0n }) }), thresholds)
		expect(at(99_000n).level).toBe(Level.Normal)
		expect(at(100_000n).level).toBe(Level.Caution)
		expect(at(250_000n).level).toBe(Level.Restricted)
		expect(at(500_000n).level).toBe(Level.Frozen)
		expect(at(500_000n).reasons).toBe(Reason.OUTFLOW_VELOCITY)
	})

	test('the report carries the worst level and every reason that reached Caution', () => {
		const a = assess(
			obs({
				market: healthyMarket({ price: pct(ETH, 106n), totalBorrowed: 460_000n * E6, priceUpdatedAt: NOW - 7_200n }),
			}),
			thresholds,
		)
		expect(a.level).toBe(Level.Restricted)
		expect(reasonNames(a.reasons).sort()).toEqual(['ORACLE_DEVIATION', 'ORACLE_STALE', 'UTILIZATION'])
	})

	test('evidence hash commits to the inputs', () => {
		const a = assess(obs(), thresholds)
		expect(assess(obs(), thresholds).evidenceHash).toBe(a.evidenceHash)
		expect(assess(obs({ observedAt: NOW + 1n }), thresholds).evidenceHash).not.toBe(a.evidenceHash)
		expect(assess(obs({ references: { chainlink: ETH } }), thresholds).evidenceHash).not.toBe(a.evidenceHash)
	})

	test('metrics pack into one uint256 and round-trip', () => {
		const a = assess(obs({ market: healthyMarket({ price: pct(ETH, 104n), windowOutflow: 12_345n * E6 }) }), thresholds)
		const packed = packMetrics(a.metrics)
		expect(packed < 1n << 256n).toBe(true)
		expect(unpackMetrics(packed)).toEqual(a.metrics)
	})
})

describe('write decision', () => {
	const guard = (g: Partial<GuardView> = {}): GuardView => ({
		level: Level.Normal,
		lastObservedAt: NOW - 30n,
		lastReportedLevel: Level.Normal,
		lastReportedReasons: 0,
		relaxPending: false,
		relaxReadyAt: 0n,
		...g,
	})
	const normal = assess(obs(), thresholds)
	const frozen = assess(obs({ market: healthyMarket({ price: pct(ETH, 130n) }) }), thresholds)

	test('trips immediately on a stricter level', () => {
		expect(decideWrite(frozen, guard(), NOW, 300)).toBe('trip')
	})
	test('skips an unchanged view inside the refresh interval', () => {
		expect(decideWrite(normal, guard(), NOW, 300)).toBe('skip')
	})
	test('sends a heartbeat once the refresh interval elapsed', () => {
		expect(decideWrite(normal, guard({ lastObservedAt: NOW - 300n }), NOW, 300)).toBe('heartbeat')
	})
	test('reports recovery (evidence for a governance relax) even though the guard stays tight', () => {
		expect(decideWrite(normal, guard({ level: Level.Frozen, lastReportedLevel: Level.Frozen }), NOW, 300)).toBe('change')
	})
	test('reports new reasons at the same level', () => {
		const g = guard({ level: Level.Frozen, lastReportedLevel: Level.Frozen, lastReportedReasons: Reason.UTILIZATION })
		expect(decideWrite(frozen, g, NOW, 300)).toBe('change')
	})
	test('sends fresh evidence as soon as a relax proposal matures', () => {
		const pending = guard({ level: Level.Frozen, relaxPending: true, relaxReadyAt: NOW - 5n, lastObservedAt: NOW - 30n })
		expect(decideWrite(normal, pending, NOW, 300)).toBe('evidence')
		// Not before maturity, and only once.
		expect(decideWrite(normal, { ...pending, relaxReadyAt: NOW + 5n }, NOW, 300)).toBe('skip')
		expect(decideWrite(normal, { ...pending, lastObservedAt: NOW - 2n }, NOW, 300)).toBe('skip')
	})
	test('never sends an observation the guard would reject as out of order', () => {
		expect(decideWrite(frozen, guard({ lastObservedAt: NOW }), NOW, 300)).toBe('skip')
	})
})

describe('config', () => {
	test('rejects decreasing ladders', () => {
		const c = config()
		const bad = structuredClone(c)
		bad.markets[0].thresholds.deviationBps = [500, 200, 1_000]
		expect(configSchema.safeParse(bad).success).toBe(false)
	})
	test('rejects more markets than the read budget allows', () => {
		const c = config()
		const bad = { ...c, markets: Array.from({ length: 8 }, () => c.markets[0]) }
		expect(configSchema.safeParse(bad).success).toBe(false)
	})
	test('rejects malformed addresses', () => {
		const c = structuredClone(config())
		c.markets[0].guard = '0x1234'
		expect(configSchema.safeParse(c).success).toBe(false)
	})
	test('shipped configs are valid', async () => {
		for (const file of ['../config.staging.json', '../config.testnet.json']) {
			const json = await Bun.file(new URL(file, import.meta.url)).json()
			expect(configSchema.safeParse(json).success).toBe(true)
		}
	})
})
