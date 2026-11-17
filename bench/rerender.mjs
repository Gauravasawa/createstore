// createStore vs Zustand vs React Context, in real Chromium with React's production build.
// Every update is wrapped in flushSync, so the timing covers the store notifying and React rendering + committing.
// Each run also counts renders and checks the last value is on screen.
//   wide:   N components, each reads its own key; one key changes per update (the common app shape)
//   narrow: N components all read the same key; it changes per update (every component must re-render)
// Libraries alternate round by round; the median of 7 rounds is reported.
// Run from the repository root: npm run build && npm install --prefix bench && node bench/rerender.mjs
// Options: N=5000 UPDATES=300 node bench/rerender.mjs
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const here = fileURLToPath(new URL('.', import.meta.url));
const lib = fileURLToPath(new URL('../dist/esm/createStore.js', import.meta.url)).replace(/\\/g, '/');
const N = Number(process.env.N ?? 1000);
const UPDATES = Number(process.env.UPDATES ?? 300);
const ROUNDS = 7;

const app = `
import { createElement as h, createContext, useContext, useState, memo } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createStore } from '${lib}';
import { create } from 'zustand';

const keys = (n) => Array.from({ length: n }, (_, i) => 'k' + i);
const initial = (n) => Object.fromEntries(keys(n).map((k) => [k, 0]));
let renders = 0;

// Each library returns [Component, set(key, value), Provider?]
const libs = {
  'createStore useGlobalState(key)'(n) {
    const s = createStore(initial(n), { name: 'cs-' + Math.random() });
    const C = memo(({ k }) => { renders++; return h('i', null, s.useGlobalState(k)[0]); });
    return [C, (k, v) => s.setState(k, v)];
  },
  'createStore useGlobalState(selector)'(n) {
    const s = createStore(initial(n), { name: 'css-' + Math.random() });
    const C = memo(({ k }) => { renders++; return h('i', null, s.useGlobalState((st) => st[k])); });
    return [C, (k, v) => s.setState(k, v)];
  },
  'zustand useStore(selector)'(n) {
    const useS = create(() => initial(n));
    const C = memo(({ k }) => { renders++; return h('i', null, useS((st) => st[k])); });
    return [C, (k, v) => useS.setState({ [k]: v })];
  },
  'zustand useStore() (no selector)'(n) {
    const useS = create(() => initial(n));
    const C = memo(({ k }) => { renders++; return h('i', null, useS()[k]); });
    return [C, (k, v) => useS.setState({ [k]: v })];
  },
  'React Context + useState'(n) {
    const Ctx = createContext(null);
    let setAll;
    const Provider = ({ children }) => { const [v, set] = useState(() => initial(n)); setAll = set; return h(Ctx.Provider, { value: v }, children); };
    const C = memo(({ k }) => { renders++; return h('i', null, useContext(Ctx)[k]); });
    return [C, (k, v) => setAll((s) => ({ ...s, [k]: v })), Provider];
  },
};

window.runBench = (name, mode, n, updates) => {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  const [C, set, Provider] = libs[name](n);
  const key = (i) => (mode === 'wide' ? 'k' + ((i * 7919 + 13) % n) : 'k0');
  const kids = keys(n).map((k) => h(C, { key: k, k: mode === 'wide' ? k : 'k0' }));
  flushSync(() => root.render(Provider ? h(Provider, null, kids) : h('div', null, kids)));
  for (let i = 0; i < 20; i++) flushSync(() => set(key(i + updates), -i - 1)); // warm-up
  renders = 0;
  const t = performance.now();
  for (let i = 0; i < updates; i++) flushSync(() => set(key(i), i + 1));
  const ms = performance.now() - t;
  const last = mode === 'wide' ? ((updates - 1) * 7919 + 13) % n : 0;
  const correct = el.querySelectorAll('i')[last].textContent === String(updates);
  flushSync(() => root.unmount());
  el.remove();
  return { perUpdate: ms / updates, rendersPerUpdate: renders / updates, correct };
};
window.libNames = Object.keys(libs);
`;
const bundle = (
  await build({
    stdin: { contents: app, resolveDir: here, loader: 'js' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  })
).outputFiles[0].text;

const server = createServer((req, res) => {
  const js = req.url.split('?')[0] === '/app.js';
  res.writeHead(200, { 'content-type': js ? 'text/javascript' : 'text/html' });
  res.end(js ? bundle : '<!doctype html><title>bench</title><script src="/app.js"></script>');
}).listen(0, '127.0.0.1');
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR:', String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
const names = await page.evaluate(() => window.libNames);
const chrome = await page.evaluate(() => navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0]);
console.log(`${chrome}, React production, N=${N} components, median of ${ROUNDS} rounds\n`);
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const mode of ['wide', 'narrow']) {
  const updates = mode === 'narrow' ? Math.max(30, UPDATES / 10) : UPDATES;
  const all = Object.fromEntries(names.map((n) => [n, []]));
  for (let r = 0; r < ROUNDS; r++)
    for (const name of r % 2 ? [...names].reverse() : names)
      all[name].push(await page.evaluate(([l, m, n, u]) => window.runBench(l, m, n, u), [name, mode, N, updates]));
  console.log(
    mode === 'wide'
      ? `WIDE: ${N} components on ${N} keys, one key changes per update`
      : `NARROW: ${N} components on one key, it changes per update`,
  );
  const rows = names.map((name) => ({
    name,
    ms: median(all[name].map((x) => x.perUpdate)),
    renders: median(all[name].map((x) => x.rendersPerUpdate)),
    ok: all[name].every((x) => x.correct),
  }));
  const best = Math.min(...rows.map((r) => r.ms));
  for (const r of rows)
    console.log(
      `  ${r.name.padEnd(38)} ${r.ms.toFixed(3).padStart(8)} ms/update ${String(r.renders).padStart(6)} renders/update ${(r.ms / best).toFixed(2).padStart(6)}x  ${r.ok ? 'correct' : 'WRONG VALUE ON SCREEN'}`,
    );
  console.log('');
}
await browser.close();
server.close();
