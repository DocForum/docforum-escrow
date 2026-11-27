import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { configHash, parseConfig } from "./releaser-account-config.mjs";

const root = process.cwd();
const script = join(root, "scripts/deploy-releaser-account");
const module = join(root, "scripts/releaser-account-config.mjs");
const SIGNER_A = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
const SIGNER_B = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const ESCROW = `C${"A".repeat(55)}`;
const ACCOUNT = `C${"B".repeat(55)}`;
const DEPLOYER = "GDJBRSDH4OARYUYDUDUXYTELZQMIJVZBLL4H2CDQFOHMNKNGE4ILUM7T";
const sha = (value) => createHash("sha256").update(value).digest("hex");

const config = () => ({
  escrow: ESCROW,
  signers: [SIGNER_A, SIGNER_B],
  threshold: 2,
  max_operations_per_window: 100,
  window_ledgers: 17280,
});

function fixture({
  threshold = 2,
  policy = "[100, 17280]",
  signerCount = 2,
  configValue = config(),
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-releaser-account-test-"));
  for (const path of ["scripts", "bin"]) mkdirSync(join(dir, path), { recursive: true });
  copyFileSync(script, join(dir, "scripts/deploy-releaser-account"));
  copyFileSync(module, join(dir, "scripts/releaser-account-config.mjs"));
  copyFileSync(
    join(root, "scripts/stellar-cli-version"),
    join(dir, "scripts/stellar-cli-version"),
  );
  writeFileSync(join(dir, "config.json"), JSON.stringify(configValue, null, 2));
  writeFileSync(join(dir, "account.wasm"), "fake-releaser-account-wasm");

  // Stubbed CLI: deploy prints a fixed account id and records the configuration
  // it was given; the read getters answer with the values under test.
  const stellar = join(dir, "bin/stellar");
  writeFileSync(
    stellar,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_STUB_LOG"
case "\${1:-}" in
  --version) echo "stellar 28.1.0 (test stub)"; exit 0 ;;
  keys)
    if [[ "\${2:-}" == "address" ]]; then echo "${DEPLOYER}"; fi
    exit 0
    ;;
  contract)
    case "\${2:-}" in
      upload)
        wasm=""
        while [[ $# -gt 0 ]]; do case "$1" in --wasm) wasm="$2"; shift 2 ;; *) shift ;; esac; done
        printf 'Signing transaction: %064d\\n' 1 >&2
        sha256sum "$wasm" | cut -d ' ' -f 1
        exit 0
        ;;
      deploy)
        printf 'Signing transaction: %064d\\n' 2 >&2
        echo "${ACCOUNT}"
        exit 0
        ;;
      invoke)
        fn=""
        while [[ $# -gt 0 ]]; do [[ "$1" == "--" ]] && { fn="\${2:-}"; break; }; shift; done
        case "$fn" in
          escrow) echo "\\"${ESCROW}\\"" ;;
          threshold) echo "${threshold}" ;;
          signer_count) echo "${signerCount}" ;;
          policy) echo "${policy}" ;;
          *) echo "unexpected read: $fn" >&2; exit 1 ;;
        esac
        exit 0
        ;;
      fetch)
        out=""
        while [[ $# -gt 0 ]]; do case "$1" in --out-file) out="$2"; shift 2 ;; *) shift ;; esac; done
        cp "$FAKE_WASM" "$out"
        exit 0
        ;;
    esac
    ;;
esac
echo "unexpected stellar invocation: $*" >&2
exit 1
`,
  );
  chmodSync(stellar, 0o755);

  const git = (...args) =>
    spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  git("init", "-q");
  git("add", "-A");
  const commit = git("commit", "-q", "-m", "fixture");
  if (commit.status !== 0) throw new Error(commit.stderr);

  return dir;
}

function run(dir, args, env = {}) {
  return spawnSync(join(dir, "scripts/deploy-releaser-account"), args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      FAKE_STUB_LOG: join(dir, "stub.log"),
      FAKE_WASM: join(dir, "account.wasm"),
      ...env,
    },
  });
}

test("dry run deploys, verifies every constructor argument and prints the record", () => {
  const dir = fixture();
  try {
    const result = run(dir, [
      "--config",
      "config.json",
      "--wasm",
      "account.wasm",
      "--dry-run",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").pop(), ACCOUNT);
    assert.match(result.stderr, /verify: escrow = C/);
    assert.match(result.stderr, /verify: threshold = 2/);
    assert.match(result.stderr, /verify: signer_count = 2/);
    assert.match(result.stderr, /verify: policy\.max_operations_per_window = 100/);
    assert.match(result.stderr, /verify: policy\.window_ledgers = 17280/);
    assert.match(result.stderr, /verify: wasm_hash = [0-9a-f]{64}/);

    const lines = result.stdout.trim().split("\n");
    lines.pop(); // the account id is printed on its own final line
    const record = JSON.parse(lines.join("\n"));
    assert.equal(record.accountId, ACCOUNT);
    assert.equal(record.escrow, ESCROW);
    assert.equal(record.network, "local");
    assert.equal(record.wasmHash, sha("fake-releaser-account-wasm"));
    assert.equal(record.configHash, configHash(parseConfig(config())));
    assert.deepEqual(record.policy, { maxOperationsPerWindow: 100, windowLedgers: 17280 });
    assert.equal(record.signerCount, 2);
    // A dry run never touches tracked files.
    assert.throws(() => readFileSync(join(dir, "releaser-account-deployments.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when a read-back value does not match the config", () => {
  const dir = fixture({ threshold: 1 });
  try {
    const result = run(dir, [
      "--config",
      "config.json",
      "--wasm",
      "account.wasm",
      "--dry-run",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /read-back mismatch for threshold: config says '2', contract says '1'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when the policy read-back does not match the config", () => {
  const dir = fixture({ policy: "[100, 999]" });
  try {
    const result = run(dir, [
      "--config",
      "config.json",
      "--wasm",
      "account.wasm",
      "--dry-run",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /read-back mismatch for policy\.window_ledgers/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses mainnet and invalid configs before any network call", () => {
  const dir = fixture();
  try {
    const mainnet = run(dir, [
      "--config",
      "config.json",
      "--wasm",
      "account.wasm",
      "--network",
      "mainnet",
    ]);
    assert.notEqual(mainnet.status, 0);
    assert.match(mainnet.stderr, /mainnet deployment is not supported/);

    writeFileSync(
      join(dir, "secret.json"),
      JSON.stringify({ ...config(), signers: [`S${"A".repeat(55)}`] }),
    );
    const invalid = run(dir, ["--config", "secret.json", "--wasm", "account.wasm", "--dry-run"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid config|secret key/);
    const logPath = join(dir, "stub.log");
    const calls = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    assert.doesNotMatch(calls, /contract upload|contract deploy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
