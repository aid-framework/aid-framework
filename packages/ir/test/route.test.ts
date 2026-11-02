/**
 * The `route` step end to end at layer 1: spec acceptance, the shape it occupies in the
 * IR, and the references the gate resolves. A route is a composite whose arms are
 * alternatives, so the tests also pin the one rule that makes it different from
 * `parallel`: a name bound by two arms is sound because exactly one arm runs.
 */

import { checkSpecText } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { type IR, IR_DIAGNOSTIC_CODES, type RouteStep, runGates } from '../src/index.js';
import { buildFixture, byId, codesOf, diagnosticAt, fixtureText, mutateIR } from './helpers.js';

const SPEC = 'route.yaml';
const DEFAULT_SPEC = 'route-default.yaml';

/** The route step in the pipeline the fixture declares, asserted to be one. */
function routeStepOf(ir: IR): RouteStep {
  const step = byId(ir.pipelines, 'triage').steps[1];
  if (step?.kind !== 'route') throw new Error('the second step is not a route');
  return step;
}

describe('route surface, spec to IR', () => {
  it('accepts both route specs at the spec layer', () => {
    for (const name of [SPEC, DEFAULT_SPEC]) {
      const checked = checkSpecText(fixtureText(name), { file: name });
      expect(checked.ok, name).toBe(true);
      expect(checked.diagnostics).toEqual([]);
    }
  });

  it('builds the decision, the classified template and the label binding', () => {
    expect(routeStepOf(buildFixture(SPEC).ir)).toMatchObject({
      kind: 'route',
      decision: 'topic',
      input: '{{plan}}',
      as: 'path',
    });
  });

  it('maps every label the decision can return when there is no default', () => {
    const step = routeStepOf(buildFixture(SPEC).ir);

    expect(Object.keys(step.on).sort()).toEqual(['billing', 'off_topic', 'product']);
    expect(step.default).toBeUndefined();
  });

  it('keeps each arm as the steps that answer its label', () => {
    const step = routeStepOf(buildFixture(SPEC).ir);

    for (const label of ['product', 'billing', 'off_topic']) {
      expect(step.on[label]).toEqual([
        {
          kind: 'generate',
          prompt: 'reply',
          model: 'fast',
          input: {
            subject:
              label === 'off_topic'
                ? { kind: 'literal', value: 'This request was off topic' }
                : { kind: 'reference', path: ['plan'] },
          },
          as: 'reply',
        },
      ]);
    }
  });

  it('builds the default arm for a label the mapping leaves out', () => {
    const step = routeStepOf(buildFixture(DEFAULT_SPEC).ir);

    expect(Object.keys(step.on).sort()).toEqual(['billing', 'product']);
    expect(step.default).toEqual([
      {
        kind: 'generate',
        prompt: 'reply',
        model: 'fast',
        input: { subject: { kind: 'literal', value: 'This request is not about the product' } },
        as: 'reply',
      },
    ]);
  });

  it('adds no capability of its own', () => {
    // The route is served by the decision layer, which the target already declares by
    // accepting `http-trigger`/`otel`; a route that demanded its own capability would
    // fail every existing target for no reason.
    expect([...buildFixture(SPEC).ir.requiredCapabilities].sort()).toEqual([
      'http-trigger',
      'otel',
    ]);
  });
});

describe('route references the gate resolves', () => {
  it('does not flag a name bound by more than one arm', () => {
    // Both mapped arms bind `reply`; exactly one arm runs, so the merge is sound and the
    // same rule that makes a `branch` legal applies here. `parallel` is the kind that
    // refuses this, and the absence of its code is the assertion.
    const result = runGates(buildFixture(SPEC).ir);

    expect(codesOf(result.diagnostics)).not.toContain(IR_DIAGNOSTIC_CODES.bindingDuplicate);
  });

  it('rejects a route naming an undeclared decision', () => {
    const ir = mutateIR(SPEC);
    routeStepOf(ir).decision = 'nowhere';

    const result = runGates(ir);

    expect(codesOf(result.diagnostics)).toContain(IR_DIAGNOSTIC_CODES.refUnresolved);
    expect(
      diagnosticAt(result.diagnostics, 'pipelines.triage.steps.1.route.decision').message,
    ).toContain('no decision named "nowhere"');
  });

  it('rejects a route input that reaches into its own arms', () => {
    // `reply` is bound inside the arms, so it exists in the pipeline but is not visible
    // where the route is asked: a route cannot classify text its arms have not produced.
    const ir = mutateIR(SPEC);
    routeStepOf(ir).input = '{{reply}}';

    const result = runGates(ir);

    expect(codesOf(result.diagnostics)).toContain(IR_DIAGNOSTIC_CODES.bindingForwardReference);
    expect(
      diagnosticAt(result.diagnostics, 'pipelines.triage.steps.1.route.input').message,
    ).toContain('"reply" is bound by a later step');
  });

  it('leaves a mapped default arm reachable for the labels it catches', () => {
    const result = runGates(buildFixture(DEFAULT_SPEC).ir);

    expect(
      result.diagnostics.filter(
        (diagnostic) => diagnostic.path.join('.') === 'pipelines.triage.steps.1.route.default',
      ),
    ).toEqual([]);
  });
});
