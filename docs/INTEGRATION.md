# Integrating Tripwire

## 1. Aave V3 (and forks): one governance transaction

Aave V3 asks an optional `PriceOracleSentinel` two questions:
- `isBorrowAllowed()`, from `ValidationLogic.validateBorrow`;
- `isLiquidationAllowed()`, from `ValidationLogic.validateLiquidationCall`, unless HF < 0.95.

`TripwireGuard` answers both, so the integration is:

```solidity
IPoolAddressesProvider(provider).setPriceOracleSentinel(address(tripwireGuard));
```

That is the full change. Proof against the live Aave V3 market on Ethereum Sepolia: `contracts/test/fork/AaveV3Sentinel.fork.t.sol`.

```bash
cd contracts && forge test --match-path 'test/fork/*' -vv
```

| Test | What Aave does |
|---|---|
| `test_aave_borrowWorksAtNormal` | borrows normally |
| `test_aave_workflowTripBlocksBorrow` | `borrow` reverts `59` after a CRE report raises the level to Caution |
| `test_aave_silentWatcherBlocksBorrow` | `borrow` reverts `59` once the watcher misses its heartbeat |
| `test_aave_restrictedPausesLiquidationsAtMarginalHealth` | a liquidation at HF ≈ 0.97 reverts `59` at Restricted, and succeeds with the sentinel removed |

Aave's existing L2 sequencer sentinel answers only "is the sequencer up?". Tripwire answers "is the price this market is about to use believable, and is the market under stress?".

## 2. Contracts you control: one modifier

```solidity
import {TripwireProtected} from "tripwire/integrations/TripwireProtected.sol";
import {Actions} from "tripwire/libraries/TripwireTypes.sol";

contract MyVault is TripwireProtected {
  constructor(ITripwireGuard guard) TripwireProtected(guard) {}

  function borrow(uint256 amount) external whenAllowed(Actions.BORROW) { ... }
  function withdraw(uint256 amount) external whenAllowed(Actions.WITHDRAW) { ... }
  function repay(uint256 amount) external { ... } // never gate risk-reducing actions
}
```

`isAllowed` costs 3,771 gas: one SLOAD plus bit operations. Bits 6–15 of the action mask are free for your own actions, such as `REBALANCE` or `REDEEM`.

## 3. What the watcher reads

The workflow reads one view per market. Implement it on the market, or on a read-only lens contract for protocols that cannot be changed:

```solidity
interface ITripwireMonitored {
  struct RiskSnapshot {
    uint256 totalSupplied;   // lender liquidity, debt-asset units
    uint256 totalBorrowed;   // outstanding debt, debt-asset units
    uint256 windowOutflow;   // debt asset that left over the trailing window
    uint32  windowSeconds;
    int256  price;           // the market's own collateral price
    uint256 priceUpdatedAt;
    uint8   priceDecimals;
  }
  function riskSnapshot() external view returns (RiskSnapshot memory);
}
```

Each run makes 2 reference reads plus 2 reads per market: `riskSnapshot` and `status`. CRE allows 15 EVM reads per execution, so one workflow watches up to 6 markets.

## 4. Deploying a guard

`contracts/script/Deploy.s.sol` shows every parameter.

| Parameter | Demo | Production guidance |
|---|---|---|
| `owner` | deployer | timelock |
| `identity.forwarder` | CRE MockKeystoneForwarder | `KeystoneForwarder` on the chain |
| `identity.workflowOwner` / `workflowName` | unset (`trustForwarderOnly`) | pinned |
| `heartbeat` | 15 min | 3× the workflow's heartbeat refresh |
| `staleLevel` | Caution | Caution or Restricted |
| `relaxDelay` | 120 s | hours |
| `maxReportAge` | 5 min | 2–5 min |
| `permissions` | default ladder | per market; must be monotone |

## 5. Tuning the workflow

Everything lives in `workflow/tripwire/config.*.json`, validated by zod at start-up:
- `reference`: exchanges and `minExchanges`, the Chainlink feed with its max age, the Perpl perpetual, and `maxSpreadBps`;
- `markets[].thresholds`: three-step ladders (Caution / Restricted / Frozen) for deviation, utilization, outflow and perp dislocation, plus the oracle max age and the levels used when references diverge or are unavailable.
