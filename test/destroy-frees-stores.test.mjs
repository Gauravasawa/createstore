// F-602: destroy() takes a named browser store out of the by-name registry, so the store can be freed. Before, every
// named store stayed reachable forever (300 of 300 survived this test). Runs in a child process with --expose-gc and a
// jsdom window, because named stores are registered only in a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('300 named stores created and destroyed in a browser are freed by the garbage collector', () => {
  const lib = pathToFileURL(resolve('dist/esm/createStore.js')).href;
  const code = `
    import { JSDOM } from 'jsdom';
    const dom = new JSDOM('<!doctype html><p></p>', { url: 'https://example.test/' });
    globalThis.window = dom.window;
    for (const k of ['document', 'navigator', 'localStorage', 'sessionStorage'])
      Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true });
    const { createStore } = await import(${JSON.stringify(lib)});
    const refs = [];
    for (let i = 0; i < 300; i++) {
      const s = createStore({ big: new Array(1000).fill(i) }, { name: 'generated-' + i });
      refs.push(new WeakRef(s));
      s.destroy();
    }
    for (let i = 0; i < 10; i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); }
    process.stdout.write(String(refs.filter((r) => r.deref() !== undefined).length));`;
  const alive = Number(
    execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', code], { encoding: 'utf8' }),
  );
  // A collector may keep a store or two for a moment; before the fix all 300 stayed.
  assert.ok(alive < 10, `${alive} of 300 destroyed stores are still alive`);
});
