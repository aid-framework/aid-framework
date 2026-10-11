/**
 * The harness every CLI test runs against.
 *
 * A CLI is mostly side effects, so the thing worth testing is the effect: run a command
 * against a real temporary directory, with the real generator and the real drift rule,
 * and assert on what ended up on disk, what was printed, and what the exit code was.
 *
 * Two choices here are deliberate:
 *
 * - The spec is the committed example, not a hand-written fixture. `aid gen` on the
 *   example has to reproduce `examples/support-copilot` exactly, so using it as the
 *   fixture means every generation test is also a statement about the golden tree. A
 *   second, smaller spec here would be a second thing to keep true.
 * - Each `aid(...)` call is a fresh run with freshly captured streams. Commands return
 *   outcomes rather than printing them, so there is nothing to reset between calls and no
 *   ordering dependency between assertions.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliContext, ExitCode, Spawn, SpawnResult } from '../src/index.js';
import { createContext, run } from '../src/index.js';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The committed example: the app whose spec this suite generates from. */
export const EXAMPLE_ROOT = join(REPO_ROOT, 'examples', 'support-copilot');

/** `app/app.spec.yaml`, the path every py-fastapi project keeps its spec at. */
export const SPEC_PATH = 'app/app.spec.yaml';

/** The committed example spec: the fixture every generation test generates from. */
export const EXAMPLE_SPEC = readFileSync(join(EXAMPLE_ROOT, 'app', 'app.spec.yaml'), 'utf8');

export interface Project {
  readonly root: string;
  /** Replace the spec. Pass text that does not parse to test a failure path. */
  setSpec(text: string): void;
  read(relPath: string): string;
  write(relPath: string, text: string): void;
  remove(relPath: string): void;
  exists(relPath: string): boolean;
  /** Every file in the tree, as sorted repository-relative POSIX paths. */
  walk(): string[];
  hash(relPath: string): string;
  /** The tree as a path-to-content map, for byte-identical comparison. */
  snapshot(): Record<string, string>;
  close(): void;
}

/**
 * Interpreter and linter caches are not part of a project's source.
 *
 * They appear the moment anyone runs the Python gates in the tree -- which CONTRIBUTING
 * tells them to do -- so a walk that counted them would fail a generation test for a
 * reason that has nothing to do with generation, in exactly the order the documented
 * workflow runs. `scripts/e2e-tree.mjs` ignores the same set for the same reason.
 */
export function isBuildArtifact(path: string): boolean {
  return path.split('/').includes('__pycache__') || path.endsWith('.pyc');
}

export function emptyProject(): Project {
  const root = mkdtempSync(join(tmpdir(), 'aid-cli-'));
  const absolute = (relPath: string): string => join(root, ...relPath.split('/'));

  const write = (relPath: string, text: string): void => {
    mkdirSync(dirname(absolute(relPath)), { recursive: true });
    writeFileSync(absolute(relPath), text, 'utf8');
  };

  const read = (relPath: string): string => readFileSync(absolute(relPath), 'utf8');

  const walk = (dir = root, acc: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isBuildArtifact(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else acc.push(relative(root, full).split(sep).join('/'));
    }
    return acc.sort();
  };

  return {
    root,
    setSpec: (text) => write(SPEC_PATH, text),
    read,
    write,
    remove: (relPath) => rmSync(absolute(relPath), { force: true }),
    exists: (relPath) => existsSync(absolute(relPath)),
    walk: () => walk(),
    hash: (relPath) =>
      createHash('sha256')
        .update(readFileSync(absolute(relPath)))
        .digest('hex'),
    snapshot: () => Object.fromEntries(walk().map((path) => [path, read(path)])),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function project(specText: string = EXAMPLE_SPEC): Project {
  const made = emptyProject();
  made.setSpec(specText);
  return made;
}

/**
 * A byte-for-byte copy of the committed example tree, for the tests that regenerate it in
 * place.
 *
 * The distinction from {@link project} matters and cost a debugging session to learn: a
 * tree built from the spec alone has no `aid.manifest.json`, so `aid gen` sees every
 * planned file as new and records the hash of what it does create. The committed manifest
 * is instead the product of generations layered over time -- a business record keeps the
 * hash it was first given, by design, so a business file that was hand-edited afterwards
 * still carries the hash of the template that created it. Regenerating *in place* is the
 * only run that can be byte-identical over the whole tree, and that is the run this
 * reproduces.
 */
export function cloneExample(): Project {
  const made = emptyProject();
  const copy = (dir: string, relPath: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isBuildArtifact(entry.name)) continue;
      const next = relPath === '' ? entry.name : `${relPath}/${entry.name}`;
      if (entry.isDirectory()) copy(join(dir, entry.name), next);
      else made.write(next, readFileSync(join(dir, entry.name), 'utf8'));
    }
  };
  copy(EXAMPLE_ROOT, '');
  return made;
}

export interface Run {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout parsed as the `--json` document. Throws when stdout is not JSON. */
  json<T = Record<string, unknown>>(): T;
}

/** Run the CLI against `project`, capturing both streams. */
export function aid(project: Project, argv: readonly string[], spawn?: Spawn): Run {
  const out: string[] = [];
  const err: string[] = [];
  const context: CliContext = createContext({
    cwd: project.root,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...(spawn === undefined ? {} : { spawn }),
  });
  const code = run(argv, context);
  const stdout = out.join('');
  const stderr = err.join('');
  return {
    code,
    stdout,
    stderr,
    json: <T>() => JSON.parse(stdout) as T,
  };
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly hint?: string;
}

/** The diagnostics a `--json` report carries, as a convenience for assertions. */
export function diagnosticsOf(run: Run): readonly Diagnostic[] {
  return (run.json<{ diagnostics: Diagnostic[] }>().diagnostics ?? []) as readonly Diagnostic[];
}

/** A recorded spawn call, as `recordingSpawn` saw it. */
export interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

export interface FakeSpawnOptions {
  /** The exit status of a real invocation. `null` simulates a program that is not there. */
  readonly status?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  /**
   * The exit status of the interpreter-discovery probe. Defaults to 0, because whether an
   * interpreter can import the runtime is a separate question from what running the eval
   * returns -- collapsing the two would make every "the gate failed" test also claim the
   * interpreter was missing.
   */
  readonly probeStatus?: number | null;
}

/**
 * A spawn that records every command and answers with `options.status`. Discovery probes
 * are answered with `options.probeStatus`, and a `null` status (what `spawnSync` reports
 * for a program that does not exist) is returned as a spawn `error`, so a test can
 * simulate an absent interpreter.
 */
export function recordingSpawn(
  options: FakeSpawnOptions | number = {},
): Spawn & { readonly calls: readonly SpawnCall[] } {
  const config = typeof options === 'number' ? { status: options } : options;
  const calls: SpawnCall[] = [];
  const spawn: Spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, stdin: spawnOptions.stdin });
    // An explicit `null` is a status, not an absence: it is how `spawnSync` reports a
    // program that is not there, so `?? 0` would turn "no interpreter" into a passing
    // probe and make the missing-interpreter test assert nothing.
    const requested = args.includes('-c') ? config.probeStatus : config.status;
    const status = requested === undefined ? 0 : requested;
    const answer: SpawnResult = {
      status,
      stdout: config.stdout ?? '',
      stderr: config.stderr ?? '',
    };
    if (status === null) return { ...answer, error: new Error(`${command} is not there`) };
    return answer;
  };
  Object.defineProperty(spawn, 'calls', { value: calls, enumerable: true });
  return spawn as Spawn & { readonly calls: readonly SpawnCall[] };
}
