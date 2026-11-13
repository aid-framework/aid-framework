/**
 * Runs every CI check this machine is able to run, in CI's order, and says plainly what it
 * could not run.
 *
 * Before this, `pnpm check` was `lint && typecheck && test`, and `lefthook.yml` claimed that
 * reproduced the full CI check. It did not: the docs build, the accessibility scan, the
 * licence audit, actionlint, the Python suites, `tofu validate`, `cdk synth` and the release
 * plan were all missing, so a green `pnpm check` was compatible with a red pull request. A
 * developer cannot discover that from the output of a command that succeeds.
 *
 * The fix is not to run everything everywhere -- a machine may have no Python, no Go binary
 * for actionlint, no `tofu` and no `npm`. The fix is to make the gap *visible and
 * impossible to mistake for a pass*:
 *
 *   - every step that runs prints `ok` or `FAILED` and its duration;
 *   - every step that cannot run prints `skip` with the tool that is missing and how to
 *     install it, and the summary counts it separately from the passes;
 *   - the final line never says all checks passed while a step was skipped. It says how
 *     many were not verified and names them, and points at `pnpm check:all`;
 *   - `pnpm check:all` turns every skip into a failure, which is the tier that cannot be
 *     skipped and the one a reviewer runs before asking for a merge.
 *
 * `scripts/check-all.test.mjs` holds the ordering, the exit codes and the skip semantics to
 * that contract, and fails when `.github/workflows/ci.yml` grows a job no step stands in
 * for -- so a new CI job cannot quietly become local-invisible.
 *
 * Usage:
 *   node scripts/check-all.mjs                 # run what this machine can run
 *   node scripts/check-all.mjs --all           # a missing tool is a failure
 *   node scripts/check-all.mjs --list          # print the plan, run nothing
 *   node scripts/check-all.mjs --only build,lint:md
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** @type {string[]} temporary shim directories, removed when the run ends */
const shimDirs = [];

/**
 * @typedef {object} Tool
 * @property {string} name
 * @property {() => boolean} available
 * @property {string} fix
 */

/**
 * @typedef {object} Step
 * @property {string} id
 * @property {string} job the CI job this step stands in for, or `docs` for the site job
 * @property {string} [script] a package.json script to run through pnpm
 * @property {string[]} [argv] a command, when no script exists
 * @property {string} [cwd] relative to the repository root
 * @property {string[]} [tools] external tools the step needs; empty means pnpm provides it
 */

/**
 * True when the command exists and exits 0.
 *
 * The exit status matters, not just the absence of a spawn error: on Windows the shell
 * fallback asks `cmd.exe` to interpret the line, so a missing command still "spawns" and
 * reports failure afterwards. Checking only for an error made `pnpm` look installed while
 * every step using it failed.
 *
 * @param {string} command @param {string[]} args
 */
function runs(command, args) {
  const result = spawnCandidate(command, args);
  return result !== null && result.status === 0;
}

/**
 * Spawns a command, preferring a direct exec and falling back to a shell only where Windows
 * needs one for a `.cmd` shim such as `pnpm`.
 *
 * The fallback passes one already-joined command line rather than args, because Node warns
 * (DEP0190) on every call that combines `shell: true` with an argument array -- a warning
 * that would print on top of the pass/skip report it is meant to help read.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 * @returns {import('node:child_process').SpawnSyncReturns<Buffer | string> | null} null if absent
 */
