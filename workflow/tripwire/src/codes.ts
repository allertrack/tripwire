/** Mirrors `Level` in contracts/src/libraries/TripwireTypes.sol. */
export enum Level {
	Normal = 0,
	Caution = 1,
	Restricted = 2,
	Frozen = 3,
}

/** Mirrors `Reasons` in contracts/src/libraries/TripwireTypes.sol (bits 0..15 are produced here). */
export const Reason = {
	ORACLE_DEVIATION: 1 << 0,
	ORACLE_STALE: 1 << 1,
	REFERENCE_DIVERGENCE: 1 << 2,
	REFERENCE_UNAVAILABLE: 1 << 3,
	UTILIZATION: 1 << 4,
	OUTFLOW_VELOCITY: 1 << 5,
	MANUAL: 1 << 30,
	LIVENESS: 2 ** 31,
} as const

export const levelName = (level: number): string => Level[level] ?? `Level(${level})`

/** Bitwise ops work on int32, so bit 31 still tests correctly (both sides become negative). */
export const reasonNames = (reasons: number): string[] =>
	Object.entries(Reason)
		.filter(([, bit]) => (reasons & bit) !== 0)
		.map(([name]) => name)
