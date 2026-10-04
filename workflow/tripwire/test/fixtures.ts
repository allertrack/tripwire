import type { Hex } from 'viem'
import { Level } from '../src/codes'
import { type Config, configSchema } from '../src/config'
import type { MarketSnapshot } from '../src/policy'

export const MONAD_TESTNET = 2183018362218727504n
export const GUARD = '0x1111111111111111111111111111111111111111' as Hex
export const MARKET = '0x2222222222222222222222222222222222222222' as Hex
export const FEED = '0x5c8c8482f064049248f86d9f4afa4b1f2f5b6d31' as Hex
export const GUARD_2 = '0x3333333333333333333333333333333333333333' as Hex
export const MARKET_2 = '0x4444444444444444444444444444444444444444' as Hex
export const NOW = 1_791_120_000n
export const E6 = 10n ** 6n
export const ETH = 2_700n * 10n ** 8n // $2,700.00000000

export const thresholds = {
	deviationBps: [200, 500, 1_000] as [number, number, number],
	utilizationBps: [9_000, 9_800, 65_535] as [number, number, number],
	outflowBps: [1_000, 2_500, 5_000] as [number, number, number],
	maxOracleAgeSeconds: 3_600,
	staleOracleLevel: Level.Restricted,
	referenceDivergenceLevel: Level.Caution,
	referenceUnavailableLevel: Level.Caution,
}

export const market = (name: string, guard: Hex, marketAddr: Hex) => ({
	name,
	chainSelectorName: 'monad-testnet',
	guard,
	market: marketAddr,
	gasLimit: '400000',
	heartbeatRefreshSeconds: 300,
	thresholds,
})

export const config = (overrides: Partial<Config> = {}): Config =>
	configSchema.parse({
		schedule: '*/30 * * * * *',
		reference: {
			symbol: 'ETH',
			exchanges: ['coinbase', 'kraken', 'bitstamp'],
			minExchanges: 2,
			chainlinkFeed: { chainSelectorName: 'monad-testnet', address: FEED, decimals: 8, maxAgeSeconds: 90_000 },
			maxSpreadBps: 150,
		},
		markets: [market('tWETH/tUSDC', GUARD, MARKET)],
		...overrides,
	})

/** A healthy market: 500k supplied, 100k borrowed (20%), no outflow, oracle at $2,700 updated a minute ago. */
export const healthyMarket = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
	totalSupplied: 500_000n * E6,
	totalBorrowed: 100_000n * E6,
	windowOutflow: 0n,
	windowSeconds: 3_600,
	price: ETH,
	priceUpdatedAt: NOW - 60n,
	priceDecimals: 8,
	...overrides,
})
