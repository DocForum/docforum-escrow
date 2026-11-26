import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findMissing, message } from './check-surface-docs.mjs';

function repo({ block, fragments = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-'));
  fs.mkdirSync(path.join(root, 'docs.d'));
  fs.writeFileSync(path.join(root, 'contract-spec.json'), JSON.stringify({
    functions: [{ name: '__constructor' }, { name: 'alpha' }, { name: 'beta' }],
  }));
  fs.writeFileSync(path.join(root, 'ARCHITECTURE_ESSENTIALS.md'),
    `# A\n\n## Contract surface\n\`\`\`\n${block}\n\`\`\`\n\n## Events\n\`\`\`\nbeta(x)\n\`\`\`\n`);
  for (const [name, text] of Object.entries(fragments)) fs.writeFileSync(path.join(root, 'docs.d', name), text);
  return root;
}
const frag = (line, section = 'Contract surface') =>
  `---\nfile: ARCHITECTURE_ESSENTIALS.md\nsection: ${section}\n---\n${line}\n`;

test('a function missing everywhere fails and the message names the fragment', () => {
  const root = repo({ block: 'alpha(a) -> ()' });
  const missing = findMissing(root);
  assert.deepEqual(missing, ['beta']);
  assert.match(message(missing), /section: Contract surface/);
  assert.match(message(missing), /beta\(<args>\)/);
});

test('a function covered by a pending fragment passes', () => {
  const root = repo({ block: 'alpha(a) -> ()', fragments: { '1-x.md': frag('beta(b) -> () // note') } });
  assert.deepEqual(findMissing(root), []);
});

test('a function in the block passes, constructor is exempt', () => {
  const root = repo({ block: 'alpha(a) -> ()\nbeta(b) -> ()' });
  assert.deepEqual(findMissing(root), []);
});

test('a fragment for another section, or a name prefix, does not count', () => {
  const root = repo({
    block: 'alpha(a) -> ()\nbeta_two(b) -> ()',
    fragments: { '1-x.md': frag('beta(b) -> ()', 'Events') },
  });
  assert.deepEqual(findMissing(root), ['beta']);
});
