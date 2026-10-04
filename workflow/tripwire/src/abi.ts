import { parseAbi, parseAbiParameters } from 'viem'

export const guardAbi = parseAbi([
	'struct Status { uint8 level; uint8 effectiveLevel; bool stale; uint32 reasons; uint32 epoch; uint40 lastObservedAt; uint32 heartbeat; uint8 staleLevel; uint8 lastReportedLevel; uint32 lastReportedReasons; uint64 permissions; bool relaxPending; uint8 relaxTarget; uint40 relaxReadyAt; uint40 trippedAt; }',
	'function status() view returns (Status)',
	'event Tripped(uint8 indexed from, uint8 indexed to, uint32 reasons, bytes32 evidenceHash, address indexed by)',
	'event Observed(uint40 observedAt, uint8 level, uint32 reasons, bytes32 evidenceHash, uint256 metrics)',
])

export const marketAbi = parseAbi([
	'struct RiskSnapshot { uint256 totalSupplied; uint256 totalBorrowed; uint256 windowOutflow; uint32 windowSeconds; int256 price; uint256 priceUpdatedAt; uint8 priceDecimals; }',
	'function riskSnapshot() view returns (RiskSnapshot)',
])

export const aggregatorV3Abi = parseAbi([
	'function decimals() view returns (uint8)',
	'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

/** Perpl exchange (perpl-sdk 0.2.4, abi/dex/Exchange.json): only the view Tripwire reads. */
export const perplExchangeAbi = parseAbi([
	'struct PerpetualInfo { string name; string symbol; uint256 priceDecimals; uint256 lotDecimals; bytes32 linkFeedId; uint256 priceTolPer100K; uint256 marginTol; uint256 marginTolDecimals; uint256 refPriceMaxAgeSec; uint256 positionBalanceCNS; uint256 insuranceBalanceCNS; uint256 markPNS; uint256 markTimestamp; uint256 lastPNS; uint256 lastTimestamp; uint256 oraclePNS; uint256 oracleTimestampSec; uint256 longOpenInterestLNS; uint256 shortOpenInterestLNS; uint256 fundingStartBlock; int16 fundingRatePct100k; uint256 absFundingClampPctPer100K; uint8 status; uint256 basePricePNS; uint256 maxBidPriceONS; uint256 minBidPriceONS; uint256 maxAskPriceONS; uint256 minAskPriceONS; uint256 numOrders; bool ignOracle; uint256 fundingSumScalingExp; }',
	'function getPerpetualInfoV2(uint256 perpId) view returns (PerpetualInfo)',
])

/** TripwireGuard report: bound to (chain, guard), see CREReceiver.sol. */
export const reportParams = parseAbiParameters(
	'uint64 chainSelector, address target, uint40 observedAt, uint8 level, uint32 reasons, bytes32 evidenceHash, uint256 metrics',
)
