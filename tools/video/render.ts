/**
 * Renders the demo video from a captured run: 1080p slides (real dashboard screenshots and terminal output),
 * narration with the Windows speech synthesizer, subtitles, and an H.264 MP4 via ffmpeg.
 *
 *   bun render.ts            # needs out/run.json from capture.ts
 *   REPO_URL=https://github.com/... bun render.ts
 *
 * Output: out/tripwire-demo.mp4, out/tripwire-demo.srt
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = resolve(import.meta.dir, '../..')
const OUT = join(import.meta.dir, 'out')
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const VOICE = process.env.VOICE ?? 'Microsoft Zira Desktop'
const run = JSON.parse(readFileSync(join(OUT, 'run.json'), 'utf8'))
mkdirSync(join(OUT, 'seg'), { recursive: true })

export const SEGMENTS: { slide: string; say: string }[] = [
	{ slide: 'title', say: 'This is Tripwire: a circuit breaker for lending markets on Monad, run by a Chainlink Runtime Environment workflow. It tightens a market within seconds of trouble, and it never loosens on its own.' },
	{ slide: 'problem', say: "When a lending market's oracle is manipulated, a bad price can turn into bad debt in a single block. Today the defence is a person with a multisig, who has to notice, gather signers, and pause, often blocking repayments too." },
	{ slide: 'how', say: "Tripwire replaces the noticing. Every thirty seconds, a CRE workflow checks the market's own oracle against three independent references: a Chainlink data feed on Monad, a median of three exchanges agreed by the oracle network, and Perpl's on-chain perpetual, priced by Chainlink Data Streams. It also watches utilization, outflows, and stress on Perpl's order book. A deterministic risk model picks the level, and a DON-signed report enforces it on chain." },
	{ slide: 'dash-normal', say: 'This is the monitor. The market is healthy: every action is allowed, and the references agree within a fraction of a percent.' },
	{ slide: 'term-attack', say: "Now an attacker pushes the market's oracle thirty percent above reality. On the next run, the workflow measures a three thousand basis point deviation, and sends a signed report that trips the guard." },
	{ slide: 'dash-frozen', say: 'The guard is frozen. Borrowing, withdrawals, and liquidations that would rely on the bad price are paused. Repaying, supplying, and adding collateral are never blocked.' },
	{ slide: 'term-borrow', say: "The attacker's borrow against the inflated price simply reverts." },
	{ slide: 'relax', say: "Automation can only make a market safer. Reports and guardians can raise the level, never lower it. To relax, governance proposes, waits out a delay, and the watcher's fresh observation must agree. If the watcher ever goes silent, the guard fails safe on its own." },
	{ slide: 'term-relax', say: 'Once the oracle is fixed, the watcher reports recovery, sends fresh evidence as soon as the proposal matures, and anyone can execute the relax.' },
	{ slide: 'dash-relaxed', say: 'The market is open again, with every signed report on chain.' },
	{ slide: 'aave', say: "Integration is a single governance call. Tripwire implements Aave V3's price oracle sentinel, and we proved it on a fork of the live Aave V3 market: Aave's own borrow and liquidation logic obey the guard, with no code change." },
	{ slide: 'eng', say: 'It is built to be trusted with a pause button: five safety invariants fuzzed over sixty-five thousand random calls, one golden report checked byte for byte in TypeScript and in Solidity, and a gated call that costs under four thousand gas.' },
	{ slide: 'close', say: 'Tripwire. Tighten in seconds, never loosen alone. Built for Monad, powered by Chainlink.' },
]

// ─── Terminal transcripts (real output from capture.ts and forge) ──────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const shortHash = (s: string) => s.replace(/0x([0-9a-f]{6})[0-9a-f]{52}([0-9a-f]{6})/g, '0x$1…$2')
const paint = (line: string) => {
	const l = esc(shortHash(line))
	// Colour by what the watcher concluded (start of line), not by the guard state it mentions.
	if (/^tWETH\/tUSDC: (Frozen|Restricted|Caution)|:trip:|TripwirePaused|reverted|FAIL/.test(line)) return `<span class="hl">${l}</span>`
	if (/^tWETH\/tUSDC: Normal|:(change|evidence|heartbeat):Normal|\(ok\)|PASS|guard level = Normal/.test(line)) return `<span class="ok">${l}</span>`
	return l
}
const usd = (v: string) => `$${(Number(v) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** Adds a readable dollar line under each raw `references:` log line. */
const withDollars = (lines: string[]) =>
	lines.flatMap((line) => {
		const m = line.match(/^references: chainlink=(\d+|-) exchanges=(\d+|-) perpl=(\d+|-)/)
		if (!m) return [paint(line)]
		const parts = [m[1] !== '-' && `Chainlink ${usd(m[1])}`, m[2] !== '-' && `exchanges ${usd(m[2])}`, m[3] !== '-' && `Perpl ${usd(m[3])}`]
		return [paint(line), dim(`# ${parts.filter(Boolean).join(' · ')}`)]
	})
