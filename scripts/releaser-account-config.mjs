#!/usr/bin/env node
// Releaser-account deployment config and record handling (issue #357).
//
// The custom releaser account (ADR 0005) is configured entirely by its
// constructor: target escrow, signer set, threshold and rate-limit policy.
// `scripts/deploy-releaser-account` reads that configuration from a JSON file,
// validates it here before any network call, records a hash of the reviewed
// configuration, and appends the deployment to releaser-account-deployments.json.
//
// Usage:
//   node scripts/releaser-account-config.mjs validate <config.json>   # canonical JSON
//   node scripts/releaser-account-config.mjs hash <config.json>       # config hash
//   node scripts/releaser-account-config.mjs record <record.json>     # append a record
//
// Config format (all keys required, no other keys accepted):
//   {
//     "escrow": "C...",                     // 56-char contract strkey
//     "signers": ["<64 hex>", "G..."],      // 1-20 distinct Ed25519 public keys
//     "threshold": 2,
//     "max_operations_per_window": 100,
//     "window_ledgers": 17280
//   }
//
// Signers may be raw 32-byte hex or a `G...` Ed25519 public-key strkey; both
// are normalised to lowercase hex. Secret keys (`S...` seeds) are refused: the
// configuration is reviewed and committed, so it may only hold public keys.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_KEYS = [
  "escrow",
  "signers",
  "threshold",
  "max_operations_per_window",
  "window_ledgers",
];

export const MAX_SIGNERS = 20;
// Soroban's default maximum entry TTL. The contract rejects a window at or
// above the network's max_ttl; this bound catches the typo before a deploy.
export const MAX_WINDOW_LEDGERS_EXCLUSIVE = 6_312_000;
const U32_MAX = 4_294_967_295;

export const RECORD_VERSION = 1;
export const RECORD_SUPPORTED_NETWORKS = new Set(["testnet"]);

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_PUBLIC_KEY_VERSION = 6 << 3;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function crc16xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32Decode(value) {
  const bytes = [];
  let bits = 0;
  let buffer = 0;
  for (const char of value) {
    const index = BASE32.indexOf(char);
    if (index === -1) fail(`not a base32 character: '${char}'`);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (buffer & ((1 << bits) - 1)) !== 0) {
    fail("invalid base32 padding");
  }
  return Buffer.from(bytes);
}

/** Decodes a `G...` Ed25519 public-key strkey to its 32 raw bytes. */
function strkeyToRawPublicKey(value) {
  // The whole strkey is base32: a 33-byte payload (version + key) followed by
  // a 2-byte little-endian CRC16-XModem checksum.
  const raw = base32Decode(value);
  if (raw.length !== 35) fail("a public key strkey must encode 35 bytes");
  const payload = raw.subarray(0, 33);
  if (payload[0] !== ED25519_PUBLIC_KEY_VERSION) {
    fail("only Ed25519 public-key strkeys (G...) are accepted");
  }
  const checksum = raw.readUInt16LE(33);
  const expected = crc16xmodem(payload);
  if (checksum !== expected) fail("public key strkey checksum does not match");
  return Buffer.from(payload.subarray(1));
}

/** Returns lowercase 32-byte hex for a hex or `G...` Ed25519 public key. */
export function normalisePublicKey(value, label) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  const key = value.trim();
  if (/^S[A-Z2-7]{55}$/.test(key)) {
    fail(`${label} looks like a secret key (S...); the config may only hold public keys`);
  }
  if (/^[0-9a-fA-F]{64}$/.test(key)) return key.toLowerCase();
  if (/^G[A-Z2-7]{55}$/.test(key)) {
    try {
      return strkeyToRawPublicKey(key).toString("hex");
    } catch (error) {
      fail(`${label} is not a valid Ed25519 public key: ${error.message}`);
    }
  }
  fail(`${label} must be 64 hex characters or a G... Ed25519 public-key strkey`);
}

