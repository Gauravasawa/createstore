// The three source files import each other in a circle: createStore -> react-bindings -> client-root -> createStore.
// It works because client-root uses createStore's exports only when it renders, and ClientRoot is a hoisted function
// declaration, so whichever file loads first, every binding exists by the time it is used. These tests pin that:
// the graph may not grow without this test being updated, and each built file must load first without throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = resolve('src');
const localImports = (file) =>
  [...readFileSync(resolve(src, file), 'utf8').matchAll(/^(?:import|export)[^;]*?from\s+['"](\.\/[^'"]+)['"]/gm)]
    .map((m) => m[1].slice(2))
    .sort();

test('the import graph between source files is exactly the known cycle', () => {
  const graph = Object.fromEntries(
    readdirSync(src)
      .filter((f) => /\.tsx?$/.test(f))
      .sort()
      .map((f) => [f, localImports(f)]),
  );
  assert.deepEqual(graph, {
    'client-root.tsx': ['createStore'],
    'createStore.ts': ['react-bindings'],
    'react-bindings.ts': ['client-root'],
  });
});

// react-bindings can't be loaded first: createStore would then run before react-bindings has set RSC and throw.
// Nothing can load it first today, and this keeps it that way: it must never become a public entry.
test('react-bindings is internal: the package exposes only the createStore entry', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './package.json']);
  assert.match(pkg.exports['.'].import.default, /createStore\.js$/);
  assert.match(pkg.exports['.'].require.default, /createStore\.cjs$/);
});

// The two files that can be loaded first: the package entry, and client-root, which Next.js loads directly as the
// 'use client' boundary. Each in a fresh process (the cycle then starts from it); the store must still work.
for (const [format, ext] of [
  ['esm', 'js'],
  ['cjs', 'cjs'],
])
  for (const first of ['createStore', 'client-root'])
    test(`${format}: loading ${first} first works, and createStore then makes a working store`, () => {
      const dir = resolve('dist', format);
      const load = (name) =>
        format === 'esm'
          ? `await import(${JSON.stringify(pathToFileURL(resolve(dir, `${name}.${ext}`)).href)})`
          : `require(${JSON.stringify(resolve(dir, `${name}.${ext}`))})`;
      const code = [
        `const firstModule = ${load(first)};`,
        `const { createStore } = ${load('createStore')};`,
        `const { ClientRoot } = ${load('react-bindings')};`,
        `if (typeof ClientRoot !== 'function') throw new Error('ClientRoot is ' + typeof ClientRoot);`,
        `const s = createStore({ n: 1 }, { name: 'cycle' }); s.setState('n', 2);`,
        `if (s.getState('n') !== 2) throw new Error('store broken');`,
        `if (!firstModule) throw new Error('first module empty');`,
        `process.stdout.write('ok');`,
      ].join('\n');
      const args =
        format === 'esm'
          ? ['--input-type=module', '-e', code]
          : ['-e', `(async () => { ${code} })().catch((e) => { console.error(e); process.exit(1); });`];
      assert.equal(execFileSync(process.execPath, args, { encoding: 'utf8' }), 'ok');
    });
