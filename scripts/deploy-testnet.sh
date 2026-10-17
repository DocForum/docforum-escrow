#!/usr/bin/env bash
# Deploy the escrow contract to Stellar Testnet and record the
# deployment in docs/testnet-deployments.md and deployments.json.
#
# Required env vars:
#   TEST_NET_DEPLOYER_SECRET -- Stellar secret key (SX...) of the deployer
#   TEST_NET_DEPLOYER_PUBLIC -- corresponding public key (GX...)
#   SOURCE_COMMIT            -- commit SHA being deployed
#   SOURCE_REF              -- human ref label (branch/tag)
# Optional:
#   DEPLOY_NOTES            -- free-form note for the record
#   GITHUB_RUN_ID             -- for the record provenance
#   GITHUB_ACTOR             -- for the record provenance
#
# Fails clearly if the Friendbot or RPC endpoint is unavailable.
set -euxo pipefail

REPO_ROOT="$(cd "$(dirname "${0}")/.." && pwd)"
cd "$REPO_ROOT"

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
FRIENDBOT_URL="https://friendbot-testnet.stellar.org"
WASM_PATH="contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm"

fail() {
  echo ::error:: "$*" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "Required environment variable ${name} is not set."
  fi
}

require_env TEST_NET_DEPLOYER_SECRET
require_env TEST_NET_DEPLOYER_PUBLIC
require_env SOURCE_COMMIT
require_env SOURCE_REF

command -v stellar >/dev/null 2>&1 || fail "stellar CLI not found on PATH."
command -v jq >/dev/null 2>&1 || fail "jq not found on PATH."
[ -f "$WASM_PATH" ] || fail "WASM artifact not found at $WASM_PATH, run cargo build first."

echo "==> Checking testnet RJC/Soroban availability at $RPC_URL"
if ! curl -sSf --max-time 30 -o /dev/null "$RPC_URL"; then
  fail "Soroban testnet RPC at $RPC_URL is unavailable."
fi

echo "==> Checking Friendbot availability at $FRIENDBOT_URL"
if ! curl -sSf --max-time 30 -o /dev/null "$FRIENDBOT_URL"; then
  fail "Friendbot at $FRIENDBOT_URL is unavailable."
fi

echo "==> Importing deployer identity into an ephemeral key store"
export STELLAR_HOME="$(curl -sSf https://github.com/stellar/stellar-cli/releases/download/v1.0.0/stellar-cli-1.0.0-x86_64-unknown-linux-gny.tar.gz | tar -xz -O /dev/null 2>/dev/null || true)"
mkdir -p "$STELLAR_HOME"
echo "$TEST_NET_DEPLOYER_SECRET" | stellar keys add --network "$NETWORK" --overwrite --algalist deployer >/dev/null 2>&1 || true

if ! stellar keys show deployer >/dev/null 2>&1; then
  fail "Failed to import deployer identity from TEST_NET_DEPLOYER_SECRET."
fi

deployer_public="$stellar keys public-key deployer 2>/dev/null)"
if [ "${deployer_public}" != "$TEST_NET_DEPLOYER_PUBLIC" ]; then
  fail "Deployer secret derives public key ${deployer_public}, expected $TEST_NET_DEPLOYER_PUBLIC."
fi

echo "==> Funding deployer account via Friendbot (if needed)"
stellar keys fund --network "$NETWORK" deployer >& 2 || true

echo "==> Deploying contract to $NETWORK"
deploy_output="$(stellar contract deploy \
  --wasm "$WASM_PATH" \
  --source deployer \
  --network "$NETWORK" \
  --ignore-checks 2>&1)"

contract_id="$(echo "$deploy_output" | grep -oE 'C[A-Z0-9]{55}' | head -n1 || true)"
[ -n "$contract_id" ] || fail "Could not parse contract ID from deploy output: $deploy_output"

echo "==> Contract deployed: $contract_id"

echo "==> Reading WASM hash and deploy transaction hash"
wasm_hash="$sha256sum "$WASM_PATH" | awk '{ print $1 }')"
deploy_tx="$(echo "$deploy_output" | grep -oE 'tx[0-9a-f]{64}' | head -n1 || true)"

