import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['spec/**/*.spec.{ts,tsx}'], environment: 'jsdom', testTimeout: 15_000 },
});
