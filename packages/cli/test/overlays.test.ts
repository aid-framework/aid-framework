/**
 * `aid resolve` and `aid fleet` are the CLI half of the overlay workflow, so these tests
 * drive them as a customer team would: one enterprise base, one overlay, then the fleet
 * view of the repo. Every refusal is asserted by its diagnostic code, because the code --
 * not the prose -- is what a CI job greps for.
 *
 * The refusals themselves live in the resolver and are unit-tested in
 * `packages/spec/test/overlay.test.ts`; what is under test here is that the CLI surfaces
 * them with the right exit code, the right file, and the right hint.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { templateSpec } from '../src/templates.js';
import { aid, diagnosticsOf, emptyProject, SPEC_PATH } from './helpers.js';

const BASE = templateSpec('enterprise-approvals', 'demo');
const OVERLAY = 'customers/acme-eu.yaml';
const RESOLVED = 'customers/acme-eu.spec.yaml';

const GOOD = [
  'base: ../app/app.spec.yaml',
  'customer: acme-eu',
  'profile: enterprise',
  'overrides:',
  '  deployments.prod.region: ap-southeast-2',
  '  models.triage.modelId: gpt-4.1-mini',
  '  agents.triage_agent.maxCostBudget: 1.5',
  '  deployments.prod.audit.retentionDays: 500',
  '',
].join('\n');

const created: ReturnType<typeof emptyProject>[] = [];

function fleetRoot(overlay = GOOD, path = OVERLAY) {
  const made = emptyProject();
  created.push(made);
  made.write(SPEC_PATH, BASE);
  made.write(path, overlay);
  return made;
}

/** The good overlay, with one override replaced, to pin a single refusal per test. */
function fleetWith(override: readonly string[]) {
  const lines = GOOD.split('\n');
  const overrides = lines.indexOf('overrides:');
  return [...lines.slice(0, overrides + 1), ...override, ''].join('\n');
}

afterAll(() => {
  for (const made of created) made.close();
});

describe('aid resolve', () => {
  it('prints the resolved spec and reports how many overrides it applied', () => {
    const made = fleetRoot();
    const run = aid(made, ['resolve', OVERLAY, '--json']);
    expect(run.code).toBe(0);
    const report = run.json<{ customer: string; counts: { applied: number } }>();
    expect(report.counts.applied).toBe(4);
    expect(report.customer).toBe('acme-eu');
    // The resolved artifact is derived, never configured: it goes next to the overlay.
    expect(made.exists(RESOLVED)).toBe(false);
  });

  it('applies every override to the document it prints', () => {
    const run = aid(fleetRoot(), ['resolve', OVERLAY]);
    expect(run.code).toBe(0);
    for (const expected of [
      'region: ap-southeast-2',
      'modelId: gpt-4.1-mini',
      'maxCostBudget: 1.5',
      'retentionDays: 500',
    ]) {
      expect(run.stdout).toContain(expected);
    }
    // The override replaces the field, it does not append a second one.
    expect(run.stdout).not.toContain('retentionDays: 400');
  });

  it('writes the same bytes it prints when asked with --out', () => {
    const made = fleetRoot();
    const printed = aid(made, ['resolve', OVERLAY]).stdout;
    const written = aid(made, ['resolve', OVERLAY, '--out', RESOLVED, '--json']);
    expect(written.code).toBe(0);
    expect(written.json<{ out: string }>().out).toBe(RESOLVED);
    expect(made.read(RESOLVED).trimEnd()).toBe(printed.trimEnd());
  });

  it('accepts the artifact while it is current, and refuses it once it drifts', () => {
    const made = fleetRoot();
    expect(aid(made, ['resolve', OVERLAY, '--check']).code).toBe(1);
    expect(aid(made, ['resolve', OVERLAY, '--out', RESOLVED]).code).toBe(0);
    expect(aid(made, ['resolve', OVERLAY, '--check']).code).toBe(0);

    // A base change invalidates every customer artifact, which is the point of --check:
    // generated files in git are compared byte for byte. The path has to be one the
    // overlay does not override, or the overlay would reproduce the same document.
    made.write(SPEC_PATH, BASE.replace('maxSteps: 8', 'maxSteps: 6'));
    const stale = aid(made, ['resolve', OVERLAY, '--check', '--json']);
    expect(stale.code).toBe(1);
    expect(diagnosticsOf(stale)[0]?.code).toBe('cli/resolve-outdated');
  });

  it('refuses an overlay that is not a file', () => {
    const run = aid(fleetRoot(), ['resolve', 'customers/nope.yaml', '--json']);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/overlay-unreadable');
  });

  it('names the file an overlay forgot to pass', () => {
    const run = aid(fleetRoot(), ['resolve', '--json']);
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/resolve-overlay-required');
  });

  it('resolves an overlay spelled with the separator a Windows shell produces', () => {
    const made = fleetRoot();
    // `customers\acme-eu.yaml` used to lose its directory here, because `parentPath` splits
    // on `/` alone: the base was then resolved against the working directory, and an
    // overlay that resolves correctly was refused with `overlay/base-missing` plus a hint
    // to check a path that was already right.
    const run = aid(made, ['resolve', 'customers\\acme-eu.yaml', '--json']);
    expect(run.code).toBe(0);
    const report = run.json<{ overlay: string; customer: string; counts: { applied: number } }>();
    expect(report.counts.applied).toBe(4);
    expect(report.customer).toBe('acme-eu');
    // Reported in the form the rest of the CLI speaks, so the artifact `--check` derives is
    // the one a forward-slash invocation wrote.
    expect(report.overlay).toBe(OVERLAY);
    expect(aid(made, ['resolve', OVERLAY, '--out', RESOLVED]).code).toBe(0);
    expect(aid(made, ['resolve', 'customers\\acme-eu.yaml', '--check']).code).toBe(0);
  });
});

