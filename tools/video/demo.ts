/**
 * Technical demo video: a real-time screen recording of the working product on Monad testnet (live monitor on the
 * left, the actual terminal output on the right), with narration and subtitles. No slides.
 *
 *   bun demo.ts record   # drives the scenario on Monad testnet and records out/demo-raw.mp4 + out/demo-marks.json
 *   bun demo.ts render       # cuts the relax-delay wait, adds narration -> out/tripwire-technical-demo.mp4 (+ .srt)
 *   bun demo.ts render-cre   # Chainlink bounty cut (≤ 2 min, CRE narration) -> out/tripwire-cre-demo.mp4 (+ .srt)
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import puppeteer, { type Frame, type Page } from 'puppeteer-core'

const ROOT = resolve(import.meta.dir, '../..')
const OUT = join(import.meta.dir, 'out')
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const RPC = 'https://testnet-rpc.monad.xyz'
const RELAX_DELAY = 60
const STATUS = 'status()((uint8,uint8,bool,uint32,uint32,uint40,uint32,uint8,uint8,uint32,uint64,bool,uint8,uint40,uint40))'

/** One narration line per step; a line never starts before its step nor overlaps the previous one. */
const NARRATION: Record<number, string> = {
	1: 'This is Tripwire running live on Monad testnet. On the left, the monitor of a lending market protected by a Tripwire guard. On the right, the real terminal.',
	2: "A Chainlink CRE workflow checks the market against the Chainlink data feed, three exchanges agreed by the oracle network, and Perpl's on-chain perpetual. Everything agrees, so the guard stays normal.",
	3: "An attacker pushes the market's oracle thirty percent above reality. On the next run, the workflow measures the deviation and sends a DON-signed report. The guard trips to frozen.",
	4: 'The attacker tries to borrow against the inflated price. The transaction reverts.',
	5: 'The oracle is fixed. The watcher reports that the market is healthy again, but the guard stays frozen, because automation can only tighten.',
	6: 'Governance proposes to relax, and must wait out the delay.',
	7: 'When the proposal matures, the watcher sends fresh evidence, and anyone can execute the relax. The market is open again.',
	8: 'Every step is a real transaction on Monad testnet. This is the receipt of the report that tripped the guard, delivered through the Chainlink forwarder.',
}

/** Chainlink bounty cut (≤ 2 min): same recording, CRE-focused narration, ends before the receipt step. */
const CRE_NARRATION: Record<number, string> = {
	1: 'This is a Chainlink CRE workflow running through the CRE CLI simulator, writing real transactions to Monad testnet.',
	2: "Each run reads the market, the Chainlink data feed and Perpl's perpetual through the EVM capability, and three exchanges through the HTTP capability with DON consensus. All references agree.",
	3: "An attacker pushes the market's oracle thirty percent higher. The next run measures the deviation, and the DON-signed report goes through the forwarder to the guard. It trips to frozen.",
	4: "The attacker's borrow reverts.",
	5: 'The oracle is fixed. The workflow reports recovery, but the guard stays frozen: CRE reports can only tighten.',
	6: 'Governance proposes a relax.',
	7: 'When it matures, the workflow sends fresh evidence and the relax executes. One workflow orchestrates the reads, the consensus, the risk logic and the onchain write.',
}

const envFile = (path: string) =>
	Object.fromEntries(
		readFileSync(path, 'utf8')
			.split(/\r?\n/)
			.filter((l) => /^[A-Z_]+=/.test(l))
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
	)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd: string[], cwd = ROOT) => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
	return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '') }
}
const short = (h: string) => h.replace(/0x([0-9a-f]{6})[0-9a-f]{52}([0-9a-f]{6})/gi, '0x$1…$2')

