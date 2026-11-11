import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = async (code) => {
  const r = await build({
    stdin: { contents: code, resolveDir: process.cwd() },
    bundle: true,
    minify: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['react'],
  });
  return r.outputFiles[0].text;
};

test('importing one tiny export does not pull in the store (sideEffects: false works)', async () => {
  const out = await bundle("import { defineEvents } from '@createstore/createstore'; console.log(defineEvents());");
  assert.ok(out.length < 500, `expected a tiny bundle, got ${out.length} bytes`);
});

test('full createStore bundle stays under the size budget', async () => {
  const out = await bundle(
    "import { createStore } from '@createstore/createstore'; console.log(createStore({ a: 1 }));",
  );
  assert.ok(out.length < 70_000, `bundle is ${out.length} bytes; raise the budget on purpose, not by accident`);
});
