import { CronCapability, type CronPayload, type Runtime, handler } from '@chainlink/cre-sdk'
import { type Hex, encodeAbiParameters } from 'viem'
import { reportParams } from './src/abi'
import { selectorOf, writeReport } from './src/chain'
import { levelName, reasonNames } from './src/codes'
import { type Config, type Market, configSchema } from './src/config'
import { readChainlink, readExchanges, readGuard, readMarket, readPerpl } from './src/observe'
import { type Assessment, type References, assess, decideWrite, packMetrics } from './src/policy'

export { configSchema }
export type { Config }

/** Deterministic observation time: the cron's scheduled time (identical on every node), else DON time. */
export const observedAtOf = (runtime: Runtime<Config>, payload?: CronPayload): bigint =>
	payload?.scheduledExecutionTime?.seconds ?? BigInt(Math.floor(runtime.now().getTime() / 1000))

export const encodeReport = (market: Market, observedAt: bigint, a: Assessment): Hex =>
	encodeAbiParameters(reportParams, [
		selectorOf(market.chainSelectorName),
		market.guard as Hex,
		Number(observedAt),
		a.level,
		a.reasons,
		a.evidenceHash,
		packMetrics(a.metrics),
	])

const describe = (a: Assessment): string => {
	const m = a.metrics
	const reasons = reasonNames(a.reasons)
	return (
		`${levelName(a.level)}${reasons.length ? ` [${reasons.join(',')}]` : ''} ` +
		`deviation=${m.deviationBps}bps spread=${m.spreadBps}bps utilization=${m.utilizationBps}bps ` +
		`outflow=${m.outflowBps}bps perpDislocation=${m.perpDislocationBps}bps oracleAge=${m.oracleAgeSeconds}s ` +
		`market=${m.marketPrice} reference=${m.referencePrice}`
	)
}

/** Assesses one market and reports to its guard when the decision calls for it. Returns a one-line summary. */
export const watchMarket = (runtime: Runtime<Config>, market: Market, references: References, observedAt: bigint): string => {
	const snapshot = readMarket(runtime, market)
	const guard = readGuard(runtime, market)
	const assessment = assess(
		{ observedAt, market: snapshot, references, maxSpreadBps: runtime.config.reference.maxSpreadBps },
		market.thresholds,
	)
	const decision = decideWrite(assessment, guard, observedAt, market.heartbeatRefreshSeconds)
	runtime.log(`${market.name}: ${describe(assessment)} guard=${levelName(guard.level)} -> ${decision}`)
	if (decision === 'skip') return `${market.name}:skip`

	const tx = writeReport(
		runtime,
		market.chainSelectorName,
		market.guard as Hex,
		encodeReport(market, observedAt, assessment),
		market.gasLimit,
	)
	return `${market.name}:${decision}:${levelName(assessment.level)}:${tx}`
}

/**
 * Cron handler. References are read once per run and shared by all markets; each market is reported
 * independently so one failing write cannot leave another market unprotected.
 */
export const onTick = (runtime: Runtime<Config>, payload?: CronPayload): string => {
	const observedAt = observedAtOf(runtime, payload)
	const references: References = {
		chainlink: readChainlink(runtime, observedAt),
		exchanges: readExchanges(runtime),
		perpl: readPerpl(runtime, observedAt),
	}
	const perpl = references.perpl ? `${references.perpl.oracle}/mark ${references.perpl.mark}` : '-'
	runtime.log(`references: chainlink=${references.chainlink ?? '-'} exchanges=${references.exchanges ?? '-'} perpl=${perpl}`)

	const results: string[] = []
	const failures: string[] = []
	for (const market of runtime.config.markets) {
		try {
			results.push(watchMarket(runtime, market, references, observedAt))
		} catch (error) {
			failures.push(`${market.name}: ${(error as Error).message}`)
		}
	}
	if (failures.length) throw new Error(`tripwire failed for ${failures.join('; ')} (ok: ${results.join(' ') || 'none'})`)
	return results.join(' ')
}

export function initWorkflow(config: Config) {
	return [handler(new CronCapability().trigger({ schedule: config.schedule }), onTick)]
}
