# Monad Metropolis submission: Tripwire

Field-by-field answers for the entry form at hackathon.monad.xyz.

| Field | Value |
|---|---|
| Primary track | **Onchain Finance & Trading** |
| Project logo | `tools/video/out/tripwire-logo.png` (1024×1024 PNG) |
| Project name | Tripwire |
| One-line description | A Chainlink CRE circuit breaker for Monad lending markets: tightens in seconds, never loosens on its own. |
| GitHub repository | https://github.com/allertrack/tripwire |
| Live product | https://allertrack.github.io/tripwire/ (reads Monad testnet directly) |
| Technical demo video | YouTube upload of `tools/video/out/tripwire-technical-demo.mp4` (2:17, real-time screen recording on Monad testnet) |
| Pitch video | YouTube upload of `tools/video/out/tripwire-pitch.mp4` (1:32) |
| Sponsor bounties | Chainlink: Best workflow with CRE · Perpl: Best Analytics/Risk Tool |

---

## Description

**The problem.** When a lending market's oracle is manipulated, or its liquidity starts to run, a bad price can become bad debt within a block. Fast chains make that faster. Today's defence is either:
- a human with a multisig who has to notice, gather signers and pause, minutes or hours later; or
- a blunt pause-everything switch that also blocks repayments and safe exits.

**What we built.** Tripwire is an automated, trust-minimised circuit breaker for lending markets on Monad, run by a Chainlink Runtime Environment (CRE) workflow.

1. **The watcher (a CRE workflow in TypeScript, compiled to WASM).** Every 30 seconds it reads, at the finalized head:
   - the market's own risk snapshot (oracle price and age, supply, borrows, trailing outflow);
   - the Chainlink ETH/USD Data Feed on Monad;
   - Perpl's on-chain perpetual on Monad, both its oracle price (Chainlink Data Streams) and its order-book mark price.

   It also fetches Coinbase, Kraken and Bitstamp in node mode and takes a DON-consensus median.

   A deterministic risk model, run on bigints with no floats, then derives a level from these signals:
   - deviation of the market oracle from the closest independent reference;
   - spread between the references;
   - oracle staleness;
   - utilization;
   - outflow velocity;
   - perp dislocation.

   The workflow writes a DON-signed report only when it matters: a stricter level, a changed view, fresh evidence for a matured relax proposal, or a heartbeat. Every report commits to an evidence hash of all inputs.
2. **The guard (`TripwireGuard`, Solidity on Monad).** It receives reports through the Chainlink Forwarder. It has four levels (Normal, Caution, Restricted, Frozen), each with a per-level allow-list of actions: borrow, withdraw, liquidate, mint, bridge-out and swap. Repay, supply and add-collateral are never gated, and positions below health factor 0.95 stay liquidatable. Markets ask `isAllowed(action)`, which is one storage read at 3.7k gas.

**What makes it trustworthy.** Five safety properties are enforced, each a Foundry invariant fuzzed over 65,536 random calls per CI run:
1. **Tighten-only automation.** Reports and guardians can raise the level but never lower it, so a compromised watcher can halt borrowing but cannot unfreeze anything.
2. **Two-key relax.** Lowering the level needs a governance proposal, a delay, no new trip since, and a fresh watcher observation that agrees. Execution is then permissionless.
3. **Fail-safe liveness.** If the watcher goes silent for a heartbeat, the effective level becomes at least Caution, with no transaction needed.
4. **Monotone permissions.** A stricter level never allows more.
5. **Bound, ordered reports.** Each report is bound to (chain, guard address), which closes replay across guards and chains, and must be strictly ordered and fresh.

**What makes it useful today.**
- **Drop-in for Aave V3 and its forks.** The guard implements Aave's `PriceOracleSentinel` (`isBorrowAllowed` / `isLiquidationAllowed`), so integrating is a single governance call: `setPriceOracleSentinel(guard)`. We proved this against Aave's own code on a fork of the live Aave V3 Sepolia market. Aave's `borrow` reverts after a workflow trip and when the watcher goes silent, and a marginal liquidation is paused at Restricted.
- **One modifier for any other market** (`TripwireProtected.whenAllowed`). Morpho Vault V2 sentinels and Euler vault hooks are the next adapters.
- **Live on Monad testnet with verified contracts.** The demo shows a real run:
  1. the market oracle is pushed 30% above reality;
  2. the CRE report trips the guard to Frozen;
  3. the attacker's borrow reverts;
  4. the oracle is fixed, but the guard stays Frozen;
  5. governance proposes a relax and the watcher sends fresh evidence;
  6. anyone executes the relax.

**Engineering.**
- 131 tests: 72 contract unit/fuzz/invariant tests, 4 tests against the live Aave V3 market, and 55 workflow tests on the CRE SDK test runtime.
- A golden report checked byte for byte in both TypeScript and Solidity.
- An end-to-end rehearsal with the real CRE simulator on a fork of Monad testnet.
- CI on every push.

---

## Go-to-market and user acquisition

**First users: risk teams that already own a pause button but have no automation behind it.**

