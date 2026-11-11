// Pre-publish gate: inspects what `npm pack` would publish and fails (exit 1) on anything wrong.
// Runs as `prepublishOnly` (covers the manual bootstrap publish) and as an explicit step in the release workflow.
//   node scripts/check-publish.mjs            offline checks
//   node scripts/check-publish.mjs --online   also asks the registry (reachable? version already taken?)
import { execSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_NAME = '@createstore/createstore';
const REGISTRY = 'https://registry.npmjs.org/';
const BUDGET = { packed: 300_000, unpacked: 1_000_000, files: 40 }; // bytes, bytes, count
// Everything that may ship. A new file type appearing in the tarball is a decision, not an accident.
const ALLOWED = [
  /^dist\/(esm|cjs|types)\/[\w-]+\.(js|cjs|js\.map|cjs\.map|d\.ts|d\.cts)$/,
  /^(LICENSE|README\.md|package\.json)$/,
];
const SECRETS = [
  [/npm_[A-Za-z0-9]{36}/, 'npm token'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/_authToken|NODE_AUTH_TOKEN/, 'npm auth config'],
];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
// A command string on purpose: npm is a .cmd file on Windows, which needs a shell. Every part is a constant or our own package name.
const run = (cmd) => execSync('npm ' + cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ---- the tarball ----
const [packed] = JSON.parse(run('pack --dry-run --json --ignore-scripts'));
const paths = new Set(packed.files.map((f) => f.path));

check(
  'dist exists (esm, cjs, types)',
  ['dist/esm/', 'dist/cjs/', 'dist/types/'].every((d) => [...paths].some((p) => p.startsWith(d))),
);

const targets = new Set([pkg.main, pkg.module, pkg.types]);
(function walk(v) {
  if (typeof v === 'string') targets.add(v);
  else if (v && typeof v === 'object') Object.values(v).forEach(walk);
})(pkg.exports);
const missing = [...targets].filter((t) => t && !paths.has(t.replace(/^\.\//, '')));
check('every main/module/types/exports target is in the tarball', missing.length === 0, missing.join(', '));

const types = [...targets].filter((t) => /\.d\.c?ts$/.test(t));
check(
  'type declarations exist for both import and require',
  types.some((t) => t.endsWith('.d.ts')) && types.some((t) => t.endsWith('.d.cts')),
);

const stray = [...paths].filter((p) => !ALLOWED.some((re) => re.test(p)));
check('only expected files ship (no src, tests, workflows, env files)', stray.length === 0, stray.join(', '));
check('LICENSE and README.md ship', paths.has('LICENSE') && paths.has('README.md'));

const stale = (() => {
  const newest = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => statSync(join(e.parentPath, e.name)).mtimeMs);
  const src = Math.max(...newest('src'));
  return [...paths].filter((p) => p.startsWith('dist/') && statSync(p).mtimeMs < src);
})();
check('dist is newer than src (not a stale build)', stale.length === 0, stale.slice(0, 3).join(', '));

check(`packed size within budget (${packed.size} <= ${BUDGET.packed} B)`, packed.size <= BUDGET.packed);
check(
  `unpacked size within budget (${packed.unpackedSize} <= ${BUDGET.unpacked} B)`,
  packed.unpackedSize <= BUDGET.unpacked,
);
check(`file count within budget (${paths.size} <= ${BUDGET.files})`, paths.size <= BUDGET.files);

const leaks = [];
for (const p of paths) {
  const text = readFileSync(p, 'utf8');
  for (const [re, what] of SECRETS) if (re.test(text)) leaks.push(`${p}: ${what}`);
}
check('no credentials in the files to publish', leaks.length === 0, leaks.join('; '));

// ---- package.json ----
check(`name is ${EXPECTED_NAME}`, pkg.name === EXPECTED_NAME, pkg.name);
check('not marked private', pkg.private !== true);
check('license is MIT', pkg.license === 'MIT');
check('repository, bugs, homepage are set', Boolean(pkg.repository?.url && pkg.bugs?.url && pkg.homepage));
check(
  'publishConfig: public access, official registry, provenance on',
  pkg.publishConfig?.access === 'public' &&
    pkg.publishConfig?.registry === REGISTRY &&
    pkg.publishConfig?.provenance === true,
);
check('engines.node is declared', Boolean(pkg.engines?.node));
check('sideEffects is declared', pkg.sideEffects !== undefined);

// ---- supply chain: what a consumer's install pulls in and runs ----
// Zero runtime dependencies is a policy, not an accident: nothing to hijack, typosquat or compromise downstream.
// Adding one should be a conscious decision, made by editing this check.
check(
  'no runtime dependencies (react is a peer)',
  Object.keys(pkg.dependencies ?? {}).length === 0 && !pkg.optionalDependencies && !pkg.bundleDependencies,
  Object.keys(pkg.dependencies ?? {}).join(', '),
);
const installHooks = ['preinstall', 'install', 'postinstall'].filter((h) => pkg.scripts?.[h]);
check(
  'no install-time scripts (they would run on every consumer machine)',
  installHooks.length === 0,
  installHooks.join(', '),
);

// ---- the registry ----
if (process.argv.includes('--online')) {
  try {
    const info = JSON.parse(run(`view ${JSON.stringify(pkg.name)} --json --registry=${REGISTRY}`));
    const versions = Array.isArray(info.versions) ? info.versions : [info.version];
    check('registry reachable', true);
    check(`version ${pkg.version} is not already published`, !versions.includes(pkg.version));
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (/E404/.test(out)) {
      check('registry reachable', true);
      check('package does not exist yet (first publish)', true);
    } else {
      check('registry reachable', false, out.slice(0, 200));
    }
  }
}

for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
const bad = results.filter((r) => !r.ok).length;
if (bad) {
  console.error(`\n${bad} publish check(s) failed. Nothing was published.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} publish checks passed for ${pkg.name}@${pkg.version}`);
