// Lockfile integrity guard. A tampered lockfile can point an install at a different server, or drop the hash
// that would catch a swapped package. Fails when any installed package does not come from the official registry
// with a sha512 integrity hash. Packages bundled inside npm itself (a dependency of semantic-release) ship
// inside npm's own tarball and legitimately have neither field.
import { readFileSync } from 'node:fs';

const REGISTRY = 'https://registry.npmjs.org/';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const problems = [];
let checked = 0;
let bundled = 0;

if (lock.lockfileVersion < 3) problems.push(`lockfileVersion is ${lock.lockfileVersion}, expected 3 or newer`);

for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (path === '' || entry.link) continue; // the root project, and workspace links
  if (entry.inBundle || /(^|\/)node_modules\/npm\/node_modules\//.test(path)) {
    bundled++;
    continue;
  }
  checked++;
  if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) {
    problems.push(`${path}: resolved from ${entry.resolved ?? 'nowhere'} (expected ${REGISTRY}...)`);
  } else if (!/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity ?? '')) {
    problems.push(`${path}: missing or weak integrity hash`);
  }
}

if (problems.length) {
  console.error(`Lockfile check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `Lockfile OK: ${checked} packages from ${REGISTRY} with sha512 integrity (${bundled} bundled inside npm skipped)`,
);
