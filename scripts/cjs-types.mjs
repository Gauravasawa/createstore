// Post-build: Node's native loaders need file extensions on relative imports (the sources omit them),
// and CJS consumers need .d.cts types. Fails the build if anything unexpected is left.
import { readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const rel = /(from\s+|require\()(["'])(\.\/[\w-]+)\2/g;
const fix = (dir, ext, files) => {
  for (const f of readdirSync(dir).filter((n) => files.test(n))) {
    const p = `${dir}/${f}`;
    writeFileSync(
      p,
      readFileSync(p, 'utf8').replace(rel, (_m, a, q, s) => `${a}${q}${s}${ext}${q}`),
    );
  }
};
fix('dist/esm', '.js', /\.js$/);
fix('dist/cjs', '.cjs', /\.cjs$/);
fix('dist/types', '.js', /\.d\.ts$/);
for (const f of readdirSync('dist/types').filter((n) => n.endsWith('.d.ts'))) {
  const to = `dist/types/${f.replace(/\.d\.ts$/, '.d.cts')}`;
  copyFileSync(`dist/types/${f}`, to);
  writeFileSync(to, readFileSync(to, 'utf8').replace(/(["'])(\.\/[\w-]+)\.js\1/g, '$1$2.cjs$1'));
}
