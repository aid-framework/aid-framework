/**
 * `aid infra`: what the spec derives, what it refuses to overwrite, and what it will not
 * pretend to have run.
 *
 * The tests are grouped by the three promises that matter, and each is asserted as a
 * property rather than a golden file:
 *
 * 1. Derivation is a function of the spec -- two runs, two projects, same bytes.
 * 2. The generated tree holds derived *shape* only. No account id, region, CIDR, domain
 *    or sizing number can appear, because none of them is a spec fact.
 * 3. Driving OpenTofu never fabricates success. A missing binary and an unconfirmed prod
 *    apply are diagnostics with a non-zero exit, and in both the tool is never invoked.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { aid, diagnosticsOf, project, recordingSpawn, SPEC_PATH } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch() {
  const made = project();
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

const GENERATED = 'infra/generated';
const TFVARS = `${GENERATED}/deploy.auto.tfvars.json`;
const CDK_CONTEXT = `${GENERATED}/deploy.cdk-context.json`;
const PLAN = `${GENERATED}/deploy.plan.json`;
const MANIFEST = 'infra/aid.infra.manifest.json';

/** Files the emitter owns, as a path-to-content map. */
function emitted(made: ReturnType<typeof project>): Record<string, string> {
  return {
    [PLAN]: made.read(PLAN),
    [TFVARS]: made.read(TFVARS),
    [CDK_CONTEXT]: made.read(CDK_CONTEXT),
    [`${GENERATED}/README.md`]: made.read(`${GENERATED}/README.md`),
  };
}

/** A minimal spec: enough to compile, with no deployments, stores or tasks. */
const TINY = `specVersion: "0.2"
project:
  name: tiny
  targets:
    - py-fastapi
`;

/** Everything a derived file must never contain, because the spec does not say it. */
function assertDerivedOnly(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    expect(text, `${path} carries an account id`).not.toMatch(/\b\d{12}\b/);
    expect(text, `${path} carries a CIDR`).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/);
    expect(text, `${path} carries a URL`).not.toMatch(/https?:\/\//);
    for (const key of [
      'account_id',
      'region',
      'cidr',
      'instance_class',
      'min_size',
      'max_size',
      'autoscale',
      'concurrency',
    ]) {
      expect(text, `${path} carries "${key}"`).not.toContain(`"${key}"`);
    }
  }
}

