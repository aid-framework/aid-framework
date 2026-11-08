/**
 * How `aid infra` talks to OpenTofu.
 *
 * Only two things live here: what to run, and how to read the exit status. Every policy
 * decision (which environment, whether prod needs confirming, what a drift status means
 * to the caller) belongs to the command, so a test can assert the argv without pretending
 * to be OpenTofu.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

let planDirectory: string | undefined;

function planDirectoryPath(): string {
  planDirectory ??= mkdtempSync(join(tmpdir(), 'aid-infra-'));
  return planDirectory;
}

/**
 * The caller's environment spelling is a file name here, not a path: a separator or a
 * `..` must not be able to point the output somewhere the temp directory does not own.
 */
function planSlug(env: string): string {
  let slug = '';
  for (const character of env) {
    slug += /[A-Za-z0-9._-]/.test(character) ? character : '_';
  }
  return slug.length === 0 ? 'env' : slug;
}

/**
 * Where `plan` writes its plan file so the structured changes can be read back.
 *
 * Deliberately outside the project: a plan is a binary artifact with a lifetime of one
 * command, and a run that is interrupted should not leave one in the operator's tree
 * where it could be committed or mistaken for a module input. The directory is created
 * by `mkdtemp` rather than by name, because a predictable file in a shared temp directory
 * is one another local user can pre-place, and this command deletes what it finds there.
 */
export function tofuPlanPath(env: string, cloud: Cloud = DEFAULT_CLOUD): string {
  return join(planDirectoryPath(), `${cloud}-${planSlug(env)}.tfplan`);
}

/** Drop the directory the plan was written to. A directory that is gone is success. */
export function removeTofuPlan(): void {
  if (planDirectory === undefined) return;
  const directory = planDirectory;
  rmSync(directory, { recursive: true, force: true });
  // A later plan in the same process must not try to write into the directory just
  // removed, so the memo points at nothing and the next path call makes a fresh one.
  planDirectory = undefined;
}

/** The resource types that hold a corpus, so plan-time reporting needs no IR. */
export const KNOWLEDGE_BASE_RESOURCES: ReadonlySet<string> = new Set([
  'aws_bedrockagent_knowledge_base',
  'google_vertex_ai_rag_corpus',
]);

/**
 * The managed knowledge-base resources whose only planned action is a delete.
 *
 * Read from `tofu show -json` rather than the human plan: `-out` makes the plan a
 * document with an addressable shape, so a warning does not depend on the wording of a
 * sentence that changes between releases. A replacement (`["delete", "create"]`) is not
 * a destroy of the data — the corpus is rebuilt — so only a bare delete is reported.
 */
export function destroyedKnowledgeBases(showJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(showJson);
  } catch {
    return [];
  }
  const changes = (parsed as { resource_changes?: unknown } | null)?.resource_changes;
  if (!Array.isArray(changes)) return [];

  const doomed = new Set<string>();
  for (const change of changes) {
    if (change === null || typeof change !== 'object') continue;
    const {
      address,
      type,
      change: edit,
    } = change as {
      address?: unknown;
      type?: unknown;
      change?: { actions?: unknown };
    };
    if (typeof type !== 'string' || !KNOWLEDGE_BASE_RESOURCES.has(type)) continue;
    const actions = edit?.actions;
    if (!Array.isArray(actions) || actions.length !== 1 || actions[0] !== 'delete') continue;
    doomed.add(typeof address === 'string' ? address : type);
  }
  return [...doomed].sort();
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
    // `drift` deliberately omits this: it answers "is the deployment what the spec
    // says", and a saved plan is only needed when `plan` has to be read back for the
    // knowledge-base destroy warning.
    ...(action === 'plan' ? [`-out=${tofuPlanPath(env, cloud)}`] : []),
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
