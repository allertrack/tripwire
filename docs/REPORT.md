# Report format

The workflow (`workflow/tripwire/workflow.ts:encodeReport`) produces this payload, and `TripwireGuard._processReport` decodes it. Both sides are pinned to the same golden bytes:
- `workflow/tripwire/test/golden.test.ts`;
- `contracts/test/ReportCompat.t.sol`.

## Payload

```
abi.encode(
  uint64  chainSelector,  // must equal the guard's chain       (cross-chain replay)
  address target,         // must equal the guard's address     (cross-receiver replay)
  uint40  observedAt,     // cron scheduled time, seconds; strictly increasing
  uint8   level,          // 0 Normal · 1 Caution · 2 Restricted · 3 Frozen
  uint32  reasons,        // bitmap below
  bytes32 evidenceHash,   // keccak256 of every model input (see below)
  uint256 metrics         // packed, below; emitted, not stored
)
```

## Reasons

| Bit | Name | Raised when |
|---|---|---|
| 0 | `ORACLE_DEVIATION` | the market oracle is too far from the closest reference, or non-positive |
| 1 | `ORACLE_STALE` | the market oracle's `updatedAt` is older than `maxOracleAgeSeconds` |
| 2 | `REFERENCE_DIVERGENCE` | the references disagree with each other by more than `maxSpreadBps` |
| 3 | `REFERENCE_UNAVAILABLE` | no reference could be read |
| 4 | `UTILIZATION` | borrowed / supplied crosses its ladder |
| 5 | `OUTFLOW_VELOCITY` | trailing-window outflow / (supplied + outflow) crosses its ladder |
| 6 | `PERP_DISLOCATION` | Perpl mark vs. oracle crosses its ladder |
| 30 | `MANUAL` | set by `trip()` (guardian) |
| 31 | `LIVENESS` | never stored; added by `status()` while the watcher is overdue |

## Metrics (uint256)

| Bits | Field | Unit |
|---|---|---|
| 0–15 | deviation of market oracle vs. closest reference | bps |
| 16–31 | spread across references | bps |
| 32–47 | utilization | bps |
| 48–63 | outflow velocity | bps |
| 64–95 | market oracle age | seconds |
| 96–159 | market oracle price | USD, 8 decimals |
| 160–223 | closest reference price | USD, 8 decimals |
| 224–231 | sources used: bit 0 Chainlink Data Feed, bit 1 exchange median, bit 2 Perpl oracle | bitmap |
| 232–247 | Perpl mark vs. oracle dislocation | bps |

## Evidence hash

```
keccak256(abi.encode(
  uint64 observedAt,
  uint256 totalSupplied, uint256 totalBorrowed, uint256 windowOutflow, uint32 windowSeconds,
  int256 marketPrice, uint256 marketPriceUpdatedAt, uint8 marketPriceDecimals,
  uint256 chainlinkRef, uint256 exchangeMedianRef, uint256 perplOracle, uint256 perplMark   // 0 if unavailable
))
```

From these logged inputs, anyone can re-run `assess()` (a pure function in `src/policy.ts`) and check both the level the DON reported and the hash.