describe('infra gen', () => {
  it('derives the deployment wiring from the example spec', () => {
    const made = scratch();
    const run = aid(made, ['infra', 'gen', '--json']);

    expect(run.code).toBe(0);
    expect(made.walk()).toContain(TFVARS);
    expect(made.walk()).toContain(PLAN);
    expect(made.walk()).toContain(MANIFEST);

    const tfvars = JSON.parse(made.read(TFVARS));
    expect(Object.keys(tfvars.services)).toEqual(['api']);
    expect(tfvars.services.api.target).toBe('container');
    expect(tfvars.services.api.streaming).toBe(true);
    // The example's only HTTP pipeline: `answer_ticket` at post /tickets/answer.
    expect(tfvars.services.api.routes).toEqual([
      { pipeline: 'answer_ticket', method: 'post', path: '/tickets/answer' },
    ]);
    // The deployment's secret is declared; the model's key env may add to it, never
    // subtract, so the assertion is containment rather than equality.
    expect(tfvars.services.api.secret_names).toContain('OPENAI_API_KEY');
    expect(tfvars.project).toEqual({ name: 'support-copilot', namespace: 'aid.examples.support' });
  });

  it('emits derived shape only', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    assertDerivedOnly(emitted(made));
    // Non-vacuity: the spec really does declare `concurrency: 4` and `secrets`, so the
    // scan above is not passing because there was nothing to leak.
    expect(made.read(SPEC_PATH)).toContain('concurrency: 4');
  });

  it('is byte-identical across two projects generated from the same spec', () => {
    const first = scratch();
    const second = scratch();
    expect(aid(first, ['infra', 'gen']).code).toBe(0);
    expect(aid(second, ['infra', 'gen']).code).toBe(0);

    expect(emitted(second)).toEqual(emitted(first));
  });

  it('spells the same plan for both backends', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const tfvars = JSON.parse(made.read(TFVARS));
    const context = JSON.parse(made.read(CDK_CONTEXT));

    expect(context.project).toEqual(tfvars.project);
    expect(Object.keys(context.services)).toEqual(Object.keys(tfvars.services));
    expect(Object.keys(context.services).length).toBeGreaterThan(0);
    for (const id of Object.keys(tfvars.services)) {
      // Routes and env are the facts a backend could silently drop; secrets are renamed
      // rather than re-derived, so this asserts the rename kept every name.
      expect(context.services[id].routes).toEqual(tfvars.services[id].routes);
      expect(context.services[id].env).toEqual(tfvars.services[id].env);
      expect(context.services[id].secrets).toEqual(tfvars.services[id].secret_names);
    }
    expect(Object.keys(context.stores)).toEqual(Object.keys(tfvars.data_stores));
    for (const id of Object.keys(tfvars.data_stores)) {
      expect(context.stores[id].kind).toBe(tfvars.data_stores[id].kind);
    }
    expect(context.tasks).toEqual(tfvars.tasks);
    expect(context.alarms).toEqual(tfvars.alarms);
    // The spelling really is camelCase: a snake_case key left behind would mean the
    // CDK app is reading Terraform's vocabulary and the two could drift.
    expect(made.read(CDK_CONTEXT)).not.toContain('secret_names');
    expect(made.read(CDK_CONTEXT)).not.toContain('data_stores');
  });

  it('is idempotent: a second run changes nothing', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const before = made.snapshot();

    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    expect(made.snapshot()).toEqual(before);
  });

  it('refuses to overwrite a hand edit, and --force discards it', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const edited = `${made.read(TFVARS)}/* hand edit */\n`;
    made.write(TFVARS, edited);

    const refused = aid(made, ['infra', 'gen', '--json']);
    expect(refused.code).toBe(1);
    expect(made.read(TFVARS)).toBe(edited);
    expect(made.exists(`${TFVARS}.aid-rej`)).toBe(true);

    const forced = aid(made, ['infra', 'gen', '--force', '--json']);
    expect(forced.code).toBe(0);
    expect(made.read(TFVARS)).not.toContain('hand edit');
  });

  it('--check reports an ungenerated tree and writes nothing', () => {
    const made = scratch();
    const run = aid(made, ['infra', 'gen', '--check', '--json']);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-generated-outdated']);
    // Nothing was written, including the manifest: a check cannot create the tree it judges.
    expect(made.walk()).toEqual([SPEC_PATH]);
  });

  it('--check passes once the tree is generated', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const before = made.snapshot();

    expect(aid(made, ['infra', 'gen', '--check']).code).toBe(0);
    expect(made.snapshot()).toEqual(before);
  });

  it('handles a spec with no deployments, stores or tasks', () => {
    const made = project(TINY);
    created.push(made);

    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const tfvars = JSON.parse(made.read(TFVARS));
    expect(tfvars.services).toEqual({});
    expect(tfvars.data_stores).toEqual({});
    expect(tfvars.tasks).toEqual([]);
    expect(tfvars.alarms).toEqual([]);
    // The README is still written: a generated tree a reader can open, not an empty dir.
    expect(made.read(`${GENERATED}/README.md`)).toContain('Services: 0');
    assertDerivedOnly(emitted(made));
  });

  it('rejects an unknown subcommand and a missing one', () => {
    const made = scratch();

    const missing = aid(made, ['infra', '--json']);
    expect(missing.code).toBe(2);
    expect(diagnosticsOf(missing).map((d) => d.code)).toEqual(['cli/infra-subcommand-required']);

    const unknown = aid(made, ['infra', 'deploy', '--json']);
    expect(unknown.code).toBe(2);
    expect(diagnosticsOf(unknown).map((d) => d.code)).toEqual(['cli/infra-unknown-subcommand']);
  });
});

describe('infra plan, apply and drift', () => {
  function generated(): ReturnType<typeof project> {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    made.write('infra/envs/dev/.keep', '');
    return made;
  }

  it('refuses to run before the wiring exists, and does not invoke tofu', () => {
    const made = scratch();
    const spawn = recordingSpawn();
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-not-generated']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('runs plan in the env root with the generated var file', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls).toHaveLength(1);
    const [call] = spawn.calls;
    expect(call?.command).toBe('tofu');
    expect(call?.args).toEqual([
      'plan',
      '-var-file=../../generated/deploy.auto.tfvars.json',
      '-input=false',
      '-no-color',
    ]);
    // The var file is relative to the env root, so that is where the tool must run.
    expect(call?.cwd?.split(/[\\/]/).slice(-3).join('/')).toBe('infra/envs/dev');
  });

  it('reports a missing binary as a usage error rather than a passing plan', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: null });
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-tofu-missing']);
    expect(run.json<{ status?: number }>().status).toBeUndefined();
  });

  it('refuses to apply to prod without --confirm-prod, before invoking tofu', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'apply', '--env', 'prod', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-confirm-prod-required']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('applies to prod once confirmed, with auto-approve', () => {
    const made = generated();
    made.write('infra/envs/prod/.keep', '');
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'apply', '--env', 'prod', '--confirm-prod', '--json'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls[0]?.args).toContain('-auto-approve');
  });

  it('distinguishes drift from a failed plan by exit status', () => {
    const made = generated();

    const drifted = aid(made, ['infra', 'drift', '--json'], recordingSpawn({ status: 2 }));
    expect(drifted.code).toBe(1);
    expect(diagnosticsOf(drifted).map((d) => d.code)).toEqual(['cli/infra-drift-detected']);

    const clean = aid(made, ['infra', 'drift', '--json'], recordingSpawn({ status: 0 }));
    expect(clean.code).toBe(0);
    expect(diagnosticsOf(clean)).toEqual([]);
  });

  it('uses -detailed-exitcode only for drift', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: 0 });
    aid(made, ['infra', 'drift', '--json'], spawn);
    expect(spawn.calls[0]?.args).toContain('-detailed-exitcode');

    const planSpawn = recordingSpawn({ status: 0 });
    aid(made, ['infra', 'plan', '--json'], planSpawn);
    expect(planSpawn.calls[0]?.args).not.toContain('-detailed-exitcode');
  });

  it('reports a missing env root instead of planning against nothing', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-env-root-missing']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('reports a failing tool with its stderr', () => {
    const made = generated();
    const spawn = recordingSpawn({ status: 1, stderr: 'Error: bad reference' });
    const run = aid(made, ['infra', 'plan', '--json'], spawn);

    expect(run.code).toBe(1);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/infra-tofu-failed');
    expect(diagnostic?.hint).toContain('bad reference');
  });
});

