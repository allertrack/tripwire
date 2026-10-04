# Tripwire — common tasks. Requires Foundry, Bun and (for simulate/e2e) the CRE CLI, logged in.
.PHONY: install test test-contracts test-fork test-workflow build-workflow e2e deploy-testnet simulate-testnet

install:
	cd contracts && npm ci --ignore-scripts
	cd workflow/tripwire && bun install --frozen-lockfile

test: test-contracts test-fork test-workflow

test-contracts:
	cd contracts && forge test --no-match-path 'test/fork/*'

test-fork:
	cd contracts && forge test --match-path 'test/fork/*'

test-workflow:
	cd workflow/tripwire && bun run typecheck && bun test

build-workflow:
	cd workflow/tripwire && bunx cre-compile main.ts

# Full rehearsal on a local anvil fork of Monad testnet with the real CRE simulator (no funds needed).
e2e:
	bash scripts/local-e2e.sh

# Live Monad testnet (contracts/.env: PRIVATE_KEY funded with testnet MON).
deploy-testnet:
	cd contracts && set -a && . ./.env && set +a && \
	  forge script script/Deploy.s.sol --rpc-url "$$MONAD_TESTNET_RPC_URL" --broadcast --slow
	bun scripts/make-config.ts contracts/deployments/monad-testnet.json workflow/tripwire/config.testnet.json

# One watcher run against the live deployment; --broadcast sends the report through the CRE simulation Forwarder.
simulate-testnet:
	cp workflow/.env.testnet workflow/.env
	cd workflow && cre workflow simulate tripwire --target testnet-settings --non-interactive --trigger-index 0 --broadcast
