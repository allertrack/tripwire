/**
 * Director for the demo video: drives the real scenario (oracle attack -> CRE trip -> blocked borrow -> recovery ->
 * two-key relax) and captures dashboard screenshots plus the exact terminal output at each step.
 *
 *   MODE=local   bun capture.ts   # anvil fork of Monad testnet on :8545 (deploys a fresh market)
 *   MODE=testnet bun capture.ts   # live Monad testnet deployment (contracts/deployments/monad-testnet.json)
 *
 * Output: out/run.json and out/*.png
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'

const MODE = (process.env.MODE ?? 'local') as 'local' | 'testnet'
const ROOT = resolve(import.meta.dir, '../..')
const OUT = join(import.meta.dir, 'out')
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ANVIL_KEY_2 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
mkdirSync(OUT, { recursive: true })

const envFile = (path: string) =>
	Object.fromEntries(
		readFileSync(path, 'utf8')
			.split(/\r?\n/)
			.filter((l) => /^[A-Z_]+=/.test(l))
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
	)

const net =
	MODE === 'local'
		? { rpc: 'http://127.0.0.1:8545', target: 'local-settings', deployment: 'local', gov: ANVIL_KEY, anyone: ANVIL_KEY_2 }
		: (() => {
				const key = envFile(join(ROOT, 'contracts/.env')).PRIVATE_KEY
				return { rpc: 'https://testnet-rpc.monad.xyz', target: 'testnet-settings', deployment: 'monad-testnet', gov: key, anyone: key }
			})()

const run = (cmd: string[], cwd = ROOT, env: Record<string, string> = {}) => {
	const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
	const out = (p.stdout.toString() + p.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '')
	return { ok: p.exitCode === 0, out }
}
const must = (cmd: string[], cwd = ROOT, env: Record<string, string> = {}) => {
	const r = run(cmd, cwd, env)
	if (!r.ok) throw new Error(`${cmd.join(' ')} failed:\n${r.out}`)
	return r.out
}
const cast = (...args: string[]) => must(['cast', ...args, '--rpc-url', net.rpc]).trim()
const send = (key: string, to: string, sig: string, ...args: string[]) =>
	must(['cast', 'send', to, sig, ...args, '--private-key', key, '--rpc-url', net.rpc, '--json'])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** CRE reads at the finalized head: anvil lags 64 blocks (mine them without moving the clock); Monad ~2 blocks. */
const finalize = async () => (MODE === 'local' ? cast('rpc', 'anvil_mine', '0x41', '0x0') : sleep(4_000))

const simulate = () => {
	const r = run(
		['cre', 'workflow', 'simulate', 'tripwire', '--target', net.target, '--non-interactive', '--trigger-index', '0', '--broadcast'],
		join(ROOT, 'workflow'),
	)
	const lines = r.out.split(/\r?\n/).filter((l) => /\[USER LOG\]|^"tWETH|✗/.test(l))
	if (!r.ok || !lines.some((l) => l.startsWith('"tWETH'))) throw new Error(`simulate failed:\n${r.out}`)
	return lines.map((l) => l.replace(/^\S+Z \[USER LOG\] /, ''))
}

// ─── Deployment ─────────────────────────────────────────────────────────────
if (MODE === 'local') {
	must(['forge', 'script', 'script/Deploy.s.sol', '--rpc-url', net.rpc, '--broadcast', '--slow'], join(ROOT, 'contracts'), {
		PRIVATE_KEY: ANVIL_KEY,
		RELAX_DELAY: '60',
		DEPLOYMENT_NAME: 'local',
	})
	must(['bun', 'scripts/make-config.ts', 'contracts/deployments/local.json', 'workflow/tripwire/config.local.json'])
	writeFileSync(join(ROOT, 'workflow/.env'), `CRE_ETH_PRIVATE_KEY=${ANVIL_KEY.slice(2)}\n`)
} else {
	writeFileSync(join(ROOT, 'workflow/.env'), readFileSync(join(ROOT, 'workflow/.env.testnet')))
}
const dep = JSON.parse(readFileSync(join(ROOT, `contracts/deployments/${net.deployment}.json`), 'utf8'))
const dashDeployment = { ...dep, rpc: net.rpc }
writeFileSync(join(ROOT, 'dashboard/deployment.capture.json'), JSON.stringify(dashDeployment, null, 2))
const level = () => Number(cast('call', dep.guard, 'status()((uint8,uint8,bool,uint32,uint32,uint40,uint32,uint8,uint8,uint32,uint64,bool,uint8,uint40,uint40))').slice(1).split(',')[0])
const chainlinkPrice = cast('call', dep.chainlinkFeed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)').split('\n')[1].split(' ')[0]

// ─── Dashboard ──────────────────────────────────────────────────────────────
const server = Bun.serve({
	port: 5174,
	fetch: (req) => {
		const path = new URL(req.url).pathname
		return new Response(Bun.file(join(ROOT, 'dashboard', path === '/' ? 'index.html' : path)))
	},
})
const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: true,
	userDataDir: join(OUT, '.chrome-profile'),
	args: ['--no-first-run', '--no-default-browser-check'],
})
const page: Page = await browser.newPage()
await page.setViewport({ width: 1240, height: 640, deviceScaleFactor: 2 })
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
await page.goto(`http://localhost:5174/?deployment=./deployment.capture.json`, { waitUntil: 'networkidle2' })
const waitLevel = async (name: string) =>
	page.waitForFunction((n) => document.getElementById('levelName')?.textContent === n, { timeout: 60_000 }, name)
