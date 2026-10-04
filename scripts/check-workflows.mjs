#!/usr/bin/env node
/**
 * Runs actionlint over .github/workflows/**.
 *
 * actionlint is a Go binary, so `pnpm install` cannot provide it: CI installs it
 * into the `workflows` job, and a local miss warns instead of failing.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

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
