// scripts/check-audit.mjs against made-up audit results: what fails, what passes, and when an exception runs out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/check-audit.mjs');
const advisory = (id, severity, pkg = 'picomatch') => ({
  source: 1,
  name: pkg,
  title: `test advisory ${id}`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: '<=4.0.7',
});
// Runs the script on an audit result; returns { code, out }
const check = (vulnerabilities, now = '2026-11-20') => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-audit-'));
  const file = join(dir, 'audit.json');
  writeFileSync(file, JSON.stringify({ vulnerabilities }));
  try {
    const out = execFileSync(process.execPath, [script, file], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, CHECK_AUDIT_NOW: now },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const ACCEPTED_ID = 'GHSA-fc5q-39xc-vjpf';

test('no advisories: passes', () => assert.equal(check({}).code, 0));

test('a moderate advisory: passes (the gate is high and critical)', () =>
  assert.equal(check({ glob: { via: [advisory('GHSA-mod-0000-0000', 'moderate', 'glob')] } }).code, 0));

test('an unlisted high advisory: fails and names it', () => {
  const r = check({ x: { via: [advisory('GHSA-aaaa-bbbb-cccc', 'high', 'x')] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /high GHSA-aaaa-bbbb-cccc in x/);
});

test('an unlisted critical advisory: fails', () =>
  assert.equal(check({ x: { via: [advisory('GHSA-crit-0000-0000', 'critical', 'x')] } }).code, 1));

test('the accepted advisory before its date: passes, with a warning that says why', () => {
  const r = check({ picomatch: { via: [advisory(ACCEPTED_ID, 'high')] }, vitest: { via: ['picomatch'] } });
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`::warning::${ACCEPTED_ID} in picomatch \\(accepted until 2026-12-18\\)`));
});

test('the accepted advisory on its last day passes; the day after, it fails again', () => {
  const vulns = { picomatch: { via: [advisory(ACCEPTED_ID, 'high')] } };
  assert.equal(check(vulns, '2026-12-18T12:00:00Z').code, 0);
  const r = check(vulns, '2026-12-19T00:00:01Z');
  assert.equal(r.code, 1);
  assert.match(r.out, /accepted until 2026-12-18, which has passed/);
});

test('the accepted advisory does not hide another high one next to it', () => {
  const r = check({ picomatch: { via: [advisory(ACCEPTED_ID, 'high'), advisory('GHSA-new0-0000-0000', 'high')] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /GHSA-new0-0000-0000/);
  assert.doesNotMatch(r.out, new RegExp(`high ${ACCEPTED_ID}`));
});

test('once the advisory is gone, it says to remove the exception', () => {
  const r = check({});
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`::notice::${ACCEPTED_ID} is no longer reported`));
});
