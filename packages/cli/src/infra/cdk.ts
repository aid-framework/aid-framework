/**
 * How `aid infra` talks to AWS CDK.
 *
 * CDK is an alternative backend, not a second truth: both drivers read the one plan in
 * `infra/generated`, and this file -- like `tofu.ts` -- knows only what to run and how to
 * read a status. Every policy decision stays in the command, so a test can assert the
 * argv without a CDK project installed.
 *
 * Deliberate limit, the same one `emit.ts` states for HCL: an env root here is a CDK app
 * owned by the project (`infra/cdk/<env>`), because a stack is business code -- it names
 * accounts, regions and construct choices. The emitter supplies the plan and a spelling
 * of it; it does not guess constructs it could not `cdk synth`.
 */

import { join, posix } from 'node:path';

import type { CliContext, SpawnResult } from '../context.js';
import type { InfraAction } from './tofu.js';

export const DEFAULT_CDK = 'cdk';

/** Set to point `aid infra` at a specific binary, such as a pinned CDK install. */
export const CDK_ENV = 'AID_CDK';

/** The env root an action runs in: `infra/cdk/<env>`, where the app's `cdk.json` lives. */
export function cdkRoot(env: string): string {
  return posix.join('infra', 'cdk', env);
}

/**
 * The argv for one action, relative to the env root.
 *
 * `deploy` passes `--require-approval never`, the equivalent of OpenTofu's
 * `-auto-approve`: that flag is consent to change state, and prod still needs
 * `--confirm-prod` before it is reached. Without it a CI apply would block on a prompt.
 *
 * `plan` deliberately omits `--fail`: `cdk diff` then exits 0 whether or not the plan is
 * non-empty, which is exactly what `tofu plan` does without `-detailed-exitcode`. An `ok`
 * here means "the plan ran", never "nothing would change", and the command says so.
 *
 * `drift` is `diff --fail`, which exits 1 when the stack differs. CDK has no
 * `-detailed-exitcode`, so its own failures also exit 1 and read as drift; that is the
 * fail-closed direction -- the check can report "not clean" too often, never clean by
 * accident.
 */
const ARGV: Readonly<Record<InfraAction, readonly string[]>> = {
  plan: ['diff', '--no-color'],
  apply: ['deploy', '--require-approval', 'never', '--no-color'],
  drift: ['diff', '--fail', '--no-color'],
};

export function cdkArgs(action: InfraAction): string[] {
  return [...ARGV[action]];
}

export function cdkBinary(context: CliContext): string {
  const configured = context.env[CDK_ENV];
  return configured === undefined || configured === '' ? DEFAULT_CDK : configured;
}

/**
 * Run one action inside the env root, because CDK resolves its app from the nearest
 * `cdk.json`, not from the project the command was started in.
 */
export function runCdk(
  context: CliContext,
  action: InfraAction,
  env: string,
  stdio: 'inherit' | 'pipe',
): SpawnResult {
  return context.spawn(cdkBinary(context), cdkArgs(action), {
    cwd: join(context.cwd, ...cdkRoot(env).split('/')),
    stdio,
    env: context.env,
  });
}

/** What an exit status means for CDK, kept beside the argv that produced it. */
export function classifyCdk(action: InfraAction, status: number | null): 'ok' | 'drift' | 'failed' {
  if (status === 0) return 'ok';
  if (action === 'drift' && status === 1) return 'drift';
  return 'failed';
}