describe('the overlay gate, through the CLI', () => {
  const refusals: readonly (readonly [string, string, string])[] = [
    [
      'a path the base never opened',
      fleetWith(['  prompts.classify_claim.template: hi']),
      'overlay/path-not-overridable',
    ],
    [
      'lowering the audit retention',
      fleetWith(['  deployments.prod.audit.retentionDays: 30']),
      'overlay/weakens-control',
    ],
    [
      'a region outside the list',
      fleetWith(['  deployments.prod.region: us-west-2']),
      'overlay/value-out-of-bounds',
    ],
    [
      'removing the gating eval',
      fleetWith(['  evals.triage_regression: null']),
      'overlay/removes-eval',
    ],
    // `profile` is a top-level overlay field, so this weakening is declared beside the
    // overrides rather than inside them.
    [
      'a weaker profile',
      GOOD.replace('profile: enterprise', 'profile: standard'),
      'overlay/profile-mismatch',
    ],
  ];

  for (const [what, overlay, code] of refusals) {
    it(`refuses ${what} with ${code}`, () => {
      const made = fleetRoot(overlay);
      const run = aid(made, ['resolve', OVERLAY, '--json']);
      expect(run.code).toBe(1);
      const [first] = diagnosticsOf(run);
      expect(first?.code).toBe(code);
      expect(first?.file).toBe(OVERLAY);
      expect(first?.hint).toBeTruthy();
      expect(made.exists(RESOLVED)).toBe(false);
    });
  }

  it('refuses a base that is not there, without inventing a profile', () => {
    const made = fleetRoot(GOOD.replace('../app/app.spec.yaml', '../nope.spec.yaml'));
    const run = aid(made, ['resolve', OVERLAY, '--json']);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run)[0]?.code).toBe('overlay/base-missing');

    const table = aid(made, ['fleet']);
    expect(table.code).toBe(1);
    expect(table.stdout).toContain('refused');
  });
});