const cmd = (c: string) => `<span class="cmd">$ ${esc(c)}</span>`
const dim = (c: string) => `<span class="dim">${esc(c)}</span>`

const aaveOut = (() => {
	const p = Bun.spawnSync(['forge', 'test', '--match-path', 'test/fork/*'], { cwd: join(ROOT, 'contracts'), stdout: 'pipe', stderr: 'pipe' })
	return p.stdout.toString().split(/\r?\n/).filter((l) => /\[PASS\]|\[FAIL|Suite result/.test(l)).map((l) => l.replace(/\s*\(gas: \d+\)/, ''))
})()

const terms = {
	attack: [
		dim('# attacker pushes the market oracle 30% above Chainlink and the exchanges'),
		cmd(`cast send <market oracle> "pushAnswer(int256)" ${run.attack.pumped}`),
		dim(`tx ${shortHash(run.attack.attackTx)}`),
		'',
		cmd('cre workflow simulate tripwire --broadcast'),
		...withDollars(run.attack.logs),
	].join('\n'),
	borrow: [
		cmd('cast send <pool> "borrow(uint256)" 25000000000   # 25,000 tUSDC against the inflated price'),
		paint(`Error: execution reverted: ${run.borrow.replace(/^.*: (TripwirePaused\(\d+\))$/, '$1')}`),
		dim('# TripwirePaused(1) = action BORROW is paused at the current level'),
	].join('\n'),
	relax: [
		cmd('cast send <market oracle> "clearOverride()"   # oracle fixed: back to the live Chainlink feed'),
		dim('# the watcher reports recovery; the guard stays Frozen (tighten-only)'),
		...run.recovery.filter((l: string) => !l.startsWith('references')).map(paint),
		'',
		cmd('cast send <guard> "proposeRelax(uint8)" 0     # governance, then the delay'),
		dim(`tx ${shortHash(run.relax.proposeTx)}`),
		...run.evidence.filter((l: string) => !l.startsWith('references')).map(paint),
		'',
		cmd('cast send <guard> "executeRelax()"            # anyone'),
		paint(`tx ${shortHash(run.relax.relaxTx)}  guard level = Normal`),
	].join('\n'),
	aave: aaveOut.map(paint).join('\n'),
}

const contractTests = (() => {
	const p = Bun.spawnSync(['forge', 'test', '--no-match-path', 'test/fork/*'], { cwd: join(ROOT, 'contracts'), stdout: 'pipe', stderr: 'pipe' })
	const m = p.stdout.toString().match(/test suites in [^:]*: (\d+) tests passed, 0 failed/)
	if (!m) throw new Error(`contract tests did not pass:
${p.stdout.toString().slice(-2000)}`)
	return m[1]
})()
const workflowTests = (() => {
	const p = Bun.spawnSync(['bun', 'test'], { cwd: join(ROOT, 'workflow/tripwire'), stdout: 'pipe', stderr: 'pipe' })
	return (p.stdout.toString() + p.stderr.toString()).match(/(\d+) pass/)?.[1] ?? '?'
})()

const data = {
	terms,
	shots: Object.fromEntries(['normal.png', 'frozen.png', 'relaxed.png'].map((f) => [f, pathToFileURL(join(OUT, f)).href])),
	eng: [
		'5 safety invariants · 65,536 fuzzed calls per CI run',
		`${contractTests} contract tests + ${aaveOut.filter((l) => l.includes('[PASS]')).length} Aave V3 fork tests · ${workflowTests} workflow tests`,
		'Golden report shared by TypeScript and Solidity',
		run.mode === 'testnet' ? 'Real CRE simulator, end to end, on Monad testnet' : 'Real CRE simulator, end to end, on a Monad testnet fork',
		'3 references: Data Feed · DON exchange median · Data Streams',
	],
	links: [process.env.REPO_URL, 'Monad testnet · chain 10143'].filter(Boolean).join('<br>'),
}

// ─── Slides ─────────────────────────────────────────────────────────────────
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(OUT, '.chrome-profile'), args: ['--allow-file-access-from-files'] })
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })
await page.evaluateOnNewDocument((d) => Object.assign(window, { __data: d }), data)
for (const s of SEGMENTS) {
	await page.goto(`${pathToFileURL(join(import.meta.dir, 'slides.html')).href}?s=${s.slide}`, { waitUntil: 'networkidle0' })
	await page.evaluate(() => document.fonts.ready)
	await page.screenshot({ path: join(OUT, 'seg', `${s.slide}.png`) as `${string}.png` })
}
await browser.close()

