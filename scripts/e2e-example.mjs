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
 *   4. The same app runs an agent to a pause and finishes it from the checkpoint:
 *      `POST /agents/refund_agent/run` stops at the confirming tool and hands back a
 *      checkpoint, and `POST /agents/resume` completes the run. Two requests, so a route
 *      that returned a canned 200 would not pass.
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

/**
 * The example declares `state.signingKeyEnv: AID_CHECKPOINT_KEY`, which the generated resume
 * route reads to sign the checkpoint a pause hands back. Declaring the key makes it mandatory
 * for every agent run, not only a pausing one, so the booted app is handed a value here the
 * same way `examples/support-copilot/tests/conftest.py` hands one to the test suite. Only the
 * length and unpredictability matter; nothing outside this process ever sees it.
 */
const CHECKPOINT_KEY_ENV = 'AID_CHECKPOINT_KEY';
const CHECKPOINT_KEY = 'e2e-checkpoint-key-'.padEnd(64, 'x');

/**
 * The same spec declares a `sqlite` state store, so the record of a spent checkpoint has to
 * be written somewhere. Each booted app gets its own file, removed with the process: sharing
 * one file between the pipeline and agent boots would carry a spent nonce across them and
 * make the second boot's failure depend on the first's history.
 */
const STATE_DB_ENV = 'AID_STATE_DB';

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
  'app/business/tools/issue_refund.py',
  'app/business/tools/lookup_customer.py',
];

/**
 * The agent half of claim 3. `refund_agent` declares `humanInTheLoop`, so the run stops
 * before the tool executes and hands back a checkpoint; approving it continues the same
 * run, which is where the second scripted turn -- the answer -- is consumed.
 *
 * The script is per provider **instance**, so the agent assertions get a server of their
 * own: one scripted provider shared with the pipeline server would spend turn one on the
 * ticket request. That is why the shim takes a mode rather than always installing the same
 * override.
 */
const AGENT_REQUEST = { text: 'Acme was charged twice this month; please refund it.' };
/**
 * The subject the example's hand-written verifier accepts.
 *
 * The refund agent's tool carries `auth: isAuthenticated()`, and the generated route resolves
 * the caller through a dependency that returns an *unauthenticated* principal, so a request
 * with no subject cannot reach a writing tool. The app installs its own verifier
 * (`app/principal_demo.py`) over that dependency in `app/main.py`; this header is what the
 * demo verifier reads. Sending it is therefore the difference between "a caller the app
 * identified" and "an anonymous caller", and the assertion below is only meaningful with it.
 */
const DEMO_SUBJECT_HEADER = { 'x-demo-subject': 'agent@support.example' };
const AGENT_TOOLS_ARGS = {
  subject: 'Acme: I was charged twice this month',
  body: 'Please refund the duplicate charge.',
};
const AGENT_ANSWER = 'Acme Corp is on the enterprise plan, and the duplicate charge was refunded.';

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
from aid_runtime import ScriptedTurn
from app.generated.deps import get_deps
from app.main import app
from tests.fake_gateway import fake_deps

AGENT_TOOL_ARGS = ${JSON.stringify(AGENT_TOOLS_ARGS)}
AGENT_ANSWER = ${JSON.stringify(AGENT_ANSWER)}


def main() -> None:
    root = os.path.realpath(sys.argv[2]) + os.sep
    imported = os.path.realpath(app_package.__file__)
    if not imported.startswith(root):
        raise SystemExit(f"imported {imported}, expected the regenerated tree under {root}")
    if sys.argv[3] == "agent":
        # Built once, not per request: the script is consumed one turn per model call, and
        # a provider rebuilt for the resume would replay the tool call instead of answering.
        deps = fake_deps(
            script=(
                ScriptedTurn.tool("lookup_customer", AGENT_TOOL_ARGS),
                ScriptedTurn.answer(AGENT_ANSWER),
            )
        )
        app.dependency_overrides[get_deps] = lambda: deps
    else:
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
 * Boot the regenerated app on a free port under the shim's `mode`, and hand back everything
 * the assertions need. Nothing is awaited for readiness here: the app is ready when it
 * accepts a connection, which `postWhenReady` is what discovers.
 *
 * @param {string} directory
 * @param {'pipeline' | 'agent'} mode
 */
