import { type Hex, encodeAbiParameters, keccak256 } from 'viem'
import { Level, Reason } from './codes'
import type { Thresholds } from './config'
import { PRICE_DECIMALS, rescale } from './prices'

const BPS = 10_000n
const MAX_U16 = 65_535n
const MAX_U32 = 4_294_967_295n
const MAX_U64 = (1n << 64n) - 1n

/** What the market reports about itself (ITripwireMonitored.riskSnapshot). */
export type MarketSnapshot = {
	totalSupplied: bigint
	totalBorrowed: bigint
	windowOutflow: bigint
	windowSeconds: number
	price: bigint
	priceUpdatedAt: bigint
	priceDecimals: number
}

/** Independent references, 8-decimal USD. `undefined` = could not be read (or too old to trust). */
export type References = {
	chainlink?: bigint
	exchanges?: bigint
}

export type Observation = {
	observedAt: bigint
	market: MarketSnapshot
	references: References
	maxSpreadBps: number
}

export type Metrics = {
	deviationBps: bigint
	spreadBps: bigint
	utilizationBps: bigint
	outflowBps: bigint
	oracleAgeSeconds: bigint
	marketPrice: bigint
	referencePrice: bigint
	/** bit 0: Chainlink used, bit 1: exchange median used. */
	sources: number
}

export type Assessment = {
	level: Level
	reasons: number
	metrics: Metrics
	evidenceHash: Hex
}

const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a)
const cap = (v: bigint, max: bigint) => (v > max ? max : v)
const ratioBps = (num: bigint, den: bigint) => (den === 0n ? 0n : (num * BPS) / den)

/** Highest ladder step reached by `value` (Normal if below the first threshold). */
export const ladderLevel = (value: bigint, ladder: readonly [number, number, number]): Level => {
	if (value >= BigInt(ladder[2])) return Level.Frozen
	if (value >= BigInt(ladder[1])) return Level.Restricted
	if (value >= BigInt(ladder[0])) return Level.Caution
	return Level.Normal
}

/**
 * Pure risk model. Each signal maps to a level; the report carries the maximum and the OR of the reasons that
 * reached at least Caution. Deterministic on its inputs, so every DON node computes the same report.
 */
export const assess = (obs: Observation, t: Thresholds): Assessment => {
	let level = Level.Normal
	let reasons = 0
	const raise = (l: Level, reason: number) => {
		if (l === Level.Normal) return
		if (l > level) level = l
		reasons |= reason
	}

	const { market, references } = obs
	const marketPrice = market.price > 0n ? rescale(market.price, market.priceDecimals, PRICE_DECIMALS) : 0n
	const refs: bigint[] = []
	let sources = 0
	if (references.chainlink !== undefined && references.chainlink > 0n) {
		refs.push(references.chainlink)
		sources |= 1
	}
	if (references.exchanges !== undefined && references.exchanges > 0n) {
		refs.push(references.exchanges)
		sources |= 2
	}

	// 1. Price integrity: the market's oracle against the closest independent reference.
	let deviationBps = 0n
	let referencePrice = 0n
	if (marketPrice === 0n) {
		deviationBps = MAX_U16
		raise(Level.Frozen, Reason.ORACLE_DEVIATION)
	} else if (refs.length === 0) {
		raise(t.referenceUnavailableLevel, Reason.REFERENCE_UNAVAILABLE)
	} else {
		// The closest reference wins: one glitching reference cannot trip a healthy market on its own.
		deviationBps = MAX_U16
		for (const ref of refs) {
			const d = ratioBps(absDiff(marketPrice, ref), ref)
			if (d < deviationBps) {
				deviationBps = d
				referencePrice = ref
			}
		}
		raise(ladderLevel(deviationBps, t.deviationBps), Reason.ORACLE_DEVIATION)
	}

	// 2. Reference integrity: Chainlink and the exchanges should agree with each other.
	let spreadBps = 0n
	if (refs.length === 2) {
		const [a, b] = refs
		spreadBps = ratioBps(absDiff(a, b), a < b ? a : b)
		if (spreadBps > BigInt(obs.maxSpreadBps)) raise(t.referenceDivergenceLevel, Reason.REFERENCE_DIVERGENCE)
	}

	// 3. Oracle liveness: the market's own feed stopped updating.
	const oracleAgeSeconds = obs.observedAt > market.priceUpdatedAt ? obs.observedAt - market.priceUpdatedAt : 0n
	if (oracleAgeSeconds > BigInt(t.maxOracleAgeSeconds)) raise(t.staleOracleLevel, Reason.ORACLE_STALE)

	// 4. Solvency pressure: utilization and outflow velocity.
	const utilizationBps = ratioBps(market.totalBorrowed, market.totalSupplied)
	raise(ladderLevel(utilizationBps, t.utilizationBps), Reason.UTILIZATION)
	const outflowBps = ratioBps(market.windowOutflow, market.totalSupplied + market.windowOutflow)
	raise(ladderLevel(outflowBps, t.outflowBps), Reason.OUTFLOW_VELOCITY)

	const metrics: Metrics = {
		deviationBps: cap(deviationBps, MAX_U16),
		spreadBps: cap(spreadBps, MAX_U16),
		utilizationBps: cap(utilizationBps, MAX_U16),
		outflowBps: cap(outflowBps, MAX_U16),
		oracleAgeSeconds: cap(oracleAgeSeconds, MAX_U32),
		marketPrice: cap(marketPrice, MAX_U64),
		referencePrice: cap(referencePrice, MAX_U64),
		sources,
	}
	return { level, reasons, metrics, evidenceHash: evidenceHash(obs) }
}

