import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const NAMES = ['createStore', 'query', 'defineEvents', 'serializeSnapshot', 'defaultRetryDelay'];

const check = (m) => {
  for (const n of NAMES) assert.equal(typeof m[n], 'function', `${n} missing`);
  const s = m.createStore({ n: 1 });
  s.setState('n', 2);
  assert.equal(s.getState('n'), 2);
  assert.ok(!m.serializeSnapshot({ a: '</script>' }).includes('<'));
};

test('ESM import via package name', async () => check(await import('@createstore/createstore')));
test('CJS require via package name', () => check(require('@createstore/createstore')));
// the createStore <-> react-bindings <-> client-root cycle must load from either end
test('ESM: react-bindings first', async () => {
  const rb = await import('../dist/esm/react-bindings.js');
  assert.equal(typeof rb.ClientRoot, 'function');
});
test('CJS: react-bindings first', () => {
  assert.equal(typeof require('../dist/cjs/react-bindings.cjs').ClientRoot, 'function');
});
test("'use client' kept on client-root", async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../dist/esm/client-root.js', import.meta.url), 'utf8'), /^["']use client["']/);
});
