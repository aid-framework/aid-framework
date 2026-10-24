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
    include: [
      'packages/**/test/**/*.test.ts',
      'runtimes/typescript/test/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
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
        // The TypeScript runtime (Phase 1, L5) mirrors the Python surface. Its floors are
        // a few points under the measured level (src 95/90/96/96, retrieval 95/92/95/96,
        // evals 93/86/97/95). They exist so that deleting the runtime's tests cannot look
        // like a green build: without them the suite still passes, because nothing else
        // imports this package. The global floors above stay untouched and are not
        // lowered by any of these.
        'runtimes/typescript/src/**': {
          statements: 90,
          branches: 83,
          functions: 90,
          lines: 91,
        },
        'runtimes/typescript/src/retrieval/pgvector.ts': {
          // The adapter resolves its driver lazily and ships without a database, so its
          // SQL path is deliberately unreachable in CI (D2) and this floor is the lowest
          // in the repo. It still has to hold: measured 73/77/71/73.
          statements: 68,
          branches: 70,
          functions: 66,
          lines: 68,
        },
        // The ts-vercel generator (Phase 1, L6) is imported only by the CLI and its own
        // tests, so without a floor here deleting those tests would still leave a green
        // suite. Floors sit a few points under the measured level (87/61/63/88 for
        // statements, branches, functions and lines). `functions` is the lowest generator
        // figure in the repo because the emitters are many small helpers that a single
        // planned spec does not reach, which is why its floor is stated rather than
        // rounded up to the global one. The global floors above stay untouched and are
        // not lowered by this entry.
        'packages/generators/ts-vercel/src/**': {
          statements: 85,
          branches: 58,
          functions: 60,
          lines: 86,
        },
      },
    },
  },
});
