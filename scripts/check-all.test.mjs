/**
 * Holds `scripts/check-all.mjs` to the promise that makes it worth having: it may skip a
 * step, but it must never let a skip look like a pass.
 *
 * The tests that matter most here are the ones that would fail if the runner regressed to
 * the behaviour it replaced -- a summary that says everything is fine while a CI job never
 * ran, and a lint step that exits 0 without reading anything.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  allSteps,
  ciJobs,
  contractProblems,
  EXTERNAL_STEPS,
  executeStep,
  planSteps,
  python,
  REQUIRED_STEPS,
  runSteps,
  summarize,
  TOOLS,
  UNCOVERED_JOBS,
} from './check-all.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** @param {string} file @returns {string} */
const read = (file) => readFileSync(join(root, file), 'utf8');

/**
 * Indexing is checked, so every access returns `T | undefined`. Failing here with the index
 * beats a spread of non-null assertions through the file.
 *
 * @template T
 * @param {T[]} items
 * @param {number} index
 * @returns {T}
 */
function at(items, index) {
  const item = items[index];
  if (item === undefined) throw new Error(`no entry at index ${index}`);
  return item;
}

describe('the step plan', () => {
  it('runs the cheap, dependency-ordered steps before the environment-dependent ones', () => {
    const ids = allSteps().map((step) => step.id);
    expect(ids.slice(0, REQUIRED_STEPS.length)).toEqual(REQUIRED_STEPS.map((step) => step.id));
    expect(ids.slice(REQUIRED_STEPS.length)).toEqual(EXTERNAL_STEPS.map((step) => step.id));
    // `build` emits the dist that typecheck and the docs generator read.
    expect(ids.indexOf('build')).toBeLessThan(ids.indexOf('typecheck'));
    expect(ids.indexOf('docs:build')).toBeLessThan(ids.indexOf('docs:links'));
  });

  it('names a CI job for every step, and never repeats an id', () => {
    const steps = allSteps();
    expect(steps.filter((step) => !step.job)).toEqual([]);
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
  });

  // A step whose directory does not exist fails only where the interpreter is installed, so
  // the mistake stays invisible on a machine that skips it -- which is how `evals:test` pointed
  // at a directory no checkout has while every local run reported it as an environment skip.
  it('runs every step in a directory the checkout has', () => {
    const missing = allSteps()
      .filter((step) => step.cwd !== undefined && !existsSync(join(root, step.cwd)))
      .map((step) => `${step.id} -> ${step.cwd}`);
    expect(missing).toEqual([]);
  });
});

