#!/usr/bin/env node
// Issue #333: the SDK mirrors several contract limits by hand. The contract
// source is the source of truth; this check fails CI when a mirrored constant
// drifts, disappears, or exists on only one side.
//
// Contract side: `pub const NAME: type = value;` in contracts/escrow/src/*.rs.
// SDK side:      `export const NAME = value;` in sdk/src/*.ts.
//
// Run from anywhere: `node scripts/check-sdk-constants.mjs`.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative as relativePath } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Contract constant → the SDK constant that must carry the same value.
 * Add an entry whenever the SDK starts mirroring another contract limit; the
 * last check below refuses an SDK constant that shadows a contract constant
 * without being listed here.
 */
const MIRRORED = [
  { contract: "MAX_RELEASERS", sdk: "MAX_RELEASERS" },
  { contract: "MAX_CONDITION_REF_LEN", sdk: "MAX_CONDITION_REF_LENGTH" },
  { contract: "MAX_BATCH_SIZE", sdk: "MAX_BATCH_SIZE" },
  { contract: "MAX_SETTLE_OPS", sdk: "MAX_SETTLE_OPS" },
  { contract: "MAX_FEE_BPS", sdk: "MAX_FEE_BPS" },
];

function sourceFiles(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, extension);
    return entry.name.endsWith(extension) ? [path] : [];
  });
}

const relative = (path) => relativePath(root, path);

/** Parses a Rust numeric literal (`16`, `1_000`) or returns `undefined`. */
function numericValue(raw) {
  const literal = raw.trim().replace(/\/\/.*$/s, "").trim();
  const plain = literal.replaceAll("_", "");
  if (/^\d+$/.test(plain)) return Number(plain);
  // A suffixed literal such as `12u32` is still a plain number.
  const suffixed = /^(\d+)(?:u\d+|i\d+)$/.exec(plain);
  return suffixed ? Number(suffixed[1]) : undefined;
}

function parseContractConstants() {
  const constants = new Map();
  for (const file of sourceFiles(join(root, "contracts/escrow/src"), ".rs")) {
    const source = readFileSync(file, "utf8");
    const pattern = /pub const ([A-Z][A-Z0-9_]*)\s*:\s*([^=]+?)\s*=\s*([^;]+);/g;
    for (const match of source.matchAll(pattern)) {
      constants.set(match[1], {
        value: numericValue(match[3]),
        raw: match[3].trim(),
        file: relative(file),
      });
    }
  }
  return constants;
}

function parseSdkConstants() {
  const constants = new Map();
  for (const file of sourceFiles(join(root, "sdk/src"), ".ts")) {
    const source = readFileSync(file, "utf8");
    const pattern = /export const ([A-Z][A-Z0-9_]*)(?:\s*:\s*[^=]+)?\s*=\s*([0-9][0-9_]*)\b/g;
    for (const match of source.matchAll(pattern)) {
      constants.set(match[1], {
        value: Number(match[2].replaceAll("_", "")),
        raw: match[2],
        file: relative(file),
      });
    }
  }
  return constants;
}

const contract = parseContractConstants();
const sdk = parseSdkConstants();
const failures = [];

for (const { contract: contractName, sdk: sdkName } of MIRRORED) {
  const contractConstant = contract.get(contractName);
  const sdkConstant = sdk.get(sdkName);
  if (!contractConstant) {
    failures.push(`contract constant ${contractName} is missing from contracts/escrow/src/`);
    continue;
  }
  if (contractConstant.value === undefined) {
    failures.push(
      `${contractConstant.file}: ${contractName} = ${contractConstant.raw} is not a numeric literal this check can read`,
    );
    continue;
  }
  if (!sdkConstant) {
    failures.push(`sdk/src: ${sdkName} is missing; it must mirror contract ${contractName}`);
    continue;
  }
  if (sdkConstant.value !== contractConstant.value) {
    failures.push(
      `${sdkConstant.file}: ${sdkName} = ${sdkConstant.raw} does not match ${contractConstant.file}: ${contractName} = ${contractConstant.raw}`,
    );
    continue;
  }
  console.log(`  ok  ${contractName} = ${contractConstant.value} (SDK: ${sdkName})`);
}

// An SDK constant that shadows a contract constant must be in the table above,
// so a newly mirrored limit cannot go unchecked. Aliases (e.g.
// MAX_CONDITION_REF_LENGTH) are matched through the table instead.
const mapped = new Set(MIRRORED.flatMap((entry) => [entry.contract, entry.sdk]));
for (const [name, sdkConstant] of sdk) {
  if (!contract.has(name) || mapped.has(name)) continue;
  failures.push(
    `${sdkConstant.file}: ${name} mirrors contract ${name} but is not in MIRRORED in scripts/check-sdk-constants.mjs`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`);
  console.error(`check-sdk-constants: ${failures.length} mismatch(es) between the SDK and the contract.`);
  process.exit(1);
}

console.log(`check-sdk-constants: all ${MIRRORED.length} mirrored constants match contracts/escrow/src/.`);
