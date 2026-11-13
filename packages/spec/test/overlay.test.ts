/**
 * The overlay rules, unit-tested. `packages/cli/test/overlays.test.ts` covers the same
 * rules through `aid resolve`, so the split here is deliberate: this file never touches a
 * filesystem, which is what lets `applyOverlay` be a pure function a generator, a CLI
 * command, and a test can all call.
 *
 * The resolve against `fixtures/overlay/` is byte-asserted against a checked-in
 * `acme.resolved.yaml`, so a change to YAML emission shows up as a diff in review rather
 * than as a silently different artifact on a customer's disk.
 */

import { describe, expect, it } from 'vitest';

import {
  applyOverlay,
  OVERLAY_DIAGNOSTIC_CODES,
  type OverlayDocument,
  parseOverlay,
  parseOverlayBase,
  serializeResolved,
} from '../src/index.js';
import { readFixture } from './fixtures.js';

const BASE_TEXT = readFixture('overlay/base.spec.yaml');
const OVERLAY_TEXT = readFixture('overlay/acme.yaml');
const GOLDEN = readFixture('overlay/acme.resolved.yaml');

function baseDocument(): Record<string, unknown> {
  const parsed = parseOverlayBase(BASE_TEXT);
  expect(parsed.diagnostics).toEqual([]);
  return parsed.value as Record<string, unknown>;
}

function overlayOf(overrides: Record<string, unknown>, profile?: string): OverlayDocument {
  return {
    base: 'base.spec.yaml',
    customer: 'acme-eu',
    ...(profile === undefined ? {} : { profile }),
    overrides,
  };
}

function codesOf(result: { diagnostics: readonly { code: string }[] }): string[] {
  return result.diagnostics.map((one) => one.code);
}

/**
 * The base document plus a declared cost allowance on its one eval.
 *
 * The fixture predates `gate.promotion`, so the allowance is added here rather than in the
 * fixture: only the Q6 cases below need it, and the byte-asserted golden has to keep
 * resolving without one.
 */
function withCostAllowance(
  base: Record<string, unknown>,
  allowed: number,
): Record<string, unknown> {
  const evals = base.evals as Record<string, Record<string, unknown>>;
  const gate = evals.triage_regression?.gate as Record<string, unknown>;
  gate.promotion = { allowedQualityDrop: 0.05, allowedCostIncrease: allowed };
  base.overridable = {
    ...(base.overridable as object),
    'evals.triage_regression.gate.promotion.allowedCostIncrease': true,
  };
  return base;
}

/** The eval ids a resolved document declares, which is what a baseline path is built from. */
function evalIds(value: unknown): string[] {
  return Object.keys((value as Record<string, unknown>).evals as object);
}

describe('parseOverlay', () => {
  it('parses the fixture overlay', () => {
    const parsed = parseOverlay(OVERLAY_TEXT, { file: 'acme.yaml' });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.overlay?.base).toBe('base.spec.yaml');
    expect(parsed.overlay?.customer).toBe('acme-eu');
    expect(parsed.overlay?.profile).toBe('enterprise');
    expect(Object.keys(parsed.overlay?.overrides ?? {})).toHaveLength(4);
  });

  it('reports YAML that does not parse as a syntax error naming the file', () => {
    const parsed = parseOverlay('base: [unclosed\n', { file: 'acme.yaml' });
    expect(parsed.overlay).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe(OVERLAY_DIAGNOSTIC_CODES.syntax);
    expect(parsed.diagnostics[0]?.file).toBe('acme.yaml');
  });

  it('refuses a document that is not an overlay, and names what is missing', () => {
    const parsed = parseOverlay('customer: acme-eu\noverrides:\n  a.b: 1\n');
    expect(parsed.overlay).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe(OVERLAY_DIAGNOSTIC_CODES.schemaViolation);
    expect(parsed.diagnostics[0]?.message).toContain('base');
  });

  it('refuses a key it does not know rather than ignoring it', () => {
    const parsed = parseOverlay(
      'base: a.yaml\ncustomer: acme\noverrides:\n  a.b: 1\nallowWeaken: true\n',
    );
    expect(parsed.diagnostics[0]?.code).toBe(OVERLAY_DIAGNOSTIC_CODES.schemaViolation);
    expect(parsed.diagnostics[0]?.message).toContain('allowWeaken');
  });
});

