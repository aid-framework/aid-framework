import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests exercise package *source*. Without this, a package that imports `@aid/ir`
  // pulls in `dist`, and dist's sourcemaps remap back onto `src`, so V8 instruments
  // every IR module twice and the duplicate half is never executed.
  resolve: {
    alias: [
      {
        find: /^@aid\/ir$/,
        replacement: fileURLToPath(new URL('./packages/ir/src/index.ts', import.meta.url)),
      },
      {
        find: /^@aid\/spec$/,
        replacement: fileURLToPath(new URL('./packages/spec/src/index.ts', import.meta.url)),
      },
      {
        find: /^@aid\/generator-sdk$/,
        replacement: fileURLToPath(
          new URL('./packages/generator-sdk/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
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
        // The retrieval surface (Phase 1, L1) lives almost entirely in these modules, so
        // they carry per-module floors a few points under their measured level (gates
        // 96/87/99/97, capabilities 97/90/100/96, build 84/65/99/90). Deleting the
        // retrieval rules or their falsifying tests drops them well below these floors;
        // the global floors stay untouched.
        'packages/ir/src/gates/**': {
          statements: 90,
          branches: 80,
          functions: 92,
          lines: 91,
        },
        'packages/ir/src/capabilities.ts': {
          statements: 91,
          branches: 84,
          functions: 92,
          lines: 90,
        },
        'packages/ir/src/build.ts': {
          statements: 79,
          branches: 58,
          functions: 92,
          lines: 85,
        },
      },
    },
  },
});
