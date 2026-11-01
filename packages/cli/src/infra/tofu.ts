/**
 * How `aid infra` talks to OpenTofu.
 *
 * Only two things live here: what to run, and how to read the exit status. Every policy
 * decision (which environment, whether prod needs confirming, what a drift status means
 * to the caller) belongs to the command, so a test can assert the argv without pretending
 * to be OpenTofu.
 */

import { join, posix } from 'node:path';

import type { CliContext, SpawnResult } from '../context.js';

export const DEFAULT_TOFU = 'tofu';

/** Set to point `aid infra` at a specific binary, such as a pinned OpenTofu download. */
export const TOFU_ENV = 'AID_TOFU';

export const TFVARS_PATH = 'infra/generated/deploy.auto.tfvars.json';

export type InfraAction = 'plan' | 'apply' | 'drift';

/** `apply` is the only action that changes anything, so it is the only one that approves. */
const APPROVALS: Readonly<Record<InfraAction, readonly string[]>> = {
  plan: [],
  drift: [],
  apply: ['-auto-approve'],
};

/** The env root an action runs in: `infra/envs/<env>`. */
export function envRoot(env: string): string {
  return posix.join('infra', 'envs', env);
}

/**
 * The argv for one action, relative to the env root.
 *
 * `drift` is `plan -detailed-exitcode`, because OpenTofu reserves exit 2 for "the plan is
 * non-empty" — the one status that distinguishes drift from a failure without parsing
 * human output.
 */
export function tofuArgs(action: InfraAction, env: string): string[] {
  const varFile = posix.relative(envRoot(env), TFVARS_PATH);
  return [
    action === 'drift' ? 'plan' : action,
    ...(action === 'drift' ? ['-detailed-exitcode'] : []),
    `-var-file=${varFile}`,
    '-input=false',
    '-no-color',
    ...APPROVALS[action],
  ];
}

export function tofuBinary(context: CliContext): string {
  const configured = context.env[TOFU_ENV];
  return configured === undefined || configured === '' ? DEFAULT_TOFU : configured;
}

/**
 * Run one action inside the env root, because `-var-file` is resolved relative to the
 * directory OpenTofu runs in, not to the project the command was started from.
 *
 * `stdio` is `inherit` for a human, so a plan streams as it is computed, and `pipe` under
 * `--json`, so the document on stdout stays parseable.
 */
export function runTofu(
  context: CliContext,
  action: InfraAction,
  env: string,
  stdio: 'inherit' | 'pipe',
): SpawnResult {
  return context.spawn(tofuBinary(context), tofuArgs(action, env), {
    cwd: join(context.cwd, ...envRoot(env).split('/')),
    stdio,
    env: context.env,
  });
}