describe('aid fleet', () => {
  it('lists every customer with the controls the overlay pinned', () => {
    const good = fleetRoot();
    good.write(
      'customers/contoso.yaml',
      GOOD.replace('acme-eu', 'contoso').replace('ap-southeast-2', 'us-east-1'),
    );
    const run = aid(good, ['fleet']);
    expect(run.code).toBe(0);
    for (const expected of [
      'acme-eu',
      'contoso',
      'enterprise',
      'gpt-4.1-mini',
      'ap-southeast-2',
      '$1.50',
      'ok',
    ]) {
      expect(run.stdout).toContain(expected);
    }
    // The base spec is not an overlay and must not appear as a customer.
    expect(run.stdout).not.toContain('demo ');
  });

  it('reports the fleet as JSON with one entry per customer', () => {
    const made = fleetRoot();
    const report = aid(made, ['fleet', '--json']).json<{
      ok: boolean;
      counts: { customers: number; ok: number; refused: number };
      customers: {
        customer: string;
        profile: string;
        regions: string;
        costCeiling: string;
        applied: number;
        status: string;
        codes: string[];
      }[];
    }>();
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ customers: 1, ok: 1, refused: 0 });
    const [customer] = report.customers;
    expect(customer?.customer).toBe('acme-eu');
    expect(customer?.profile).toBe('enterprise');
    expect(customer?.regions).toBe('ap-southeast-2');
    expect(customer?.costCeiling).toBe('$1.50');
    expect(customer?.applied).toBe(4);
    expect(customer?.status).toBe('ok');
    expect(customer?.codes).toEqual([]);
  });

  it('counts a refused customer and still names its base controls', () => {
    const made = fleetRoot();
    made.write(
      'customers/broken.yaml',
      GOOD.replace('acme-eu', 'broken').replace(
        '  deployments.prod.region: ap-southeast-2',
        '  deployments.prod.region: us-west-2',
      ),
    );
    const run = aid(made, ['fleet', '--json']);
    expect(run.code).toBe(1);
    const report = run.json<{
      ok: boolean;
      counts: { customers: number; ok: number; refused: number };
      customers: { customer: string; status: string; codes: string[] }[];
    }>();
    expect(report.ok).toBe(false);
    expect(report.counts).toEqual({ customers: 2, ok: 1, refused: 1 });
    const broken = report.customers.find((one) => one.customer === 'broken');
    expect(broken?.status).toBe('refused (1)');
    expect(broken?.codes).toEqual(['overlay/value-out-of-bounds']);
  });

  it('re-runs the gates, so a customer the gates refuse is not reported ok', () => {
    const made = emptyProject();
    created.push(made);
    // The base is gate-broken at a path no overlay touches: its audit sink is gone, which
    // the enterprise profile refuses. An overlay that only pins a model is still legal, so
    // a fleet that checked overlay rules alone would call this customer ok.
    made.write(SPEC_PATH, BASE.replace(/\n {4}audit:\n(?: {6}.*\n)+/, '\n'));
    made.write(
      OVERLAY,
      [
        'base: ../app/app.spec.yaml',
        'customer: acme-eu',
        'overrides:',
        '  models.triage.modelId: gpt-4.1-mini',
        '',
      ].join('\n'),
    );
    const report = aid(made, ['fleet', '--json']).json<{
      counts: { ok: number; refused: number };
      customers: { codes: string[] }[];
    }>();
    expect(report.counts).toEqual({ customers: 1, ok: 0, refused: 1 });
    expect(report.customers[0]?.codes).toContain('ir/profile-audit');
  });

  it('says so when the repository has no overlays', () => {
    const made = emptyProject();
    created.push(made);
    const run = aid(made, ['fleet', '--json']);
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/fleet-no-overlays');
  });

  it('refuses a directory that is not there', () => {
    const run = aid(fleetRoot(), ['fleet', 'nowhere', '--json']);
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/fleet-dir-unreadable');
  });

  it('finds the overlays under the directory it is given', () => {
    const made = fleetRoot();
    const run = aid(made, ['fleet', 'customers', '--json']);
    expect(run.code).toBe(0);
    const report = run.json<{
      counts: { customers: number };
      customers: { overlay: string; customer: string }[];
    }>();
    expect(report.counts.customers).toBe(1);
    // The reported path is repository-relative, so it is the one `aid resolve` accepts.
    expect(report.customers[0]?.overlay).toBe(OVERLAY);
    expect(aid(made, ['resolve', OVERLAY, '--json']).code).toBe(0);
  });

  it('walks the subdirectories of the directory it is given', () => {
    const made = fleetRoot();
    made.write('customers/north/contoso.yaml', GOOD.replace('acme-eu', 'contoso'));
    const report = aid(made, ['fleet', 'customers/', '--json']).json<{
      counts: { customers: number };
      customers: { overlay: string; customer: string }[];
    }>();
    expect(report.counts.customers).toBe(2);
    expect(report.customers.map((one) => one.overlay).sort()).toEqual([
      'customers/acme-eu.yaml',
      'customers/north/contoso.yaml',
    ]);
  });

  it('walks a directory spelled with the separator a Windows shell produces', () => {
    const made = fleetRoot();
    made.write('customers/north/contoso.yaml', GOOD.replace('acme-eu', 'contoso'));
    // The prefix a walk reports is derived from the directory as it was typed, so a
    // backslash one used to reach the resolver as `customers\north/contoso.yaml`: a path
    // whose parent came out as the whole string, which sent the base lookup one level too
    // deep and refused a customer whose overlay is fine.
    const report = aid(made, ['fleet', 'customers\\north', '--json']).json<{
      counts: { customers: number };
      customers: { overlay: string; customer: string }[];
    }>();
    expect(report.counts.customers).toBe(1);
    expect(report.customers[0]?.overlay).toBe('customers/north/contoso.yaml');
  });
});
