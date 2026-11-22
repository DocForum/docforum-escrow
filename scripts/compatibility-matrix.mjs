#!/usr/bin/env node

/**
 * Build and validate the SDK/contract compatibility matrix used by CI.
 *
 * The matrix is deliberately data-driven: a missing result is `not-run`, not
 * a pass, and only pairs listed in KNOWN_INCOMPATIBLE may be non-passing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const KNOWN_INCOMPATIBLE = [
  {
    sdk: "sdk-v0.1.0",
    contract: "main",
    reason: "SDK 0.1.0 sends the pre-0.3 create_escrow argument list.",
  },
  {
    sdk: "sdk-v0.2.0",
    contract: "main",
    reason: "SDK 0.2.0 sends the pre-0.3 create_escrow argument list.",
  },
];

export function releaseTags(tags) {
  return tags.filter((tag) => /^sdk-v\d+\.\d+\.\d+$/.test(tag)).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

export function matrixPairs(tags, lastSdkCount = 2) {
  const contracts = [...releaseTags(tags), "main"];
  const sdks = [...releaseTags(tags).slice(-lastSdkCount), "main"];
  return sdks.flatMap((sdk) => contracts.map((contract) => ({ sdk, contract })));
}

function key({ sdk, contract }) {
  return `${sdk}::${contract}`;
}

export function renderMatrix(pairs, results = {}) {
  const known = new Map(KNOWN_INCOMPATIBLE.map((item) => [key(item), item]));
  const rows = pairs.map((pair) => {
    const result = results[key(pair)];
    if (result) return { ...pair, ...result };
    const expected = known.get(key(pair));
    return expected
      ? { ...pair, status: "known-incompatible", detail: expected.reason }
      : { ...pair, status: "not-run", detail: "CI result missing" };
  });

  const lines = [
    "| SDK release | Contract deployment | Result |",
    "| --- | --- | --- |",
    ...rows.map(({ sdk, contract, status, detail }) =>
      `| \`${sdk}\` | \`${contract}\` | ${status}${detail ? ` — ${detail}` : ""} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export function validateResults(pairs, results = {}) {
  const expected = new Set(pairs.map(key));
  const unknown = Object.keys(results).filter((item) => !expected.has(item));
  const missing = pairs.filter((pair) => {
    const item = results[key(pair)];
    return !item && !KNOWN_INCOMPATIBLE.some((known) => key(known) === key(pair));
  });
  const failed = pairs.filter((pair) => results[key(pair)]?.status === "failed");
  return { unknown, missing, failed };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const tags = (process.env.COMPATIBILITY_TAGS ?? execFileSync("git", ["tag", "--list", "sdk-v*"], { encoding: "utf8" }))
    .split(/\s+/)
    .filter(Boolean);
  const discovered = tags.length ? tags : [];
  const pairs = matrixPairs(discovered, Number(process.env.COMPATIBILITY_SDK_COUNT ?? 2));
  const resultsPath = process.env.COMPATIBILITY_RESULTS;
  const results = resultsPath ? JSON.parse(readFileSync(resultsPath, "utf8")) : {};
  const table = renderMatrix(pairs, results);
  if (args.has("--write")) writeFileSync(process.env.COMPATIBILITY_TABLE ?? "compatibility-table.md", table);
  else process.stdout.write(table);

  if (args.has("--check")) {
    const validation = validateResults(pairs, results);
    if (validation.unknown.length || validation.missing.length || validation.failed.length) {
      if (validation.unknown.length) console.error(`Unknown compatibility results: ${validation.unknown.join(", ")}`);
      if (validation.missing.length) console.error(`Missing compatibility results: ${validation.missing.map(key).join(", ")}`);
      if (validation.failed.length) console.error(`Unexpected compatibility failures: ${validation.failed.map(key).join(", ")}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main();
