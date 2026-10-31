#!/usr/bin/env node
/**
 * Runs actionlint over .github/workflows/**.
 *
 * actionlint is a Go binary, so `pnpm install` cannot provide it: CI installs it
 * into the `workflows` job, and a local miss warns instead of failing.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * @typedef {object} WorkflowStep
 * @property {string} [name]
 * @property {string} [uses]
 * @property {string} [run]
 * @property {Record<string, string>} [env]
 */

/**
 * `gh` resolves its repository from the working tree unless `GH_REPO` or `-R`
 * names one. A job that runs `gh` with no checkout therefore fails at runtime
 * with "fatal: not a git repository" -- and only when that job finally runs,
 * which for `release.yml` means the first releasable merge. actionlint does not
 * model the working tree, so check it here, before the actionlint probe, where
 * a missing binary cannot hide the result.
 *
 * @returns {string[]} one message per offending step
 */
function checkGhRepositoryContext() {
  const directory = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
  const failures = [];

  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;

    const document = parseYaml(readFileSync(join(directory, name), 'utf8'));
    const jobs = document?.jobs ?? {};

    for (const [jobId, job] of Object.entries(jobs)) {
      /** @type {WorkflowStep[]} */
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const checksOut = steps.some((step) =>
        String(step?.uses ?? '').startsWith('actions/checkout'),
      );

      for (const step of steps) {
        const script = step?.run;
        if (typeof script !== 'string') continue;
        // A call, not a mention: the command must start a word.
        if (!/(^|[\s;&|(`])gh\s+\S/.test(script)) continue;

        const namesRepository =
          job?.env?.GH_REPO !== undefined ||
          step?.env?.GH_REPO !== undefined ||
          /(^|\s)(--repo|-R)\s/.test(script);

        if (checksOut || namesRepository) continue;

        failures.push(
          `${name}: job '${jobId}' step '${step.name ?? '(unnamed)'}' runs gh without a checkout ` +
            `or GH_REPO; gh will fail with "not a git repository"`,
        );
      }
    }
  }

  return failures;
}

const contextFailures = checkGhRepositoryContext();
if (contextFailures.length > 0) {
  for (const failure of contextFailures) process.stderr.write(`${failure}\n`);
  process.stderr.write(
    `\n${contextFailures.length} workflow step(s) cannot resolve a repository.\n`,
  );
  process.exit(1);
}

const version = process.env.ACTIONLINT_VERSION ?? '1.7.12';
const command = process.env.ACTIONLINT ?? 'actionlint';

const probe = spawnSync(command, ['--version'], { encoding: 'utf8', shell: false });

if (probe.error) {
  const install = [
    `actionlint ${version} is not on PATH.`,
    'Install it, or point ACTIONLINT at the binary:',
    `  curl -sSfL -o /tmp/actionlint.tar.gz \\`,
    `    https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz`,
    '  tar -xzf /tmp/actionlint.tar.gz -C /usr/local/bin actionlint',
  ].join('\n  ');

  if (process.env.CI === 'true') {
    process.stdout.write(`error: ${install}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `warning: skipping workflow lint locally.\n  ${install}\n  CI enforces this check (job: workflows).\n`,
    );
  }
  process.exit(process.exitCode ?? 0);
}

process.stdout.write(`${probe.stdout.trim()}\n`);

// actionlint exits 0 when shellcheck is absent, so the CI job asserts shellcheck
// exists before running this.
const result = spawnSync(command, ['-color', '-shellcheck=shellcheck'], {
  stdio: 'inherit',
  shell: false,
});

process.exit(result.status ?? 1);
