/**
 * End-to-end check for the TypeScript target: the shipped `aid` binary, the committed
 * bytes, and a real socket.
 *
 * This is the `spot-check` counterpart to `scripts/e2e-example.mjs` and makes the same
 * three separable claims for `examples/support-copilot-ts`, each failing on its own:
 *
 *   1. Regenerating the committed example in place changes nothing -- not the generated
 *      code, not `aid.manifest.json`, and not the hand-edited business files the generator
 *      seeded once and must never touch again. Both commands under test are passed their
 *      target explicitly (`--target ts-vercel`), so this also proves that the second
 *      registry entry is reachable by name rather than only as a default.
 *   2. Generating from the spec alone in an empty directory reproduces the committed
 *      `app/generated/**` byte for byte, which is where "the IR only" gets checked.
 *   3. The committed handler, compiled by the example's own `tsconfig.json` from the
 *      regenerated copy, boots and answers `POST /tickets/answer` with 200 over a real
 *      socket. A 200 is only reachable if the route, the pipeline, the business tool and
 *      the model gateway all wired up.
 *
 * Two departures from the Python harness, both forced:
 *
 * The generated app is a *route handler*, not a server: in a Next.js App Router project
 * `app/api/tickets/answer/route.ts` is what Next serves. Adding Next to the example would
 * pull `caniuse-lite` (CC-BY-4.0) past `scripts/check-licenses.mjs`, so the example ships a
 * hand-written Next shim plus `tests/server.ts`, a Node host that speaks the same
 * Fetch-shaped contract. The harness boots that host, which is the same seam the example's
 * own test suite uses. Nothing here fakes the regeneration, which is the part under test.
 *
 * The TypeScript target has no bytecode to import ahead of its source, so claim 3 compiles
 * the regenerated copy first. `dist` and `node_modules` are compiled locally: the copy gets
 * a link to the committed example's installed dependencies, and `tsc` runs with the
 * project's own settings, so a compile failure is a real failure.
 *
 * Usage: `pnpm e2e:ts` (after `pnpm build`).
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { compareTrees, formatTreeDiff, isIdentical, snapshotTree } from './e2e-tree.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const exampleRoot = join(repoRoot, 'examples', 'support-copilot-ts');
const exampleSpec = join(exampleRoot, 'app', 'app.spec.yaml');
const cli = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');

/** The request the example's own test suite sends, so the two agree by construction. */
const REQUEST = {
  subject: 'Acme: I was charged twice this month',
  body: 'Please refund the duplicate charge.',
};

/**
 * The business seeds the first generation writes and every later one must preserve.
 * `lookup_customer.ts` is not byte-checked against the generator's output because it is
 * hand-owned: what is checked is that it survives regeneration untouched.
 */
const BUSINESS_SEEDS = [
  'app/business/index.ts',
  'app/business/prompts/index.ts',
  'app/business/tools/index.ts',
  'app/business/tools/lookup_customer.ts',
];

/** Build output and installed dependencies: copied on nothing, linked or compiled instead. */
const EXCLUDED = new Set(['node_modules', 'dist', 'coverage']);

/** @param {string} message */
function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function require(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Run the CLI in a project directory and require a successful, machine-readable answer.
 *
 * @param {string} cwd
 * @param {string[]} argv
 * @returns {any}
 */
function runAid(cwd, argv) {
  const result = spawnSync(process.execPath, [cli, ...argv], { cwd, encoding: 'utf8' });
  const invocation = `aid ${argv.join(' ')}`;
  require(result.status ===
    0, `\`${invocation}\` exited ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`\`${invocation}\` did not print JSON:\n${result.stdout}`);
  }
}

/**
 * Copy the committed example, leaving out what is installed or compiled and linking the
 * installed dependencies back in so the copy can be compiled with them.
 *
 * @param {string} destination
 */
