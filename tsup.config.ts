import { defineConfig } from 'tsup';
// bundle:false keeps one output file per source file, so 'use client' stays at the top of client-root
// and the three modules keep sharing one context (a bundle would duplicate it).
const base = {
  entry: ['src/*.ts', 'src/*.tsx'],
  bundle: false,
  sourcemap: true,
  target: 'es2022',
  clean: false,
} as const;
export default defineConfig([
  { ...base, format: 'esm', outDir: 'dist/esm', outExtension: () => ({ js: '.js' }) },
  { ...base, format: 'cjs', outDir: 'dist/cjs', outExtension: () => ({ js: '.cjs' }) },
]);
