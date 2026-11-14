// Loads the built site in a real Chromium, served with the exact headers from site/dist/_headers, and checks
// that the Content-Security-Policy neither breaks the page nor can be bypassed.
//   node site/browser-check.mjs               uses Playwright's Chromium (npx playwright-core install chromium)
//   CHROME_PATH=/path/to/chrome node ...      uses another Chromium-based browser (Edge, Chrome)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist');

// ---- a tiny static server that applies _headers the way Cloudflare Pages does ----
const rules = readFileSync(join(dist, '_headers'), 'utf8')
  .split(/\n\s*\n/)
  .filter((b) => b.trim())
  .map((block) => {
    const [pattern, ...lines] = block.split('\n').filter(Boolean);
    const headers = lines
      .map((l) => /^\s+([^:]+):\s*(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]);
    const prefix = pattern.replace(/\*$/, '');
    return { match: (p) => p.startsWith(prefix), headers };
  });
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // like Cloudflare Pages: a path ending in "/" is the index.html of that folder
  let file = join(dist, normalize(path.endsWith('/') ? `${path}index.html` : path));
  let status = 200;
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    file = join(dist, '404.html');
    status = 404;
  }
  const headers = { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' };
  for (const r of rules) if (r.match(path)) for (const [k, v] of r.headers) headers[k] = v;
  res.writeHead(status, headers);
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- checks ----
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });

try {
  const page = await browser.newPage();
  const requested = [];
  const consoleErrors = [];
  page.on('request', (r) => requested.push(r.url()));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });

  const response = await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  const sent = response.headers();
  check(
    'page is served 200 with the CSP header',
    response.status() === 200 && Boolean(sent['content-security-policy']),
  );
  check(
    'security headers reach the browser',
    [
      'strict-transport-security',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
      'x-frame-options',
    ].every((h) => sent[h]),
  );
  check(
    'no CSP violations while loading',
    (await page.evaluate(() => window.__csp)).length === 0,
    JSON.stringify(await page.evaluate(() => window.__csp)),
  );
  check('no console errors or page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  check(
    'every request stayed on this site',
    requested.every((u) => u.startsWith(base)),
    requested.filter((u) => !u.startsWith(base)).join(', '),
  );

  await page.waitForSelector('.token', { timeout: 5000 }).catch(() => {}); // blocks are highlighted as they come near the screen
  check('syntax highlighting ran (self-hosted Prism)', (await page.locator('.token').count()) > 0);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/['"]/g, ''));
  });
  check(
    'self-hosted fonts loaded',
    ['Atkinson Hyperlegible', 'Bricolage Grotesque', 'IBM Plex Mono'].every((f) => fonts.includes(f)),
    fonts.join(', '),
  );

  // ---- a section page (its own URL) works the same way, under the same policy ----
  const sp = await browser.newPage();
  const spProblems = [];
  const spOutside = [];
  sp.on('console', (m) => m.type() === 'error' && spProblems.push(m.text()));
  sp.on('pageerror', (e) => spProblems.push(String(e)));
  sp.on('request', (r) => !r.url().startsWith(base) && spOutside.push(r.url()));
  await sp.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  const spResponse = await sp.goto(`${base}/persist/`, { waitUntil: 'networkidle' });
  check(
    'section page: 200 with the CSP, one h1, nothing blocked, no errors, nothing from outside this site',
    spResponse.status() === 200 &&
      Boolean(spResponse.headers()['content-security-policy']) &&
      (await sp.locator('h1').count()) === 1 &&
      (await sp.evaluate(() => window.__csp)).length === 0 &&
      spProblems.length === 0 &&
      spOutside.length === 0,
    JSON.stringify([await sp.evaluate(() => window.__csp), spProblems, spOutside]),
  );
  check(
    'section page: code is highlighted and the navigation marks this page',
    (await sp.locator('.token').count()) > 0 &&
      (await sp.locator('#sidebar a[aria-current="page"]').innerText()).includes('Persistence'),
  );
  await sp.keyboard.press('Tab');
  check(
    'section page: the first Tab stop is the skip link, and it leads to the content',
    (await sp.evaluate(() => document.activeElement?.className)) === 'skip-link' &&
      (await sp.evaluate(() => document.activeElement?.getAttribute('href'))) === '#main-content',
  );
  const spTheme = () => sp.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const spBefore = await spTheme();
  await sp.locator('.theme-btn').click();
  check('section page: theme switch works', (await spTheme()) !== spBefore);
  await sp.close();

  // ---- the page still works ----
  const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const before = await theme();
  await page.locator('.theme-btn').click();
  check('theme switch works', (await theme()) !== before);
  await page.reload({ waitUntil: 'networkidle' });
  check('theme choice is remembered (localStorage + the inline script)', (await theme()) !== before);

  await page.keyboard.press('/');
  await page.locator('#search-input').fill('persist');
  check(
    'search opens and returns results',
    (await page.locator('#search-results li').count()) > 0 && (await page.locator('#search[open]').count()) === 1,
  );
  // Escape inside a search box clears its text first, so a user (and this test) closes the dialog with its button
  await page.locator('#search-close').click();
  check('search dialog closes', (await page.locator('#search[open]').count()) === 0);

  const total = async () => Number(await page.locator('#demo-total').innerText());
  const totalBefore = await total();
  await page.fill('#demo-input', 'Buy milk');
  await page.press('#demo-input', 'Enter');
  // The page updates after the event, so wait for the result instead of reading it in the same instant
  const updated = await page
    .waitForFunction(() => document.querySelector('#demo-list')?.textContent?.includes('Buy milk'), null, {
      timeout: 3000,
    })
    .then(
      () => true,
      () => false,
    );
  const totalAfter = await total();
  check(
    'live demo works (form submit handled in page script, no navigation)',
    updated && totalAfter === totalBefore + 1 && page.url() === `${base}/`,
    `listUpdated=${updated} total ${totalBefore}->${totalAfter} url=${page.url()}`,
  );

  // ---- the CSP is real: injected code must not run ----
  await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.body.append(s);
    const img = document.createElement('img');
    img.src = 'https://example.com/pixel.png';
    document.body.append(img);
  });
  await page.waitForTimeout(150);
  check('injected inline script is blocked', (await page.evaluate(() => window.__injected)) === undefined);
  const violations = await page.evaluate(() => window.__csp);
  check(
    '...and reported as CSP violations (script and third-party image)',
    violations.some((v) => v.startsWith('script-src')) && violations.some((v) => v.startsWith('img-src')),
    violations.join(' | '),
  );

  // ---- 404 ----
  const notFound = await browser.newPage();
  const bad = await notFound.goto(`${base}/no/such/page`, { waitUntil: 'networkidle' });
  check(
    'unknown URL gives a real 404 status and the 404 page',
    bad.status() === 404 && (await notFound.locator('h1').innerText()).includes('does not exist'),
  );
  const font = await notFound.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily);
  check('404 page is styled (its stylesheet loaded under the CSP)', font.includes('Bricolage Grotesque'));
} finally {
  await browser.close();
  server.close();
}

for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
const bad = results.filter((r) => !r.ok).length;
if (bad) {
  console.error(`\n${bad} browser check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} browser checks passed.`);
