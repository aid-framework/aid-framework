/**
 * Runs the example's own test suite and asserts how many tests passed.
 *
 * The root `pnpm test` is a single workspace run and `examples/` names its suite
 * directory `tests/`, so this file is not collected there. The `e2e` job calls this
 * script instead. `node --test <file>` exits 0 when the file registers no tests at
 * all, so a deleted or emptied suite would otherwise look green: the count below is
 * what makes this step fail when it runs zero tests. Adding or removing a test means
 * updating `expected` deliberately.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const expected = 7;
const root = fileURLToPath(new URL('..', import.meta.url));
const entry = fileURLToPath(new URL('../dist/tests/app.test.js', import.meta.url));

const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', entry], {
  cwd: root,
  encoding: 'utf8',
});

process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

const passed = /^# pass (\d+)$/m.exec(run.stdout ?? '');
const count = passed ? Number(passed[1]) : 0;

if (count !== expected) {
  console.error(`The example's suite reported ${count} passing test(s), expected ${expected}.`);
  process.exit(1);
}
