# Tripwire

**A circuit breaker for DeFi markets on Monad, run by Chainlink CRE. It tightens a market within one workflow run of trouble starting, and it never loosens on its own.**

**Live monitor:** https://allertrack.github.io/tripwire/ (Monad testnet) · **Demo video:** see [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)

When a lending market's oracle is manipulated or its liquidity starts to run, the usual defence is a person with a multisig noticing in time. Tripwire replaces the noticing. A Chainlink Runtime Environment (CRE) workflow watches the market every 30 seconds:

- the market's own oracle, checked against **three independent references**:
  - a Chainlink Data Feed on Monad;
  - a DON-consensus median of public exchanges;
  - Perpl's on-chain perpetual oracle (Chainlink Data Streams);
- Monad's own order book (Perpl mark price vs. its oracle) as a stress signal;
- utilization and outflow velocity.

On trouble, the workflow sends a DON-signed report to an on-chain **guard**. The guard pauses exactly the actions that can turn a bad price into bad debt.

```
                 every 30 s (CRE cron)                                     Monad
 ┌──────────────────────────────────────────────┐        ┌───────────────────────────────────────┐
 │ CRE workflow (TypeScript → WASM, DON)        │        │ TripwireGuard (CRE receiver)           │
 │  read  market.riskSnapshot()        [Monad]  │        │  • tighten-only from reports/guardians │
 │  read  Chainlink ETH/USD feed       [Monad]  │ signed │  • fails safe if the watcher goes quiet│
 │  read  Perpl getPerpetualInfoV2     [Monad]  │ report │  • relax = governance + watcher agree  │
 │  http  Coinbase · Kraken · Bitstamp → median │ ─────► │  isAllowed(action)  ← 1 SLOAD          │
 │  model deviation · spread · staleness ·      │        └──────────────┬────────────────────────┘
 │        utilization · outflow · perp stress   │                       │ isBorrowAllowed()
 │  write only on trip / change / heartbeat     │        ┌──────────────▼────────────────────────┐
 └──────────────────────────────────────────────┘        │ Any market: modifier, or Aave V3's    │
                                                         │ PriceOracleSentinel slot (no code     │
                                                         │ change, proven on a fork of Aave V3)  │
                                                         └───────────────────────────────────────┘
```

## What happens in an attack

From `scripts/local-e2e.sh`, which runs the real CRE simulator against a fork of Monad testnet:

```
3. attack: the market's own oracle is pushed 30% above Chainlink and the exchanges
[USER LOG] references: chainlink=270292000000 exchanges=269935000000 perpl=269875000000/mark 269860000000
[USER LOG] tWETH/tUSDC: Frozen [ORACLE_DEVIATION] deviation=3000bps spread=15bps utilization=400bps ... -> trip
"tWETH/tUSDC:trip:Frozen:0x962c…d9a8"
guard level = 3 (ok)
4. the attacker tries to borrow against the inflated price
borrow reverted: TripwirePaused(BORROW) (ok)
5. oracle fixed: the workflow reports recovery, the guard stays Frozen (tighten-only)
6. governance proposes to relax; the watcher must agree after the delay  -> evidence
7. anyone executes the matured relax -> guard level = 0, borrow works again
```

## Levels and what they pause

| Level | Borrow | Mint | Liquidate | Bridge out | Withdraw | Swap | Repay / supply / add collateral |
|---|---|---|---|---|---|---|---|
| Normal | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ always |
| Caution | ⛔ | ⛔ | ✅ | ✅ | ✅ | ✅ | ✅ always |
| Restricted | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ | ✅ always |
| Frozen | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ always |

Each level's allow-list is configurable, but must be a subset of the level below it; the guard enforces this. Positions with a health factor below 0.95 stay liquidatable at every level, the same rule Aave V3 applies to its oracle sentinel, so a frozen market cannot build up deep bad debt.

## Safety properties

Each property below is a Foundry invariant. The invariant suite runs 65,536 random calls in CI (`contracts/test/TripwireGuard.invariant.t.sol`).

