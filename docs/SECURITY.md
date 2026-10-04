# Security model

Tripwire adds an automated way to **restrict** a market. The question that matters is what goes wrong when the automation itself goes wrong. The design answers it by making every automated path one-directional.

## Actors and powers

| Actor | Can | Cannot |
|---|---|---|
| CRE workflow (via the Forwarder) | raise the level; refresh liveness; record its view (evidence) | lower the level; change any configuration |
| Guardian (incident responder) | raise the level (`trip`); cancel a pending relax | lower the level; change configuration |
| Governance (`owner`, should be a timelock or multisig) | propose a relax; configure permissions, liveness, relax delay, guardians and workflow identity | execute a relax the watcher disagrees with, before its delay, or after a newer trip |
| Anyone | execute a matured relax that meets every condition | anything else |

## Invariants (Foundry, `test/TripwireGuard.invariant.t.sol`)

The handler interleaves:
- reports, some late or out of order;
- guardian trips;
- relax proposals, executions and cancellations;
- liveness reconfiguration;
- time jumps.

| # | Invariant | Meaning |
|---|---|---|
| 1 | `invariant_tightenOnlyOutsideRelax` | No action other than `executeRelax` ever lowers the stored level. |
| 2 | `invariant_relaxNeedsBothKeys` | Every successful relax had all of these: a proposal; its delay elapsed; a fresh watcher; the watcher's latest level ≤ target; the epoch bumped exactly once. |
| 3 | `invariant_failSafeLiveness` | The effective level is ≥ the stored level and, while the watcher is stale, ≥ `staleLevel`. `stale` equals `now > lastObservedAt + heartbeat`. |
| 4 | `invariant_permissionsMonotone` | allowed(level L+1) ⊆ allowed(level L). |
| 5 | `invariant_observationsInOrder` | `lastObservedAt` never decreases. |

The handler was probed to confirm that runs really reach the trip and relax paths, so the invariants are not vacuous. CI runs 512 × 128 = 65,536 calls.

## Threats and mitigations

**Compromised or buggy workflow.**
- **Worst case:** it raises the level and keeps it there, halting borrowing and withdrawals. That is a liveness failure, not a solvency failure. Repay, supply and add-collateral are never gated, and positions below HF 0.95 stay liquidatable.
- **Recovery:** a guardian alerts; governance rotates the workflow identity (`setWorkflowIdentity`) and relaxes.
- **What it cannot do:** fake a relax on its own. Governance must propose first.

**Silent workflow (DON outage, quota, RPC failures).**
The guard fails safe once one heartbeat passes without a report: 15 min in the demo, configurable from 60 s to 7 d. No keeper is needed, because staleness is evaluated inside `isAllowed`.

**Report replay.**
The Forwarder signs the report but not the receiver it is delivered to, and the same applies across chains. Every payload therefore starts with `(uint64 chainSelector, address target)`, and `CREReceiver` rejects any mismatch. Tested in `test_report_rejectsOtherTarget` and `test_report_rejectsOtherChain`.

**Stale or delayed reports.**
- `observedAt` must be strictly greater than the last one.
- It must not be more than `MAX_CLOCK_SKEW` (60 s) ahead of the chain.
- It must not be older than `maxReportAge` (5 min in the demo).

A delayed report therefore can neither refresh liveness nor serve as relax evidence.

**Wrong workflow reporting through the real Forwarder.**
`CREReceiver` pins the workflow owner, and optionally its name or ID. A production identity that pins neither is rejected at configuration time (`WorkflowIdentityNotConfigured`).

**Reference manipulation.**
- **Closest reference wins.** The market oracle is compared against the closest of up to three independent references: the Chainlink Data Feed, the exchange median under DON consensus, and Perpl's Data Streams oracle. One bad reference cannot trip a healthy market.
- **References are cross-checked.** If the references disagree with each other by more than `maxSpreadBps`, that is a signal in its own right (Caution).
- **Unanimity is required to look healthy.** To hide a manipulated market oracle, an attacker would have to move *all* references in the same direction.
- **No references at all** means Caution, never a silent pass.

**Exchange APIs.**
- Each node takes the median of the exchanges that answered and needs at least `minExchanges` of them. The DON then takes the median across nodes.
- One exchange that is down or wrong cannot move the reference by itself.
- Responses are parsed as exact decimal strings into fixed-point bigints, never floats.

**Governance key compromise.**
Out of scope for the guard itself: the owner can reconfigure everything. Deploy with a timelock owner and a separate guardian set.

## Known limitations

- **Testnet trust.** The testnet deployment uses the CRE *simulation* Forwarder with `trustForwarderOnly`, because that Forwarder delivers no workflow metadata and checks no signatures. On testnet, anyone can therefore call it to raise the level, or to post a "Normal" view that a governance relax could use as evidence. Production uses the `KeystoneForwarder` and a pinned workflow owner.
- **Finalized reads.** The workflow reads at the finalized head, so every DON node sees the same state. On Monad that adds about 1 s.
- **Approximate outflow window.** The demo market's outflow window is a sliding-window *estimate*. It never under-counts the current fixed window and never over-counts the last two, a property that is fuzzed in `SlidingWindow.t.sol`.
- **Demo market.** The demo lending pool is intentionally minimal: no interest, no bad-debt handling.
- **Not audited.**