1. **Aave DAO and its risk service provider, LlamaRisk.**
   - The proposed *Aave Risk Framework* (governance.aave.com, June 2026) has a layer for "automated freeze guardians that act between adverse events and human response".
   - A companion proposal moves Aave's risk oracles onto Chainlink CRE and plans to bring "the automated freeze guardian" onto the same infrastructure.
   - Aave V3 on Monad (≈ $324M deposits, DefiLlama) has no PriceOracleSentinel set today, and Tripwire is a drop-in sentinel already proven against Aave's code.
   - *How we reach them:* a governance forum post with the testnet evidence, direct conversation with LlamaRisk, and an open-source guard offered as a testnet pilot.
2. **Vault curators on Monad.** These are teams such as K3 Capital, Hyperithm, Steakhouse, Gamma Research and Clearstar, who together curate hundreds of millions on Morpho and Euler.
   - Morpho Vault V2 has a "sentinel" role that can only de-risk (decrease caps, deallocate), and Euler vaults have hook targets. Both are natural homes for a Tripwire guard.
   - *How we reach them:* their published business contacts and the Morpho and Euler forums, offering a per-vault guard pilot.
3. **Native Monad lending markets:** Curvance, Neverland (Aave V3 based, so the same sentinel path), Reservoir, TownSquare and Folks Finance. Each can integrate with one modifier or the sentinel.

**Acquisition channels.**
- The open-source code and the public live monitor serve as proof.
- Monad ecosystem introductions (DeltaV, Monad Foundation).
- Chainlink's ecosystem, as a CRE showcase.
- Incident replays: published analyses showing how Tripwire would have reacted to past oracle-manipulation incidents.

**Business model.**
- The core is open source.
- Revenue comes from operating the watcher workflow for each market, as a monthly fee per protected market with a monitoring SLA, and from custom risk models.
- The path is a paid pilot on testnet first, then an external audit and mainnet.

**Next 90 days.**
- Two pilots.
- Morpho sentinel and Euler hook adapters.
- CRE deploy access with a pinned workflow owner on the production Forwarder.
- Audit.

---

## Judge access instructions (optional field)

No login needed.

1. **Live monitor:** https://allertrack.github.io/tripwire/
   - It reads Monad testnet directly and shows the guard level, what the market allows, the watcher heartbeat, all price references (Chainlink Data Feed, Perpl oracle and mark), and the guard's on-chain activity feed.
2. **Contracts:** all verified on MonadVision. The addresses are in the README ("Deployments") and in `contracts/deployments/monad-testnet.json`.
3. **On-chain run:** the README links every transaction of the attack → trip → blocked borrow → relax sequence.
4. **Reproduce locally** (Foundry, Bun, CRE CLI with `cre login`):
   - `make install`
   - `make test`
   - `make e2e`, which runs the full scenario with the real CRE simulator against an anvil fork of Monad testnet; no funds needed.
5. **Note.** The watcher currently runs through `cre workflow simulate --broadcast`, because CRE deploy access is pending. If the monitor ever shows **CAUTION · Watcher silent**, that is the fail-safe described above working as designed.

---

## Bounty answers

### Chainlink: Best workflow with CRE

- **Trigger:** cron, every 30 s.
- **EVM read capability on Monad testnet**, at the finalized head:
  - the market snapshot;
  - the guard status;
  - the **Chainlink ETH/USD Data Feed**;
  - Perpl's perpetual, whose oracle is **Chainlink Data Streams**.
- **HTTP capability + consensus:** `runInNodeMode` fetches three exchanges. Each node returns the median of those that answered (at least two), and the DON aggregates with `consensusMedianAggregation`.
- **Reports + EVM write:** DON-signed reports go through the Forwarder to `TripwireGuard.onReport`.
  - The receiver authenticates the Forwarder and the workflow identity.
  - Every payload carries `(chainSelector, guard)`, because Forwarder signatures do not cover the receiver.
  - The workflow fails loudly if the receiver reverts.
- **Determinism and quotas:**
  - bigint-only model;
  - the cron's scheduled time as `observedAt`;
  - 2 + 2×markets EVM reads, so up to 6 markets per workflow;
  - 3 HTTP calls;
  - writes only when needed;
  - a 150k gas limit, against 98.8k measured, because Monad charges the gas limit.
- **Tested:**
  - 55 bun tests on the CRE SDK test runtime, with EVM and HTTP mocks;
  - a golden report shared with Solidity;
  - WASM compile in CI;
  - end-to-end `cre workflow simulate --broadcast` on Monad testnet (the demo video) and on a local fork (`make e2e`).

### Perpl: Best Analytics/Risk Tool

Tripwire turns Perpl's on-chain state into a risk signal for other Monad protocols. It reads `getPerpetualInfoV2` on Perpl's exchange (ETH perp, id 32) through CRE.
- **Third price reference.** Perpl's oracle price (Chainlink Data Streams, verified by the exchange) joins the Chainlink Data Feed and the exchange median.
- **Stress signal.** When the order book's mark price dislocates from the oracle, the `PERP_DISLOCATION` reason moves dependent markets to Caution or Restricted, on a configurable ladder.
- **Hygiene.** Stale data and `ignOracle` markets are excluded automatically.
- **Visibility.** The live monitor shows Perpl's oracle and mark next to the other references, and every report packs the dislocation in its metrics.