describe('skipping', () => {
  it('reports a step whose tool is missing as skipped, with the fix', () => {
    const step = at(EXTERNAL_STEPS, 0);
    const plan = planSteps({ present: new Set(), steps: [step] });
    expect(plan.run).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.tool).toBe('actionlint');
    expect(plan.skipped[0]?.fix).toBe(TOOLS.actionlint?.fix);
  });

  it('runs a step whose every tool is present', () => {
    const step = at(EXTERNAL_STEPS, 0);
    const plan = planSteps({ present: new Set(step.tools ?? []), steps: [step] });
    expect(plan.run).toEqual([step]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('running', () => {
  it('keeps going after a failure, and names the step that failed', () => {
    const steps = allSteps().slice(0, 3);
    /** @type {string[]} */
    const lines = [];
    const result = runSteps({
      run: steps,
      skipped: [],
      execute: (step) => ({ status: step.id === steps[1]?.id ? 1 : 0 }),
      log: (line) => lines.push(line),
    });

    expect(result.failed).toEqual([steps[1]?.id]);
    expect(result.passed).toEqual([steps[0]?.id, steps[2]?.id]);
    expect(lines).toContain(`  FAILED ${steps[1]?.id} 0.0s`);
  });

  it('treats a missing status as a failure rather than a pass', () => {
    const step = allSteps()[0];
    if (step === undefined) throw new Error('no steps');
    const result = runSteps({
      run: [step],
      skipped: [],
      execute: () => ({ status: null }),
      log: () => {},
    });
    expect(result.failed).toEqual([step.id]);
  });
});

describe('the summary', () => {
  /** @param {Parameters<typeof summarize>[0]} result */
  const clean = (result) => summarize(result, { all: false });

  it('says only the counts when every step ran', () => {
    const text = clean({ passed: ['a', 'b'], failed: [], skipped: [], ms: 1500 });
    expect(text).toBe('checks: 2 passed in 1.5s');
    expect(text).not.toContain('NOT');
  });

  it('never claims a pass while a step was skipped', () => {
    const step = EXTERNAL_STEPS[0];
    if (step === undefined) throw new Error('no external steps');
    const text = clean({
      passed: ['a'],
      failed: [],
      skipped: [{ step, tool: 'actionlint', fix: 'install actionlint' }],
      ms: 1000,
    });

    expect(text).toContain('NOT all CI checks ran');
    expect(text).toContain('not verified locally: lint:actions');
    expect(text).toContain('install actionlint');
    expect(text).toContain('check:all');
  });

  // `--all` exits before running when a tool is missing, so this only guards the helper
  // against being called in a state it would otherwise describe as complete.
  it('still refuses to claim completeness when skips are passed with --all', () => {
    const step = EXTERNAL_STEPS[0];
    if (step === undefined) throw new Error('no external steps');
    const text = summarize(
      { passed: [], failed: [], skipped: [{ step, tool: 'actionlint', fix: 'install it' }], ms: 0 },
      { all: true },
    );
    expect(text).toContain('NOT all CI checks ran');
  });
});

describe('the CI contract', () => {
  it('fails when a step names a script package.json does not declare', () => {
    const problems = contractProblems({ scripts: {}, jobs: [] });
    expect(problems.some((problem) => problem.includes('does not declare'))).toBe(true);
  });

  it('fails when CI has a job no step stands in for', () => {
    const problems = contractProblems({ scripts: {}, jobs: ['brand-new-job'] });
    expect(problems.some((problem) => problem.includes('brand-new-job'))).toBe(true);
  });

  it('accepts a job listed as uncovered, with its reason', () => {
    const job = [...UNCOVERED_JOBS.keys()][0];
    if (job === undefined) throw new Error('nothing listed as uncovered');
    expect(UNCOVERED_JOBS.get(job)?.length).toBeGreaterThan(20);
    const problems = contractProblems({ scripts: {}, jobs: [job] });
    expect(problems.some((problem) => problem.includes(job))).toBe(false);
  });

  // The real guard: a new job in ci.yml, or a renamed script, has to be answered here.
  it('matches the real workflow and the real package.json', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    const jobs = ciJobs();

    expect(jobs).toContain('node');
    expect(jobs).toContain('conformance');
    // `on: push:` sits at the same indentation as a job id.
    expect(jobs).not.toContain('push');

    expect(contractProblems({ scripts, jobs })).toEqual([]);
  });
});

describe('python', () => {
  it('reads the interpreter from AID_PYTHON so one variable points at a venv', () => {
    const before = process.env.AID_PYTHON;
    process.env.AID_PYTHON = '/opt/venv/bin/python';
    try {
      expect(python()).toBe('/opt/venv/bin/python');
    } finally {
      if (before === undefined) delete process.env.AID_PYTHON;
      else process.env.AID_PYTHON = before;
    }
  });

  it('runs a step through that interpreter rather than a bare `python`', () => {
    const before = process.env.AID_PYTHON;
    process.env.AID_PYTHON = process.execPath;
    try {
      // If the placeholder were not substituted, this would run the real `python`.
      const result = executeStep(
        { id: 'probe', job: 'probe', argv: ['python', '--version'] },
        null,
      );
      expect(result.status).toBe(0);
    } finally {
      if (before === undefined) delete process.env.AID_PYTHON;
      else process.env.AID_PYTHON = before;
    }
  });

  it('fails a script step when pnpm could not be found', () => {
    expect(executeStep({ id: 'probe', job: 'probe', script: 'build' }, null).status).toBe(1);
  });
});

describe('the command line', () => {
  /** @param {string[]} args */
  const cli = (args) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'check-all.mjs'), ...args], {
      cwd: root,
      encoding: 'utf8',
    });

  it('lists the plan and runs nothing', () => {
    const run = cli(['--list']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('lint:actions');
    expect(run.stdout).toContain('docs:a11y');
    // Nothing was spawned: no step result lines.
    expect(run.stdout).not.toContain('  ok ');
  });

  it('refuses a step name it does not have', () => {
    const run = cli(['--only', 'not-a-step']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no step or job named not-a-step');
  });
});

describe('the markdown lint the runner shells out to', () => {
  it('fails on a fence with no language', () => {
    // The point of this test: `pnpm lint:md` is only worth a green tick if the linter can
    // go red. It is easy to invoke the package's library entry point by mistake, which
    // accepts anything and exits 0 -- so this asserts the real bin refuses a real defect.
    const dir = mkdtempSync(join(tmpdir(), 'aid-md-'));
    try {
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'bad.md'), '```\ncode\n```\n');

      const run = spawnSync(
        process.execPath,
        [
          join(root, 'node_modules', 'markdownlint-cli2', 'markdownlint-cli2-bin.mjs'),
          '--no-globs',
          '--config',
          join(root, '.markdownlint-cli2.jsonc'),
          'docs/bad.md',
        ],
        { cwd: dir, encoding: 'utf8' },
      );

      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain('MD040');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
