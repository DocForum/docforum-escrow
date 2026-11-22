import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const checker = join(root, "scripts/check-contract-change.mjs");
const folder = (dir, name) => join(dir, name);
const run = (dir, file, args = []) => {
  const command = file === "git" ? file : process.execPath;
  const commandArgs = file === "git" ? args : [file, ...args];
  return execFileSync(command, commandArgs, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "contract-change-test-"));
  mkdirSync(folder(dir, "contracts/escrow/src"), { recursive: true });
  mkdirSync(folder(dir, "contract-changes.d"));
  mkdirSync(folder(dir, "changelog.d"));
  writeFileSync(folder(dir, "contracts/escrow/src/lib.rs"), 'pub const CONTRACT_VERSION: &str = "3.0.1";\n');
  writeFileSync(folder(dir, "contracts/escrow/src/errors.rs"), 'pub enum Error {\n    Existing = 1,\n}\n');
  run(dir, "git", ["init", "-q"]);
  run(dir, "git", ["config", "user.email", "test@example.invalid"]);
  run(dir, "git", ["config", "user.name", "Test"]);
  run(dir, "git", ["add", "."]);
  run(dir, "git", ["commit", "-qm", "base"]);
  return { dir, base: run(dir, "git", ["rev-parse", "HEAD"]).trim() };
}

function commitChange(f, source, fragment, name = "322-test.md") {
  writeFileSync(folder(f.dir, "contracts/escrow/src/change.rs"), source);
  if (fragment !== undefined) writeFileSync(folder(f.dir, `contract-changes.d/${name}`), fragment);
  run(f.dir, "git", ["add", "."]);
  run(f.dir, "git", ["commit", "-qm", "change"]);
}

function checkFails(f) {
  assert.throws(() => run(f.dir, checker, [f.base]));
}

test("requires a valid fragment for contract changes", () => {
  const f = fixture();
  commitChange(f, "pub fn change() {}\n");
  checkFails(f);
  const valid = fixture();
  commitChange(valid, "pub fn change() {}\n", "bump: patch\n---\nIssue #322: test.\n");
  assert.match(run(valid.dir, checker, [valid.base]), /1 contract-change fragment/);
});

test("rejects malformed fragment format and filenames", () => {
  for (const [name, text] of [
    ["bad.md", "bump: patch\n---\nSummary\n"],
    ["322-bad.md", "bump: typo\n---\nSummary\n"],
    ["322-empty.md", "bump: patch\n---\n   \n"],
  ]) {
    const f = fixture();
    commitChange(f, "pub fn change() {}\n", text, name);
    checkFails(f);
  }
});

test("rejects a version edit and non-provisional error renumbering", () => {
  const version = fixture();
  writeFileSync(folder(version.dir, "contracts/escrow/src/lib.rs"), 'pub const CONTRACT_VERSION: &str = "3.0.2";\n');
  writeFileSync(folder(version.dir, "contracts/escrow/src/change.rs"), "pub fn change() {}\n");
  writeFileSync(folder(version.dir, "contract-changes.d/322-version.md"), "bump: patch\n---\nVersion test\n");
  run(version.dir, "git", ["add", "."]);
  run(version.dir, "git", ["commit", "-qm", "change"]);
  checkFails(version);

  const codes = fixture();
  writeFileSync(folder(codes.dir, "contracts/escrow/src/errors.rs"), "pub enum Error {\n    Existing = 2,\n}\n");
  writeFileSync(folder(codes.dir, "contracts/escrow/src/change.rs"), "pub fn change() {}\n");
  writeFileSync(folder(codes.dir, "contract-changes.d/322-codes.md"), "bump: patch\n---\nCode test\n");
  run(codes.dir, "git", ["add", "."]);
  run(codes.dir, "git", ["commit", "-qm", "change"]);
  checkFails(codes);
});

test("accepts provisional codes and fold renumbers them", () => {
  const f = fixture();
  writeFileSync(folder(f.dir, "contracts/escrow/src/errors.rs"), "pub enum Error {\n    Existing = 1,\n    Added = 32201,\n}\n");
  writeFileSync(folder(f.dir, "contracts/escrow/src/change.rs"), "pub fn change() {}\n");
  writeFileSync(folder(f.dir, "contract-changes.d/322-provisional.md"), "bump: minor\n---\nProvisional code test\n");
  run(f.dir, "git", ["add", "."]);
  run(f.dir, "git", ["commit", "-qm", "change"]);
  assert.match(run(f.dir, checker, [f.base]), /1 contract-change fragment/);
  const fold = join(root, "scripts/fold-contract-changes.mjs");
  run(f.dir, fold);
  assert.match(readFileSync(folder(f.dir, "contracts/escrow/src/lib.rs"), "utf8"), /3\.1\.0/);
  assert.match(readFileSync(folder(f.dir, "contracts/escrow/src/errors.rs"), "utf8"), /Added = 2/);
});
