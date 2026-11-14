// The site checks must pass on a real build, and must FAIL when a security rule is broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const env = { ...process.env, SITE_URL: 'https://createstore.pages.dev' };
execFileSync(process.execPath, ['site/build.mjs'], { env, stdio: 'pipe' });

// Runs check.mjs against a mutated copy of the real build; returns its exit code.
const exitCodeFor = (mutate) => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-site-'));
  try {
    mkdirSync(join(dir, 'site'));
    cpSync(resolve('site/dist'), join(dir, 'site/dist'), { recursive: true });
    cpSync(resolve('site/check.mjs'), join(dir, 'site/check.mjs'));
    mutate(join(dir, 'site/dist'));
    execFileSync(process.execPath, [join(dir, 'site/check.mjs')], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const edit = (file, fn) => (dist) => writeFileSync(join(dist, file), fn(readFileSync(join(dist, file), 'utf8')));

test('the real build passes', () =>
  assert.equal(
    exitCodeFor(() => {}),
    0,
  ));
test('an inline event handler is rejected', () =>
  assert.equal(exitCodeFor(edit('index.html', (h) => h.replace('<body', '<body onload="x()"'))), 1));
test('an inline style attribute is rejected', () =>
  assert.equal(exitCodeFor(edit('index.html', (h) => h.replace('<body', '<body style="color:red"'))), 1));
test('a javascript: link is rejected', () =>
  assert.equal(
    exitCodeFor(edit('index.html', (h) => h.replace('<body', '<a href="javascript:alert(1)">x</a><body'))),
    1,
  ));
test('a third-party script is rejected', () =>
  assert.equal(
    exitCodeFor(
      edit('index.html', (h) => h.replace('</head>', '<script src="https://cdn.example.com/x.js"></script></head>')),
    ),
    1,
  ));
test('an inline script that is not in the CSP is rejected', () =>
  assert.equal(exitCodeFor(edit('index.html', (h) => h.replace('</head>', '<script>alert(1)</script></head>'))), 1));
test("'unsafe-inline' in the CSP is rejected", () =>
  assert.equal(
    exitCodeFor(edit('_headers', (h) => h.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))),
    1,
  ));
test('a missing security header is rejected', () =>
  assert.equal(exitCodeFor(edit('_headers', (h) => h.replace('X-Content-Type-Options: nosniff', ''))), 1));
test('a reference to a missing asset is rejected', () =>
  assert.equal(exitCodeFor(edit('index.html', (h) => h.replace('/favicon.svg', '/missing.svg'))), 1));

// Search, answer engines and agents
test('a docs section missing from llms.txt is rejected', () =>
  assert.equal(exitCodeFor(edit('llms.txt', (t) => t.replace(/^- \[Persistence\].*\n/m, ''))), 1));
test('a FAQ that no longer matches the structured data is rejected', () =>
  assert.equal(exitCodeFor(edit('index.html', (h) => h.replace('"name":"Do I need a provider?"', '"name":""'))), 1));
test('a robots.txt that blocks an AI crawler is rejected', () =>
  assert.equal(exitCodeFor(edit('robots.txt', (t) => t.replace('User-agent: ClaudeBot\n', ''))), 1));
test('a page without a social image is rejected', () =>
  assert.equal(exitCodeFor(edit('index.html', (h) => h.replace('og-image.png', 'missing.png'))), 1));

// One page per section, and the files for crawlers
test('a section without its own page is rejected', () =>
  assert.equal(
    exitCodeFor((dist) => rmSync(join(dist, 'persist'), { recursive: true, force: true })),
    1,
  ));
test('a sitemap without the section pages is rejected', () =>
  assert.equal(
    exitCodeFor(edit('sitemap.xml', (x) => x.replace(/<url><loc>[^<]+\/persist\/<\/loc>.*<\/url>\n/, ''))),
    1,
  ));
test('a section page whose inline script is not in the CSP is rejected', () =>
  assert.equal(
    exitCodeFor(edit('persist/index.html', (h) => h.replace('</body>', '<script>alert(1)</script></body>'))),
    1,
  ));
test('a section page with a broken link is rejected', () =>
  assert.equal(exitCodeFor(edit('persist/index.html', (h) => h.replace('href="/ssr/"', 'href="/nowhere/"'))), 1));
test('an expired security.txt is rejected', () =>
  assert.equal(
    exitCodeFor(edit('.well-known/security.txt', (t) => t.replace(/Expires: .*/, 'Expires: 2020-01-01T00:00:00.000Z'))),
    1,
  ));
test('a page without the skip link is rejected', () =>
  assert.equal(exitCodeFor(edit('index.html', (h) => h.replace('class="skip-link"', 'class="x"'))), 1));
