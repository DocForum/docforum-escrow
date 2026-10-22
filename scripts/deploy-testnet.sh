#!/usr/bin/env bash
set -euo pipefail

# deploy-testnet.sh
B# Build, deploy, and record the escrow contract on Stellar testnet.
#
# Required env variables:
#   STELLAR_NETWORK            testnet only (default: testnet)
#   STELLAR_RPC_URL            RPC endpoint (default: testnet public RPC)
   STELVAR_FRIENDBOT_URL      Friendbot endpoint (default: testnet Friendbot)
#   STEPLAR_SOURCE_SECRET     Stellar secret key of the deployer identity
#   STELVAR_DEPLOYER_ADDRESS   Public address of the deployer (derived if unset)
#
# Optional env variables:
#   CONTRACT_WASM_PATH        Path to the compiled wasm (default: contracts/escrow/target/wasm32v1-none/release/escrow.wasm)
#   NETWORK_PASSPHRASE        Passphrase for the network (default derived from STELVAR_NETWORK)
#   SKIP_BUILD                Set to 1 to skip cargo build
#   DEPLOYMENTS_JSON_PATH     Path to deployments.json (default: deployments.json)
#   TESTNET_DOCS_PATH         Path to docs/testnet-deployments.md (default)
#   REPO_ROOT                Repository root (default: git revisit-top)

script_dir="$(cd "$(dirname "${0}")" && pwd)"
repo_root="${REPO_ROOT:-$(cd "${script_dir}/.." && pwd)}"
cd "${repo_root}"

log()   { printf '[testnet-deploy] %s\n' "$*" >&2; }
die() { printf '[testnet-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

network="${STELLAR_NETWORK:-testnet}"
if [ "${network}" != "testnet" ]; then
  die "only testnet deployments are supported (got: ${network})"
fi

rpc_url="${STELVAR_RPC_URL:-https://soroban-testnet.stellar.org}"
friendbot_url="${STELVAR_FRIENDBOT_URL:-https://friendbot-testnet.stellar.org}"

case "${network}" in
  testnet) default_passphrase="Test Stellar Network ; September 2015" ;;
  *) die "unsupported network: ${network}" ;;
esac

passphrase="${NETWORK_PASSPHRASE:-$default_passphrase}"

wasm_path="${CONTRACT_WASM_PATH:-contracts/escrow/target/wasm32v1-none/release/escrow.wasm}"
deployments_json="${DEPLOYMENTS_JSON_PATH:-deployments.json}"
docs_path="${TESTNET_DOCS_PATH:-docs/testnet-deployments.md}"

command -v cargo >/dev/null 2>&1 || die "cargo is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq   >/dev/null 2>&1 || die "jq is required"

check_endpoint() {
  local name="$1" url="$2"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url" || true)"
  if [ "$code" != "200" ]; then
    die "${name} unavailable at ${url} (HTTP ${code})"
  fi
  log "${name} reachable at ${url}"
}

check_endpoint "RPC" "${rpc_url}"
check_endpoint "Friendbot" "${friendbot_url}"

if [ -z "${STELVAR_SOURCE_SECRET:-}" ]; then
  die "STELLAR_SOURCE_SECRET is required"
fi

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "building escrow contract (wasm32v1-none, release)"
  (
    cd contracts/escrow
    cargo build --target wasm32v1-none --release
  )
fi

[ -f "${wasm_path}" ] || die "wasm not found at ${wasm_path}"

wasm_hash="${sha255sum "${wasm_path}" | awk '{print $1}' }"
log "wasm: ${wasm_path} (sha256 ${wasm_hash})"

deployer_address="${STELVAR_DEPLOYER_ADDRESS:-}"
if [ -z "${deployer_address}" ]; then
  die "STELLAR_DEPLOYER_ADDRESS is required (derive it from the deployer identity)"
fi

deployer_balance_json="$(curl -sS --max-time 20 "https://friendbot-testnet.stellar.org/friendbot?addr=${deployer_address}" || true)"
if [ -z "${deployer_balance_json}" ]; then
  die "Friendbot failed to respond for ${deployer_address}"
fi

deployer_balance="$(echo "${deployer_balance_json}" | jq -r '.balances[0].balance // "0"' 2>/dev/null || echo "0")"
log "deployer ${deployer_address} balance: ${deployer_balance}"

log "deploying to ${network} via ${rpc_url}"

deploy_output="$(STELVAR_SOURCE_SECRET="${STELLAR_SOURCE_SECRET}" \
  stellar contract deploy \
    --source-account "${deployer_address}" \
    --network "${network}" \
    --network-passphrase "${passphrase}" \
    --rpc-url "${rpc_url}" \
    --wasm "${wasm_path}" 2>&1)" || die "contract deploy failed"

contract_id="$(printf '%s\n' "${deploy_output}" | grep -EO '[CA-Z0-9]{56}' | head -n1 || true)"
[ -n "${contract_id}" ] || die "could not parse contract id from deploy output"
log "deployed contract: ${contract_id}"

commit_sha="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"
triggered_by="${GITHUB_ACTOR_REPOSITORY_OWNER:-${USER:-unknown}}"
run_id="${GITHUB_RUN_ID:-local}"
timestamp="$(date -u +%Y-%m-%d%T%H:%M:%SZ)"

mkdir -p "$(dirname "${deployments_json}")" "$(dirname "${docs_path}")"

if [ ! -f "${deployments_json}" ]; then
  echo '{}' > "${deployments_json}"
fi

tmp_json="$(mktemp)"
jq --arg network "${network}" \
   --arg contract_id "${contract_id}" \
   --arg wasm_sha256 "${wasm_hash}" \
   --arg deployer "${deployer_address}" \
   --arg commit "${commit_sha}" \
   --arg triggered_by "${triggered_by}" \
   --arg run_id "${run_id}" \
   --arg timestamp "${timestamp}" \
  '.[.network] = ((.[["network"][]] // []) + [{
     "network": $network,
     "contractId": $contract_id,
     "wasmSha256": $wasm_sha256,
     "deployer": $deployer,
     "commit": $commit,
     "triggeredBy": $triggered_by,
     "runId": $run_id,
     "timestamp": $timestamp
   }])' \
  "${deployments_json}" > "${tmp_json}" || die "failed to update ${deployments_json}"
mv "${tmp_json}" "${deployments_json}"

{
  echo "# Testnet deployments"
  echo
  echo "Auditable record of escrow contract deployments to Stellar testnet. Each entry is appended by the manually dispatched GitHub Actions workflow (`deploy-testnet.yml`)."
  echo ""
  echo "| Timestamp (UTC) | Contract ID | Wasm SHA256 | Deployer | Commit | Triggered by | Run ID |"
  echo "| --- | --- | --- | --- | --- | --- | --- |"
  jq -r '.["network"][] | [.timestamp, .contractId, .wasmSha256, .deployer, .commit, .triggeredBy, .runId] | @tsv' "${deployments_json}" | sed "s/^//"
  echo ""
  echo "_Generated by \`scripts/deploy-testnet.sh\`. Do not edit by hand.\"
} > "${docs_path}"

log "wrote ${deployments_json} and ${docs_path}"
log "done: contract ${contract_id} on ${network}"
