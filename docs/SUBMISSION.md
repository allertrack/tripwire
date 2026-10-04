# Monad Metropolis submission: Tripwire

> Copy-paste source for the submission form at hackathon.monad.xyz. Track and bounty answers are below.

**Project name:** Tripwire

**Tagline:** A circuit breaker for DeFi markets on Monad, run by Chainlink CRE. It tightens in seconds and never loosens on its own.

**Track:** 01 · Onchain Finance & Trading

**Sponsor bounties:**
- Chainlink: Best workflow with CRE
- Perpl: Best Analytics/Risk Tool

**Links:**
- Code: https://github.com/allertrack/tripwire *(to confirm once published)*
- Demo video: *(YouTube link)*
- Live monitor: *(GitHub Pages link)*
- Deployment: Monad testnet. Addresses are in `contracts/deployments/monad-testnet.json` and the README.

---

## Short description (≈ 80 words)

When a lending market's oracle is manipulated, the usual defence is a person with a multisig noticing in time. Tripwire replaces the noticing. A Chainlink CRE workflow checks the market every 30 seconds:
- the market's oracle against three independent references: a Chainlink Data Feed on Monad, a DON-consensus exchange median, and Perpl's Data Streams oracle;
- utilization, outflow velocity and stress on Perpl's order book.

On trouble, it sends a DON-signed report to an on-chain guard. The guard pauses exactly the risky actions. Automation can only tighten; relaxing needs governance and the watcher to agree.

## The problem

Fast chains make fast exploits. On Monad a manipulated price can become bad debt within a block, and existing defences are either:
- **manual:** multisig pauses that take minutes to hours to coordinate; or
- **blunt:** pause-everything switches that also block repayments and safe exits.

What DeFi protocols lack is an automated, *trust-minimised* risk layer. It has to react in seconds. It also has to be impossible to abuse, which means a buggy or compromised watcher must not be able to unfreeze a market or drain it.

## What we built

1. **`TripwireGuard` (Solidity, Monad).** A CRE report receiver that exposes `isAllowed(action)`, one storage read at 3.7k gas.
   - Four levels (Normal → Caution → Restricted → Frozen), each with a per-level allow-list (borrow, withdraw, liquidate, mint, bridge-out, swap). Repay, supply and add-collateral are never gated.
   - Five safety properties, each a Foundry invariant fuzzed over 65,536 calls per CI run:
     1. Tighten-only automation.
     2. Two-key relax: governance proposal, delay, no new trip, and a fresh watcher observation that agrees.
     3. Fail-safe liveness: if the watcher goes silent for a heartbeat, the guard is at least Caution, with no transaction needed.
     4. Monotone permissions.
     5. Reports bound to (chain, guard address), strictly ordered and fresh.
   - **Drop-in for Aave V3.** The guard implements `PriceOracleSentinel`. We proved it on a fork of the live Aave V3 market on Sepolia: Aave's own `borrow` and `liquidationCall` obey the guard after one governance call.
2. **The CRE workflow (TypeScript → WASM).** Every 30 s it:
   - reads the market's `riskSnapshot()`, the Chainlink ETH/USD Data Feed on Monad, and Perpl's `getPerpetualInfoV2` (oracle and mark);
   - fetches Coinbase, Kraken and Bitstamp in node mode and takes a **DON-consensus median** of the per-node medians;
   - runs a deterministic risk model covering deviation, reference spread, oracle staleness, utilization, outflow velocity and perp dislocation;
   - writes only when needed: on a trip, on a change of view, when a relax proposal matures (evidence), or on a heartbeat.

   Every report commits to an evidence hash of all inputs.
3. **A demo lending market** wired to the guard with one modifier, plus **a live monitor** (a static page reading Monad directly).

## How we use Chainlink CRE (Chainlink bounty)

- **Triggers:** a cron trigger, every 30 s.
- **EVM read capability on Monad testnet:** the market snapshot, the guard status, the **Chainlink Data Feed** (ETH/USD), and Perpl's perpetual, whose oracle is **Chainlink Data Streams** verified on-chain. All reads are at the finalized head, so every DON node sees the same state.
- **HTTP capability + consensus:** `runInNodeMode` fetches three exchanges; each node returns the median of the exchanges that answered (at least two); the DON aggregates with `consensusMedianAggregation`.
- **Reports + EVM write:** DON-signed reports are delivered through the Forwarder to `TripwireGuard.onReport`.
  - The receiver authenticates the Forwarder and the workflow identity.
  - Every payload carries `(chainSelector, guard address)`, because Forwarder signatures do not cover the receiver. This closes replay across guards and chains.
  - The workflow checks the receiver's execution status and fails loudly if the receiver reverts.
- **Determinism and limits:**
  - pure risk model on bigints with no floats, and decimal strings parsed exactly;
  - cron scheduled time as `observedAt`;
  - designed inside CRE quotas: 2 + 2×markets EVM reads (up to 6 markets in one workflow), 3 HTTP calls, and one write per market only when needed.
- **Tested like production code:**
  - 55 bun tests use the CRE SDK test runtime with EVM and HTTP capability mocks;
  - a golden report is checked byte for byte in both TypeScript and Solidity;
  - the workflow compiles to WASM in CI;
  - the full attack → trip → relax flow runs end to end with `cre workflow simulate --broadcast` (`scripts/local-e2e.sh`).

## How we use Perpl (Perpl bounty: Best Analytics/Risk Tool)

Tripwire turns Perpl's on-chain state into a risk signal for *other* protocols on Monad:
- **A third independent price reference.** Perpl's perpetual oracle price (Chainlink Data Streams, verified by the exchange) is read straight from the exchange contract with `getPerpetualInfoV2`. A lending market's oracle is now cross-checked against an independent on-chain venue on Monad itself.
- **A market-stress signal.** When Perpl's order book (mark price) dislocates from its oracle, the `PERP_DISLOCATION` reason moves dependent markets to Caution or Restricted, on a configurable ladder.
- **Safe by construction.** Stale Perpl data and markets with `ignOracle` are excluded automatically. The live monitor shows Perpl's oracle and mark next to the other references.

## What is new during the hackathon

Everything in this repository: contracts, workflow, tests, monitor and docs. It was started on 4 October 2026, inside the build window.

## Team

Pablo, a solo builder based in Spain.

## What's next

- CRE deploy access, then the production `KeystoneForwarder` with a pinned workflow owner.
- Pilot integrations with lending markets on Monad, using the Aave V3 sentinel path or the modifier.
- An external audit.
