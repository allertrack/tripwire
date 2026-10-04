import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { assess, packMetrics } from '../src/policy'
import { encodeReport } from '../workflow'
import { ETH, config, healthyMarket, thresholds } from './fixtures'

/**
 * Cross-language contract: contracts/test/ReportCompat.t.sol delivers these exact bytes to a TripwireGuard and
 * checks every decoded field. If either side changes the report layout, one of the two tests fails.
 */
export const GOLDEN = {
	guard: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as Hex,
	observedAt: 1_790_000_030n,
	evidenceHash: '0xd4fbc4a7368db3385310885775ead5892696e0a054d3bf67f45d2ccf7fe3984d',
	metrics: 0x30000003edd410c0000000051b93af6000000003c000007d000000bb8n,
	report:
		'0x0000000000000000000000000000000000000000000000001e4ba3a26233c8500000000000000000000000005615deb798bb3e4dfa0139dfa1b3d433cc23b72f000000000000000000000000000000000000000000000000000000006ab13b9e00000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001d4fbc4a7368db3385310885775ead5892696e0a054d3bf67f45d2ccf7fe3984d000000030000003edd410c0000000051b93af6000000003c000007d000000bb8',
} as const

describe('report encoding (golden, shared with Solidity)', () => {
	test('the workflow encodes the golden oracle-manipulation report byte for byte', () => {
		const m = { ...config().markets[0], guard: GOLDEN.guard }
		const a = assess(
			{
				observedAt: GOLDEN.observedAt,
				market: healthyMarket({ price: (ETH * 13n) / 10n, priceUpdatedAt: GOLDEN.observedAt - 60n }),
				references: { chainlink: ETH, exchanges: ETH },
				maxSpreadBps: 150,
			},
			thresholds,
		)
		expect(a.evidenceHash).toBe(GOLDEN.evidenceHash)
		expect(packMetrics(a.metrics)).toBe(GOLDEN.metrics)
		expect(encodeReport(m, GOLDEN.observedAt, a)).toBe(GOLDEN.report)
	})
})
