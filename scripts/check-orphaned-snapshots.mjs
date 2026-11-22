#!/usr/bin/env node
// Fail when a committed Soroban test snapshot has no corresponding test.
// Snapshot suffixes (.1, .2, ...) are invocation numbers, not test names.
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

const snapshotDir = "contracts/escrow/test_snapshots";
const listed = execFileSync(
  "cargo",
  ["test", "--manifest-path", "contracts/escrow/Cargo.toml", "--", "--list"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
)
  .split("\n")
  .filter((line) => line.endsWith(": test"))
  .map((line) => line.slice(0, -": test".length));

const testNames = new Set(listed);
const snapshots = readdirSync(snapshotDir).filter((file) => file.endsWith(".json"));
const orphans = snapshots.filter((file) => {
  const snapshotName = basename(file).replace(/\.\d+\.json$/, "");
  return !listed.some(
    (testName) => testName === snapshotName || testName.endsWith(`::${snapshotName}`),
  );
});

if (orphans.length > 0) {
  console.error("::error::orphaned Soroban test snapshots found:");
  for (const file of orphans) console.error(`  ${join(snapshotDir, file)}`);
  process.exit(1);
}

console.log(`Test snapshots OK (${snapshots.length} files, ${testNames.size} tests listed).`);
