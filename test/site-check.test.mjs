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
