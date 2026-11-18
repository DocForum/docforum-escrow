#!/usr/bin/env node
// Folds the fragments in contract-changes.d/ into one contract release:
//
//   1. bumps CONTRACT_VERSION in contracts/escrow/src/lib.rs once, by the
//      largest `bump:` level across the fragments (major > minor > patch);
//   2. renumbers provisional `Error` codes (>= 1000, see the README) to the
//      next free codes after the highest final one, in ascending order;
//   3. writes changelog.d/contract-<version>.md so scripts/fold-changelog.mjs
//      records the release in ROADMAP.md, and deletes the fragments.
//
// Maintainers run this and commit the result in its own PR (contributors only
// add fragments, so their PRs never touch the version line). Afterwards,
// refresh the outputs that depend on the contract and commit them too:
//
//   (cd contracts/escrow && cargo test)          # refreshes test_snapshots/
//   scripts/check-generated-bindings.sh          # prints the regenerate steps
//
//   node scripts/fold-contract-changes.mjs            # fold and delete fragments
//   node scripts/fold-contract-changes.mjs --dry-run  # print what would change
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dryRun = process.argv.includes('--dry-run');
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const dir = path.join(root, 'contract-changes.d');
const libPath = path.join(root, 'contracts/escrow/src/lib.rs');
const PROVISIONAL_MIN = 1000;
const LEVELS = ['patch', 'minor', 'major'];

const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()
  : [];
if (files.length === 0) {
  console.log('No contract-change fragments to fold.');
  process.exit(0);
}

const fragments = files.map((file) => {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const m = text.match(/^bump:\s*(major|minor|patch)\s*\n---\s*\n([\s\S]*)$/);
  if (!m) {
    console.error(`${file}: expected a "bump: major|minor|patch" line, then "---", then the summary.`);
    process.exit(1);
  }
  return { file, bump: m[1], summary: m[2].trim() };
});

let lib = fs.readFileSync(libPath, 'utf8');
const versionRe = /^pub const CONTRACT_VERSION: &str = "(\d+)\.(\d+)\.(\d+)";/m;
const vm = lib.match(versionRe);
if (!vm) {
  console.error('Could not find CONTRACT_VERSION in lib.rs.');
  process.exit(1);
}
const level = fragments.reduce((max, f) => Math.max(max, LEVELS.indexOf(f.bump)), 0);
let [major, minor, patch] = vm.slice(1).map(Number);
if (level === 2) [major, minor, patch] = [major + 1, 0, 0];
else if (level === 1) [minor, patch] = [minor + 1, 0];
else patch += 1;
const oldVersion = vm.slice(1).join('.');
const newVersion = `${major}.${minor}.${patch}`;
lib = lib.replace(versionRe, `pub const CONTRACT_VERSION: &str = "${newVersion}";`);

const enumRe = /^pub enum Error \{([\s\S]*?)^\}/m;
const body = lib.match(enumRe)[1];
const variants = [...body.matchAll(/^(\s*)([A-Z][A-Za-z0-9]*)(\s*=\s*)(\d+)(\s*,)/gm)];
let next = Math.max(0, ...variants.map((v) => Number(v[4])).filter((c) => c < PROVISIONAL_MIN)) + 1;
const renumbered = [];
const byCode = variants.filter((v) => Number(v[4]) >= PROVISIONAL_MIN).sort((a, b) => a[4] - b[4]);
const finalCode = new Map(byCode.map((v) => [v[2], next++]));
const newBody = body.replace(/^(\s*)([A-Z][A-Za-z0-9]*)(\s*=\s*)(\d+)(\s*,)/gm, (all, ws, name, eq, code, comma) => {
  if (!finalCode.has(name)) return all;
  renumbered.push(`Error::${name} ${code} -> ${finalCode.get(name)}`);
  return `${ws}${name}${eq}${finalCode.get(name)}${comma}`;
});
lib = lib.replace(enumRe, (all) => all.replace(body, newBody));

const entry = [
  `Contract ${newVersion} (was ${oldVersion}), folded from ${files.length} change(s):`,
  '',
  ...fragments.map((f) => `- ${f.summary.replace(/\s*\n\s*/g, ' ')}`),
  ...(renumbered.length ? ['', `Final error codes: ${renumbered.join(', ')}.`] : []),
  '',
].join('\n');

console.log(`CONTRACT_VERSION ${oldVersion} -> ${newVersion} (${LEVELS[level]})`);
for (const r of renumbered) console.log(`  ${r}`);
for (const f of fragments) console.log(`  ${f.bump.padEnd(5)}  ${f.file}`);
if (dryRun) process.exit(0);

fs.writeFileSync(libPath, lib);
fs.writeFileSync(path.join(root, 'changelog.d', `contract-${newVersion}.md`), entry);
for (const f of files) fs.rmSync(path.join(dir, f));
console.log(`\nFolded ${files.length} fragment(s). Now run cargo test (snapshots) and regenerate the SDK bindings.`);
