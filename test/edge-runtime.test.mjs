import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { EdgeVM } from '@edge-runtime/vm';

// Bundle a consumer for a worker-style runtime (no Node built-ins) and run it in an Edge sandbox.
test('works in an edge runtime (no Node APIs)', async () => {
  const r = await build({
    stdin: {
      contents: `import { createStore, serializeSnapshot } from '@createstore/createstore';
        const s = createStore({ n: 1 }); s.setState('n', (x) => x + 1);
        globalThis.__out = serializeSnapshot({ n: s.getState('n'), tag: '</script>' });`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'worker', 'edge-light'],
    target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const vm = new EdgeVM();
  assert.equal(vm.evaluate('typeof process'), 'undefined', 'sandbox must not expose Node globals');
  vm.evaluate(r.outputFiles[0].text);
  const out = vm.evaluate('globalThis.__out');
  assert.ok(!out.includes('<'), 'must be script-safe');
  assert.deepEqual(JSON.parse(out), { n: 2, tag: '</script>' });
});
