import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Golden-file tests compare byte-for-byte, so never retry silently.
    retry: 0,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Floors set just below the measured PR 1 level (71/57/80/72).
      thresholds: {
        statements: 70,
        branches: 55,
        functions: 78,
        lines: 70,
      },
    },
  },
});