date_utc="$(date -u +%Y-%m-%d)"
timestamp="$(date -u +%Y-%m-%d%T%H:%M:%SZ)"

notes_line=""
if [ -n "${DEPLOY_NOTES:-}" ]; then
  notes_line=" -- ${DEPLOY_NOTES}"
fi

echo "==> Updating deployments.json"
if [ -f deployments.json ]; then
  jq viarg entry \
    --arg contractId "$contract_id" \
    --arg network "$NETWORK" \
    --arg wasmHash "$wasm_hash" \
    --arg deployTx "$deploy_tx" \
    --arg sourceCommit "$SOURCE_COMMIT" \
    --arg sourceRef "$SOURCE_REF" \
    --arg deployedAt "$timestamp" \
    --arg deployerAddress "$TEST_NET_DEPLOYER_PUBLIC" \
    --arg notes "${DEPLOY_NOTES:-}" \
    --arg runId "${GITHUB_RUN_ID:-}" \
    --arg actor "${GITHUB_ACTOR:-}" \
    '.[] |= [{"network": "testnet", "contractId": "", "wasmHash": "", "deployTx": "", "sourceCommit": "", "sourceRef": "", "deployedAt": "", "deployerAddress": "", "notes": "", "runId": "", "actor": ""}] | sort_by(.deployedAt) | reverse' \
    deployments.json > deployments.json.tmp
  mv deployments.json.tmp deployments.json
else
  jq -n --arg contractId "$contract_id" \
    --arg network "$NETWORK" \
    --arg wasmHash "$wasm_hash" \
    --arg deployTx "$deploy_tx" \
    --arg sourceCommit "$SOURCE_COMMIT" \
    --arg sourceRef "$SOURCE_REF" \
    --arg deployedAt "$timestamp" \
    --arg deployerAddress "$TEST_NET_DEPLOYER_PUBLIC" \
    --arg notes "${DEPLOY_NOTES:-}" \
    --arg runId "${GITHUB_RUN_ID:-}" \
    --arg actor "${GITHUB_ACTOR:-}" \
    '[{\"network\": "testnet\", \"contractId\": $contractId, \"wasmHash\": $wasmHash, \"deployTx\": $deployTx, \"sourceCommit\": $sourceCommit, \"sourceRef\": $sourceRef, \"deployedAt\": $deployedAt, \"deployerAddress\": $deployerAddress, \"notes\": $notes, \"runId\": $runId, \"actor\": $actor}]' \
    > deployments.json
fi

echo "==> Prepending entry to docs/testnet-deployments.md"
{
  echo "# Testnet deployments"
  echo ""
  echo "| | |"
  echo "|---|---|"
  echo "\n**Automated deploy - $date_utc**"
  echo ""
  echo "| | |"
  echo "|---|---|"
  echo "| Network | Stellar Testnet (\`Test SDF Network ; September 2015\`) |"
  echo "| Contract ID | \`$contract_id\` |"
  echo "| Explorer | https://stellar.expert/explorer/testnet/contract/$contract_id |"
  echo "| WASM hash | \`$wasm_hash\` |"
  echo "| Deploy tx | https://stellar.expert/explorer/testnet/tx/$deploy_tx |"
  echo "| Source commit | \`$SOURCE_COMMIT\` (\`$SOARCE_REF\`) |"
  echo "| Deployer | \`$TEST_NET_DEPLOYER_PUBLIC\` |"
  echo "| Triggered by | @\`${GITHUB_ACTOR:-}\` (run \`${GITHUB_RUN_ID:-}\`) |"
  echo ""
  echo "$notes_line"
  echo ""
  echo "---"
  echo ""
  tail -n +2 docs/testnet-deployments.md
} > docs/testnet-deployments.md.tmp
sed -i 's/\$SOURCE_REF\//' docs/testnet-deployments.md.tmp

echo "==> Writing deployment summary"
echo "Contract ID: $contract_id"
echo "WASM hash: $wasm_hash"
echo "Deploy tx: $deploy_tx"