/**
 * Packs metrics into the report's opaque uint256 (layout documented in docs/REPORT.md):
 * [0,16) deviation · [16,32) spread · [32,48) utilization · [48,64) outflow (bps) · [64,96) oracle age (s) ·
 * [96,160) market price · [160,224) reference price (8-dec USD) · [224,232) sources.
 */
export const packMetrics = (m: Metrics): bigint =>
	m.deviationBps |
	(m.spreadBps << 16n) |
	(m.utilizationBps << 32n) |
	(m.outflowBps << 48n) |
	(m.oracleAgeSeconds << 64n) |
	(m.marketPrice << 96n) |
	(m.referencePrice << 160n) |
	(BigInt(m.sources) << 224n)

export const unpackMetrics = (packed: bigint): Metrics => ({
	deviationBps: packed & MAX_U16,
	spreadBps: (packed >> 16n) & MAX_U16,
	utilizationBps: (packed >> 32n) & MAX_U16,
	outflowBps: (packed >> 48n) & MAX_U16,
	oracleAgeSeconds: (packed >> 64n) & MAX_U32,
	marketPrice: (packed >> 96n) & MAX_U64,
	referencePrice: (packed >> 160n) & MAX_U64,
	sources: Number((packed >> 224n) & 0xffn),
})

/** Commits to every input of the assessment, so anyone can re-run the model on the logged observation. */
export const evidenceHash = (obs: Observation): Hex =>
	keccak256(
		encodeAbiParameters(
			[
				{ type: 'uint64' },
				{ type: 'uint256' },
				{ type: 'uint256' },
				{ type: 'uint256' },
				{ type: 'uint32' },
				{ type: 'int256' },
				{ type: 'uint256' },
				{ type: 'uint8' },
				{ type: 'uint256' },
				{ type: 'uint256' },
			],
			[
				obs.observedAt,
				obs.market.totalSupplied,
				obs.market.totalBorrowed,
				obs.market.windowOutflow,
				obs.market.windowSeconds,
				obs.market.price,
				obs.market.priceUpdatedAt,
				obs.market.priceDecimals,
				obs.references.chainlink ?? 0n,
				obs.references.exchanges ?? 0n,
			],
		),
	)

/** The guard's state as `status()` returns it (only the fields the workflow needs). */
export type GuardView = {
	level: Level
	lastObservedAt: bigint
	lastReportedLevel: Level
	lastReportedReasons: number
	relaxPending: boolean
	relaxReadyAt: bigint
}

export type WriteDecision = 'trip' | 'change' | 'evidence' | 'heartbeat' | 'skip'

/**
 * Writes cost gas, so only send what changes the guard or its evidence: a stricter level (trip), a different view
 * (governance needs it to relax), a fresh observation as soon as a relax proposal matures (so it can execute
 * without waiting for the next heartbeat), or a heartbeat before the guard would consider the watcher stale.
 */
export const decideWrite = (a: Assessment, guard: GuardView, observedAt: bigint, refreshSeconds: number): WriteDecision => {
	if (observedAt <= guard.lastObservedAt) return 'skip'
	if (a.level > guard.level) return 'trip'
	if (a.level !== guard.lastReportedLevel || (a.reasons & ~guard.lastReportedReasons) !== 0) return 'change'
	if (guard.relaxPending && observedAt >= guard.relaxReadyAt && guard.lastObservedAt < guard.relaxReadyAt) return 'evidence'
	if (observedAt - guard.lastObservedAt >= BigInt(refreshSeconds)) return 'heartbeat'
	return 'skip'
}
