// npm audit signatures, with retries for the one failure that is the registry's, not the packages':
// EMISSINGSIGNATUREKEY ("has attestations but no corresponding public key(s) can be found") means npm couldn't get
// the registry's signing key, which happens now and then for a minute or more. That alone is retried, waiting
// longer each time (20 s, 40 s, 80 s, 160 s: about 5 minutes in all). Any other failure, such as a signature that
// doesn't match, fails at once, and so does the key error if it outlasts every retry.
// Usage: node scripts/audit-signatures.mjs   (tests: AUDIT_SIGNATURES_WAITS="0,0" and AUDIT_SIGNATURES_COMMAND)
import { spawnSync } from 'node:child_process';

const command = process.env.AUDIT_SIGNATURES_COMMAND ?? 'npm audit signatures';
const waits = (process.env.AUDIT_SIGNATURES_WAITS ?? '20,40,80,160').split(',').map(Number);
const attempts = waits.length + 1;
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

for (let attempt = 1; attempt <= attempts; attempt++) {
  const run = spawnSync(command, { shell: true, encoding: 'utf8' }); // a fixed command, no outside input
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status === 0) process.exit(0);
  const keyMissing = `${run.stdout}${run.stderr}`.includes('EMISSINGSIGNATUREKEY');
  if (!keyMissing) {
    console.error(`npm audit signatures failed (not a missing registry key), so it isn't retried.`);
    process.exit(run.status || 1);
  }
  if (attempt === attempts) break;
  const wait = waits[attempt - 1];
  console.log(
    `::warning::the registry's signing key couldn't be found (attempt ${attempt} of ${attempts}); trying again in ${wait} s`,
  );
  await sleep(wait);
}
console.error(`npm audit signatures: the registry's signing key was still missing after ${attempts} attempts.`);
process.exit(1);
