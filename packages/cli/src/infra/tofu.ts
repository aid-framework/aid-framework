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
import { type Cloud, DEFAULT_CLOUD } from './cloud.js';

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

/**
 * The env root an action runs in: `infra/envs/<env>`, or `infra/envs/gcp-<env>` on GCP.
 *
 * The cloud is part of the directory name rather than a subdirectory, so `dev` and `prod`
 * stay siblings and a listing groups one cloud's environments together. AWS keeps the
 * unprefixed name so every existing root keeps working.
 */
export function envRoot(env: string, cloud: Cloud = DEFAULT_CLOUD): string {
  return posix.join('infra', 'envs', cloud === 'gcp' ? `gcp-${env}` : env);
}

/**
 * The argv for one action, relative to the env root.
 *
 * `drift` is `plan -detailed-exitcode`, because OpenTofu reserves exit 2 for "the plan is
 * non-empty" — the one status that distinguishes drift from a failure without parsing
 * human output.
 */
export function tofuArgs(action: InfraAction, env: string, cloud: Cloud = DEFAULT_CLOUD): string[] {
  const varFile = posix.relative(envRoot(env, cloud), TFVARS_PATH);
  return [
    action === 'drift' ? 'plan' : action,
    ...(action === 'drift' ? ['-detailed-exitcode'] : []),
    `-var-file=${varFile}`,
    '-input=false',
    '-no-color',
    ...APPROVALS[action],
  ];
}

/** What an exit status means for OpenTofu, kept beside the argv that produced it. */
export function classifyTofu(
  action: InfraAction,
  status: number | null,
): 'ok' | 'drift' | 'failed' {
  if (status === 0) return 'ok';
  // OpenTofu reserves exit 2 for "the plan is non-empty" under `-detailed-exitcode`, so
  // drift is a distinguishable status rather than a guess over human output.
  if (action === 'drift' && status === 2) return 'drift';
  return 'failed';
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
  cloud: Cloud,
  stdio: 'inherit' | 'pipe',
): SpawnResult {
  return context.spawn(tofuBinary(context), tofuArgs(action, env, cloud), {
    cwd: join(context.cwd, ...envRoot(env, cloud).split('/')),
    stdio,
    env: context.env,
  });
}
