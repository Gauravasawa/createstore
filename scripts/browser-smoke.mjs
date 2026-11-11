// Runs the built package in real browsers (Chromium, Firefox, WebKit) through Playwright: rendering, persistence
// across a reload, tab sync through BroadcastChannel, undo/redo, server data, and hydrating server-rendered HTML.
//   npx playwright-core install chromium firefox webkit     (once)
//   npm run build && npm run test:browsers                  (all three)
//   node scripts/browser-smoke.mjs chromium                 (only some)
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright-core';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { createStore, query } from '../dist/esm/createStore.js';
import { makeApps } from './browser-smoke-app.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wanted = process.argv.slice(2);
const engines = { chromium, firefox, webkit };
const names = wanted.length ? wanted : Object.keys(engines);

// The browser bundle: React, ReactDOM and the built package in one script
const entry = `
import { createElement as h } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { createStore, query } from '../dist/esm/createStore.js';
import { makeApps } from './browser-smoke-app.mjs';
const { client, Client, ssr, Ssr } = makeApps({ createStore, query, h });
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
const el = document.getElementById('root');
if (location.pathname === '/ssr') {
  hydrateRoot(el, h(ssr.Root, { scope: ssr.hydrate() }, h(Ssr)), { onRecoverableError: (e) => window.__errors.push('hydration: ' + e.message) });
} else {
  createRoot(el).render(h(Client));
}
window.__ready = true;
`;
const bundle = (
  await build({
    stdin: { contents: entry, resolveDir: join(root, 'scripts'), loader: 'js' },
    bundle: true,
    format: 'iife',
    write: false,
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  })
).outputFiles[0].text;

// What the server sends for /ssr: HTML for this request's store, and its data after it
const { ssr, Ssr } = makeApps({ createStore, query, h });
const scope = ssr.createScope({ user: 'ada', cart: ['book', 'pen'] });
const ssrHtml = renderToString(h(ssr.Root, { scope }, h(Ssr)));
const page = (inner, extra = '') =>
  `<!doctype html><meta charset="utf-8"><body><div id="root">${inner}</div>${extra}<script>${bundle.replaceAll('</script', '<\\/script')}</script>`;

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/api/items') return res.writeHead(200, { 'content-type': 'application/json' }).end('["a","b","c"]');
  if (path === '/ssr') return res.writeHead(200, { 'content-type': 'text/html' }).end(page(ssrHtml, scope.toScript()));
  if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page(''));
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const report = (engine, name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${engine.padEnd(8)} ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};
const text = (p, sel) => p.locator(sel).textContent();
const ready = (p) => p.waitForFunction(() => window.__ready === true);

for (const engine of names) {
  const browser = await engines[engine].launch({ headless: true });
  const t = (name, ok, detail) => report(engine, name, ok, detail);
  try {
    const context = await browser.newContext();
    const a = await context.newPage();
    const errors = [];
    a.on('pageerror', (e) => errors.push(e.message));
    await a.goto(`${base}/`);
    await ready(a);

    t('renders, and a click changes the state once', (await text(a, '#count')) === '0');
    await a.click('#inc');
    await a.click('#inc');
    t('two clicks make 2', (await text(a, '#count')) === '2');

    await a.click('#undo');
    t('undo', (await text(a, '#count')) === '1');
    await a.click('#redo');
    t('redo', (await text(a, '#count')) === '2');

    await a.waitForFunction(() => document.getElementById('items').textContent === 'a,b,c');
    t('server data loads and shows', true);

    // the save is written when the page goes away or after a short delay
    await a.waitForTimeout(400);
    await a.reload();
    await ready(a);
    await a.waitForFunction(() => document.getElementById('count').textContent === '2');
    t('persistence: the value survives a reload', true);

    const b = await context.newPage();
    await b.goto(`${base}/`);
    await ready(b);
    await a.click('#inc');
    await b
      .waitForFunction(() => document.getElementById('count').textContent === '3', null, { timeout: 5000 })
      .then(
        () => t('tab sync: a change in one tab reaches the other (BroadcastChannel)', true),
        () => t('tab sync: a change in one tab reaches the other (BroadcastChannel)', false, `tab B shows ${'?'}`),
      );
    await b.close();

    const s = await context.newPage();
    const ssrErrors = [];
    s.on('pageerror', (e) => ssrErrors.push(e.message));
    await s.goto(`${base}/ssr`);
    await ready(s);
    t(
      'SSR: the server HTML is there before hydration and the data is kept',
      (await text(s, '#user')) === 'ada' && (await text(s, '#cart')) === 'book,pen',
    );
    await s.click('#rename');
    t('SSR: the hydrated page is interactive', (await text(s, '#user')) === 'renamed');
    const hydrationErrors = await s.evaluate(() => window.__errors);
    t(
      'SSR: no hydration mismatch and no errors',
      hydrationErrors.length === 0 && ssrErrors.length === 0,
      JSON.stringify([...hydrationErrors, ...ssrErrors]),
    );

    t('no uncaught errors on the client page', errors.length === 0, errors.join(' | '));
  } catch (error) {
    report(
      engine,
      'the run itself',
      false,
      String(error?.stack ?? error)
        .split('\n')
        .slice(0, 4)
        .join('\n        '),
    );
  } finally {
    await browser.close();
  }
}
server.close();
console.log(failed ? `\n${failed} browser check(s) failed` : `\nAll browser checks passed (${names.join(', ')})`);
process.exit(failed ? 1 : 0);
