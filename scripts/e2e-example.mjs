/**
 * End-to-end check: the shipped `aid` binary, the committed bytes, and a real socket.
 *
 * The unit tests prove the CLI's pieces behave; this proves the *product* does. It makes
 * three separable claims, each of which fails on its own:
 *
 *   1. Regenerating the committed example in place changes nothing -- not the generated
 *      code, not `aid.manifest.json`, and not the hand-edited business file the generator
 *      seeded once and must never touch again.
 *   2. Generating from the spec alone in an empty directory reproduces the committed
 *      `app/generated/**` byte for byte. The generated tree is a function of the spec and
 *      the generator, and this is where "only" gets checked.
 *   3. The regenerated app imports, boots under uvicorn, and answers `POST /tickets/answer`
 *      with 200 over a real socket -- generated code that runs, not code that looks
 *      plausible. A 200 is only reachable if the route, the pipeline, the business tool and
 *      the model gateway all wired up, so the assertion is not just "the server is up".
 *
 * The generated app talks to a model provider, so booting it offline needs the example's
 * own seam: `tests/fake_gateway.py` is the same dependency override the example's test suite
 * uses, and the regenerated tree carries a copy of it. Nothing here fakes the regeneration,
 * which is the part under test.
 *
 * Usage: `pnpm e2e` (after `pnpm build`). `AID_PYTHON` selects the interpreter, defaulting
 * to the `python` on PATH.
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { compareTrees, formatTreeDiff, isIdentical, snapshotTree } from './e2e-tree.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const exampleRoot = join(repoRoot, 'examples', 'support-copilot');
const exampleSpec = join(exampleRoot, 'app', 'app.spec.yaml');
const cli = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
const python = process.env.AID_PYTHON ?? 'python';

/** The request the example's own test suite sends, so the two agree by construction. */
const REQUEST = {
  subject: 'Acme: I was charged twice this month',
  body: 'Please refund the duplicate charge.',
};

/**
 * The business seeds the first generation writes and every later one must preserve.
 * `lookup_customer.py` is not byte-checked against the generator's output because it is
 * hand-owned: what is checked is that it survives regeneration untouched.
 */
const BUSINESS_SEEDS = [
  'app/business/__init__.py',
  'app/business/prompts/__init__.py',
  'app/business/tools/__init__.py',
  'app/business/tools/lookup_customer.py',
];

/**
 * Boots the regenerated app with its gateway dependency overridden to the example's
 * deterministic fake, which is what lets an otherwise network-bound app answer in CI.
 *
 * It also asserts that the app it imported is the one under the directory handed to it. The
 * committed example is installed as a distribution in the same interpreter, so without that
 * assertion a path-precedence accident could boot the committed tree and report success.
 *
 * argv: `<port> <project root>`.
 */
const SERVER_SHIM = `
import os
import sys

import uvicorn

import app as app_package
from app.generated.deps import get_deps
from app.main import app
from tests.fake_gateway import fake_deps


def main() -> None:
    root = os.path.realpath(sys.argv[2]) + os.sep
    imported = os.path.realpath(app_package.__file__)
    if not imported.startswith(root):
        raise SystemExit(f"imported {imported}, expected the regenerated tree under {root}")
    app.dependency_overrides[get_deps] = lambda: fake_deps()
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")


main()
`;

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
  require(result.status ===
    0, `\`aid ${argv.join(' ')}\` exited ${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`\`aid ${argv.join(' ')}\` did not print JSON:\n${result.stdout}`);
  }
}

/**
 * Claim 1: regenerating the committed example is a no-op, tree-wide.
 *
 * @param {string} directory
 */
function assertRegenerationIsANoOp(directory) {
  log('==> regenerating the committed example in place');
  cpSync(exampleRoot, directory, { recursive: true });

  const report = runAid(directory, ['gen', '--json']);
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
  log(`    ${changes.unchanged.length} generated files unchanged, ${changes.kept.length} kept`);
}

/**
 * Claim 2: the spec alone, in an empty directory, produces the committed generated code.
 *
 * @param {string} directory
 */
function assertSpecAloneReproducesGeneratedCode(directory) {
  log('==> generating from the spec alone in an empty directory');
  mkdirSync(directory, { recursive: true });

  const report = runAid(directory, ['init', '.', '--from', exampleSpec, '--gen', '--json']);
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
  log(`    a fresh generation matches the committed app/generated`);
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      require(address !== null && typeof address === 'object', 'could not read a port');
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
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
 * Claim 3: the regenerated app imports, boots and answers over a real socket.
 *
 * @param {string} directory
 */
async function assertRegeneratedAppAnswers(directory) {
  log('==> booting the regenerated app and sending a real request');
  const port = await freePort();
  const child = spawn(python, ['-c', SERVER_SHIM, String(port), directory], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The regenerated tree wins over the installed distribution, whatever the order the
    // interpreter would otherwise resolve `app` in. The shim asserts it actually did.
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: directory },
  });

  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });

  const url = `http://127.0.0.1:${port}/tickets/answer`;
  const deadline = Date.now() + 60_000;
  try {
    /** @type {Response | undefined} */
    let response;
    while (response === undefined) {
      if (child.exitCode !== null) {
        throw new Error(`the app exited with ${child.exitCode} before it answered:\n${output}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`the app did not answer within 60s:\n${output}`);
      }
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(REQUEST),
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

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
  ), `the CLI build is missing at ${cli}; run \`pnpm build\` before \`pnpm e2e\``);

  const workRoot = mkdtempSync(join(tmpdir(), 'aid-e2e-'));
  const regenerated = join(workRoot, 'regen');
  try {
    assertRegenerationIsANoOp(regenerated);
    assertSpecAloneReproducesGeneratedCode(join(workRoot, 'fresh'));
    await assertRegeneratedAppAnswers(regenerated);
    log('==> ok: regeneration is byte-identical and the regenerated app runs');
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

await main();
