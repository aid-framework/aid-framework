/**
 * The 0.28 gates: the promotion policy and the feedback intake.
 *
 * Each test mutates the one construct it is about, so a passing assertion names the rule
 * rather than the fixture. The positive case is the fixture as written: an enterprise
 * document whose baseline is one version behind the prompt it names, whose eval records a
 * cost, and whose feedback store names the fields it redacts.
 */

import { describe, expect, it } from 'vitest';
import type { IrDiagnostic } from '../src/diagnostics.js';
import { runGates } from '../src/gates/index.js';
import { IR_DIAGNOSTIC_CODES } from '../src/index.js';
import type { IR } from '../src/shapes.js';
import { buildFixture, codesOf, mutateIR } from './helpers.js';

/** The single promotion or feedback diagnostic a mutation is expected to produce. */
function only(diagnostics: readonly IrDiagnostic[]): IrDiagnostic {
  const [head] = diagnostics;
  if (head === undefined || diagnostics.length !== 1) {
    throw new Error(`expected exactly one diagnostic, found ${String(diagnostics.length)}`);
  }
  return head;
}

const SPEC = 'v28-feedback-promotion.yaml';

function refundEval(ir: IR): IR['evals'][number] {
  const evalShape = ir.evals.find((candidate) => candidate.id === 'refund_exact');
  if (evalShape === undefined)
    throw new Error('expected the fixture to declare a refund_exact eval');
  return evalShape;
}

function promotionOf(ir: IR) {
  const promotion = refundEval(ir).gate.promotion;
  if (promotion === undefined)
    throw new Error('expected the fixture to declare a promotion policy');
  return promotion;
}

function feedbackOf(ir: IR) {
  const feedback = ir.observability.feedback;
  if (feedback === undefined) throw new Error('expected the fixture to declare a feedback intake');
  return feedback;
}

/** The promotion diagnostics alone, so an unrelated gate cannot satisfy an assertion. */
function promotionCodes(ir: IR): string[] {
  return codesOf(runGates(ir).byGate['evals/promotion'].diagnostics);
}

function feedbackCodes(ir: IR): string[] {
  return codesOf(runGates(ir).byGate.feedback.diagnostics);
}

describe('the 0.28 fixture', () => {
  it('builds the declared constructs into the IR', () => {
    const ir = buildFixture(SPEC).ir;
    const promotion = promotionOf(ir);
    expect(promotion.allowedQualityDrop).toBe(0.01);
    expect(promotion.allowedCostIncrease).toBe(0.1);
    expect(promotion.baseline).toEqual({ prompt: 'classify_claim', version: 1 });
    expect(promotion.approval?.record).toBe('app/approvals/classify-claim-2.md');

    const feedback = feedbackOf(ir);
    expect(feedback.signals.map((signal) => signal.id)).toEqual([
      'correction',
      'handoff',
      'rating',
    ]);
    expect(feedback.signals.map((signal) => signal.kind)).toEqual([
      'correction',
      'escalation',
      'thumbs',
    ]);
    expect(feedback.redact).toEqual(['email', 'phone']);
    expect(feedback.retentionDays).toBe(90);
    expect(feedback.persistent).toBe(true);
  });

  it('is clean: the baseline is behind the candidate and every control is declared', () => {
    const result = runGates(buildFixture(SPEC).ir);
    // The fixture is an excerpt and does not satisfy every gate (its tool has a write side
    // effect and no auth), so this asserts that these two gates have nothing to say about it
    // rather than that the whole document is clean.
    expect(result.byGate['evals/promotion'].diagnostics).toEqual([]);
    expect(result.byGate.feedback.diagnostics).toEqual([]);
    // Normalization is total, so a construct it silently dropped would show up here.
    expect(codesOf(result.diagnostics)).not.toContain(IR_DIAGNOSTIC_CODES.normalizationIncomplete);
  });

  it('serializes the promotion policy and the feedback intake', () => {
    const ir = buildFixture(SPEC).ir;
    expect(JSON.stringify(ir)).toContain('"allowedQualityDrop":0.01');
    expect(JSON.stringify(ir)).toContain('"retentionDays":90');
  });
});

describe('ir/prompt-version-stale', () => {
  it('refuses a baseline equal to the version the document declares', () => {
    const ir = mutateIR(SPEC);
    promotionOf(ir).baseline.version = 2;

    const diagnostic = only(runGates(ir).byGate['evals/promotion'].diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.promptVersionStale);
    expect(diagnostic.message).toContain('version 2 is the accepted baseline');
    expect(diagnostic.message).toContain('two different templates would share one identity');
    expect(diagnostic.path).toEqual([
      'evals',
      'refund_exact',
      'gate',
      'promotion',
      'baseline',
      'version',
    ]);
    expect(diagnostic.hint).toContain('bump prompts.classify_claim.version above 2');
  });

  it('refuses a baseline ahead of the document, which is a rollback rather than a promotion', () => {
    const ir = mutateIR(SPEC);
    promotionOf(ir).baseline.version = 5;

    const diagnostic = only(runGates(ir).byGate['evals/promotion'].diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.promptVersionStale);
    expect(diagnostic.message).toContain('behind the accepted baseline 5');
  });

  it('refuses a baseline naming a prompt the document does not declare', () => {
    const ir = mutateIR(SPEC);
    promotionOf(ir).baseline.prompt = 'nowhere';

    const diagnostic = only(runGates(ir).byGate['evals/promotion'].diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.refUnresolved);
    expect(diagnostic.message).toContain('baseline names prompt "nowhere"');
  });

  it('reports only the stale version, not the policy complaints underneath it', () => {
    // A candidate with no distinct identity has no quality allowance and no cost ceiling
    // worth discussing, so the reader gets one diagnostic and one fix.
    const ir = mutateIR(SPEC);
    promotionOf(ir).baseline.version = 2;
    refundEval(ir).metrics = [{ kind: 'latency', maxMs: 900 }];

    expect(promotionCodes(ir)).toEqual([IR_DIAGNOSTIC_CODES.promptVersionStale]);
  });
});

