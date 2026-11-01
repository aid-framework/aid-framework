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
const PLAN = `${GENERATED}/deploy.plan.json`;
const MANIFEST = 'infra/aid.infra.manifest.json';

/** Files the emitter owns, as a path-to-content map. */
function emitted(made: ReturnType<typeof project>): Record<string, string> {
  return {
    [PLAN]: made.read(PLAN),
    [TFVARS]: made.read(TFVARS),
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
