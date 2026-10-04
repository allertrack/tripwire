/**
 * Perpl bounty video (≤ 2 min): a real-time walkthrough of the Perpl Risk Monitor on Monad mainnet, with narration.
 * Narration is synthesised first so every step is held exactly as long as its line.
 *
 *   bun perpl-demo.ts   # -> out/tripwire-perpl-demo.mp4 (+ .srt)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'

const ROOT = resolve(import.meta.dir, '../..')
const OUT = join(import.meta.dir, 'out')
const NAME = 'tripwire-perpl-demo'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const STEPS: { caption: string; say: string }[] = [
	{ caption: 'Tripwire · Perpl Risk Monitor <span>· live on Monad mainnet, read directly from the exchange contract</span>', say: "This is the Tripwire Perpl Risk Monitor: a live view of Perpl's on-chain state on Monad mainnet, read straight from the exchange contract, with no backend." },
	{ caption: 'Protocol level <span>· collateral, insurance, open interest, notional near liquidation</span>', say: 'At the protocol level: collateral in the exchange, insurance funds, open interest, accounts, and how much notional sits within ten percent of liquidation.' },
	{ caption: 'Every market <span>· mark vs Chainlink Data Streams oracle = Tripwire signal</span>', say: "For every market, the mark price against the Chainlink Data Streams oracle. That dislocation is the signal Tripwire's Chainlink workflow uses to protect lending markets on Monad, shown with the level it would trigger, next to funding and insurance cover." },
	{ caption: 'Liquidation radar <span>· every open position ranked by distance to liquidation</span>', say: "The liquidation radar scans every open position and ranks them by distance to their liquidation price, computed with Perpl's documented formula." },
	{ caption: 'Wallet view <span>· one click on the radar</span>', say: 'One click opens the wallet view: collateral, equity and notional, and for each position its leverage, unrealized and funding P and L, liquidation price and distance.' },
	{ caption: 'Any wallet, live <span>· paste an address</span>', say: 'Any wallet can be inspected by address, and every number refreshes live.' },
	{ caption: 'Mainnet and testnet <span>· same view, one switch</span>', say: 'The same view runs on Monad testnet, where Tripwire reads Perpl as a third price reference.' },
	{ caption: 'Protocol stress + wallet risk <span>· one live view, feeding Tripwire</span>', say: "Protocol-level stress and wallet-level risk in one live view, feeding Tripwire's circuit breaker." },
]

const probe = (f: string) =>
	Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { stdout: 'pipe' }).stdout.toString().trim())
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 1. Narration first.
writeFileSync(join(OUT, `${NAME}-narration.json`), JSON.stringify(STEPS.map((s, i) => ({ step: i + 1, say: s.say }))))
const ps = `
Add-Type -AssemblyName System.Speech
$segs = Get-Content -Raw '${join(OUT, `${NAME}-narration.json`)}' | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('${process.env.VOICE ?? 'Microsoft Zira Desktop'}')
$s.Rate = 1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($seg in $segs) { $s.SetOutputToWaveFile('${join(OUT, `${NAME}-n`)}' + $seg.step + '.wav', $fmt); $s.Speak($seg.say) }
$s.SetOutputToNull()
`
const tts = Bun.spawnSync(['powershell', '-NoProfile', '-Command', ps], { stdout: 'pipe', stderr: 'pipe' })
if (tts.exitCode !== 0) throw new Error(`TTS failed: ${tts.stderr.toString()}`)
const durs = STEPS.map((_, i) => probe(join(OUT, `${NAME}-n${i + 1}.wav`)))

// 2. Serve the monitor and record it.
const server = Bun.serve({
	port: 5174,
	fetch: (req) => {
		const path = new URL(req.url).pathname
		return new Response(Bun.file(join(ROOT, 'dashboard', path === '/' ? 'perpl.html' : path)))
	},
})
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(OUT, '.chrome-profile') })
const page: Page = await browser.newPage()
await page.setViewport({ width: 1400, height: 788, deviceScaleFactor: 1920 / 1400 })
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
await page.goto('http://localhost:5174/perpl.html', { waitUntil: 'networkidle2' })
await page.waitForFunction(() => document.querySelectorAll('#radar tr.click').length > 5, { timeout: 120_000, polling: 500 })
// Recording-only caption bar (not part of the product).
await page.evaluate(() => {
	const bar = document.createElement('div')
	bar.id = '__cap'
	bar.style.cssText =
		'position:fixed;left:0;right:0;bottom:0;z-index:99;padding:14px 22px;background:rgba(7,9,13,.92);border-top:1px solid #252c38;color:#eef1f6;font:700 22px/1.3 Inter,sans-serif'
	document.body.appendChild(bar)
	const style = document.createElement('style')
	style.textContent = '#__cap span{color:#949cad;font-weight:500} body{padding-bottom:70px}'
	document.head.appendChild(style)
})
const caption = (html: string) => page.evaluate((h) => (document.getElementById('__cap')!.innerHTML = h), html)
const scrollTo = (sel: string, offset = 12) =>
	page.evaluate(
		(s, o) => window.scrollTo({ top: (document.querySelector(s) as HTMLElement).getBoundingClientRect().top + window.scrollY - o, behavior: 'smooth' }),
		sel,
		offset,
	)

const framesDir = join(OUT, `${NAME}-frames`)
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })
const frames: { file: string; t: number }[] = []
const t0 = performance.now()
const now = () => (performance.now() - t0) / 1000
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

const marks: number[] = []
const step = async (i: number, action?: () => Promise<unknown>) => {
	marks[i] = now()
	await caption(STEPS[i].caption)
	if (action) await action()
	const left = marks[i] + durs[i] + 0.9 - now()
	if (left > 0) await sleep(left * 1000)
}

await step(0)
await step(1, () => scrollTo('.kpis', 70))
await step(2, () => scrollTo('#markets', 60))
await step(3, () => scrollTo('#radar', 60))
await step(4, async () => {
	await page.evaluate(() => (document.querySelector('#radar tr.click') as HTMLElement).click())
	await page.waitForFunction(() => document.querySelector('#wallet .acct'), { timeout: 30_000 })
	await scrollTo('#walletCard', 60)
})
// Another account from further down the radar, typed in as an address.
// The largest position on the radar, typed in as an address (a different wallet from the one clicked).
const other = await page.evaluate(() => {
	const rows = [...document.querySelectorAll('#radar tr.click')].slice(1) as HTMLElement[]
	return rows.sort((a, b) => Number(b.dataset.notional) - Number(a.dataset.notional))[0].dataset.account
})
const acct = Bun.spawnSync(
	['cast', 'call', '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F', 'getAccountById(uint256)((uint256,uint256,uint256,uint8,address,(uint256,uint256,uint256,uint256)))', String(other), '--rpc-url', 'https://rpc.monad.xyz'],
	{ stdout: 'pipe', stderr: 'pipe' },
).stdout.toString()
const otherAddr = acct.match(/0x[0-9a-fA-F]{40}/)?.[0]
if (!otherAddr) throw new Error(`could not resolve account ${other}: ${acct}`)
await step(5, async () => {
	await page.evaluate(() => { (document.getElementById('addr') as HTMLInputElement).value = '' })
	await page.type('#addr', otherAddr, { delay: 18 })
	await page.click('#inspect')
	await page.waitForFunction(() => document.querySelector('#wallet .acct'), { timeout: 30_000 })
})
await step(6, async () => {
	await page.goto('http://localhost:5174/perpl.html?net=testnet', { waitUntil: 'networkidle2' })
	await page.evaluate(() => {
		const bar = document.createElement('div')
		bar.id = '__cap'
		bar.style.cssText =
			'position:fixed;left:0;right:0;bottom:0;z-index:99;padding:14px 22px;background:rgba(7,9,13,.92);border-top:1px solid #252c38;color:#eef1f6;font:700 22px/1.3 Inter,sans-serif'
		document.body.appendChild(bar)
		const style = document.createElement('style')
		style.textContent = '#__cap span{color:#949cad;font-weight:500}'
		document.head.appendChild(style)
	})
	await caption(STEPS[6].caption)
	await page.waitForFunction(() => document.querySelectorAll('#markets tr').length > 1 && !document.querySelector('#markets .empty'), { timeout: 60_000 })
})
await step(7, async () => {
	await page.goto('http://localhost:5174/perpl.html', { waitUntil: 'networkidle2' })
	await page.evaluate(() => {
		const bar = document.createElement('div')
		bar.id = '__cap'
		bar.style.cssText =
			'position:fixed;left:0;right:0;bottom:0;z-index:99;padding:14px 22px;background:rgba(7,9,13,.92);border-top:1px solid #252c38;color:#eef1f6;font:700 22px/1.3 Inter,sans-serif'
		document.body.appendChild(bar)
		const style = document.createElement('style')
		style.textContent = '#__cap span{color:#949cad;font-weight:500}'
		document.head.appendChild(style)
	})
	await caption(STEPS[7].caption)
})
recording = false
await loop
const duration = now()
await browser.close()
server.stop()

// 3. Video from timestamped frames + narration at each step mark.
const posix = (p: string) => p.replaceAll('\\', '/')
const list = frames.map((f, i) => `file '${posix(f.file)}'\nduration ${Math.max(0.001, (i + 1 < frames.length ? frames[i + 1].t : duration) - f.t).toFixed(3)}`)
writeFileSync(join(OUT, `${NAME}-frames.txt`), `${list.join('\n')}\nfile '${posix(frames[frames.length - 1].file)}'\n`)
writeFileSync(join(OUT, `${NAME}-marks.json`), JSON.stringify({ marks, duration, durs }, null, 2))
// Two passes, as in demo.ts: frames -> video, then video + narration.
const raw = join(OUT, `${NAME}-raw.mp4`)
const v = Bun.spawnSync(
	['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(OUT, `${NAME}-frames.txt`), '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', raw],
	{ stdout: 'pipe', stderr: 'pipe' },
)
if (v.exitCode !== 0) throw new Error(`ffmpeg frames: ${v.stderr.toString()}`)
const at = marks.map((m) => m + 0.3)
const inputs = ['-i', raw, ...STEPS.flatMap((_, i) => ['-i', join(OUT, `${NAME}-n${i + 1}.wav`)])]
const audio = STEPS.map((_, i) => `[${i + 1}:a]adelay=${Math.round(at[i] * 1000)}|${Math.round(at[i] * 1000)}[a${i}]`).join(';')
const mix = `${STEPS.map((_, i) => `[a${i}]`).join('')}amix=inputs=${STEPS.length}:normalize=0,apad,atrim=0:${duration.toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`
const out = join(OUT, `${NAME}.mp4`)
const r = Bun.spawnSync(
	['ffmpeg', '-y', '-loglevel', 'error', ...inputs, '-filter_complex', `[0:v]format=yuv420p,fade=t=in:st=0:d=0.4[v];${audio};${mix}`, '-map', '[v]', '-map', '[a]',
		'-t', duration.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', '30', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', out],
	{ stdout: 'pipe', stderr: 'pipe' },
)
if (r.exitCode !== 0) throw new Error(`ffmpeg: ${r.stderr.toString()}`)
const ts = (t: number) => {
	const ms = Math.round(t * 1000)
	const p = (n: number, w = 2) => String(n).padStart(w, '0')
	return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}
writeFileSync(join(OUT, `${NAME}.srt`), STEPS.map((s, i) => `${i + 1}\n${ts(at[i])} --> ${ts(at[i] + durs[i])}\n${s.say}\n`).join('\n'))
console.log(`rendered ${out} (${duration.toFixed(1)} s)`)