const shot = async (file: string, scrollToFeed = false) => {
	await sleep(2_500) // let the 2 s poll and the feed settle
	if (scrollToFeed) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
	else await page.evaluate(() => window.scrollTo(0, 0))
	await page.screenshot({ path: join(OUT, file) as `${string}.png` })
}

// ─── Scenario ───────────────────────────────────────────────────────────────
const result: Record<string, unknown> = { mode: MODE, deployment: dep, startedAt: new Date().toISOString() }
if (level() !== 0) throw new Error('guard must start at Normal')
send(net.gov, dep.oracle, 'pushAnswer(int256)', chainlinkPrice)
await finalize()

console.log('1/6 healthy run')
result.healthy = simulate()
await waitLevel('NORMAL')
await shot('normal.png')

console.log('2/6 attack')
const pumped = ((BigInt(chainlinkPrice) * 13n) / 10n).toString()
const attackTx = JSON.parse(send(net.gov, dep.oracle, 'pushAnswer(int256)', pumped)).transactionHash
await finalize()
result.attack = { pumped, attackTx, logs: simulate() }
await waitLevel('FROZEN')
await shot('frozen.png')
if (level() !== 3) throw new Error('expected Frozen')

console.log('3/6 attacker borrow')
const borrow = run(['cast', 'send', dep.pool, 'borrow(uint256)', '25000000000', '--private-key', net.gov, '--rpc-url', net.rpc])
if (borrow.ok) throw new Error('borrow should have reverted')
result.borrow = borrow.out.match(/TripwirePaused\(\d+\)|custom error[^\n]*/)?.[0] ?? borrow.out.slice(0, 300)

console.log('4/6 oracle fixed')
send(net.gov, dep.oracle, 'pushAnswer(int256)', chainlinkPrice)
await finalize()
result.recovery = simulate()

console.log('5/6 relax proposal')
const proposeTx = JSON.parse(send(net.gov, dep.guard, 'proposeRelax(uint8)', '0')).transactionHash
const readyAt = Number(cast('call', dep.guard, 'status()((uint8,uint8,bool,uint32,uint32,uint40,uint32,uint8,uint8,uint32,uint64,bool,uint8,uint40,uint40))').slice(1).split(',')[13].trim().split(' ')[0])
while (Math.floor(Date.now() / 1000) < readyAt + 2) await sleep(2_000)
if (MODE === 'local') cast('rpc', 'evm_mine')
await finalize()
result.evidence = simulate()

console.log('6/6 execute relax')
const relaxTx = JSON.parse(send(net.anyone, dep.guard, 'executeRelax()')).transactionHash
await waitLevel('NORMAL')
const borrowAfter = run(['cast', 'send', dep.pool, 'borrow(uint256)', '1000000000', '--private-key', net.gov, '--rpc-url', net.rpc])
result.relax = { proposeTx, relaxTx, borrowAfterOk: borrow.ok === false && borrowAfter.ok }
await shot('relaxed.png', true)

result.finishedAt = new Date().toISOString()
writeFileSync(join(OUT, 'run.json'), JSON.stringify(result, null, 2))
await browser.close()
server.stop()
console.log(`captured ${MODE} run -> ${join(OUT, 'run.json')}`)
