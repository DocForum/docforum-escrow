import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const script = join(root, "scripts/verify-deployment");
const contractId = "CTESTVERIFYDEPLOYMENT0000000000000000000000000000000000000000";
const sha = (value) => createHash("sha256").update(value).digest("hex");

function fixture({ recordedHash = sha("escrow-wasm"), gitSha = "a".repeat(40) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-deployment-test-"));
  for (const path of ["scripts", "bin", "contracts/escrow/target/wasm32v1-none/release"]) {
    mkdirSync(join(dir, path), { recursive: true });
  }
  copyFileSync(script, join(dir, "scripts/verify-deployment"));
  copyFileSync(join(root, "scripts/stellar-cli-version"), join(dir, "scripts/stellar-cli-version"));

  const build = join(dir, "scripts/build-wasm.sh");
  writeFileSync(build, `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "\${BASH_SOURCE[0]}")/.."
mkdir -p contracts/escrow/target/wasm32v1-none/release
printf %s "$FAKE_LOCAL_WASM" > contracts/escrow/target/wasm32v1-none/release/docforum_escrow.wasm
`);
  chmodSync(build, 0o755);

  const stellar = join(dir, "bin/stellar");
  writeFileSync(stellar, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STUB_LOG"
if [[ "\${1:-}" == "--version" ]]; then
  echo "stellar \${STUB_CLI_VERSION:-28.1.0} (test stub)"
  exit 0
fi
if [[ "\${1:-}" == "contract" && "\${2:-}" == "fetch" ]]; then
  out=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --out-file) out="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf %s "$FAKE_ONCHAIN_WASM" > "$out"
  exit 0
fi
echo "unexpected stellar invocation: $*" >&2
exit 1
`);
  chmodSync(stellar, 0o755);

  writeFileSync(
    join(dir, "deployments.json"),
    JSON.stringify({
      version: 1,
      deployments: [
        {
          network: "testnet",
          contractId,
          wasmHash: recordedHash,
          gitSha,
        },
      ],
    }),
  );
  return dir;
}

function run(dir, args = [], env = {}) {
  const log = join(dir, "stellar-args.log");
  const result = spawnSync(join(dir, "scripts/verify-deployment"), args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      FAKE_LOCAL_WASM: "escrow-wasm",
      FAKE_ONCHAIN_WASM: "escrow-wasm",
      FAKE_STUB_LOG: log,
      DOCFORUM_GIT_SHA: "a".repeat(40),
      ...env,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ...result, output, log };
}

test("reports all three hashes and passes when the record, build and chain agree", () => {
  const dir = fixture();
  const result = run(dir, [contractId]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /Local build SHA-256:\s+[0-9a-f]{64}/);
  assert.match(result.stdout, /On-chain SHA-256:\s+[0-9a-f]{64}/);
  assert.match(result.stdout, new RegExp(`Deployment record SHA-256: ${sha("escrow-wasm")}`));
  assert.match(result.stdout, /PASS: local build, on-chain WASM and deployment record agree \(testnet\)/);
  assert.doesNotMatch(result.stderr, /WARNING|FAIL/);
  assert.match(readLog(dir), /--network testnet/);
});

test("fails when any hash disagrees", () => {
  const staleRecord = fixture({ recordedHash: sha("something-else") });
  let result = run(staleRecord, [contractId]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL: recorded wasmHash does not match this source build/);
  assert.match(result.output, /FAIL: recorded wasmHash does not match the on-chain WASM/);

  const differentChain = fixture();
  result = run(differentChain, [contractId], { FAKE_ONCHAIN_WASM: "another-wasm" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL: on-chain WASM does not match this source build \(testnet\)/);
});

test("warns for an unrecorded id but still verifies against the build", () => {
  const dir = fixture();
  const result = run(dir, ["--network", "local", "CUNRECORDED"], {
    LOCAL_RPC_URL: "http://localhost:8009/rpc",
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /Deployment record SHA-256: not recorded/);
  assert.match(result.stderr, /not in deployments\.json for local/);
  assert.match(result.stdout, /PASS: deployed WASM matches this source build \(local\)/);
  assert.match(readLog(dir), /--rpc-url http:\/\/localhost:8009\/rpc/);
});

test("warns when the checkout is not the recorded gitSha", () => {
  const dir = fixture();
  const result = run(dir, [contractId], { DOCFORUM_GIT_SHA: "b".repeat(40) });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stderr, /WARNING: checkout .* is not the recorded gitSha/);
});

test("supports futurenet and defaults to testnet", () => {
  const dir = fixture();
  const futurenet = run(dir, ["--network=futurenet", contractId]);
  assert.equal(futurenet.status, 0, futurenet.output);
  assert.match(readLog(dir), /--network futurenet/);
  assert.match(futurenet.output, /\(futurenet\)/);
});

test("accepts --network=NAME and never requires deployments.json", () => {
  const dir = fixture();
  rmSync(join(dir, "deployments.json"));
  const result = run(dir, ["--network=local", contractId], {
    LOCAL_RPC_URL: "http://localhost:8000/rpc",
  });
  assert.equal(result.status, 0, result.output);
  assert.match(result.stdout, /Deployment record SHA-256: not recorded/);
  assert.match(result.stderr, /not in deployments\.json for local/);
  assert.match(readLog(dir), /--network-passphrase Standalone Network ; February 2017/);
});

test("warns when a record exists without a wasmHash", () => {
  const dir = fixture();
  writeFileSync(
    join(dir, "deployments.json"),
    JSON.stringify({ version: 1, deployments: [{ network: "testnet", contractId }] }),
  );
  const result = run(dir, [contractId]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.stderr, /recorded for testnet but has no wasmHash/);
  assert.match(result.stdout, /the deployment record has no wasmHash/);
});

test("rejects an empty --network value", () => {
  const dir = fixture();
  const result = run(dir, ["--network=", contractId]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /--network needs a value/);
});

test("refuses mainnet aliases and unknown networks", () => {
  const dir = fixture();
  for (const network of ["mainnet", "public", "pubnet", "devnet"]) {
    const result = run(dir, ["--network", network, contractId]);
    assert.equal(result.status, 2, result.output);
    assert.match(result.stderr, /unsupported network|mainnet verification is not supported/);
  }
  assert.doesNotMatch(readLog(dir, run(dir, ["--help"])), /contract fetch/);
});

test("checks the pinned CLI version before touching the network", () => {
  const dir = fixture();
  const result = run(dir, [contractId], { STUB_CLI_VERSION: "99.0.0" });
  assert.equal(result.status, 2, result.output);
  assert.match(result.stderr, /Expected Stellar CLI 28\.1\.0, found 99\.0\.0/);
  assert.doesNotMatch(result.output, /Local build SHA-256/);
});

function readLog(dir) {
  try {
    return readFileSync(join(dir, "stellar-args.log"), "utf8");
  } catch {
    return "";
  }
}
