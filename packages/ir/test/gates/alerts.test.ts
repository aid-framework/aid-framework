import { describe, expect, it } from 'vitest';

import {
  ALERT_METRICS,
  buildDeployPlan,
  type DeployAlarm,
  IR_DIAGNOSTIC_CODES,
  runGates,
} from '../../src/index.js';
import { buildFixture, codesOf, gateFixture, mutateIR, onlyDiagnosticWith } from '../helpers.js';

const ALERTS = 'v30-alerts.yaml';
const BEFORE = 'v27-observability.yaml';

function alertsGate(ir: ReturnType<typeof mutateIR>) {
  return runGates(ir).byGate['observability/alerts'];
}

describe('alert metrics', () => {
  it('names exactly the series the deploy plan derives', () => {
    // The compile-time half of this pin: a metric added to `DeployAlarm` without a line
    // here fails to typecheck, and a line here without a derived series fails below.
    // Without both halves an alert could watch a series nothing produces, which reports
    // no data -- and no data reads as healthy.
    const derived: Record<DeployAlarm['metric'], true> = {
      'agent.cost': true,
      'agent.tokens': true,
      'eval.cost': true,
      'eval.latency.p95': true,
    };
    expect([...ALERT_METRICS].sort()).toEqual(Object.keys(derived).sort());
  });

  it('excludes the two series the runtime records as events, not measurements', () => {
    // Guardrail hits and approval latency are span events. No metric derivation reads
    // events, so an alert over either is expressible and permanently silent; the schema
    // closes the enum rather than offering a knob that cannot page anyone.
    expect([...ALERT_METRICS]).not.toContain('guardrail.hit');
    expect([...ALERT_METRICS]).not.toContain('hitl.approval.latency.p95');
  });
});

describe('alerts gate', () => {
  it('accepts a document whose alerts watch exported series', () => {
    expect(alertsGate(mutateIR(ALERTS)).diagnostics).toEqual([]);
    expect(gateFixture(ALERTS).byGate['observability/alerts'].diagnostics).toEqual([]);
  });

  it('reads the declared alerts into the IR in id order', () => {
    const { observability } = buildFixture(ALERTS).ir;
    expect(observability.alerts?.map((alert) => alert.id)).toEqual([
      'adjudicator_cost',
      'adjudicator_tokens',
      'fleet_eval_spend',
      'refund_latency',
    ]);
  });

  it('keeps an absent source absent, so it means the whole environment', () => {
    const { observability } = buildFixture(ALERTS).ir;
    const fleet = observability.alerts?.find((alert) => alert.id === 'fleet_eval_spend');
    expect(fleet?.source).toBeUndefined();
    expect(alertsGate(mutateIR(ALERTS)).diagnostics).toEqual([]);
  });

  it('refuses alerts on a document that exports nothing', () => {
    const ir = mutateIR(ALERTS);
    ir.observability.export = 'none';
    const diagnostic = onlyDiagnosticWith(
      alertsGate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.alertsUnexported,
    );
    expect(diagnostic.path).toEqual(['observability', 'alerts']);
    expect(diagnostic.message).toContain('4 alert(s) are declared');
    expect(diagnostic.message).toContain('report no data forever');
    expect(diagnostic.hint).toContain('export: otlp');
    expect(diagnostic.hint).toContain('remove the alerts block');
  });

  it('names the export it found, so the fix does not need a second lookup', () => {
    const ir = mutateIR(ALERTS);
    delete ir.observability.export;
    delete ir.observability.endpointEnv;
    const diagnostic = onlyDiagnosticWith(
      alertsGate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.alertsUnexported,
    );
    expect(diagnostic.message).toContain('exports nothing');
  });

  it('reports one refusal for the missing export, not one per alert', () => {
    const ir = mutateIR(ALERTS);
    ir.observability.export = 'none';
    // The four alerts share one cause, so four copies of the same fix would bury it.
    expect(alertsGate(ir).diagnostics).toHaveLength(1);
  });

  it('refuses a quantity reduction over a latency series', () => {
    const ir = mutateIR(ALERTS);
    const latency = ir.observability.alerts?.find((alert) => alert.id === 'refund_latency');
    if (latency === undefined) throw new Error('fixture lost refund_latency');
    latency.aggregate = 'sum';
    const diagnostic = onlyDiagnosticWith(
      alertsGate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.alertsAggregate,
    );
    expect(diagnostic.path).toEqual(['observability', 'alerts', 'refund_latency', 'aggregate']);
    expect(diagnostic.message).toContain('`aggregate: sum` cannot interpret metric');
    expect(diagnostic.hint).toContain('use `aggregate: p95`');
  });

  it('refuses a percentile over a quantity', () => {
    const ir = mutateIR(ALERTS);
    const cost = ir.observability.alerts?.find((alert) => alert.id === 'adjudicator_cost');
    if (cost === undefined) throw new Error('fixture lost adjudicator_cost');
    cost.aggregate = 'p95';
    const diagnostic = onlyDiagnosticWith(
      alertsGate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.alertsAggregate,
    );
    expect(diagnostic.path).toEqual(['observability', 'alerts', 'adjudicator_cost', 'aggregate']);
    expect(diagnostic.hint).toContain('a percentile of it has no definition');
  });

  it('accepts every quantity reduction over a quantity series', () => {
    for (const aggregate of ['sum', 'average', 'max'] as const) {
      const ir = mutateIR(ALERTS);
      const cost = ir.observability.alerts?.find((alert) => alert.id === 'adjudicator_cost');
      if (cost === undefined) throw new Error('fixture lost adjudicator_cost');
      cost.aggregate = aggregate;
      expect(alertsGate(ir).diagnostics).toEqual([]);
    }
  });

  it('refuses a source that names nothing in the document', () => {
    const ir = mutateIR(ALERTS);
    const cost = ir.observability.alerts?.find((alert) => alert.id === 'adjudicator_cost');
    if (cost === undefined) throw new Error('fixture lost adjudicator_cost');
    cost.source = 'nowhere';
    const diagnostic = onlyDiagnosticWith(
      alertsGate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.alertsSource,
    );
    expect(diagnostic.path).toEqual(['observability', 'alerts', 'adjudicator_cost', 'source']);
    expect(diagnostic.message).toContain('the series it watches never carries that label');
    expect(diagnostic.hint).toContain('omit `source` to watch the whole environment');
  });

  it('resolves a source against agents and evals alike', () => {
    const ir = mutateIR(ALERTS);
    const latency = ir.observability.alerts?.find((alert) => alert.id === 'refund_latency');
    if (latency === undefined) throw new Error('fixture lost refund_latency');
    // `refund_exact` is an eval id, `claims_adjudicator` an agent id; both are legal.
    expect(alertsGate(ir).diagnostics).toEqual([]);
  });

  it('leaves a document from before 0.30 untouched', () => {
    const ir = mutateIR(BEFORE);
    expect(ir.observability.alerts).toBeUndefined();
    expect(alertsGate(ir).diagnostics).toEqual([]);
  });

  it('skips the rule on a downgraded document, which cannot spell an alert at all', () => {
    // A 0.29 document has no `alerts` key, so demanding OTLP for one would refuse a
    // document for a feature it never used.
    const ir = mutateIR(ALERTS);
    ir.specVersion = '0.29';
    ir.observability.export = 'none';
    expect(alertsGate(ir).diagnostics).toEqual([]);
  });

  it('is registered, so `aid gen` actually reaches it', () => {
    const ir = mutateIR(ALERTS);
    ir.observability.export = 'none';
    expect(codesOf(runGates(ir).diagnostics)).toContain(IR_DIAGNOSTIC_CODES.alertsUnexported);
  });
});