function assertU32(value, label, { min = 1, max = U32_MAX } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer from ${min} to ${max}`);
  }
}

/** Rejects secret material anywhere in the config, by key name or seed shape. */
function assertNoSecretMaterial(value, where) {
  if (typeof value === "string") {
    if (/^S[A-Z2-7]{55}$/.test(value)) {
      fail(`${where} holds a secret key (S...); the config may only hold public keys`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${where}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/secret|seed|private/i.test(key)) {
        fail(`${where}.${key} is not allowed: the config may only hold public keys`);
      }
      assertNoSecretMaterial(item, `${where}.${key}`);
    }
  }
}

/**
 * Validates a parsed config object and returns its normalised form: signers
 * as sorted lowercase hex (the constructor is order-independent).
 */
export function parseConfig(value) {
  if (!isPlainObject(value)) fail("config must be a JSON object");
  const unknown = Object.keys(value).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length > 0) {
    fail(`unknown config key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  for (const key of CONFIG_KEYS) {
    if (!(key in value) || value[key] === undefined) fail(`config is missing '${key}'`);
  }
  assertNoSecretMaterial(value, "config");

  const escrow = typeof value.escrow === "string" ? value.escrow.trim() : value.escrow;
  if (typeof escrow !== "string" || !/^C[A-Z2-7]{55}$/.test(escrow)) {
    fail("escrow must be a 56-character contract id (C...)");
  }

  if (!Array.isArray(value.signers)) fail("signers must be an array");
  if (value.signers.length === 0) fail("signers must not be empty");
  if (value.signers.length > MAX_SIGNERS) {
    fail(`at most ${MAX_SIGNERS} signers are supported`);
  }
  const signers = value.signers.map((key, index) =>
    normalisePublicKey(key, `signers[${index}]`),
  );
  const duplicate = signers.find((key, index) => signers.indexOf(key) !== index);
  if (duplicate) fail(`signers contains '${duplicate}' more than once`);

  assertU32(value.threshold, "threshold", { min: 1, max: MAX_SIGNERS });
  if (value.threshold > signers.length) {
    fail(`threshold ${value.threshold} is greater than the ${signers.length} signers`);
  }
  assertU32(value.max_operations_per_window, "max_operations_per_window");
  assertU32(value.window_ledgers, "window_ledgers", {
    min: 1,
    max: MAX_WINDOW_LEDGERS_EXCLUSIVE - 1,
  });

  return {
    escrow,
    signers: signers.sort(),
    threshold: value.threshold,
    max_operations_per_window: value.max_operations_per_window,
    window_ledgers: value.window_ledgers,
  };
}

/** Parses and validates the JSON text of a config file. */
export function parseConfigJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`config is not valid JSON: ${error.message}`);
  }
  return parseConfig(parsed);
}

/** Deterministic JSON: recursively sorted object keys, no whitespace. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the canonical config: the reviewed configuration's identity. */
export function configHash(config) {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

export function loadConfigFile(file) {
  if (!existsSync(file)) fail(`config not found: ${file}`);
  return parseConfigJson(readFileSync(file, "utf8"));
}

export function recordPath(root) {
  return path.join(root, "releaser-account-deployments.json");
}

export function loadRecords(file) {
  if (!existsSync(file)) return { version: RECORD_VERSION, deployments: [] };
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (doc.version !== RECORD_VERSION || !Array.isArray(doc.deployments)) {
    fail(`${file} must be { "version": ${RECORD_VERSION}, "deployments": [...] }`);
  }
  return doc;
}

/**
 * Appends one deployment to the record file atomically. Local (dry-run)
 * deployments and duplicate account ids are refused.
 */
export function appendRecord(file, entry) {
  if (!RECORD_SUPPORTED_NETWORKS.has(entry.network)) {
    fail(`refusing to record network "${entry.network}"`);
  }
  for (const field of ["accountId", "wasmHash", "configHash"]) {
    if (typeof entry[field] !== "string" || entry[field] === "") {
      fail(`record is missing '${field}'`);
    }
  }
  const doc = loadRecords(file);
  const duplicate = doc.deployments.find(
    (d) => d.accountId === entry.accountId && d.network === entry.network,
  );
  if (duplicate) {
    fail(`account ${entry.accountId} is already recorded on ${entry.network}`);
  }
  doc.deployments.push(entry);
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(temp, file);
}

function main(argv) {
  const [command, file] = argv;
  const usage =
    "Usage: node scripts/releaser-account-config.mjs validate|hash|record <file.json>";
  if (!command || !file) {
    console.error(usage);
    process.exit(2);
  }
  try {
    if (command === "validate") {
      process.stdout.write(`${canonicalJson(loadConfigFile(file))}\n`);
    } else if (command === "hash") {
      process.stdout.write(`${configHash(loadConfigFile(file))}\n`);
    } else if (command === "record") {
      appendRecord(file, JSON.parse(readFileSync(file, "utf8")));
      process.stdout.write(`${file}\n`);
    } else {
      console.error(usage);
      process.exit(2);
    }
  } catch (error) {
    console.error(`releaser-account-config: ${error.message}`);
    process.exit(2);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
