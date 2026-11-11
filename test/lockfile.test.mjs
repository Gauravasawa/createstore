import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/check-lockfile.mjs');
const real = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const target = Object.keys(real.packages).find((k) => k.endsWith('node_modules/prettier'));

// Runs the guard against a mutated copy of the real lockfile; returns its exit code.
const exitCodeFor = (mutate) => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-lock-'));
  try {
    const lock = structuredClone(real);
    mutate(lock.packages[target]);
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
    execFileSync(process.execPath, [script], { cwd: dir, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the real lockfile passes', () =>
  assert.equal(
    exitCodeFor(() => {}),
    0,
  ));
test('a package resolved from git is rejected', () =>
  assert.equal(
    exitCodeFor((p) => (p.resolved = 'git+https://github.com/evil/prettier.git#abc')),
    1,
  ));
test('a package resolved from another server is rejected', () =>
  assert.equal(
    exitCodeFor((p) => (p.resolved = 'https://evil.example.com/prettier-3.tgz')),
    1,
  ));
test('a package without an integrity hash is rejected', () =>
  assert.equal(
    exitCodeFor((p) => delete p.integrity),
    1,
  ));
test('a weak (sha1) integrity hash is rejected', () =>
  assert.equal(
    exitCodeFor((p) => (p.integrity = 'sha1-abcdefabcdefabcdefabcdefabc=')),
    1,
  ));
