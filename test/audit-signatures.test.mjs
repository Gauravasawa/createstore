// scripts/audit-signatures.mjs with a fake `npm audit signatures`: what is retried, what fails at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/audit-signatures.mjs');
const KEY =
  'npm error code EMISSINGSIGNATUREKEY\nnpm error es-toolkit@1.53.2 has attestations but no corresponding public key(s) can be found';
const BAD = 'npm error code EINTEGRITYSIGNATURE\nnpm error lodash@4.17.21 has an invalid registry signature';
const OK = '234 packages have verified attestations';

// outcomes: what each successive call of the fake npm does: 'ok', 'key' or 'bad'. Returns { code, out, calls }.
function run(outcomes, waits = '0,0,0,0') {
  const dir = mkdtempSync(join(tmpdir(), 'cs-sig-'));
  const counter = join(dir, 'calls');
  const fake = join(dir, 'fake-npm.mjs');
  writeFileSync(
    fake,
    `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
     const n = existsSync(${JSON.stringify(counter)}) ? Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;
     writeFileSync(${JSON.stringify(counter)}, String(n + 1));
     const what = ${JSON.stringify(outcomes)}[n] ?? 'ok';
     if (what === 'ok') { console.log(${JSON.stringify(OK)}); process.exit(0); }
     console.error(what === 'key' ? ${JSON.stringify(KEY)} : ${JSON.stringify(BAD)}); process.exit(1);`,
  );
  const env = {
    ...process.env,
    AUDIT_SIGNATURES_COMMAND: `"${process.execPath}" "${fake}"`,
    AUDIT_SIGNATURES_WAITS: waits,
  };
  try {
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe', env });
    return { code: 0, out, calls: Number(readFileSync(counter, 'utf8')) };
  } catch (e) {
    return {
      code: e.status,
      out: `${e.stdout}${e.stderr}`,
      calls: existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('signatures verified at the first try: passes, one call', () => {
  const r = run(['ok']);
  assert.deepEqual([r.code, r.calls], [0, 1]);
  assert.match(r.out, /234 packages have verified attestations/);
});

test('the registry key is missing twice, then found (what happened in the failed release): passes after 3 calls', () => {
  const r = run(['key', 'key', 'ok']);
  assert.deepEqual([r.code, r.calls], [0, 3]);
  assert.equal((r.out.match(/::warning::the registry's signing key couldn't be found/g) ?? []).length, 2);
});

test('the key stays missing through every retry: fails after all 5 attempts', () => {
  const r = run(['key', 'key', 'key', 'key', 'key']);
  assert.deepEqual([r.code, r.calls], [1, 5]);
  assert.match(r.out, /still missing after 5 attempts/);
});

test('a signature that does not match is never retried: fails after one call', () => {
  const r = run(['bad', 'ok']);
  assert.deepEqual([r.code, r.calls], [1, 1]);
  assert.match(r.out, /isn't retried/);
});

test('a bad signature after a missing key still fails at once (no retry past a real failure)', () => {
  const r = run(['key', 'bad', 'ok']);
  assert.deepEqual([r.code, r.calls], [1, 2]);
});

test('the default waits are 20, 40, 80 and 160 seconds: about 5 minutes in all, within every job time limit', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /'20,40,80,160'/);
  assert.equal(20 + 40 + 80 + 160, 300);
});