function spawnCandidate(command, args, options = {}) {
  const direct = spawnSync(command, args, { ...options, shell: false });
  if (direct.error === undefined) return direct;
  if (process.platform !== 'win32') return null;

  const line = [command, ...args]
    .map((part) => (/[\s"]/.test(part) ? `"${part.replaceAll('"', '""')}"` : part))
    .join(' ');
  const viaShell = spawnSync(line, { ...options, shell: true });
  return viaShell.error === undefined ? viaShell : null;
}

/**
 * The interpreter every Python step runs through. `AID_PYTHON` is the same override
 * `scripts/e2e-example.mjs` documents, so one variable points the whole local gate at a venv.
 *
 * @returns {string}
 */
export function python() {
  return process.env.AID_PYTHON ?? 'python';
}

/** @type {Record<string, Tool>} */
export const TOOLS = {
  actionlint: {
    name: 'actionlint',
    available: () => runs('actionlint', ['--version']),
    fix: 'install actionlint (https://github.com/rhysd/actionlint) and shellcheck, or set ACTIONLINT to the binary',
  },
  playwright: {
    name: 'playwright',
    available: () =>
      existsSync(join(root, 'site', 'node_modules', 'playwright')) &&
      existsSync(join(root, 'site', 'node_modules', '@axe-core', 'playwright')),
    fix: 'run `pnpm install` so the site workspace resolves playwright and @axe-core/playwright',
  },
  python: {
    name: 'python',
    available: () => runs(python(), ['-c', 'import pytest']),
    fix: 'create the venv documented in CONTRIBUTING.md (uv venv --python 3.11; uv pip install -e "runtimes/python[dev]") or set AID_PYTHON',
  },
};

/**
 * The steps that need nothing beyond `pnpm install` plus a checkout.
 *
 * The order follows CI because the steps depend on each other: `build` produces the `dist`
 * that `typecheck` and the docs generator read, and `docs:build` must precede the head and
 * link checks, which inspect the built site.
 *
 * @type {Step[]}
 */
export const REQUIRED_STEPS = [
  { id: 'build', job: 'node', script: 'build' },
  { id: 'lint:code', job: 'node', script: 'lint:code' },
  { id: 'lint:md', job: 'node', script: 'lint:md' },
  { id: 'lint:config', job: 'node', script: 'lint:config' },
  { id: 'typecheck', job: 'typescript', script: 'typecheck' },
  { id: 'test:coverage', job: 'node', script: 'test:coverage' },
  { id: 'test:typescript', job: 'typescript', script: 'test:typescript' },
  { id: 'lint:licenses', job: 'licenses', script: 'lint:licenses' },
  { id: 'docs:check', job: 'docs', script: 'docs:check' },
  { id: 'docs:build', job: 'docs', script: 'docs:build' },
  { id: 'docs:head', job: 'docs', script: 'docs:head' },
  { id: 'docs:links', job: 'docs', script: 'docs:links' },
];

/**
 * The steps that need a tool `pnpm install` cannot provide.
 *
 * Each one mirrors a CI job. They are the part a green `pnpm check` used to hide, so each
 * carries the command it runs rather than delegating to a script that would repeat it.
 *
 * @type {Step[]}
 */
export const EXTERNAL_STEPS = [
  { id: 'lint:actions', job: 'workflows', script: 'lint:actions', tools: ['actionlint'] },
  { id: 'docs:a11y', job: 'docs', script: 'docs:a11y', tools: ['playwright'] },
  { id: 'e2e', job: 'e2e', script: 'e2e', tools: ['python'] },
  { id: 'e2e:ts', job: 'e2e', script: 'e2e:ts', tools: ['python'] },
  {
    id: 'python:test',
    job: 'python',
    argv: ['python', '-m', 'pytest'],
    cwd: 'runtimes/python',
    tools: ['python'],
  },
  {
    id: 'python:ruff',
    job: 'python',
    argv: ['python', '-m', 'ruff', 'check', '.'],
    cwd: 'runtimes/python',
    tools: ['python'],
  },
  {
    id: 'python:ruff-format',
    job: 'python',
    argv: ['python', '-m', 'ruff', 'format', '--check', '.'],
    cwd: 'runtimes/python',
    tools: ['python'],
  },
  {
    id: 'python:mypy',
    job: 'python',
    argv: ['python', '-m', 'mypy'],
    cwd: 'runtimes/python',
    tools: ['python'],
  },
  {
    id: 'evals:test',
    job: 'evals',
    argv: ['python', '-m', 'pytest'],
    cwd: 'examples/support-copilot',
    tools: ['python'],
  },
  {
    id: 'guarded-reply:test',
    job: 'guarded-reply',
    argv: ['python', '-m', 'pytest'],
    cwd: 'examples/guarded-reply',
    tools: ['python'],
  },
];

/**
 * CI jobs with no local step, and why. A job that is neither here nor named by a step fails
 * `scripts/check-all.test.mjs`, so this map cannot rot silently.
 *
 * @type {Map<string, string>}
 */
export const UNCOVERED_JOBS = new Map([
  [
    'release-plan',
    'needs the tags and the base branch a pull request is compared with, which a local checkout does not have; `node scripts/version.mjs decide` needs --tags-file and --changed-files-file',
  ],
  [
    'tofu',
    'runs `tofu init` in each of five fixture roots before `tofu validate` can run, which is a loop over directories rather than one command',
  ],
  ['cdk', 'needs `npm ci` inside packages/generators/cdk and writes cdk.out/ into that directory'],
  [
    'conformance',
    'runs the Python and TypeScript conformance suites into two verdict files and then compares them, so no single step stands in for it',
  ],
]);

/**
 * Steps in the order they run. CI-order first (the dependency order above), then the
 * external ones, because those are the slow, environment-dependent checks and a failure in
 * the cheap ones should be reported before them.
 *
 * @returns {Step[]}
 */
export function allSteps() {
  return [...REQUIRED_STEPS, ...EXTERNAL_STEPS];
}

/**
 * The steps this machine can run, and the ones it cannot with the reason.
 *
 * @param {{ present?: Set<string>, steps?: Step[] }} [options]
 * @returns {{ run: Step[], skipped: { step: Step, tool: string, fix: string }[] }}
 */
export function planSteps({ present = new Set(), steps = allSteps() } = {}) {
  /** @type {Step[]} */
  const run = [];
  /** @type {{ step: Step, tool: string, fix: string }[]} */
  const skipped = [];

  for (const step of steps) {
    const missing = (step.tools ?? []).filter((tool) => !present.has(tool));
    if (missing.length === 0) {
      run.push(step);
      continue;
    }
    for (const tool of missing) {
      skipped.push({ step, tool, fix: TOOLS[tool]?.fix ?? `install ${tool}` });
    }
  }

  return { run, skipped };
}

/** @param {number} ms */
function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Runs one step. Injected so the tests can drive the contract without spawning anything.
 *
 * @param {Step} step
 * @param {{ execute: (step: Step) => { status: number | null }, log: (line: string) => void }} io
 * @returns {{ id: string, ok: boolean, ms: number }}
 */
function runOne(step, { execute, log }) {
  const started = Date.now();
  log(`  ${step.id}`);
  const { status } = execute(step);
  const ms = Date.now() - started;
  const ok = status === 0;
  log(`  ${ok ? 'ok' : 'FAILED'} ${step.id} ${seconds(ms)}`);
  return { id: step.id, ok, ms };
}

/**
 * Runs every planned step and reports. A failing step does not stop the run: CI reports all
 * its failures at once, and a developer fixing docs and a type error should learn both now.
 *
 * @param {{
 *   run: Step[],
 *   skipped: { step: Step, tool: string, fix: string }[],
 *   execute: (step: Step) => { status: number | null },
 *   log: (line: string) => void,
 * }} options
 * @returns {{ passed: string[], failed: string[], skipped: { step: Step, tool: string, fix: string }[], ms: number }}
 */
export function runSteps({ run, skipped, execute, log }) {
  const started = Date.now();
  /** @type {string[]} */
  const passed = [];
  /** @type {string[]} */
  const failed = [];

  for (const step of run) {
    const result = runOne(step, { execute, log });
    (result.ok ? passed : failed).push(result.id);
  }

  for (const entry of skipped) {
    log(`  skip ${entry.step.id} -- ${entry.tool} not installed`);
  }

  return { passed, failed, skipped, ms: Date.now() - started };
}

/**
 * The last line a developer reads. It never claims a pass while a step was skipped, and it
 * prints the command that would have run the skipped steps.
 *
 * @param {{ passed: string[], failed: string[], skipped: { step: Step, tool: string, fix: string }[], ms: number }} result
 * @param {{ all?: boolean }} [options]
 * @returns {string}
 */
export function summarize(result, { all = false } = {}) {
  const parts = [`${result.passed.length} passed`];
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);

  const summary = `${parts.join(', ')} in ${seconds(result.ms)}`;
  if (result.skipped.length === 0) return `checks: ${summary}`;

  const names = [...new Set(result.skipped.map((entry) => entry.step.id))];
  return [
    // A skip means CI ran something this did not, whatever tier was asked for.
    `checks: ${summary} -- NOT all CI checks ran`,
    `not verified locally: ${names.join(', ')}`,
    ...result.skipped.map((entry) => `  ${entry.step.id}: ${entry.fix}`),
    all
      ? '`--all` was passed but a step was still skipped: this is a bug in scripts/check-all.mjs.'
      : '`pnpm check:all` refuses to skip, which is the tier to run before asking for a review.',
  ].join('\n');
}

/** @returns {string[] | null} */
function pnpmArgv() {
  if (runs('pnpm', ['--version'])) return ['pnpm'];
  if (runs('corepack', ['pnpm', '--version'])) return ['corepack', 'pnpm'];
  return null;
}

/**
 * Makes `pnpm` resolvable for the scripts this runs.
 *
 * Several scripts invoke `pnpm` themselves (`docs:build` is `pnpm --filter ... build`), so
 * finding pnpm via corepack is not enough: the nested call has to resolve too, and on a
 * machine where `corepack enable` was never run it does not. Rather than fail those steps
 * with an error that says nothing about the real cause, a shim directory is put at the front
 * of PATH for the duration of the run.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function stepEnv() {
  if (runs('pnpm', ['--version'])) return process.env;

  const dir = mkdtempSync(join(tmpdir(), 'aid-pnpm-'));
  shimDirs.push(dir);
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'pnpm.cmd'), '@echo off\r\ncorepack pnpm %*\r\n');
  } else {
    const file = join(dir, 'pnpm');
    writeFileSync(file, '#!/bin/sh\nexec corepack pnpm "$@"\n');
    chmodSync(file, 0o755);
  }

  const path = process.env.PATH ?? '';
  return { ...process.env, PATH: `${dir}${delimiter}${path}` };
}

/**
 * Runs a step for real. Exported so the test can assert the interpreter substitution
 * without going through the whole CLI.
 *
 * @param {Step} step
 * @param {string[] | null} pnpm
 * @returns {{ status: number | null }}
 */
export function executeStep(step, pnpm) {
  const cwd = step.cwd === undefined ? root : join(root, step.cwd);
  /** @type {string[] | null} */
  let argv;
  if (step.script === undefined) {
    const declared = step.argv ?? [];
    // `python` in a step's argv is a placeholder: the interpreter is often a venv.
    argv = declared.map((part, index) => (index === 0 && part === 'python' ? python() : part));
  } else {
    argv = pnpm === null ? null : [...pnpm, 'run', step.script];
  }

  if (argv === null || argv.length === 0) return { status: 1 };

  const command = argv[0] ?? '';
  const args = argv.slice(1);
  const result = spawnCandidate(command, args, { cwd, stdio: 'inherit', env: stepEnv() });
  return { status: result?.status ?? 1 };
}

/**
 * Every script a step names must exist in `package.json`, and every CI job must be named by
 * a step or listed as uncovered. Exported for the test, which is the only caller.
 *
 * @param {{ scripts?: Record<string, string>, jobs?: string[] }} input
 * @returns {string[]} one message per problem
 */
export function contractProblems({ scripts = {}, jobs = [] } = {}) {
  /** @type {string[]} */
  const problems = [];

  for (const step of allSteps()) {
    if (step.script === undefined) continue;
    if (scripts[step.script] === undefined) {
      problems.push(
        `step \`${step.id}\` runs \`${step.script}\`, which package.json does not declare`,
      );
    }
  }

  const covered = new Set(allSteps().map((step) => step.job));
  for (const job of jobs) {
    if (covered.has(job) || UNCOVERED_JOBS.has(job)) continue;
    problems.push(
      `CI job \`${job}\` has no local step; add one to REQUIRED_STEPS or EXTERNAL_STEPS, or to UNCOVERED_JOBS with the reason`,
    );
  }

  return problems;
}

/**
 * The job ids `.github/workflows/ci.yml` declares, in file order.
 *
 * @param {string} [file]
 * @returns {string[]}
 */
export function ciJobs(file = '.github/workflows/ci.yml') {
  const text = readFileSync(join(root, file), 'utf8');
  const start = text.indexOf('\njobs:');
  if (start === -1) return [];
  /** @type {string[]} */
  const jobs = [];
  for (const line of text.slice(start).split('\n')) {
    // A top-level key ends the `jobs:` mapping; `on:` keys such as `push:` sit at the same
    // indentation as a job id, so only the slice above keeps them out.
    if (/^[A-Za-z]/.test(line)) {
      if (line === 'jobs:') continue;
      break;
    }
    const match = /^ {2}([a-z0-9-]+):$/.exec(line);
    if (match?.[1] !== undefined) jobs.push(match[1]);
  }
  return jobs;
}

function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const list = args.includes('--list');
  const onlyArg = args.find((arg) => arg.startsWith('--only'));

  const steps = allSteps();
  /** @type {Set<string> | null} */
  let only = null;
  if (onlyArg !== undefined) {
    const raw = onlyArg.includes('=')
      ? onlyArg.slice(onlyArg.indexOf('=') + 1)
      : (args[args.indexOf(onlyArg) + 1] ?? '');
    const wanted = raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const unknown = wanted.filter((id) => !steps.some((step) => step.id === id || step.job === id));
    if (unknown.length > 0) {
      process.stderr.write(`checks: no step or job named ${unknown.join(', ')}\n`);
      process.exit(1);
    }
    only = new Set(wanted);
  }
  const selected =
    only === null ? steps : steps.filter((step) => only.has(step.id) || only.has(step.job));

  /** @type {Set<string>} */
  const present = new Set();
  for (const [name, tool] of Object.entries(TOOLS)) {
    if (tool.available()) present.add(name);
  }

  /** @type {Step[]} */
  let planned = selected;
  /** @type {{ step: Step, tool: string, fix: string }[]} */
  let skipped = [];

  if (all) {
    const missing = [];
    for (const step of selected) {
      const absent = (step.tools ?? []).filter((tool) => !present.has(tool));
      for (const tool of absent) missing.push({ step, tool, fix: TOOLS[tool]?.fix ?? '' });
    }
    if (missing.length > 0) {
      process.stdout.write('checks: --all set, so a missing tool is a failure\n');
      for (const entry of missing) {
        process.stdout.write(`  ${entry.step.id}: ${entry.tool} missing -- ${entry.fix}\n`);
      }
      process.exit(1);
    }
  } else {
    const plan = planSteps({ present, steps: selected });
    planned = plan.run;
    skipped = plan.skipped;
  }

  if (list) {
    for (const step of steps) {
      const needed = (step.tools ?? []).join(', ');
      const state =
        needed === ''
          ? 'needs pnpm only'
          : (step.tools ?? []).every((tool) => present.has(tool))
            ? `needs ${needed} (present)`
            : `needs ${needed} (MISSING)`;
      process.stdout.write(`${step.id.padEnd(24)} ${step.job.padEnd(14)} ${state}\n`);
    }
    return;
  }

  const pnpm = pnpmArgv();
  if (pnpm === null && planned.some((step) => step.script !== undefined)) {
    process.stderr.write(
      'checks: pnpm is not on PATH, and package.json pins it; run `corepack enable pnpm` first\n',
    );
    process.exit(1);
  }

  process.stdout.write(
    `checks: ${planned.length} step(s) to run, ${skipped.length} skipped, ${all ? 'requiring' : 'using'} ${present.size} external tool(s) on this machine\n`,
  );

  const result = runSteps({
    run: planned,
    skipped,
    execute: (step) => executeStep(step, pnpm),
    log: (line) => process.stdout.write(`${line}\n`),
  });

  for (const dir of shimDirs) rmSync(dir, { recursive: true, force: true });

  process.stdout.write(`${summarize(result, { all })}\n`);
  process.exit(result.failed.length === 0 ? 0 : 1);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  main();
}

export { main };
