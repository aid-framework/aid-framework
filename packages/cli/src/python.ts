/**
 * The Python toolchain the commands that run generated code have to find.
 *
 * `aid eval` and `aid ingest` both shell out to a module the generator emitted, so both
 * need the same two answers: which interpreter can actually import the runtime, and how
 * to spawn it. Keeping the discovery here means there is one definition of "a usable
 * interpreter" -- if the two commands each carried their own, an environment could work
 * for one and not the other without anything explaining why.
 *
 * The contract is deliberately narrow: the caller names the module, and this file only
 * decides which program runs it and from where. It knows nothing about evals or ingest.
 *
 * There is a second question in here for `aid package edge`: which interpreter can run a
 * helper that needs only the standard library. It is a different question -- it asks for
 * an interpreter that will *not* import the project, and it needs a newer minimum version
 * -- so it gets its own discovery rather than a flag on the first one.
 */

import type { CliContext, SpawnResult } from './context.js';

/**
 * Tried in order. The interpreter already active on this project comes first: it is the
 * one the runtime was installed into. `uv` is last, and is kept because a uv-managed
 * environment that has not been activated is a real setup where none of the others exist.
 */
export const INTERPRETERS = ['python3', 'python', 'uv'] as const;

/**
 * Discovery asks whether a candidate can import the runtime, not merely whether it
 * exists. A machine with a system `python` beside a project virtualenv has several
 * interpreters, and picking the one that cannot `import aid_runtime` reports a missing
 * dependency as a broken generated module. The probe is the import itself, so it cannot
 * disagree with what the run will do a moment later.
 */
const RUNTIME_PROBE = 'import aid_runtime.evals';

/** `uv run python` is a different argv shape from `python`, so it is not a rename. */
export function interpreterCommand(interpreter: string): readonly string[] {
  return interpreter === 'uv' ? ['uv', 'run', 'python'] : [interpreter];
}

/**
 * The argv for a helper that needs nothing but the standard library.
 *
 * `aid eval`, `aid ingest` and `aid dev` want the *project's* Python and so use
 * {@link interpreterCommand}. A helper that imports only stdlib must not: `uv run` inside
 * the app root syncs the project first, and that sync is the install `aid package edge`
 * is deliberately performing for a different platform. It would also fail whenever the
 * app's dependencies have no wheel for the machine doing the packaging, which is exactly
 * the case the packager exists to serve.
 */
export function stdlibCommand(interpreter: string): readonly string[] {
  return interpreter === 'uv' ? ['uv', 'run', '--no-project', 'python'] : [interpreter];
}

/**
 * Spawn, or `undefined` when the program could not be executed at all. `spawnSync` reports
 * a missing binary as `error` with a `null` status, and collapsing those two into one
 * `undefined` is what lets discovery and the real run share a code path.
 */
export function invoke(
  context: CliContext,
  command: readonly string[],
  stdin?: string,
): SpawnResult | undefined {
  const [program, ...args] = command;
  if (program === undefined) return undefined;
  const result = context.spawn(program, args, {
    cwd: context.cwd,
    stdio: 'pipe',
    env: context.env,
    ...(stdin === undefined ? {} : { stdin }),
  });
  return result.error === undefined ? result : undefined;
}

/** The first interpreter that can import the runtime, or `undefined` when none can. */
export function discoverInterpreter(
  context: CliContext,
  probe: string = RUNTIME_PROBE,
): string | undefined {
  for (const interpreter of INTERPRETERS) {
    const attempt = invoke(context, [...interpreterCommand(interpreter), '-c', probe]);
    if (attempt !== undefined && attempt.status === 0) return interpreter;
  }
  return undefined;
}

/**
 * What a stdlib-only helper needs: `tomllib`, which entered the standard library in 3.11.
 *
 * That minimum is why discovery asks at all: a 3.10 `python3` exists and looks usable, and
 * would then fail the packager's first helper with an `ImportError` instead of falling
 * through to an interpreter that works.
 */
export const STDLIB_PROBE = 'import tomllib, zipfile';

/** The first interpreter that can run a stdlib-only helper, or `undefined` when none can. */
export function discoverStdlibInterpreter(
  context: CliContext,
  probe: string = STDLIB_PROBE,
): string | undefined {
  for (const interpreter of INTERPRETERS) {
    const attempt = invoke(context, [...stdlibCommand(interpreter), '-c', probe]);
    if (attempt !== undefined && attempt.status === 0) return interpreter;
  }
  return undefined;
}

/**
 * What `aid dev` needs on top of the runtime: a server to run it with.
 *
 * Asked as one import statement rather than two probes because a single command either
 * can start the app or cannot; a machine where uvicorn exists in one interpreter and the
 * runtime in another has no interpreter that serves the app, and two probes that each
 * pass somewhere would name one that does not.
 */
export const DEV_PROBE = 'import aid_runtime, uvicorn';