describe('alerts in the deploy plan', () => {
  it('carries the threshold, window and aggregate a module needs', () => {
    const plan = buildDeployPlan(buildFixture(ALERTS).ir);
    expect(plan.alerts.map((alert) => alert.id)).toEqual([
      'adjudicator_cost',
      'adjudicator_tokens',
      'fleet_eval_spend',
      'refund_latency',
    ]);
    const cost = plan.alerts.find((alert) => alert.id === 'adjudicator_cost');
    expect(cost).toEqual({
      id: 'adjudicator_cost',
      metric: 'agent.cost',
      window: '15m',
      aggregate: 'sum',
      threshold: 25,
      unit: 'usd',
      source: 'claims_adjudicator',
    });
  });

  it('derives the unit from the metric rather than trusting the author', () => {
    const plan = buildDeployPlan(buildFixture(ALERTS).ir);
    const units = Object.fromEntries(plan.alerts.map((alert) => [alert.id, alert.unit]));
    expect(units).toEqual({
      adjudicator_cost: 'usd',
      adjudicator_tokens: 'tokens',
      fleet_eval_spend: 'usd',
      refund_latency: 'ms',
    });
  });

  it('is empty for a document from before 0.30 rather than optional', () => {
    // An emitter reads `plan.alerts` without a presence check; the empty list keeps the
    // emitted tree byte-identical for every earlier document.
    expect(buildDeployPlan(buildFixture(BEFORE).ir).alerts).toEqual([]);
  });

  it('stays separate from the budget alarms, which carry no threshold', () => {
    const plan = buildDeployPlan(buildFixture(ALERTS).ir);
    // The agent declares a cost budget, so a budget alarm exists; the four declared
    // alerts are a different list answering a different question.
    expect(plan.alarms.map((alarm) => alarm.metric)).toEqual(['agent.cost']);
    expect(plan.alerts).toHaveLength(4);
  });

  it('survives normalization, so the whole document reaches the generators', () => {
    // The normalize gate re-derives every default and reports any key the builder left
    // out or the normalizer dropped. An `alerts` block the normalizer forgot fails here
    // rather than passing every gate and vanishing before the emitter sees it.
    const ir = buildFixture(ALERTS).ir;
    const diagnostics = runGates(ir).diagnostics.filter(
      (diagnostic) => diagnostic.code === IR_DIAGNOSTIC_CODES.normalizationIncomplete,
    );
    expect(diagnostics).toEqual([]);
    expect(ir.observability.alerts).toHaveLength(4);
  });
});
