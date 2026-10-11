/**
 * Everything the CLI touches outside of itself, behind one injectable object.
 *
 * A CLI is mostly side effects, and side effects are what makes a command hard to test.
 * Naming them in one place keeps every command a pure function of its arguments and
 * this context, so a test can run a whole command against a temporary directory and
 * assert on what it printed, what it wrote, and what it exited with -- without a
 * subprocess, and without a mock for the parts that are not I/O.
 */

import { spawnSync } from 'node:child_process';

export interface SpawnOptions {
  readonly cwd: string;
  /** `inherit` streams the child's output straight through; `pipe` captures it. */
  readonly stdio: 'inherit' | 'pipe';
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Written to the child's stdin, then closed. Used for the baseline recipe. */
  readonly stdin?: string;
}

export interface SpawnResult {
  /** The exit status, or `null` when the child never ran or died by signal. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the child could not be executed at all, such as a missing binary. */
  readonly error?: Error;
}

export type Spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnResult;

export interface CliContext {
  /** The project root: every repository-relative path resolves against this. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly spawn: Spawn;
}

function spawnWith(command: string, args: readonly string[], options: SpawnOptions): SpawnResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env } as NodeJS.ProcessEnv,
    stdio: options.stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/** The real world: the process streams, the process environment, and real children. */
export function createContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    stdout: overrides.stdout ?? ((text: string) => process.stdout.write(text)),
    stderr: overrides.stderr ?? ((text: string) => process.stderr.write(text)),
    spawn: overrides.spawn ?? spawnWith,
  };
}
