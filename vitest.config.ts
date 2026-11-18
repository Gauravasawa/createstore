import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['spec/**/*.spec.{ts,tsx}'],
    environment: 'jsdom',
    testTimeout: 15_000,
    // The tests run against dist/; its source maps report the coverage per line of src/. The floor sits about one
    // point below what the suite reaches, so a real drop fails `npm run test:unit` while noise doesn't.
    coverage: {
      provider: 'v8',
      include: ['dist/esm/*.js'],
      reporter: ['text-summary'],
      thresholds: { statements: 82, branches: 71, functions: 77, lines: 84 },
    },
  },
});
