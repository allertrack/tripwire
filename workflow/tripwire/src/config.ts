import { z } from 'zod'
import { Level } from './codes'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address')
const bps = z.number().int().min(1).max(65_535)
const level = z.nativeEnum(Level)

/** Thresholds (bps) at which a signal reaches [Caution, Restricted, Frozen]. Use 65535 to disable a step. */
const ladder = z
	.tuple([bps, bps, bps])
	.refine(([c, r, f]) => c <= r && r <= f, 'ladder thresholds must be non-decreasing')

export const exchangeSchema = z.enum(['coinbase', 'kraken', 'bitstamp'])
export type Exchange = z.infer<typeof exchangeSchema>

export const thresholdsSchema = z.object({
	/** Market oracle vs the closest independent reference. */
	deviationBps: ladder,
	/** totalBorrowed / totalSupplied. */
	utilizationBps: ladder,
	/** Trailing-window outflow / (totalSupplied + outflow). */
	outflowBps: ladder,
	/** The market oracle's own `updatedAt` may lag by at most this much. */
	maxOracleAgeSeconds: z.number().int().positive(),
	staleOracleLevel: level,
	/** Chainlink and the exchanges disagree with each other by more than `reference.maxSpreadBps`. */
	referenceDivergenceLevel: level,
	/** No independent reference could be read. */
	referenceUnavailableLevel: level,
	/** Perpl perp mark price vs its oracle (stress on Monad's own order book). Optional. */
	perpDislocationBps: ladder.optional(),
})
export type Thresholds = z.infer<typeof thresholdsSchema>

export const marketSchema = z.object({
	name: z.string().min(1),
	chainSelectorName: z.string().min(1),
	/** TripwireGuard receiving the reports. */
	guard: address,
	/** Contract implementing ITripwireMonitored.riskSnapshot() (the market itself or a lens). */
	market: address,
	gasLimit: z.string().regex(/^\d+$/),
	/** Re-send an unchanged observation this often, well inside the guard's heartbeat. */
	heartbeatRefreshSeconds: z.number().int().positive(),
	thresholds: thresholdsSchema,
})
export type Market = z.infer<typeof marketSchema>

export const configSchema = z.object({
	schedule: z.string().min(1),
	reference: z.object({
		/** Asset symbol on the exchanges, e.g. "ETH" (quoted in USD). */
		symbol: z.string().regex(/^[A-Z0-9]{2,10}$/),
		exchanges: z.array(exchangeSchema).min(1).max(5),
		/** A node only reports an exchange median if at least this many exchanges answered. */
		minExchanges: z.number().int().min(1),
		chainlinkFeed: z
			.object({
				chainSelectorName: z.string().min(1),
				address,
				/** Saves a decimals() read per execution. */
				decimals: z.number().int().min(0).max(36),
				maxAgeSeconds: z.number().int().positive(),
			})
			.optional(),
		/**
		 * Perpl perpetual on Monad: its on-chain oracle price (Chainlink Data Streams) is a third reference, and its
		 * mark-vs-oracle dislocation a market-stress signal. Optional.
		 */
		perpl: z
			.object({
				chainSelectorName: z.string().min(1),
				exchange: address,
				perpId: z.number().int().positive(),
				maxAgeSeconds: z.number().int().positive(),
			})
			.optional(),
		/** Largest spread between references above which the references themselves are suspect. */
		maxSpreadBps: bps,
	}),
	/** 2 reference reads + 2 reads per market must stay within CRE's 15 EVM reads per execution. */
	markets: z.array(marketSchema).min(1).max(6),
})
export type Config = z.infer<typeof configSchema>
