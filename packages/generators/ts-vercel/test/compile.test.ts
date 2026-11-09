/**
 * The emitted app has to compile, not merely look right.
 *
 * Every other test in this package reads the emitted text. That proves a call was written
 * and cannot prove the call is well-typed, and the gap is not hypothetical: the streaming
 * emitter once shipped an app that planned cleanly, matched its golden file and failed
 * `tsc` with 16 errors -- a module was omitted while the barrel still exported it, and
 * sections that were empty still imported their whole vocabulary. So this file writes the
 * plan to disk and runs the example's own compiler over it, with the example's own
 * options, `noUnusedLocals` and `noUnusedParameters` included.
 *
 * Two documents, chosen for the branches they reach:
 *
 *   - the example rearranged to stream, which compiles a pipeline that replays leading
 *     steps before its generation, plus every module the shipped example already has; and
 *   - `MINIMAL_STREAMING_SPEC`, a generate-only app with no tools and no retrieval, which
 *     compiles the zero-leading-step stream branch and the empty-section emitters at once.
 *
 * The example directory supplies the compiler, the runtime's types and `zod`; the emitted
 * tree goes to a fresh OS temp directory, so a run leaves nothing behind and two runs --
 * or two worktrees -- cannot collide.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { filesFor } from '../src/plan.js';
import {
  buildForSpecText,
  EXAMPLE_ROOT,
  MINIMAL_STREAMING_SPEC,
  streamableExampleIR,
} from './helpers.js';

const TSC = join(EXAMPLE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const NODE_MODULES = join(EXAMPLE_ROOT, 'node_modules');

/** The example's compiler options verbatim, minus the one that writes to disk. */
const COMPILER_OPTIONS = {
  target: 'ES2023',
  lib: ['ES2023'],
  module: 'node16',
  moduleResolution: 'node16',
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  rootDir: '.',
  noEmit: true,
  types: ['node'],
};

/**
 * Write one plan to a fresh temp directory, compile it, and return the compiler's output.
 *
 * An empty string means it compiled. Anything else is the diagnostic text, which vitest
 * prints on failure -- the line and the reason, not just "compilation failed".
 */
function compile(files: readonly { path: string; content: string }[]): string {
  if (!existsSync(TSC)) {
    throw new Error(
      `the example's typescript install is missing at ${TSC}; run \`pnpm install\` first`,
    );
  }

  const root = mkdtempSync(join(tmpdir(), 'aid-ts-emit-'));
  try {
    for (const file of files) {
      const target = join(root, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }
    // The emitted modules are ESM, and `node16` resolution reads that from the nearest
    // package.json. The scaffold supplies one in a real project; the temp tree needs it
    // for the same reason, or every file is compiled as CommonJS.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'emitted-app', private: true, type: 'module' }),
      'utf8',
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['app/**/*.ts'] }, undefined, 2),
      'utf8',
    );
    // The emitted imports are bare specifiers (`@aid-framework/runtime`, `zod`), so the
    // tree needs a module path to resolve them through. Linking the example's install is
    // what makes this the app a developer would actually build.
    symlinkSync(
      NODE_MODULES,
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    try {
      execFileSync(process.execPath, [TSC, '-p', root], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return '';
    } catch (error) {
      const shaped = error as { stdout?: string; stderr?: string };
      return `${shaped.stdout ?? ''}${shaped.stderr ?? ''}`;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('an emitted app compiles', () => {
  it('compiles the example rearranged to stream', () => {
    // The pipeline here has effects before its generation, so this is the branch that
    // replays them through `new Pipeline([...]).run(seed)`; the emitted replay has to
    // typecheck against the same step signatures the buffered path uses.
    expect(compile(filesFor(streamableExampleIR()))).toBe('');
  }, 120_000);

  it('compiles a generate-only app, with no tools and no retrieval', () => {
    // The zero-leading-step stream branch, and every module whose section is empty: an
    // unconditional import of a name nothing uses is an error under this tsconfig.
    const { ir } = buildForSpecText(MINIMAL_STREAMING_SPEC);
    expect(compile(filesFor(ir))).toBe('');
  }, 120_000);
});
