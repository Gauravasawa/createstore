// Packs the real tarball and installs it with npm, pnpm, yarn and bun into throwaway projects, then
// imports AND requires it there. Proves what consumers get, not what the repo contains.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const win = process.platform === 'win32';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8', shell: win });
const pkg = JSON.parse(await import('node:fs').then((f) => f.readFileSync('package.json', 'utf8')));
const only = process.argv[2]; // optional: run one manager

const pack = mkdtempSync(join(tmpdir(), 'cs-pack-'));
run('npm', ['pack', '--pack-destination', pack], process.cwd());
const tgz = resolve(
  pack,
  readdirSync(pack).find((f) => f.endsWith('.tgz')),
);

const managers = {
  npm: (d) => run('npm', ['install', '--no-audit', '--no-fund', tgz, 'react@19'], d),
  pnpm: (d) => run('pnpm', ['add', tgz, 'react@19'], d),
  yarn: (d) => run('npx', ['-y', 'yarn@1.22.22', 'add', tgz, 'react@19'], d),
  bun: (d) => run('bun', ['add', tgz, 'react@19'], d),
  // Deno 2 resolves bare specifiers from node_modules; it's installed with npm and run via the `deno` npm package.
  deno: (d) => run('npm', ['install', '--no-audit', '--no-fund', tgz, 'react@19'], d),
};
const runtime = { deno: (d) => run('npx', ['-y', 'deno@2', 'run', '--allow-all', 'probe.mjs'], d) };
const probe = `
import { createStore } from '${pkg.name}';
import { createRequire } from 'node:module';
const cjs = createRequire(import.meta.url)('${pkg.name}');
const s = createStore({ n: 1 }); s.setState('n', 2);
if (s.getState('n') !== 2 || typeof cjs.createStore !== 'function') throw new Error('broken install');
console.log('ok');`;

let failed = 0;
for (const [name, install] of Object.entries(managers)) {
  if (only && only !== name) continue;
  const dir = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"consumer","private":true,"type":"module"}');
    writeFileSync(join(dir, 'probe.mjs'), probe);
    install(dir);
    const out = (runtime[name] ?? ((d) => run('node', ['probe.mjs'], d)))(dir).trim();
    console.log(`${name}: ${out}`);
  } catch (e) {
    failed++;
    console.error(`${name}: FAILED\n${(e.stderr || e.message).toString().slice(0, 600)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
rmSync(pack, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
