/**
 * The Node toolchain `aid guard` uses when a target's guardrail table is TypeScript.
 *
 * There is no discovery step, and that is deliberate: `aid` is itself a Node program, so
 * the binary that runs the CLI is a Node that exists, and the CLI's own `engines` floor is
 * 24 -- the line after which Node loads a `.ts` module without a flag. A second,
 * discovered Node could be older than the one already running this command, and the
 * failure would look like a broken generated module.
 *
 * `--input-type=module -e` carries the driver as text rather than a file, so a measurement
 * never writes into a repository it is reviewing. The driver imports the generated module
 * by absolute URL, which means the module's own imports (the runtime, `zod`) resolve from
 * the project tree rather than from wherever the process happens to start.
 */

import type { CliContext, SpawnResult } from './context.js';

/** The program named in a failed measurement, and reported in the JSON outcome. */
export const NODE = 'node';

/**
 * Run one driver script with the Node that is running this CLI.
 *
 * `undefined` means the child could not be started at all. For `process.execPath` that is
 * a bug rather than a machine state, but the contract is the same one `invoke` keeps for
 * Python so callers handle both drivers identically.
 */
export function invokeNode(context: CliContext, script: string): SpawnResult | undefined {
  const result = context.spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: context.cwd,
    stdio: 'pipe',
    env: context.env,
  });
  return result.error === undefined ? result : undefined;
}
