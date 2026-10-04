#!/usr/bin/env bash
# End-to-end rehearsal on a local anvil fork of Monad testnet, driven by the real CRE simulator:
#   deploy -> healthy run -> oracle manipulation -> CRE trips the guard -> borrow blocked
#   -> oracle restored -> CRE reports recovery -> governance proposes relax -> CRE sends fresh evidence
#   -> anyone executes the relax -> borrowing works again.
# Needs: foundry, bun, the CRE CLI (logged in: `cre login`). No testnet funds: the fork has the CRE
# MockKeystoneForwarder and the Chainlink ETH/USD feed already deployed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="http://127.0.0.1:8545"
# anvil's well-known dev keys (local fork only)
GOV_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANYONE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
RELAX_DELAY=60 # contract minimum

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
# anvil reports finalized = latest - 64; CRE reads at the finalized head. Mine without moving the clock.
finalize() { cast rpc anvil_mine 0x41 0x0 --rpc-url "$RPC" >/dev/null; }
json() { python -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }
level() { cast call "$GUARD" "status()((uint8,uint8,bool,uint32,uint32,uint40,uint32,uint8,uint8,uint32,uint64,bool,uint8,uint40,uint40))" --rpc-url "$RPC" | cut -d, -f1 | tr -d '( '; }
simulate() {
  (cd "$ROOT/workflow" && cre workflow simulate tripwire --target local-settings --non-interactive --trigger-index 0 --broadcast 2>&1) \
    | sed 's/\x1b\[[0-9;]*m//g' | grep -E "USER LOG|Result|^\"|✗" || true
}
expect_level() {
  local got; got="$(level)"
  if [ "$got" != "$1" ]; then echo "FAIL: guard level $got, expected $1" >&2; exit 1; fi
  echo "guard level = $got (ok)"
}

if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  say "starting anvil fork of Monad testnet"
  anvil --fork-url "${MONAD_TESTNET_RPC_URL:-https://testnet-rpc.monad.xyz}" --chain-id 10143 --silent &
  ANVIL_PID=$!
  trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
  for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
fi

say "1. deploy guard + demo market"
(cd "$ROOT/contracts" && PRIVATE_KEY="$GOV_KEY" RELAX_DELAY="$RELAX_DELAY" DEPLOYMENT_NAME=local \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow >/dev/null)
DEP="$ROOT/contracts/deployments/local.json"
GUARD="$(json "$DEP" guard)"; POOL="$(json "$DEP" pool)"; ORACLE="$(json "$DEP" oracle)"; FEED="$(json "$DEP" chainlinkFeed)"
echo "guard=$GUARD pool=$POOL oracle=$ORACLE"
bun "$ROOT/scripts/make-config.ts" "$DEP" "$ROOT/workflow/tripwire/config.local.json"
printf 'CRE_ETH_PRIVATE_KEY=%s\n' "${GOV_KEY#0x}" > "$ROOT/workflow/.env"
finalize

say "2. healthy market: the workflow observes and stays quiet"
simulate
expect_level 0

say "3. attack: the market's own oracle is pushed 30% above Chainlink and the exchanges"
CL_PRICE="$(cast call "$FEED" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC" | sed -n 2p | cut -d' ' -f1)"
cast send "$ORACLE" "pushAnswer(int256)" "$((CL_PRICE * 13 / 10))" --private-key "$GOV_KEY" --rpc-url "$RPC" >/dev/null
finalize
simulate
expect_level 3

say "4. the attacker tries to borrow against the inflated price"
if cast send "$POOL" "borrow(uint256)" 1000000000 --private-key "$GOV_KEY" --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "FAIL: borrow went through" >&2; exit 1
fi
echo "borrow reverted: TripwirePaused(BORROW) (ok)"

say "5. oracle fixed: the workflow reports recovery, the guard stays Frozen (tighten-only)"
cast send "$ORACLE" "clearOverride()" --private-key "$GOV_KEY" --rpc-url "$RPC" >/dev/null # back to the live feed
finalize
simulate
expect_level 3

say "6. governance proposes to relax; the watcher must agree after the delay"
cast send "$GUARD" "proposeRelax(uint8)" 0 --private-key "$GOV_KEY" --rpc-url "$RPC" >/dev/null
echo "waiting ${RELAX_DELAY}s relax delay..."
sleep $((RELAX_DELAY + 2))
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
finalize
simulate

say "7. anyone executes the matured relax"
cast send "$GUARD" "executeRelax()" --private-key "$ANYONE_KEY" --rpc-url "$RPC" >/dev/null
expect_level 0
cast send "$POOL" "borrow(uint256)" 1000000000 --private-key "$GOV_KEY" --rpc-url "$RPC" >/dev/null
echo "borrow works again (ok)"

say "local e2e passed"
