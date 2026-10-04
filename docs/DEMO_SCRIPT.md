# Demo video

The video is generated, not hand-edited, so it always shows a real run:

1. `MODE=testnet bun tools/video/capture.ts` (or `MODE=local` against an anvil fork of Monad testnet) runs the real scenario:
   - push the market oracle 30% above the references;
   - run the CRE workflow (`cre workflow simulate --broadcast`), which trips the guard;
   - attempt a borrow, which reverts;
   - fix the oracle, propose a relax, let the watcher send fresh evidence, and execute the relax.

   At each step it captures the live monitor and the exact terminal output.
2. `bun tools/video/render.ts` turns the run into a 1080p video:
   - slides from `tools/video/slides.html`;
   - narration through the Windows speech synthesizer;
   - subtitles as an `.srt` file;
   - ffmpeg for the H.264/AAC encode, with loudness normalised to −16 LUFS.

Output: `tools/video/out/tripwire-demo.mp4` and `tripwire-demo.srt`.

## Narration

| # | Slide | Narration |
|---|---|---|
| 1 | `title` | This is Tripwire: a circuit breaker for lending markets on Monad, run by a Chainlink Runtime Environment workflow. It tightens a market within seconds of trouble, and it never loosens on its own. |
| 2 | `problem` | When a lending market's oracle is manipulated, a bad price can turn into bad debt in a single block. Today the defence is a person with a multisig, who has to notice, gather signers, and pause, often blocking repayments too. |
| 3 | `how` | Tripwire replaces the noticing. Every thirty seconds, a CRE workflow checks the market's own oracle against three independent references: a Chainlink data feed on Monad, a median of three exchanges agreed by the oracle network, and Perpl's on-chain perpetual, priced by Chainlink Data Streams. It also watches utilization, outflows, and stress on Perpl's order book. A deterministic risk model picks the level, and a DON-signed report enforces it on chain. |
| 4 | `dash-normal` | This is the monitor. The market is healthy: every action is allowed, and the references agree within a fraction of a percent. |
| 5 | `term-attack` | Now an attacker pushes the market's oracle thirty percent above reality. On the next run, the workflow measures a three thousand basis point deviation, and sends a signed report that trips the guard. |
| 6 | `dash-frozen` | The guard is frozen. Borrowing, withdrawals, and liquidations that would rely on the bad price are paused. Repaying, supplying, and adding collateral are never blocked. |
| 7 | `term-borrow` | The attacker's borrow against the inflated price simply reverts. |
| 8 | `relax` | Automation can only make a market safer. Reports and guardians can raise the level, never lower it. To relax, governance proposes, waits out a delay, and the watcher's fresh observation must agree. If the watcher ever goes silent, the guard fails safe on its own. |
| 9 | `term-relax` | Once the oracle is fixed, the watcher reports recovery, sends fresh evidence as soon as the proposal matures, and anyone can execute the relax. |
| 10 | `dash-relaxed` | The market is open again, with every signed report on chain. |
| 11 | `aave` | Integration is a single governance call. Tripwire implements Aave V3's price oracle sentinel, and we proved it on a fork of the live Aave V3 market: Aave's own borrow and liquidation logic obey the guard, with no code change. |
| 12 | `eng` | It is built to be trusted with a pause button: five safety invariants fuzzed over sixty-five thousand random calls, one golden report checked byte for byte in TypeScript and in Solidity, and a gated call that costs under four thousand gas. |
| 13 | `close` | Tripwire. Tighten in seconds, never loosen alone. Built for Monad, powered by Chainlink. |
