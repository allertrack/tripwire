/**
 * Writes a workflow config for a deployment: bun scripts/make-config.ts <deployment.json> <config.out.json>
 * Starts from workflow/tripwire/config.staging.json (thresholds, references) and fills in the deployed addresses.
 */
const [deploymentPath, outPath] = process.argv.slice(2)
if (!deploymentPath || !outPath) throw new Error('usage: bun scripts/make-config.ts <deployment.json> <config.out.json>')

const root = new URL('..', import.meta.url)
const deployment = await Bun.file(deploymentPath).json()
const config = await Bun.file(new URL('workflow/tripwire/config.staging.json', root)).json()

config.reference.chainlinkFeed.address = deployment.chainlinkFeed
config.markets[0].guard = deployment.guard
config.markets[0].market = deployment.pool
await Bun.write(outPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`wrote ${outPath}: guard=${deployment.guard} market=${deployment.pool}`)