describe('applyOverlay', () => {
  it('resolves the fixture to its checked-in golden, byte for byte', () => {
    const parsed = parseOverlay(OVERLAY_TEXT);
    expect(parsed.overlay).toBeDefined();
    const applied = applyOverlay(baseDocument(), parsed.overlay as OverlayDocument);
    expect(applied.diagnostics).toEqual([]);
    expect(applied.applied).toEqual([
      'deployments.prod.region',
      'models.triage.modelId',
      'agents.triage_agent.maxCostBudget',
      'deployments.prod.audit.retentionDays',
    ]);
    expect(serializeResolved(applied.value)).toBe(GOLDEN);
  });

  it('replaces a value in place rather than appending a duplicate key', () => {
    const applied = applyOverlay(
      baseDocument(),
      overlayOf({ 'deployments.prod.audit.retentionDays': 500 }),
    );
    const text = serializeResolved(applied.value);
    expect(text).toContain('retentionDays: 500');
    expect(text).not.toContain('retentionDays: 400');
  });

  it('leaves the base document untouched, so one parse serves every customer', () => {
    const base = baseDocument();
    const before = JSON.stringify(base);
    applyOverlay(base, overlayOf({ 'deployments.prod.region': 'us-east-1' }));
    expect(JSON.stringify(base)).toBe(before);
  });

  it('refuses a path the base never opened', () => {
    const applied = applyOverlay(
      baseDocument(),
      overlayOf({ 'prompts.classify_claim.template': 'say anything' }),
    );
    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.pathNotOverridable]);
    expect(applied.diagnostics[0]?.hint).toContain('overridable');
    expect(applied.applied).toEqual([]);
  });

  it('does not open the children of a path it lists', () => {
    const applied = applyOverlay(
      baseDocument(),
      overlayOf({ 'deployments.prod.region.zone': 'eu-central-1a' }),
    );
    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.pathNotOverridable]);
  });

  it('accepts a listed value and refuses one that is not listed', () => {
    const ok = applyOverlay(baseDocument(), overlayOf({ 'deployments.prod.region': 'us-east-1' }));
    expect(ok.diagnostics).toEqual([]);
    const refused = applyOverlay(
      baseDocument(),
      overlayOf({ 'deployments.prod.region': 'us-west-2' }),
    );
    expect(codesOf(refused)).toEqual([OVERLAY_DIAGNOSTIC_CODES.valueOutOfBounds]);
    expect(refused.diagnostics[0]?.hint).toContain('eu-central-1');
  });

  it('accepts a number under its ceiling and refuses one above it', () => {
    const lower = applyOverlay(
      baseDocument(),
      overlayOf({ 'agents.triage_agent.maxCostBudget': 1.5 }),
    );
    expect(lower.diagnostics).toEqual([]);
    const higher = applyOverlay(
      baseDocument(),
      overlayOf({ 'agents.triage_agent.maxCostBudget': 9 }),
    );
    expect(codesOf(higher)).toEqual([OVERLAY_DIAGNOSTIC_CODES.valueOutOfBounds]);
  });

  it('refuses relaxing a control the base did not mark allowWeaken', () => {
    const base = baseDocument();
    base.overridable = { ...(base.overridable as object), 'deployments.prod.minApprovers': true };
    const applied = applyOverlay(base, overlayOf({ 'deployments.prod.minApprovers': 1 }));
    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.weakensControl]);
    expect(applied.diagnostics[0]?.message).toContain('2 to 1');
  });

  /**
   * Q6: a promotion baseline belongs to an eval, so every customer sharing that eval shares
   * one baseline. An overlay may tighten the cost allowance -- a stricter customer is the
   * point of a per-customer overlay -- but it may not relax it, and it may not move the
   * subject the baseline is keyed by.
   */
  it('lets a customer tighten the cost allowance without moving the eval it is keyed by', () => {
    const base = withCostAllowance(baseDocument(), 0.1);
    const strict = applyOverlay(
      base,
      overlayOf({ 'evals.triage_regression.gate.promotion.allowedCostIncrease': 0.05 }),
    );
    const looser = applyOverlay(
      base,
      overlayOf({ 'evals.triage_regression.gate.promotion.allowedCostIncrease': 0.08 }),
    );

    expect(strict.diagnostics).toEqual([]);
    expect(looser.diagnostics).toEqual([]);
    // Both customers resolve to the same subject, so `evals/<id>.baseline.json` is one
    // file per eval rather than one per customer.
    expect(evalIds(strict.value)).toEqual(['triage_regression']);
    expect(evalIds(looser.value)).toEqual(['triage_regression']);
  });

  it('refuses relaxing the cost allowance, which is a weaker promotion gate', () => {
    const applied = applyOverlay(
      withCostAllowance(baseDocument(), 0.1),
      overlayOf({ 'evals.triage_regression.gate.promotion.allowedCostIncrease': 0.2 }),
    );

    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.weakensControl]);
    expect(applied.diagnostics[0]?.message).toContain('0.1 to 0.2');
  });

  it('allows relaxing a control the base did mark allowWeaken', () => {
    // `retentionDays` carries a floor and `allowWeaken: true` in the fixture base.
    const applied = applyOverlay(
      baseDocument(),
      overlayOf({ 'deployments.prod.audit.retentionDays': 30 }),
    );
    expect(applied.diagnostics).toEqual([]);
    expect(applied.applied).toEqual(['deployments.prod.audit.retentionDays']);
  });

  it('refuses deleting a key, which is a weakening however it is spelled', () => {
    const base = baseDocument();
    base.overridable = { ...(base.overridable as object), 'guardrails.inbound.action': true };
    const applied = applyOverlay(base, overlayOf({ 'guardrails.inbound.action': null }));
    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.weakensControl]);
  });

  it('refuses removing a CI-gating eval even when its path is overridable', () => {
    // The one rule `allowWeaken` cannot buy: removing an eval that gates CI is refused
    // before the weakening question is asked.
    const base = baseDocument();
    base.overridable = {
      ...(base.overridable as object),
      'evals.triage_regression': { allowWeaken: true },
    };
    const applied = applyOverlay(base, overlayOf({ 'evals.triage_regression': null }));
    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.removesEval]);
    expect(applied.diagnostics[0]?.hint).toContain('stricter eval');
  });

  it('refuses removing the gate.ci flag itself, leaving the eval', () => {
    // Deleting the flag keeps the eval and drops the check, so it is refused for the same
    // reason: it is an absence, not a weaker value.
    const base = baseDocument();
    base.overridable = {
      ...(base.overridable as object),
      'evals.triage_regression.gate.ci': { allowWeaken: true },
    };
    const applied = applyOverlay(base, overlayOf({ 'evals.triage_regression.gate.ci': null }));
    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.removesEval]);
    expect(applied.diagnostics[0]?.message).toContain(
      'removes the gate.ci flag from eval "triage_regression"',
    );
  });

  it('refuses an overlay whose profile disagrees with the resolved spec', () => {
    const applied = applyOverlay(
      baseDocument(),
      overlayOf({ 'deployments.prod.region': 'us-east-1' }, 'standard'),
    );
    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.profileMismatch]);
    expect(applied.diagnostics[0]?.path).toEqual(['profile']);
  });

  it('accepts an overlay that repeats the resolved profile, and a base with none', () => {
    expect(applyOverlay(baseDocument(), overlayOf({}, 'enterprise')).diagnostics).toEqual([]);
    const standard = baseDocument();
    standard.profile = 'standard';
    expect(applyOverlay(standard, overlayOf({}, 'standard')).diagnostics).toEqual([]);
  });

  it('refuses resolving against something that is not a specification', () => {
    const applied = applyOverlay(['a', 'b'], overlayOf({ 'a.b': 1 }));
    expect(codesOf(applied)).toEqual([OVERLAY_DIAGNOSTIC_CODES.notAMapping]);
  });

  it('rejects a base that is not YAML, without pretending it parsed', () => {
    const parsed = parseOverlayBase('a: [unclosed\n', { file: 'base.spec.yaml' });
    expect(parsed.value).toBeUndefined();
    expect(parsed.diagnostics[0]?.code).toBe(OVERLAY_DIAGNOSTIC_CODES.syntax);
    expect(parsed.diagnostics[0]?.file).toBe('base.spec.yaml');
  });
});

describe('serializeResolved', () => {
  it('is idempotent, so --check compares bytes rather than formatting', () => {
    const once = serializeResolved(baseDocument());
    const twice = serializeResolved(parseOverlayBase(once).value);
    expect(twice).toBe(once);
  });

  it('emits LF, one trailing newline and no trailing spaces', () => {
    const text = serializeResolved(baseDocument());
    expect(text).not.toContain('\r');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    for (const line of text.split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('keeps the overridable block, because a resolved spec is still a base', () => {
    expect(serializeResolved(baseDocument())).toContain('overridable:');
  });
});