1. **Tighten-only automation.** Workflow reports and guardians can raise the level, never lower it. A compromised watcher can halt borrowing; it cannot unfreeze anything.
2. **Two-key relax.** Lowering the level needs all of these:
   - a governance proposal;
   - its delay elapsed;
   - no new trip since the proposal;
   - a fresh watcher observation, made after the proposal, that agrees with the lower level.

   Execution is permissionless once all of that holds.
3. **Fail-safe liveness.** If the watcher misses its heartbeat, the effective level becomes at least `staleLevel` (Caution by default), with no transaction needed.
4. **Monotone permissions.** A stricter level never allows more.
5. **Bound, ordered, fresh reports.** Each report carries `(chainSelector, guard address)`, because the Forwarder's signatures do not cover the receiver. That closes replay into another guard or onto another chain. `observedAt` must strictly increase, must be no more than 60 s ahead of the chain, and must be younger than `maxReportAge`.

More detail, with the threat model, is in [docs/SECURITY.md](docs/SECURITY.md).

## Integrating a market

- **Aave V3 and forks:** a single governance call, `PoolAddressesProvider.setPriceOracleSentinel(guard)`. The guard implements `isBorrowAllowed()` and `isLiquidationAllowed()`. `contracts/test/fork/AaveV3Sentinel.fork.t.sol` plugs a guard into the **live Aave V3 market on Sepolia** and checks three things:
  - Aave's own `borrow` reverts with `59` (`PRICE_ORACLE_SENTINEL_CHECK_FAILED`) after a workflow trip;
  - it also reverts when the watcher goes silent;
  - a marginal liquidation is paused at Restricted and goes through without the sentinel.
- **Your own contracts:** inherit `TripwireProtected` and add `whenAllowed(Actions.BORROW)` to the entry point.
- **The watcher's view:** implement `ITripwireMonitored.riskSnapshot()`, or point it at a read-only lens if the protocol cannot be changed.

See [docs/INTEGRATION.md](docs/INTEGRATION.md).

## Cost

| Path | Gas |
|---|---|
| `isAllowed(action)`: what an integrator pays per gated call | 3,771 |
| `isBorrowAllowed()`: the Aave sentinel hook | 3,698 |
| Heartbeat report (CRE → Forwarder → guard) | 43,580 |
| Trip report | 51,219 |

On Monad the transaction pays for its gas *limit*, so the workflow sets a tight one: 150k, against 98,766 measured for a trip including the Forwarder (`cast run` on the testnet trip below). All hot state lives in one 256-bit storage slot. The workflow writes only when the level goes up, when its view changes, when a relax proposal matures, or once per heartbeat refresh (5 min). In steady state that is 12 writes an hour. Gas snapshots are checked in CI.

## Repository

```
contracts/   Foundry. TripwireGuard, CREReceiver, TripwireProtected, demo market + tests
  src/TripwireGuard.sol              the guard (CRE receiver, Aave sentinel)
  src/demo/GuardedLendingPool.sol    minimal lending market wired to the guard
  test/                              unit, fuzz, invariant, golden-report and Aave V3 fork tests
workflow/    CRE project. tripwire/workflow.ts + src/{observe,policy,prices}.ts, 55 bun tests
dashboard/   static live monitor (viem, no build step)
scripts/     local-e2e.sh (anvil fork + CRE simulator), make-config.ts
docs/        SECURITY, INTEGRATION, REPORT (payload + metrics layout), DEMO_SCRIPT, SUBMISSION
```

## Run it