// ─── Narration (Windows SAPI) ───────────────────────────────────────────────
writeFileSync(join(OUT, 'seg', 'narration.json'), JSON.stringify(SEGMENTS))
const ps = `
Add-Type -AssemblyName System.Speech
$segs = Get-Content -Raw '${join(OUT, 'seg', 'narration.json')}' | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('${VOICE}')
$s.Rate = 1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($seg in $segs) {
  $s.SetOutputToWaveFile('${join(OUT, 'seg')}\\' + $seg.slide + '.wav', $fmt)
  $s.Speak($seg.say)
}
$s.SetOutputToNull()
`
const tts = Bun.spawnSync(['powershell', '-NoProfile', '-Command', ps], { stdout: 'pipe', stderr: 'pipe' })
if (tts.exitCode !== 0) throw new Error(`TTS failed: ${tts.stderr.toString()}`)

// ─── Video ──────────────────────────────────────────────────────────────────
const ffprobeDuration = (file: string) =>
	Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { stdout: 'pipe' }).stdout.toString().trim())
const LEAD = 0.5 // silence before each line
const TAIL = 0.9 // silence after
const srt: string[] = []
let clock = 0
const ts = (t: number) => {
	const ms = Math.round(t * 1000)
	const p = (n: number, w = 2) => String(n).padStart(w, '0')
	return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}
const list: string[] = []
SEGMENTS.forEach((s, i) => {
	const wav = join(OUT, 'seg', `${s.slide}.wav`)
	const speech = ffprobeDuration(wav)
	const dur = LEAD + speech + TAIL
	const mp4 = join(OUT, 'seg', `${String(i).padStart(2, '0')}-${s.slide}.mp4`)
	const r = Bun.spawnSync(
		[
			'ffmpeg', '-y', '-loglevel', 'error',
			'-loop', '1', '-framerate', '30', '-i', join(OUT, 'seg', `${s.slide}.png`),
			'-i', wav,
			'-filter_complex',
			`[0:v]format=yuv420p,fade=t=in:st=0:d=0.35,fade=t=out:st=${(dur - 0.35).toFixed(2)}:d=0.35[v];[1:a]adelay=${LEAD * 1000}|${LEAD * 1000},apad,atrim=0:${dur.toFixed(3)},aresample=48000[a]`,
			'-map', '[v]', '-map', '[a]', '-t', dur.toFixed(3),
			'-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-tune', 'stillimage', '-r', '30',
			'-c:a', 'aac', '-b:a', '160k', '-ac', '2', mp4,
		],
		{ stdout: 'pipe', stderr: 'pipe' },
	)
	if (r.exitCode !== 0) throw new Error(`ffmpeg segment ${s.slide}: ${r.stderr.toString()}`)
	srt.push(`${i + 1}\n${ts(clock + LEAD)} --> ${ts(clock + LEAD + speech)}\n${s.say}\n`)
	clock += dur
	list.push(`file '${mp4.replace(/\\/g, '/')}'`)
})
writeFileSync(join(OUT, 'seg', 'list.txt'), list.join('\n'))
const cat = Bun.spawnSync(
	[
		'ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(OUT, 'seg', 'list.txt'),
		// Video untouched; narration normalised to streaming loudness (-16 LUFS).
		'-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
		'-movflags', '+faststart', join(OUT, 'tripwire-demo.mp4'),
	],
	{ stdout: 'pipe', stderr: 'pipe' },
)
if (cat.exitCode !== 0) throw new Error(`ffmpeg concat: ${cat.stderr.toString()}`)
writeFileSync(join(OUT, 'tripwire-demo.srt'), srt.join('\n'))
console.log(`rendered ${join(OUT, 'tripwire-demo.mp4')} (${clock.toFixed(1)} s)`)
