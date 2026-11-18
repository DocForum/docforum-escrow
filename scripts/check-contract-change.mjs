#!/usr/bin/env node
// CI rule for pull requests that touch the escrow contract.
//
// Contributors no longer edit CONTRACT_VERSION. When nine open PRs each bumped
// that one line, every contract merge put all the others into conflict. Now a
// PR that changes contracts/escrow/src/lib.rs adds a fragment under
// contract-changes.d/ instead, and a maintainer bumps the version once per
// batch with scripts/fold-contract-changes.mjs (see contract-changes.d/README.md).
//
// The same goes for `Error` codes: new variants use a provisional discriminant
// (issue number × 100 + n, so they can't collide between PRs), and the fold
// renumbers them to the next free codes.
//
// Fails when lib.rs changed and:
//   - no fragment was added, or
//   - CONTRACT_VERSION changed (only a fold PR, which deletes fragments, may), or
//   - an existing `Error` variant was renumbered or removed, or
//   - a new `Error` variant uses a non-provisional code (below 1000).
//
//   node scripts/check-contract-change.mjs <base-ref>   # e.g. origin/main
import { execFileSync } from 'node:child_process';

const LIB = 'contracts/escrow/src/lib.rs';
const FRAGMENTS = 'contract-changes.d/';
const PROVISIONAL_MIN = 1000;

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/check-contract-change.mjs <base-ref>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const mergeBase = git('merge-base', base, 'HEAD').trim();
const show = (rev) => git('show', `${rev}:${LIB}`);

if (!git('diff', '--name-only', mergeBase, 'HEAD', '--', LIB).trim()) process.exit(0);

const changed = git('diff', '--name-status', mergeBase, 'HEAD', '--', FRAGMENTS)
  .split('\n')
  .filter((l) => l.trim() && !l.endsWith('README.md'));
const added = changed.filter((l) => l.startsWith('A'));
const deleted = changed.filter((l) => l.startsWith('D'));
const isFold = deleted.length > 0 && added.length === 0;

const version = (src) => (src.match(/^pub const CONTRACT_VERSION: &str = "([^"]+)";/m) || [])[1];
function errorCodes(src) {
  const body = (src.match(/^pub enum Error \{([\s\S]*?)^\}/m) || [])[1] || '';
  const codes = new Map();
  for (const m of body.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*=\s*(\d+)\s*,/gm)) codes.set(m[1], Number(m[2]));
  return codes;
}

const before = show(mergeBase);
const after = show('HEAD');
const problems = [];

if (!isFold && added.length === 0) {
  problems.push(
    `${LIB} changed, but no fragment was added under ${FRAGMENTS}. ` +
      `Add ${FRAGMENTS}<issue>-<slug>.md (see ${FRAGMENTS}README.md).`,
  );
}
if (!isFold && version(before) !== version(after)) {
  problems.push(
    `CONTRACT_VERSION changed (${version(before)} -> ${version(after)}). ` +
      `Leave it as it is on main: a maintainer bumps it when folding ${FRAGMENTS}.`,
  );
}

const old = errorCodes(before);
const now = errorCodes(after);
for (const [name, code] of old) {
  if (!now.has(name)) problems.push(`Error::${name} (= ${code}) was removed. Error codes are append-only.`);
  else if (now.get(name) !== code && !(isFold && code >= PROVISIONAL_MIN)) {
    problems.push(`Error::${name} was renumbered (${code} -> ${now.get(name)}). Error codes are append-only.`);
  }
}
if (!isFold) {
  for (const [name, code] of now) {
    if (!old.has(name) && code < PROVISIONAL_MIN) {
      problems.push(
        `New Error::${name} uses code ${code}. Use a provisional code (your issue number × 100 + n, ` +
          `e.g. issue #35 -> 3500, 3501); the maintainer fold assigns the final number.`,
      );
    }
  }
}
const seen = new Map();
for (const [name, code] of now) {
  if (seen.has(code)) problems.push(`Error::${name} and Error::${seen.get(code)} share code ${code}.`);
  seen.set(code, name);
}

if (problems.length) {
  for (const p of problems) console.error(`error: ${p}`);
  process.exit(1);
}
console.log(isFold ? 'OK: contract-change fold.' : `OK: ${added.length} contract-change fragment(s) added.`);
