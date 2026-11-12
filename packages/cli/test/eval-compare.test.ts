/**
 * `aid eval --compare` is the promotion decision, and the thing worth testing is that it is
 * a decision rather than a report: it reads two committed baselines, applies the allowance
 * the spec declares, and exits non-zero when the candidate lost more than the author said it
 * may.
 *
 * The fixture is the committed example with a promotion policy bolted on, because the
 * example is the only spec already known to pass every gate, and `aid eval` lowers the spec
 * before it does anything -- a hand-written minimal document would have to satisfy the
 * capability, cost and eval-coverage gates to reach the code under test. Each patch is
 * asserted to have applied, so a spec change that moves the anchors fails here loudly
 * instead of quietly comparing nothing.
 *
 * Nothing is generated here on purpose: comparing two baselines must work on a checkout that
 * has no generated tree, because the candidate side is usually a branch.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { aid, diagnosticsOf, EXAMPLE_SPEC, type Project, project } from './helpers.js';

const created: Project[] = [];

afterAll(() => {
  for (const made of created) made.close();
});

/** Applies one patch, failing the fixture rather than silently testing an unpatched spec. */
function patched(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture anchor is gone: ${from}`);
  return text.replace(from, to);
}

const PROMOTION = [
  '      promotion:',
  '        allowedQualityDrop: 0.01',
  '        baseline:',
  '          prompt: classify_ticket',
  '          version: 1',
].join('\n');

/**
 * The example with a promotion policy on its first eval.
 *
 * `classify_ticket` is bumped to version 2 because the gate refuses a policy whose baseline
 * is not behind the prompt it names -- a candidate that has not bumped the prompt has no
 * candidate at all. The policy is inserted into the first eval only, so one document yields
 * one possible verdict and `--suite` stays optional.
 */
function promotableSpec(options: { readonly withApproval?: boolean } = {}): string {
  let text = patched(EXAMPLE_SPEC, 'specVersion: "0.27"', 'specVersion: "0.28"');
  text = patched(text, '  classify_ticket:\n    version: 1', '  classify_ticket:\n    version: 2');

  const marker = '\n  handbook_quality:';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('fixture anchor is gone: handbook_quality');
  const head = text.slice(0, at).replace('      samples: 5', `      samples: 5\n${PROMOTION}`);
  const withPolicy = head + text.slice(at);

  if (options.withApproval !== true) return withPolicy;
  return patched(
    withPolicy,
    '        allowedQualityDrop: 0.01',
    '        allowedQualityDrop: 0.01\n        approval:\n          by: [release-manager]\n          record: approvals/classify-2.md',
  );
}

interface BaselinePayload {
  readonly dataset?: string;
  readonly dataset_version?: string;
  readonly model?: string;
  readonly metrics?: readonly { metric: string; runs: number; mean: number; stdev: number }[];
}

/** The shape both runtimes write, with the one thing a caller varies: the quality score. */
function baseline(mean: number, overrides: BaselinePayload = {}): string {
  return JSON.stringify(
    {
      dataset: 'evals/classify_quality.json',
      dataset_version: '1',
      model: 'fast',
      metrics: [{ metric: 'json-schema', runs: 5, mean, stdev: 0.004 }],
      note: '',
      ...overrides,
    },
    null,
    2,
  );
}

const ACCEPTED = 'accepted.baseline.json';
const CANDIDATE = 'candidate.baseline.json';

/**
 * A project with a promotion policy and two baselines already on disk.
 *
 * `accepted` is the score the policy was written against. `candidate` is what the branch
 * recorded; the whole question is whether the difference between them fits the allowance.
 */
function compared(options: { accepted?: number; candidate?: number; withApproval?: boolean } = {}) {
  const made = project(promotableSpec({ withApproval: options.withApproval === true }));
  created.push(made);
  writeFileSync(join(made.root, ACCEPTED), baseline(options.accepted ?? 0.95), 'utf8');
  writeFileSync(join(made.root, CANDIDATE), baseline(options.candidate ?? 0.945), 'utf8');
  return made;
}

/** The human-readable report, which is what a person reads before approving a promotion. */
function compareText(made: Project) {
  return aid(made, ['eval', '--compare', ACCEPTED, '--candidate', CANDIDATE]);
}

/** The same run under `--json`, which is how a diagnostic code is asserted. */
function compare(made: Project) {
  return aid(made, ['eval', '--compare', ACCEPTED, '--candidate', CANDIDATE, '--json']);
}

describe('aid eval --compare', () => {
  it('promotes a candidate that lost less than the declared allowance', () => {
    const run = compareText(compared({ accepted: 0.95, candidate: 0.945 }));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('verdict: promotable');
  });

  it('refuses a candidate that lost more than the declared allowance', () => {
    const made = compared({ accepted: 0.95, candidate: 0.9 });
    const run = compare(made);
    expect(run.code).toBe(1);
    const refused = diagnosticsOf(run).find(
      (diagnostic) => diagnostic.code === 'cli/eval-compare-regressed',
    );
    // The number matters as much as the refusal: a gate whose message does not say how far
    // the candidate fell leaves the author guessing at the allowance.
    expect(refused?.message).toContain('metric "json-schema" dropped 5.00%');
    expect(refused?.message).toContain('allowedQualityDrop on "classify_quality" is 1.00%');
    expect(compareText(made).stdout).toContain('verdict: refused');
  });

  it('names the metric and the allowance in the report, not only in the diagnostic', () => {
    const run = compareText(compared({ accepted: 0.95, candidate: 0.9 }));
    expect(run.stdout).toContain('FAIL json-schema');
    expect(run.stdout).toContain('allowance 1.00%');
  });

  it('does not need a generated tree, because the evidence is two files', () => {
    // `--compare` short-circuits before the module check; without that, this project (which
    // has never been generated) would fail with `cli/eval-modules-missing` instead of
    // answering the question it was asked.
    const run = compare(compared());
    expect(run.code).toBe(0);
    expect(diagnosticsOf(run).map((diagnostic) => diagnostic.code)).not.toContain(
      'cli/eval-modules-missing',
    );
  });

  it('refuses to compare two datasets', () => {
    const made = project(promotableSpec());
    created.push(made);
    writeFileSync(join(made.root, ACCEPTED), baseline(0.95), 'utf8');
    writeFileSync(join(made.root, CANDIDATE), baseline(0.95, { dataset_version: '2' }), 'utf8');

    const run = compare(made);
    // Exit 2: nothing was judged. A number computed across two datasets would be a verdict
    // about nothing, which is the approximation the framework refuses rather than performs.
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((diagnostic) => diagnostic.code)).toContain(
      'cli/eval-compare-mismatch',
    );
  });

  it('refuses a baseline that is not a baseline', () => {
    const made = project(promotableSpec());
    created.push(made);
    writeFileSync(join(made.root, ACCEPTED), '{ "metrics": [] }', 'utf8');
    writeFileSync(join(made.root, CANDIDATE), baseline(0.945), 'utf8');

    const run = compare(made);
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((diagnostic) => diagnostic.code)).toContain(
      'cli/eval-compare-unreadable',
    );
  });

  it('refuses to invent a policy when the spec declares none', () => {
    // The unpatched example has the same evals and no `gate.promotion`, so this is the
    // refusal a project without a declared allowance gets.
    const made = project();
    created.push(made);
    writeFileSync(join(made.root, ACCEPTED), baseline(0.95), 'utf8');
    writeFileSync(join(made.root, CANDIDATE), baseline(0.945), 'utf8');

    const run = compare(made);
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((diagnostic) => diagnostic.code)).toContain(
      'cli/eval-compare-no-policy',
    );
  });

  it('refuses --compare without the other half of the pair', () => {
    const made = compared();
    const run = aid(made, ['eval', '--compare', ACCEPTED, '--json']);
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((diagnostic) => diagnostic.code)).toContain(
      'cli/eval-compare-pair-required',
    );
  });

  it('says the cost ceiling was not judged, instead of passing it silently', () => {
    // No runtime measures a cost metric, so a baseline carries quality scores only. The
    // warning is the honest form of the check the policy asked for.
    const made = compared();
    const specPath = join(made.root, 'app', 'app.spec.yaml');
    // A cost ceiling is only coherent on an eval that records a cost metric, which the
    // promotion gate enforces; declaring the metric is what a real document would do.
    writeFileSync(
      specPath,
      promotableSpec()
        .replace(
          '        allowedQualityDrop: 0.01',
          '        allowedQualityDrop: 0.01\n        allowedCostIncrease: 0.1',
        )
        .replace(
          '      - kind: json-schema\n        schema: Answer',
          '      - kind: json-schema\n        schema: Answer\n      - kind: cost\n        max: 0.4',
        ),
      'utf8',
    );

    const run = compare(made);
    expect(run.code).toBe(0);
    expect(diagnosticsOf(run).map((diagnostic) => diagnostic.code)).toContain(
      'cli/eval-compare-cost-unjudged',
    );
  });

  it('refuses a promotion whose required approval is not in the tree', () => {
    const made = compared({ withApproval: true });
    const run = compare(made);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).map((diagnostic) => diagnostic.code)).toContain(
      'cli/eval-compare-approval-missing',
    );
  });

  it('promotes under an approval policy once the record exists', () => {
    const made = compared({ withApproval: true });
    mkdirSync(join(made.root, 'approvals'), { recursive: true });
    writeFileSync(join(made.root, 'approvals', 'classify-2.md'), '# Approved\n', 'utf8');

    const run = compareText(made);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('verdict: promotable');
  });
});