async function bootApp(directory, mode) {
  const port = await freePort();
  const stateDir = mkdtempSync(join(tmpdir(), 'aid-e2e-state-'));
  const child = spawn(python, ['-c', SERVER_SHIM, String(port), directory, mode], {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The regenerated tree wins over the installed distribution, whatever the order the
    // interpreter would otherwise resolve `app` in. The shim asserts it actually did.
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: directory,
      [CHECKPOINT_KEY_ENV]: CHECKPOINT_KEY,
      [STATE_DB_ENV]: join(stateDir, 'aid-state.db'),
    },
  });
  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
  });
  return { child, port, stateDir, output: () => output };
}

/**
 * POST until the server answers, failing loudly if it exited or never came up.
 *
 * @param {{ child: import('node:child_process').ChildProcess, port: number, output: () => string }} server
 * @param {string} path
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
async function postWhenReady(server, path, body, headers = {}) {
  const url = `http://127.0.0.1:${server.port}${path}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `the app exited with ${server.child.exitCode} before it answered:\n${server.output()}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`the app did not answer within 60s:\n${server.output()}`);
    }
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * The reasons the app logged for its refusals.
 *
 * The generated route logs why a checkpoint was refused and returns one fixed sentence, so
 * the operator log is the only place the real reason exists. Reading it is what lets the
 * assertions below prove two refusals failed *different* checks while answering identically:
 * identical bodies alone would also be satisfied by one check firing twice.
 *
 * @param {{ output: () => string }} server
 * @param {number} count
 * @returns {Promise<string[]>}
 */
