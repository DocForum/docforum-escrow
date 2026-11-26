#!/usr/bin/env node
// Surface docs coverage: every public function in contract-spec.json must be
// listed in the "Contract surface" code block of ARCHITECTURE_ESSENTIALS.md,
// or in a pending docs.d/*.md fragment that targets that section (issue #475).
//
//   node scripts/check-surface-docs.mjs [repo-root]
//
// `__constructor` is exempt: it runs once at deployment and is not a callable
// entry point. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXEMPT = new Set(['__constructor']);
const DOC = 'ARCHITECTURE_ESSENTIALS.md';
const SECTION = 'contract surface';

const norm = (s) => s.replace(/`/g, '').trim().toLowerCase();

// Text of the first fenced code block under the "Contract surface" heading.
export function surfaceBlock(doc) {
  const lines = doc.split(/\r?\n/);
  let start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && norm(l.replace(/^#+\s*/, '')) === SECTION);
  if (start < 0) throw new Error(`${DOC}: no "Contract surface" heading`);
  const out = [];
  let inside = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      if (inside) return out.join('\n');
      inside = true;
      continue;
    }
    if (!inside && /^#{1,6}\s/.test(lines[i])) break;
    if (inside) out.push(lines[i]);
  }
  throw new Error(`${DOC}: no code block under "Contract surface"`);
}

// Bodies of pending fragments aimed at the Contract surface section.
export function fragmentBodies(dir) {
  if (!fs.existsSync(dir)) return [];
  const bodies = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md').sort()) {
    const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) continue;
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-z]+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    if (meta.file === DOC && meta.section && norm(meta.section) === SECTION) bodies.push({ file: f, body: m[2] });
  }
  return bodies;
}

const mentions = (text, name) => new RegExp(`(^|[^A-Za-z0-9_])${name}\\(`, 'm').test(text);

export function findMissing(root) {
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'contract-spec.json'), 'utf8'));
  const block = surfaceBlock(fs.readFileSync(path.join(root, DOC), 'utf8'));
  const frags = fragmentBodies(path.join(root, 'docs.d'));
  return spec.functions
    .map((f) => f.name)
    .filter((n) => !EXEMPT.has(n))
    .filter((n) => !mentions(block, n) && !frags.some((fr) => mentions(fr.body, n)));
}

export function message(missing) {
  return [
    `${missing.length} public function(s) in contract-spec.json have no line in the "Contract surface" block of ${DOC}:`,
    ...missing.map((n) => `  - ${n}`),
    '',
    'Add a fragment, e.g. docs.d/<issue>-<slug>.md (do not edit ARCHITECTURE_ESSENTIALS.md directly):',
    '',
    '---',
    `file: ${DOC}`,
    'section: Contract surface',
    '---',
    ...missing.map((n) => `${n}(<args>) -> <return> // <issue/ADR, who authorizes, which states, testnet status>`),
  ].join('\n');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const missing = findMissing(root);
  if (missing.length) {
    console.error(message(missing));
    process.exit(1);
  }
  console.log('surface docs: every public function is covered');
}
