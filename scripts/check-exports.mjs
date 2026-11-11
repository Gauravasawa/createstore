// Every runtime export of the source must exist in the ESM and CJS builds (and nothing extra); every exported type in the .d.ts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const src = readFileSync('src/createStore.ts', 'utf8');
const names = (re) => [...new Set([...src.matchAll(re)].map((m) => m[1]))].sort();
const runtime = names(/^export (?:async )?(?:function|const|class) (\w+)/gm);
const types = names(/^export (?:type|interface) (\w+)/gm);
const esm = Object.keys(await import('@createstore/createstore')).sort();
const cjs = Object.keys(createRequire(import.meta.url)('@createstore/createstore')).sort();
const dts = readFileSync('dist/types/createStore.d.ts', 'utf8');
const errs = [];
for (const [label, got] of [
  ['ESM', esm],
  ['CJS', cjs],
]) {
  const missing = runtime.filter((n) => !got.includes(n)),
    extra = got.filter((n) => !runtime.includes(n));
  if (missing.length || extra.length) errs.push(`${label}: missing [${missing}] extra [${extra}]`);
}
for (const t of types)
  if (!new RegExp(`export (type|interface) ${t}(?![A-Za-z0-9_])`).test(dts)) errs.push(`d.ts missing ${t}`);
console.log(`runtime ${runtime.length}, types ${types.length}`);
if (errs.length) {
  console.error(errs.join('\n'));
  process.exit(1);
}
console.log('exports OK');