async function refusalReasons(server, count) {
  const pattern = /refused a resume for agent \S+ \(nonce [^)]*\): (.+)/g;
  const deadline = Date.now() + 5_000;
  for (;;) {
    const reasons = [];
    for (const match of server.output().matchAll(pattern)) {
      const reason = match[1]?.trim();
      if (reason) reasons.push(reason);
    }
    if (reasons.length >= count) return reasons;
    if (Date.now() > deadline) {
      throw new Error(
        `the operator log showed ${reasons.length} refusal(s), wanted ${count}:\n${server.output()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Remove a directory the app has just released, yielding between attempts.
 *
 * Windows keeps the sqlite file locked for a moment after the process that opened it exits,
 * and a synchronous retry never gives the closing handle the event-loop turn it needs. A
 * directory left in the OS temp area is not worth failing a run over, so the last attempt
 * warns instead of throwing.
 *
 * @param {string} directory
 */
async function removeEventually(directory) {
  const attempts = 25;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (cause) {
      if (attempt === attempts) {
        log(`    (left ${directory} behind: ${String(cause)})`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/**
 * @param {{ child: import('node:child_process').ChildProcess, stateDir: string }} server
 */
async function stopApp(server) {
  server.child.kill('SIGTERM');
  if (!(await waitForExit(server.child, 10_000))) {
    server.child.kill('SIGKILL');
    await waitForExit(server.child, 5_000);
  }
  await removeEventually(server.stateDir);
}

/**
 * Claim 3: the regenerated app imports, boots and answers over a real socket.
 *
 * @param {string} directory
 */
async function assertRegeneratedAppAnswers(directory) {
  log('==> booting the regenerated app and sending a real request');
  const server = await bootApp(directory, 'pipeline');
  try {
    const response = await postWhenReady(server, '/tickets/answer', REQUEST);
    const body = await response.text();
    require(response.status === 200, `POST /tickets/answer answered ${response.status}: ${body}`);
    const answer = JSON.parse(body);
    require(answer.category ===
      'billing', `the answer was not the one the pipeline produced: ${body}`);
    require(typeof answer.summary === 'string' && answer.summary !== '', `empty summary: ${body}`);
    log(`    POST /tickets/answer -> 200 ${body}`);
  } finally {
    await stopApp(server);
  }
}

/**
 * Claim 4: the agent route runs, pauses, and resumes over a real socket.
 *
 * A 200 alone would not prove this: the run has to stop with a checkpoint and the *second*
 * request has to finish it, which is only reachable if the emitted route built a runtime
 * over this app's gateway and handed back a checkpoint a client can hold.
 *
 * The two refusals are asserted here as well, because they are what makes the checkpoint a
 * capability rather than a bearer token: an edited checkpoint and a spent one must both be
 * refused, and the *same* refusal must come back for both. Two distinct bodies would answer
 * "was it the signature or the replay?" for whoever is holding the checkpoint and guessing,
 * which is the oracle the generated route's opaque 403 exists to close.
 *
 * @param {string} directory
 */
async function assertRegeneratedAgentPausesAndResumes(directory) {
  log('==> booting the regenerated app and running an agent through a pause');
  const server = await bootApp(directory, 'agent');
  try {
    const started = await postWhenReady(
      server,
      '/agents/refund_agent/run',
      AGENT_REQUEST,
      DEMO_SUBJECT_HEADER,
    );
    const startedBody = await started.text();
    require(started.status === 200, `the run answered ${started.status}: ${startedBody}`);
    const paused = JSON.parse(startedBody);
    require(paused.status === 'paused', `the run did not pause for approval: ${startedBody}`);
    require(paused.checkpoint !== null, `the pause carried no checkpoint: ${startedBody}`);
    log(`    POST /agents/refund_agent/run -> 200 paused, checkpoint handed back`);

    // A flipped signature byte, with the payload otherwise intact: the checkpoint still
    // parses, so this reaches the signature check rather than the 422 that a malformed body
    // would earn. Sent before the genuine resume because a refused resume must not spend the
    // nonce -- if it did, the assertion below would be testing a checkpoint it broke.
    const tampered = structuredClone(paused.checkpoint);
    const signature = tampered.integrity?.signature;
    const signed = typeof signature === 'string' && signature !== '';
    require(signed, 'the pause handed back an unsigned checkpoint');
    tampered.integrity.signature = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
    const edited = await postWhenReady(
      server,
      '/agents/resume',
      { checkpoint: tampered, decision: 'approve' },
      DEMO_SUBJECT_HEADER,
    );
    const editedBody = await edited.text();
    require(edited.status === 403, `an edited checkpoint answered ${edited.status}: ${editedBody}`);
    log('    POST /agents/resume (edited) -> 403 refused');

    const resumed = await postWhenReady(
      server,
      '/agents/resume',
      {
        checkpoint: paused.checkpoint,
        decision: 'approve',
      },
      DEMO_SUBJECT_HEADER,
    );
    const resumedBody = await resumed.text();
    require(resumed.status === 200, `the resume answered ${resumed.status}: ${resumedBody}`);
    const finished = JSON.parse(resumedBody);
    require(finished.status === 'completed', `the resume did not finish the run: ${resumedBody}`);
    require(finished.answer ===
      AGENT_ANSWER, `the answer was not the scripted one: ${resumedBody}`);
    log(`    POST /agents/resume -> 200 completed ${JSON.stringify(finished.answer)}`);

    // The same checkpoint, now spent. It has to fail on the replay claim *after* the
    // signature and owner checks pass, so a 403 here is the one-time claim doing its work
    // rather than the signature check catching a copy that went stale.
    const replayed = await postWhenReady(
      server,
      '/agents/resume',
      { checkpoint: paused.checkpoint, decision: 'approve' },
      DEMO_SUBJECT_HEADER,
    );
    const replayedBody = await replayed.text();
    const spentStatus = replayed.status;
    require(spentStatus === 403, `a spent checkpoint answered ${spentStatus}: ${replayedBody}`);

    // The oracle assertion. The route deliberately logs the reason and returns one fixed
    // sentence; a body that differed between "edited" and "spent" -- or that named the
    // failed check -- would tell a caller which part of the checkpoint to change next.
    require(replayedBody !== '', 'both refusals were empty, so "identical" proves nothing');
    const differ = `edited -> ${editedBody} / spent -> ${replayedBody}`;
    require(replayedBody === editedBody, `the two refusals differ, which is an oracle: ${differ}`);
    const leak = /tamper|replay|spent|signature|nonce|expir|owner|unsigned|already|stale/i;
    require(!leak.test(replayedBody), `the refusal names the failed check: ${replayedBody}`);

    // The other half of the oracle claim: the bodies match *because* the route hides a
    // reason, not because both requests failed the same check. The log is where the two
    // differ, and neither reason may reappear in the response.
    const reasons = await refusalReasons(server, 2);
    require(reasons[0] !== reasons[1], `both refusals logged one reason: ${reasons[0]}`);
    for (const reason of reasons) {
      require(!replayedBody.includes(reason), `the body repeats the logged reason: ${reason}`);
    }
    log(`    operator log: two distinct reasons ("${reasons[0]}" / "${reasons[1]}")`);
    log('    POST /agents/resume (spent) -> 403 refused, byte-identical to the edited refusal');
  } finally {
    await stopApp(server);
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
    await assertRegeneratedAgentPausesAndResumes(regenerated);
    log('==> ok: regeneration is byte-identical and the regenerated app runs');
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

await main();
