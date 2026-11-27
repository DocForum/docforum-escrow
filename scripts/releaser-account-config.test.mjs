import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendRecord,
  canonicalJson,
  configHash,
  loadConfigFile,
  normalisePublicKey,
  parseConfig,
  parseConfigJson,
} from "./releaser-account-config.mjs";

const ESCROW = `C${"A".repeat(55)}`;
const SIGNER_A = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
const SIGNER_B = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
// A real Ed25519 public key (the recorded testnet pause admin).
const SIGNER_G = "GDJBRSDH4OARYUYDUDUXYTELZQMIJVZBLL4H2CDQFOHMNKNGE4ILUM7T";
const SIGNER_G_HEX = "d218c867e3811c5303a0e97c4c8bcc1884d7215af87d08702b8ec6a9a62710ba";

const validConfig = () => ({
  escrow: ESCROW,
  signers: [SIGNER_A, SIGNER_B],
  threshold: 2,
  max_operations_per_window: 100,
  window_ledgers: 17280,
});

test("normalises signers to sorted lowercase hex", () => {
  const config = parseConfig(validConfig());
  assert.deepEqual(config.signers, [SIGNER_B, SIGNER_A].sort());
  assert.equal(config.escrow, ESCROW);
});

test("config hash is independent of key and signer order", () => {
  const first = validConfig();
  const second = {
    window_ledgers: first.window_ledgers,
    max_operations_per_window: first.max_operations_per_window,
    threshold: first.threshold,
    signers: [SIGNER_B, SIGNER_A],
    escrow: ESCROW,
  };
  assert.equal(configHash(parseConfig(first)), configHash(parseConfig(second)));
  assert.match(configHash(parseConfig(first)), /^[0-9a-f]{64}$/);
});

test("canonical JSON sorts object keys and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test("accepts a G... public-key strkey and normalises it to hex", () => {
  assert.equal(normalisePublicKey(SIGNER_G, "signers[0]"), SIGNER_G_HEX);
  const config = parseConfig({ ...validConfig(), signers: [SIGNER_G], threshold: 1 });
  assert.deepEqual(config.signers, [SIGNER_G_HEX]);
});

test("rejects a strkey with a broken checksum", () => {
  const broken = `${SIGNER_G.slice(0, -1)}A`;
  assert.throws(() => normalisePublicKey(broken, "signers[0]"), /checksum/);
});

test("rejects two encodings of the same signer key", () => {
  const hex = normalisePublicKey(SIGNER_G, "signers[0]");
  assert.throws(
    () => parseConfig({ ...validConfig(), signers: [SIGNER_G, hex], threshold: 2 }),
    /more than once/,
  );
});

test("rejects secret keys and secret-looking config keys", () => {
  const seed = `S${"A".repeat(55)}`;
  assert.throws(
    () => parseConfig({ ...validConfig(), signers: [seed] }),
    /secret key/,
  );
  assert.throws(
    () => parseConfig({ ...validConfig(), secret_key: "anything" }),
    /unknown config key/,
  );
  assert.throws(
    () => parseConfig({ ...validConfig(), signers: [{ secret: seed }] }),
    /secret/,
  );
});

test("rejects malformed configs", () => {
  const cases = [
    [{ ...validConfig(), escrow: `G${"A".repeat(55)}` }, /escrow must be/],
    [{ ...validConfig(), escrow: "not-an-address" }, /escrow must be/],
    [{ ...validConfig(), signers: [] }, /must not be empty/],
    [
      { ...validConfig(), signers: Array.from({ length: 21 }, (_, i) => `${i}`.repeat(64)) },
      /at most 20 signers/,
    ],
    [{ ...validConfig(), signers: ["nope"] }, /64 hex characters/],
    [{ ...validConfig(), signers: [SIGNER_A, SIGNER_A] }, /more than once/],
    [{ ...validConfig(), threshold: 0 }, /threshold must be an integer/],
    [{ ...validConfig(), threshold: 3 }, /greater than the 2 signers/],
    [{ ...validConfig(), threshold: 1.5 }, /threshold must be an integer/],
    [{ ...validConfig(), max_operations_per_window: 0 }, /max_operations_per_window/],
    [{ ...validConfig(), window_ledgers: 0 }, /window_ledgers/],
    [{ ...validConfig(), window_ledgers: 6_312_000 }, /window_ledgers/],
    [{ ...validConfig(), extra: true }, /unknown config key/],
    [{ ...validConfig(), escrow: undefined }, /missing 'escrow'/],
    [(({ escrow, ...rest }) => rest)(validConfig()), /missing 'escrow'/],
    [null, /must be a JSON object/],
  ];
  for (const [config, error] of cases) {
    assert.throws(() => parseConfig(config), error);
  }
});

test("rejects invalid JSON and missing files", () => {
  assert.throws(() => parseConfigJson("{"), /not valid JSON/);
  assert.throws(() => loadConfigFile("/nonexistent/config.json"), /config not found/);
});

test("accepts the example config committed for reviewers", () => {
  const example = loadConfigFile("examples/releaser-account/deploy-config.example.json");
  assert.equal(example.signers.length, 2);
  assert.equal(example.threshold, 2);
});

test("appends records atomically and refuses duplicates and local networks", () => {
  const dir = mkdtempSync(join(tmpdir(), "releaser-account-record-"));
  try {
    const file = join(dir, "releaser-account-deployments.json");
    const entry = {
      network: "testnet",
      accountId: `C${"B".repeat(55)}`,
      wasmHash: "a".repeat(64),
      configHash: "b".repeat(64),
    };
    appendRecord(file, entry);
    appendRecord(file, { ...entry, accountId: `C${"C".repeat(55)}` });
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.version, 1);
    assert.equal(doc.deployments.length, 2);
    assert.throws(() => appendRecord(file, entry), /already recorded/);
    assert.throws(
      () => appendRecord(file, { ...entry, network: "local", accountId: `C${"D".repeat(55)}` }),
      /refusing to record network/,
    );
    assert.throws(
      () => appendRecord(file, { network: "testnet", accountId: `C${"E".repeat(55)}` }),
      /missing 'wasmHash'/,
    );

    const seeded = join(dir, "seeded.json");
    writeFileSync(seeded, `${JSON.stringify({ version: 2, deployments: [] })}\n`);
    assert.throws(
      () => appendRecord(seeded, { ...entry, accountId: `C${"F".repeat(55)}` }),
      /must be \{ "version": 1/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
