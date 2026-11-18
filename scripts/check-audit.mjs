// Dev-tool audit with time-boxed exceptions. Fails on any high or critical advisory, except one listed in ACCEPTED
// below, and only until its date: then it fails again, so an exception can't be forgotten. Use it only for an
// advisory that has no fixed version yet and can't be exploited here; say why, and keep the date close.
// Usage: node scripts/check-audit.mjs [audit.json]   (without a file it runs `npm audit --json` itself)
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ACCEPTED = [
  {
    id: 'GHSA-fc5q-39xc-vjpf',
    until: '2026-12-18',
    why:
      'picomatch <=4.0.7 ReDoS through crafted glob patterns. No fixed version exists yet (4.0.7 is the latest). ' +
      'It is only in dev tools (vitest, tsup, typescript-eslint, semantic-release), never in the package, and ' +
      'every glob pattern they get comes from this repository, not from outside input.',
  },
];

const readAudit = () => {
  if (process.argv[2]) return readFileSync(process.argv[2], 'utf8');
  try {
    return execSync('npm audit --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); // a fixed command, no input
  } catch (error) {
    return error.stdout; // npm audit exits 1 when it finds anything; the JSON is still on stdout
  }
};
const audit = JSON.parse(readAudit().replace(/^\uFEFF/, ''));
const now = process.env.CHECK_AUDIT_NOW ? new Date(process.env.CHECK_AUDIT_NOW) : new Date();
const idOf = (url) => /GHSA-[\w-]+/.exec(url ?? '')?.[0] ?? url ?? 'unknown';

// The advisories themselves (not every package that depends on an affected one), by id
const advisories = new Map();
for (const [pkg, vuln] of Object.entries(audit.vulnerabilities ?? {}))
  for (const via of vuln.via ?? [])
    if (typeof via === 'object' && (via.severity === 'high' || via.severity === 'critical'))
      advisories.set(idOf(via.url), {
        id: idOf(via.url),
        pkg,
        severity: via.severity,
        title: via.title,
        range: via.range,
      });

const failures = [];
const accepted = [];
for (const a of advisories.values()) {
  const exception = ACCEPTED.find((e) => e.id === a.id);
  if (!exception) failures.push(`${a.severity} ${a.id} in ${a.pkg} ${a.range}: ${a.title}`);
  else if (now > new Date(`${exception.until}T23:59:59Z`))
    failures.push(
      `${a.id} was accepted until ${exception.until}, which has passed: fix it, or renew the exception on purpose`,
    );
  else accepted.push(`${a.id} in ${a.pkg} (accepted until ${exception.until}): ${exception.why}`);
}
for (const e of ACCEPTED)
  if (!advisories.has(e.id))
    console.log(`::notice::${e.id} is no longer reported: remove its exception from scripts/check-audit.mjs`);
for (const line of accepted) console.log(`::warning::${line}`);

if (failures.length) {
  console.error(`npm audit: high or critical advisories:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `npm audit OK: no high or critical advisories${accepted.length ? ` other than ${accepted.length} accepted until its date` : ''}`,
);