Prerequisites: [Foundry](https://getfoundry.sh), [Bun](https://bun.sh), and the [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation) logged in with `cre login`.

```bash
make install
make test            # contracts (unit/fuzz/invariant), Aave V3 fork, workflow
make e2e             # full attack → trip → relax rehearsal on an anvil fork of Monad testnet, real CRE simulator
```

To run against the live Monad testnet deployment instead, fill in `contracts/.env` and `workflow/.env.testnet` from the `.env.example` files, then:

```bash
make deploy-testnet
make simulate-testnet
```

The dashboard is a static page: `python -m http.server -d dashboard 5173`, then open `http://localhost:5173`. It reads `dashboard/deployment.json`, or `?guard=0x…&pool=0x…` in the URL.

## Deployments (Monad testnet, chain 10143)

All contracts are verified on MonadVision (Sourcify). The source of truth is [`contracts/deployments/monad-testnet.json`](contracts/deployments/monad-testnet.json).

| Contract | Address |
|---|---|
| TripwireGuard | [`0x7c12d527b8047F53F2e019F83b45b9aeBB981658`](https://testnet.monadvision.com/address/0x7c12d527b8047F53F2e019F83b45b9aeBB981658) |
| GuardedLendingPool (demo market) | [`0x15Ac97a7031bB3777AA1B85DFBFB11319BD244dC`](https://testnet.monadvision.com/address/0x15Ac97a7031bB3777AA1B85DFBFB11319BD244dC) |
| DemoOracle (the market's own oracle) | [`0xcEAcE91ed8fC52654F477329E0B14476940D3f94`](https://testnet.monadvision.com/address/0xcEAcE91ed8fC52654F477329E0B14476940D3f94) |
| tWETH / tUSDC (demo tokens) | [`0xFb443e7b653BC40FcF004c34445bc7fC41244Da2`](https://testnet.monadvision.com/address/0xFb443e7b653BC40FcF004c34445bc7fC41244Da2) / [`0x0938305adC809B9089C7baA89Dc6d173AeEe3212`](https://testnet.monadvision.com/address/0x0938305adC809B9089C7baA89Dc6d173AeEe3212) |
| CRE MockKeystoneForwarder (simulation) | `0xB9F79d863261869B234c481D1f9A7af84AeAd192` |
| Chainlink ETH/USD Data Feed | `0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31` |
| Perpl exchange (ETH perp, id 32) | `0x1964C32f0bE608E7D29302AFF5E61268E72080cc` |

**The attack and recovery on chain, recorded for the demo video:**
1. [oracle pushed +30%](https://testnet.monadvision.com/tx/0x507575957db85e00c0d3c1a2d56bf997cf943d6b5e045b0c72337123879ae615)
2. [CRE report trips the guard to Frozen](https://testnet.monadvision.com/tx/0x7e54db96d3e9fd1f5dbedd6cac62b7ada234c6f9a23085998d519f8da74af498)
3. borrow reverts with `TripwirePaused(1)`
4. [governance proposes relax](https://testnet.monadvision.com/tx/0xcfdb0e44b6ca086f590638198c12277ba34c9eaa6569002edaa81039e64e9f49)
5. [watcher sends fresh evidence](https://testnet.monadvision.com/tx/0x2b344bfaf2c1ba3f1968f0716b3ce31f78c13cb4fa4cf2219366d194f3c6f5a0)
6. [anyone executes the relax](https://testnet.monadvision.com/tx/0x45ce78f4369ee33d73e1afeedb1bd97c60def70cde4bff10111a61c250cb96de)

The demo guard uses a 24 h heartbeat. Its watcher runs through `cre workflow simulate` from a laptop until CRE deploy access is granted; production would use 15 min.

## Status and honest limits

- **Simulation only, for now.** The workflow runs through `cre workflow simulate --broadcast`, which writes real transactions through Chainlink's *simulation* Forwarder. That Forwarder checks no signatures, so the testnet guard trusts it (`trustForwarderOnly`). In production you would:
  - get CRE deploy access;
  - point the guard at the `KeystoneForwarder` (Monad testnet `0xF8344CFd…4482`);
  - pin the workflow owner (and optionally its name or ID).

  `CREReceiver` rejects a production identity that pins nothing.
- **The demo market is minimal:** one collateral asset, one debt asset, no interest. It exists to show the integration; the product is the guard plus the workflow.
- **Governance:** the guard's owner should be a timelock or multisig, because configuration changes (permissions, liveness, workflow identity) are governance powers.
- **Not audited.**

MIT licensed.