describe('infra with cdk', () => {
  function cdkGenerated(): ReturnType<typeof project> {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    made.write('infra/cdk/dev/.keep', '');
    return made;
  }

  it('drives the cdk app root with its own argv', () => {
    const made = cdkGenerated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'cdk', '--json'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls).toHaveLength(1);
    const [call] = spawn.calls;
    expect(call?.command).toBe('cdk');
    expect(call?.args).toEqual(['diff', '--no-color']);
    // CDK resolves its app from the nearest cdk.json, so the app root is the cwd.
    expect(call?.cwd?.split(/[\\/]/).slice(-3).join('/')).toBe('infra/cdk/dev');
  });

  it('uses --fail only for drift, so plan mirrors tofu plan', () => {
    const made = cdkGenerated();

    const driftSpawn = recordingSpawn({ status: 0 });
    aid(made, ['infra', 'drift', '--iac', 'cdk', '--json'], driftSpawn);
    expect(driftSpawn.calls[0]?.args).toContain('--fail');

    // `cdk diff` exits 0 for a non-empty plan without --fail, exactly as `tofu plan` does
    // without -detailed-exitcode. `plan` reports that the plan ran; `drift` is the gate.
    const planSpawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'cdk', '--json'], planSpawn);
    expect(planSpawn.calls[0]?.args).not.toContain('--fail');
    expect(run.code).toBe(0);
  });

  it('never leaves an apply waiting for an interactive approval', () => {
    const made = cdkGenerated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'apply', '--iac', 'cdk', '--json'], spawn);

    expect(run.code).toBe(0);
    expect(spawn.calls[0]?.args).toEqual(['deploy', '--require-approval', 'never', '--no-color']);
  });

  it('keeps the prod confirmation in front of the cdk binary', () => {
    const made = cdkGenerated();
    made.write('infra/cdk/prod/.keep', '');
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'apply', '--iac', 'cdk', '--env', 'prod', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-confirm-prod-required']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('reads a cdk drift exit as drift, and everything else as a failure', () => {
    const made = cdkGenerated();

    const drifted = aid(
      made,
      ['infra', 'drift', '--iac', 'cdk', '--json'],
      recordingSpawn({ status: 1 }),
    );
    expect(drifted.code).toBe(1);
    expect(diagnosticsOf(drifted).map((d) => d.code)).toEqual(['cli/infra-drift-detected']);

    // CDK has no -detailed-exitcode, so a crash that exits 2 must not read as clean.
    const broken = aid(
      made,
      ['infra', 'drift', '--iac', 'cdk', '--json'],
      recordingSpawn({ status: 2, stderr: 'boom' }),
    );
    expect(broken.code).toBe(1);
    expect(diagnosticsOf(broken).map((d) => d.code)).toEqual(['cli/infra-cdk-failed']);
    expect(diagnosticsOf(broken)[0]?.hint).toContain('boom');
  });

  it('reports a missing cdk as usage, not as a passing plan', () => {
    const made = cdkGenerated();
    const run = aid(
      made,
      ['infra', 'plan', '--iac', 'cdk', '--json'],
      recordingSpawn({ status: null }),
    );

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-cdk-missing']);
    expect(run.json<{ status?: number }>().status).toBeUndefined();
  });

  it('requires the cdk app root rather than running from the project root', () => {
    const made = scratch();
    expect(aid(made, ['infra', 'gen']).code).toBe(0);
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'cdk', '--json'], spawn);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-env-root-missing']);
    expect(spawn.calls).toHaveLength(0);
  });

  it('rejects an unknown backend before spawning anything', () => {
    const made = cdkGenerated();
    const spawn = recordingSpawn({ status: 0 });
    const run = aid(made, ['infra', 'plan', '--iac', 'pulumi', '--json'], spawn);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((d) => d.code)).toEqual(['cli/infra-unknown-iac']);
    expect(spawn.calls).toHaveLength(0);
  });
});
