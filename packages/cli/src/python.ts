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
export function discoverInterpreter(context: CliContext): string | undefined {
  for (const interpreter of INTERPRETERS) {
    const probe = invoke(context, [...interpreterCommand(interpreter), '-c', RUNTIME_PROBE]);
    if (probe !== undefined && probe.status === 0) return interpreter;
  }
  return undefined;
}
