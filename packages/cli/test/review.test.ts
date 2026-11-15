import { afterAll, describe, expect, it } from 'vitest';
import { templateSpec } from '../src/templates.js';
import { aid, diagnosticsOf, project } from './helpers.js';

const created: ReturnType<typeof project>[] = [];
function scratch(specText?: string) {
  const made = project(specText);
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

interface Unverified {
  readonly control: string;
  readonly declared: string;
  readonly path: string;
}

interface Pack {
  readonly profile: string;
  readonly deployments: string[];
  readonly unverified: Unverified[];
}

const packOf = (made: ReturnType<typeof project>, args: string[] = []): Pack =>
  aid(made, ['review', ...args, '--json']).json<Pack>();

describe('aid review', () => {
  it('separates what the build proved from what it only accepted as declared', () => {
    const made = scratch();
    const run = aid(made, ['review']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('the build verified');
    expect(run.stdout).toContain('the build did not verify');
    // The example declares one thing and one thing only: a secret name. A pack that listed
    // it under "verified" would be the exact lie this command exists to prevent.
    expect(packOf(made).unverified).toEqual([
      {
        control: 'secret references',
        declared: 'OPENAI_API_KEY',
        path: 'deployments.api.secrets',
      },
    ]);
  });

  it('names every enterprise control with the path a reviewer has to go and confirm', () => {
    const made = scratch(templateSpec('enterprise-approvals', 'claims'));
    const pack = packOf(made);

    expect(pack.profile).toBe('enterprise');
    expect(pack.deployments).toEqual(['prod']);
    expect(pack.unverified.map((entry) => entry.path)).toEqual([
      'deployments.prod.cloud',
      'deployments.prod.region',
      'deployments.prod.audit.sink',
      'deployments.prod.audit.retentionDays',
      'deployments.prod.identity.issuer',
      'deployments.prod.identity.audience',
      'deployments.prod.network.private',
      'deployments.prod.network.egress',
      'deployments.prod.approvals.require',
      'deployments.prod.approvals.minApprovers',
      'deployments.prod.secrets',
    ]);
  });

  it('carries the declared value, so a reviewer need not reopen the spec', () => {
    const made = scratch(templateSpec('enterprise-approvals', 'claims'));
    const pack = packOf(made);
    const entry = pack.unverified.find((each) => each.path === 'deployments.prod.identity.issuer');

    expect(entry?.control).toBe('identity issuer');
    expect(entry?.declared).toBe('https://login.example.com');
    expect(
      pack.unverified.find((e) => e.path === 'deployments.prod.approvals.require')?.declared,
    ).toBe('security, platform');
  });

  it('refuses a spec the build refuses rather than itemise controls the build never reached', () => {
    // `validate` already refuses this, and the refusal is the answer: a pack listing a
    // region pin and an audit sink for a spec that does not build invites a reviewer to
    // approve controls the build never got as far as checking.
    const spec = templateSpec('enterprise-approvals', 'claims');
    const withoutIdentity = spec.replace(/^ {4}identity:\n(?: {6}.*\n)+/m, '');
    expect(withoutIdentity).not.toContain('identity:');

    const made = scratch(withoutIdentity);
    const run = aid(made, ['review']);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('not reviewable');
    expect(run.stdout).not.toContain('the build verified');
    expect(
      diagnosticsOf(aid(made, ['review', '--json'])).some((each) => each.code.includes('profile')),
    ).toBe(true);
  });

  it('prints the same pack twice, because it reads files and nothing else', () => {
    const made = scratch(templateSpec('enterprise-approvals', 'claims'));
    expect(aid(made, ['review']).stdout).toBe(aid(made, ['review']).stdout);
  });
});