describe('ir/promotion-regression', () => {
  it('refuses an allowance that governs no quality metric', () => {
    const ir = mutateIR(SPEC);
    refundEval(ir).metrics = [{ kind: 'cost', max: 0.4 }];
    refundEval(ir).costBudget = 0.4;

    const diagnostic = only(runGates(ir).byGate['evals/promotion'].diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.promotionRegression);
    expect(diagnostic.message).toContain('measures no quality metric');
    expect(diagnostic.path).toEqual([
      'evals',
      'refund_exact',
      'gate',
      'promotion',
      'allowedQualityDrop',
    ]);
  });
});

describe('ir/promotion-cost', () => {
  it('refuses a cost allowance on an eval that declares no cost ceiling', () => {
    const ir = mutateIR(SPEC);
    refundEval(ir).metrics = [{ kind: 'exact', field: 'text' }];
    refundEval(ir).costBudget = undefined;

    const diagnostic = only(runGates(ir).byGate['evals/promotion'].diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.promotionCost);
    expect(diagnostic.message).toContain('declares no cost ceiling');
  });

  it('accepts a cost ceiling when the eval records a cost', () => {
    expect(promotionCodes(mutateIR(SPEC))).toEqual([]);
  });

  it('refuses a cost allowance no target in the build can measure', () => {
    // ts-vercel's manifest declares no `metrics`, so its runtime meters no spend and
    // `aid eval --compare` would have nothing to judge the allowance against.
    const ir = mutateIR(SPEC);
    ir.project.targets = ['ts-vercel'];

    const diagnostic = only(runGates(ir).byGate['evals/promotion'].diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.promotionCost);
    expect(diagnostic.message).toContain('no target in this build records metric spend');
    expect(diagnostic.hint).toContain('ts-vercel');
  });
});

describe('ir/promotion-approval', () => {
  it('refuses an enterprise promotion with no approval record', () => {
    const ir = mutateIR(SPEC);
    delete promotionOf(ir).approval;

    const diagnostic = only(runGates(ir).byGate['evals/promotion'].diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.promotionApproval);
    expect(diagnostic.message).toContain('profile "enterprise" requires a recorded approval');
    expect(diagnostic.hint).toContain('promote under `profile: standard`');
  });

  it('allows a standard-profile promotion with no approval record', () => {
    const ir = mutateIR(SPEC);
    ir.profile = 'standard';
    delete promotionOf(ir).approval;
    expect(promotionCodes(ir)).toEqual([]);
  });
});

describe('ir/feedback-pii', () => {
  it('refuses a persistent store with no retention limit', () => {
    const ir = mutateIR(SPEC);
    delete feedbackOf(ir).retentionDays;

    const diagnostic = only(runGates(ir).byGate.feedback.diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.feedbackPii);
    expect(diagnostic.message).toContain('kept indefinitely');
    expect(diagnostic.path).toEqual(['observability', 'feedback', 'retentionDays']);
  });

  it('refuses a text signal under a redaction set that misses a sensitive field', () => {
    const ir = mutateIR(SPEC);
    feedbackOf(ir).redact = ['phone'];

    const diagnostic = only(runGates(ir).byGate.feedback.diagnostics);
    expect(diagnostic.code).toBe(IR_DIAGNOSTIC_CODES.feedbackPii);
    expect(diagnostic.message).toContain('signal "correction"');
    expect(diagnostic.message).toContain('do not cover email');
    expect(diagnostic.hint).toContain('add email to observability.feedback.pii.redact');
  });

  it('does not apply the redaction rule to signals that carry no prose', () => {
    // A thumbs vote and an escalation are outcomes. Refusing them for an uncovered field
    // would make the cheapest honest signal the expensive one.
    const ir = mutateIR(SPEC);
    feedbackOf(ir).signals = [{ id: 'rating', kind: 'thumbs' }];
    feedbackOf(ir).redact = [];

    expect(feedbackCodes(ir)).toEqual([]);
  });

  it('does not apply the redaction rule to a transient store', () => {
    const ir = mutateIR(SPEC);
    feedbackOf(ir).persistent = false;
    feedbackOf(ir).redact = [];

    expect(feedbackCodes(ir)).toEqual([]);
  });

  it('accepts a persistent store that redacts the sensitive set', () => {
    expect(feedbackCodes(mutateIR(SPEC))).toEqual([]);
  });
});