async function record() {
	const key = envFile(join(ROOT, 'contracts/.env')).PRIVATE_KEY
	const dep = JSON.parse(readFileSync(join(ROOT, 'contracts/deployments/monad-testnet.json'), 'utf8'))
	const cast = (...a: string[]) => sh(['cast', ...a, '--rpc-url', RPC])
	const send = (to: string, sig: string, ...args: string[]) =>
		sh(['cast', 'send', to, sig, ...args, '--private-key', key, '--rpc-url', RPC, '--json'])
	const level = () => Number(cast('call', dep.guard, STATUS).out.slice(1).split(',')[0])

	// ─── Preconditions (not recorded) ───────────────────────────────────────
	writeFileSync(join(ROOT, 'dashboard/deployment.capture.json'), JSON.stringify({ ...dep, rpc: RPC }, null, 2))
	writeFileSync(join(ROOT, 'workflow/.env'), readFileSync(join(ROOT, 'workflow/.env.testnet')))
	if (cast('call', dep.oracle, 'overridden()(bool)').out.trim() === 'true') send(dep.oracle, 'clearOverride()')
	if (level() !== 0) throw new Error('guard must be Normal before recording')
	if (!send(dep.guard, 'setRelaxDelay(uint32)', String(RELAX_DELAY)).ok) throw new Error('setRelaxDelay failed')
	const clPrice = cast('call', dep.chainlinkFeed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)').out.split('\n')[1].split(' ')[0]

	const server = Bun.serve({
		port: 5174,
		fetch: (req) => {
			const path = new URL(req.url).pathname
			if (path === '/stage') return new Response(Bun.file(join(import.meta.dir, 'stage.html')))
			return new Response(Bun.file(join(ROOT, 'dashboard', path === '/' ? 'index.html' : path)))
		},
	})
	const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(OUT, '.chrome-profile') })
	const page: Page = await browser.newPage()
	await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 })
	await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
	await page.goto('http://localhost:5174/stage', { waitUntil: 'networkidle2' })
	const dash = (): Frame => page.frames().find((f) => f.url().includes('deployment.capture'))!
	const waitDash = (fn: string, timeout = 90_000) => dash().waitForFunction(fn, { timeout, polling: 500 })
	await waitDash(`document.getElementById('levelName')?.textContent === 'NORMAL'`)
	await sleep(3_000)

	const line = (text: string, cls = '') => page.evaluate((t, c) => (window as any).__line(t, c), text, cls)
	const marks: { step: number; t: number }[] = []
	let cut = { start: 0, end: 0 }
	const t0 = performance.now()
	const now = () => (performance.now() - t0) / 1000
	const step = async (n: number, caption: string) => {
		marks.push({ step: n, t: now() })
		await page.evaluate((s, c) => (window as any).__caption(s, c), String(n), caption)
	}
	const runTx = async (label: string, to: string, sig: string, ...args: string[]) => {
		await line(`$ cast send ${label} "${sig}" ${args.join(' ')}`.trim(), 'cmd')
		const r = send(to, sig, ...args)
		if (r.ok) await line(`tx ${short(JSON.parse(r.out).transactionHash)}  status 1 (success)`, 'dim')
		return r
	}
	/** Streams the CRE simulator's own output into the terminal as it happens. */
	const cre = async () => {
		await line('$ cre workflow simulate tripwire --target testnet-settings --broadcast', 'cmd')
		const p = Bun.spawn(['cre', 'workflow', 'simulate', 'tripwire', '--target', 'testnet-settings', '--non-interactive', '--trigger-index', '0', '--broadcast'], {
			cwd: join(ROOT, 'workflow'),
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const decoder = new TextDecoder()
		let buf = ''
		for await (const chunk of p.stdout) {
			buf += decoder.decode(chunk)
			const lines = buf.split(/\r?\n/)
			buf = lines.pop() ?? ''
			for (const raw of lines) {
				const l = raw.replace(/\x1b\[[0-9;]*m/g, '')
				if (/Workflow compiled|Simulator Initialized|Running trigger/.test(l)) await line(l.replace(/^\S+Z /, ''), 'dim')
				else if (/\[USER LOG\]/.test(l)) {
					const msg = l.replace(/^.*\[USER LOG\] /, '')
					await line(msg, /: (Frozen|Restricted|Caution) /.test(msg) ? 'bad' : /: Normal /.test(msg) ? 'ok' : '')
				} else if (/^"tWETH/.test(l)) await line(short(l), /:trip:/.test(l) ? 'bad' : 'ok')
			}
		}
		await p.exited
	}

	// Timestamped screenshots (≈6 fps): exact wall-clock timing, unlike a screencast encoder.
	const framesDir = join(OUT, 'demo-frames')
	rmSync(framesDir, { recursive: true, force: true })
	mkdirSync(framesDir, { recursive: true })
	const frames: { file: string; t: number }[] = []
	let recording = true
	const loop = (async () => {
		while (recording) {
			const t = now()
			const file = join(framesDir, `f${String(frames.length).padStart(5, '0')}.jpg`)
			try {
				await page.screenshot({ path: file as `${string}.jpeg`, type: 'jpeg', quality: 88 })
				frames.push({ file, t })
			} catch {}
			const spent = now() - t
			if (spent < 0.16) await sleep((0.16 - spent) * 1000)
		}
	})()
	await step(1, 'A lending market on Monad testnet, guarded by Tripwire <span>· every action allowed</span>')
	await sleep(9_000)

	await step(2, 'The Chainlink CRE watcher runs <span>· all references agree: Normal</span>')
	await cre()
	await sleep(5_000)

	await step(3, 'Attack: the market oracle is pushed 30% above reality')
	const pumped = ((BigInt(clPrice) * 13n) / 10n).toString()
	await runTx('<market oracle>', dep.oracle, 'pushAnswer(int256)', pumped)
	await sleep(4_000)
	await cre()
	await waitDash(`document.getElementById('levelName')?.textContent === 'FROZEN'`)
	await sleep(7_000)

	await step(4, 'The attacker tries to borrow against the inflated price')
	await line('$ cast send <pool> "borrow(uint256)" 25000000000   # 25,000 tUSDC', 'cmd')
	const b = send(dep.pool, 'borrow(uint256)', '25000000000')
	await line(b.ok ? 'UNEXPECTED: borrow succeeded' : 'Error: execution reverted: TripwirePaused(1)  # BORROW paused', 'bad')
	await sleep(6_000)

	await step(5, 'Oracle fixed <span>· the guard stays Frozen: automation only tightens</span>')
	await runTx('<market oracle>', dep.oracle, 'clearOverride()')
	await sleep(4_000)
	await cre()
	await sleep(7_000)

	await step(6, `Governance proposes to relax <span>· ${RELAX_DELAY} s delay, skipped in this edit</span>`)
	await runTx('<guard>', dep.guard, 'proposeRelax(uint8)', '0')
	await sleep(7_000)
	const readyAt = Number(cast('call', dep.guard, STATUS).out.slice(1).split(',')[13].trim().split(' ')[0])
	cut = { start: now(), end: 0 }
	while (Math.floor(Date.now() / 1000) < readyAt + 3) await sleep(1_000)
	await sleep(3_000)
	cut.end = now()

	await step(7, 'The watcher agrees <span>· anyone executes the matured relax</span>')
	await cre()
	await runTx('<guard>', dep.guard, 'executeRelax()')
	await waitDash(`document.getElementById('levelName')?.textContent === 'NORMAL'`)
	await sleep(3_000)
	await waitDash(`document.getElementById('feed')?.textContent?.includes('RELAXED')`)
	await page.evaluate(() => (window as any).__scrollDash(1200))
	await sleep(9_000)

	await step(8, 'Every step is on chain <span>· contracts verified on MonadVision</span>')
	// The CRE report that tripped the guard, delivered through the Chainlink Forwarder.
	const tripUrl = await dash().evaluate(
		() =>
			[...document.querySelectorAll('#feed .ev')].find((e) => e.textContent?.includes('TRIPPED'))?.querySelector('a')?.getAttribute('href') ?? '',
	)
	const tripTx = tripUrl.split('/').pop() ?? ''
	if (/^0x[0-9a-f]{64}$/i.test(tripTx)) {
		await line(`$ cast receipt ${short(tripTx)}   # the report that tripped the guard`, 'cmd')
		const rc = cast('receipt', tripTx).out
		const field = (k: string) => rc.match(new RegExp(String.raw`^${k}\s+(.*)$`, 'm'))?.[1]?.trim() ?? '?'
		await line(`status        ${field('status')}`, 'ok')
		await line(`blockNumber   ${field('blockNumber')}`)
		await line(`to            ${field('to')}   # Chainlink CRE forwarder`)
	}
	await line(`$ cast call <guard> "status()"`, 'cmd')
	const st = cast('call', dep.guard, STATUS).out.slice(1).split(',').map((x) => x.trim().split(' ')[0])
	await line(`level ${st[0]} (Normal) · epoch ${st[4]} · watcher's view ${st[8]} · relax pending ${st[11]}`, 'ok')
	await sleep(10_000)

	recording = false
	await loop
	writeFileSync(join(OUT, 'demo-marks.json'), JSON.stringify({ marks, cut, duration: now(), frames }, null, 2))
	await browser.close()
	server.stop()
	console.log('recorded', JSON.stringify({ marks, cut }))
}

type RenderOptions = { narration: Record<number, string>; name: string; speed: number; endBeforeStep?: number }

async function render({ narration, name, speed, endBeforeStep }: RenderOptions) {
	const rec = JSON.parse(readFileSync(join(OUT, 'demo-marks.json'), 'utf8')) as {
		marks: { step: number; t: number }[]
		cut: { start: number; end: number }
		frames: { file: string; t: number }[]
		duration: number
	}
	const { cut, frames } = rec
	const endT = endBeforeStep ? (rec.marks.find((m) => m.step === endBeforeStep)?.t ?? rec.duration) : rec.duration
	const marks = rec.marks.filter((m) => m.t < endT)
	const probe = (f: string) =>
		Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { stdout: 'pipe' }).stdout.toString().trim())
	const removed = cut.end - cut.start
	/** Recording time -> output time: the relax-delay wait is cut, then the whole timeline is sped up by `speed`. */
	const mapT = (t: number) => (t >= cut.end ? t - removed : Math.min(t, cut.start)) / speed
	// Concat list with each frame held until the next one; frames inside the cut (or after the end) are dropped.
	const kept = frames.filter((f) => (f.t < cut.start || f.t >= cut.end) && f.t < endT)
	const posix = (p: string) => p.replaceAll('\\', '/')
	const list = kept.map((f, i) => {
		const next = i + 1 < kept.length ? mapT(kept[i + 1].t) : mapT(endT)
		return `file '${posix(f.file)}'\nduration ${Math.max(0.001, next - mapT(f.t)).toFixed(3)}`
	})
	// The concat demuxer needs the last file repeated for its duration to apply.
	writeFileSync(join(OUT, `${name}-frames.txt`), `${list.join('\n')}\nfile '${posix(kept[kept.length - 1].file)}'\n`)
	const raw = join(OUT, `${name}-raw.mp4`)
	const enc = Bun.spawnSync(
		['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(OUT, `${name}-frames.txt`), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', raw],
		{ stdout: 'pipe', stderr: 'pipe' },
	)
	if (enc.exitCode !== 0) throw new Error(`ffmpeg frames: ${enc.stderr.toString()}`)

	// Narration (Windows SAPI), one wav per step.
	writeFileSync(join(OUT, `${name}-narration.json`), JSON.stringify(Object.entries(narration).map(([step, say]) => ({ step, say }))))
	const ps = `
Add-Type -AssemblyName System.Speech
$segs = Get-Content -Raw '${join(OUT, `${name}-narration.json`)}' | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('${process.env.VOICE ?? 'Microsoft Zira Desktop'}')
$s.Rate = 1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($seg in $segs) { $s.SetOutputToWaveFile('${join(OUT, `${name}-n`)}' + $seg.step + '.wav', $fmt); $s.Speak($seg.say) }
$s.SetOutputToNull()
`
	const tts = Bun.spawnSync(['powershell', '-NoProfile', '-Command', ps], { stdout: 'pipe', stderr: 'pipe' })
	if (tts.exitCode !== 0) throw new Error(`TTS failed: ${tts.stderr.toString()}`)

	// Place each line at its (mapped) step time, never overlapping the previous line.
	const placed: { step: number; at: number; dur: number; say: string }[] = []
	let prevEnd = 0
	for (const m of marks) {
		const say = narration[m.step]
		if (!say) continue
		const dur = probe(join(OUT, `${name}-n${m.step}.wav`))
		const at = Math.max(mapT(m.t) + 0.4, prevEnd + 0.3)
		placed.push({ step: m.step, at, dur, say })
		prevEnd = at + dur
	}
	const videoDur = probe(raw)
	const finalDur = Math.max(videoDur, prevEnd + 1.0)

	const inputs = ['-i', raw, ...placed.flatMap((p) => ['-i', join(OUT, `${name}-n${p.step}.wav`)])]
	const vcut = `[0:v]tpad=stop_mode=clone:stop_duration=${Math.max(0, finalDur - videoDur + 0.1).toFixed(2)},format=yuv420p,fade=t=in:st=0:d=0.4[v]`
	const audio = placed.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)}[a${i}]`).join(';')
	const mix = `${placed.map((_, i) => `[a${i}]`).join('')}amix=inputs=${placed.length}:normalize=0,apad,atrim=0:${finalDur.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`
	const out = join(OUT, `${name}.mp4`)
	const r = Bun.spawnSync(
		['ffmpeg', '-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${vcut};${audio};${mix}`, '-map', '[v]', '-map', '[a]',
			'-t', finalDur.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', out],
		{ stdout: 'pipe', stderr: 'pipe' },
	)
	if (r.exitCode !== 0) throw new Error(`ffmpeg: ${r.stderr.toString()}`)
	const ts = (t: number) => {
		const ms = Math.round(t * 1000)
		const p = (n: number, w = 2) => String(n).padStart(w, '0')
		return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
	}
	writeFileSync(join(OUT, `${name}.srt`), placed.map((p, i) => `${i + 1}\n${ts(p.at)} --> ${ts(p.at + p.dur)}\n${p.say}\n`).join('\n'))
	console.log(`rendered ${out} (${finalDur.toFixed(1)} s; cut ${removed.toFixed(1)} s of waiting; speed ${speed}x)`)
}

const mode = process.argv[2]
if (mode === 'record') await record()
else if (mode === 'render') await render({ narration: NARRATION, name: 'tripwire-technical-demo', speed: 1 })
else if (mode === 'render-cre') await render({ narration: CRE_NARRATION, name: 'tripwire-cre-demo', speed: 1.07, endBeforeStep: 8 })
else console.log('usage: bun demo.ts record|render|render-cre')