function copyExample(destination) {
  cpSync(exampleRoot, destination, {
    recursive: true,
    filter: (source) => !EXCLUDED.has(basename(source)),
  });
  symlinkSync(
    join(exampleRoot, 'node_modules'),
    join(destination, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

/**
 * Claim 1: regenerating the committed example is a no-op, tree-wide.
 *
 * `aid validate` runs first because a generator that regenerates cleanly but whose output
 * the validator rejects would pass every later step while being useless.
 *
 * @param {string} directory
 */
function assertTargetRegenerationIsANoOp(directory) {
  log('==> regenerating the committed example in place');
  copyExample(directory);

  const validation = runAid(directory, ['validate', '--json']);
  require(validation.ok ===
    true, `aid validate rejected the example: ${JSON.stringify(validation.diagnostics)}`);

  const report = runAid(directory, ['gen', '--target', 'ts-vercel', '--json']);
  const changes = report.changes;
  require(changes.created.length === 0 &&
    changes.updated.length === 0 &&
    changes.conflicts.length ===
      0, `regeneration wanted to change committed files: ${JSON.stringify({
    created: changes.created,
    updated: changes.updated,
    conflicts: changes.conflicts,
  })}`);
  require(changes.unchanged.length >
    0, 'regeneration reported nothing as unchanged, so it did not regenerate anything');
  require(changes.kept.length ===
    BUSINESS_SEEDS.length, `expected ${BUSINESS_SEEDS.length} preserved business files, got ${changes.kept.length}`);

  // The report says the files are unchanged; the disk says whether that is true. The second
  // is the one that matters, and it also covers `aid.manifest.json`.
  const diff = compareTrees(snapshotTree(exampleRoot), snapshotTree(directory));
  require(isIdentical(diff), `regenerating the example was not byte-identical:\n${formatTreeDiff(
    diff,
    {
      expected: 'the committed example',
      actual: 'the regenerated copy',
    },
  )}`);
  log(
    `    ${changes.unchanged.length} generated files unchanged, ${changes.kept.length} kept, validate ok`,
  );
}

/**
 * Claim 2: the spec alone, in an empty directory, produces the committed generated code.
 *
 * @param {string} directory
 */
function assertSpecAloneReproducesGeneratedCode(directory) {
  log('==> generating from the spec alone in an empty directory');
  mkdirSync(directory, { recursive: true });

  const report = runAid(directory, [
    'init',
    '.',
    '--from',
    exampleSpec,
    '--target',
    'ts-vercel',
    '--gen',
    '--json',
  ]);
  require(report.ok === true, `aid init reported failure: ${JSON.stringify(report.diagnostics)}`);
  require(report.generation?.changes?.created.length >
    0, 'aid init --gen created nothing, so there was nothing to compare');

  for (const seed of BUSINESS_SEEDS) {
    require(existsSync(join(directory, seed)), `aid init did not seed ${seed}`);
  }

  const diff = compareTrees(
    snapshotTree(join(exampleRoot, 'app', 'generated')),
    snapshotTree(join(directory, 'app', 'generated')),
  );
  require(isIdentical(
    diff,
  ), `a fresh generation does not match the committed app/generated:\n${formatTreeDiff(diff, {
    expected: 'the committed app/generated',
    actual: 'a fresh generation',
  })}`);
  log('    a fresh generation matches the committed app/generated');
}

/**
 * Compile the regenerated copy with the example's own settings.
 *
 * @param {string} directory
 */
function compile(directory) {
  const tsc = join(directory, 'node_modules', 'typescript', 'bin', 'tsc');
  require(existsSync(tsc), `the example's typescript install is missing at ${tsc}`);
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  require(result.status ===
    0, `the regenerated app did not compile:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Claim 3: the regenerated app compiles, boots and answers over a real socket.
 *
 * @param {string} directory
 */
async function assertRegeneratedAppAnswers(directory) {
  log('==> compiling and booting the regenerated app, then sending a real request');
  compile(directory);

  const entry = join(directory, 'dist', 'tests', 'server.js');
  require(existsSync(entry), `the regenerated app has no server entry at ${entry}`);

  // A relative import chain from `dist/tests/server.js` is what binds the booted code to
  // this directory: the host imports `../app/generated/...`, so a stale tree elsewhere on
  // the module path cannot be the one that answers.
  const child = spawn(process.execPath, [entry], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });

  const listening = /AID_EXAMPLE_LISTENING (\d+)/;
  const deadline = Date.now() + 60_000;
  try {
    while (!listening.test(output)) {
      if (child.exitCode !== null) {
        throw new Error(`the app exited with ${child.exitCode} before it listened:\n${output}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`the app did not listen within 60s:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const match = listening.exec(output);
    require(match !== null, `could not read a port from:\n${output}`);
    const url = `http://127.0.0.1:${match[1]}/tickets/answer`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(REQUEST),
    });

    const body = await response.text();
    require(response.status === 200, `POST ${url} answered ${response.status}: ${body}`);
    const answer = JSON.parse(body);
    require(answer.category ===
      'billing', `the answer was not the one the pipeline produced: ${body}`);
    require(typeof answer.summary === 'string' && answer.summary !== '', `empty summary: ${body}`);
    log(`    POST /tickets/answer -> 200 ${body}`);
  } finally {
    child.kill('SIGTERM');
    if (!(await waitForExit(child, 10_000))) {
      child.kill('SIGKILL');
      await waitForExit(child, 5_000);
    }
  }
}

async function main() {
  require(existsSync(
    cli,
  ), `the CLI build is missing at ${cli}; run \`pnpm build\` before \`pnpm e2e:ts\``);

  const workRoot = mkdtempSync(join(tmpdir(), 'aid-e2e-ts-'));
  const regenerated = join(workRoot, 'regen');
  try {
    assertTargetRegenerationIsANoOp(regenerated);
    assertSpecAloneReproducesGeneratedCode(join(workRoot, 'fresh'));
    await assertRegeneratedAppAnswers(regenerated);
    log('==> ok: ts-vercel regeneration is byte-identical and the regenerated app runs');
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

await main();
