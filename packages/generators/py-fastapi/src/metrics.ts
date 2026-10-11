/**
 * The IR's eval metric vocabulary mapped onto the runtime's metrics.
 *
 * The mapping is deliberately partial. The runtime ships four metrics, and four of
 * the IR's eight kinds have no runtime implementation in Phase 0, so they are
 * *rejected* rather than silently dropped: a metric that is declared but not measured
 * makes a baseline report a passing gate over an unmeasured claim, which is worse than
 * refusing to generate. The same reasoning rejects the parts of a supported metric the
 * runtime cannot see -- `ExactMatch` and `NormalizedContains` compare the whole
 * prediction against the case's `expected`, so a `field` selector would be ignored.
 *
 * Everything here is pure: the table is data, so every branch (including the rejection
 * messages) is reachable from a unit test.
 */

import type { EvalShape, MetricShape, TypeRef } from '@aid/ir';

import { pythonString } from './python.js';

export type MetricMapping =
  | {
      readonly measured: true;
      readonly name: string;
      readonly deterministic: boolean;
      /** The Python expression constructing the runtime metric. */
      readonly expression: string;
    }
  | { readonly measured: false; readonly reason: string };

/** How the runtime measures one IR metric. */
export function mapMetric(metric: MetricShape): MetricMapping {
  switch (metric.kind) {
    case 'exact':
      if (metric.field !== '') {
        return {
          measured: false,
          reason:
            'the runtime compares the whole prediction against the case expected value, so a ' +
            'field selector would be silently ignored',
        };
      }
      return {
        measured: true,
        name: 'exact-match',
        deterministic: true,
        expression: 'ExactMatch()',
      };
    case 'contains':
      if (metric.value !== undefined) {
        return {
          measured: false,
          reason:
            'the runtime contains metric looks for the case expected value inside the prediction, ' +
            'so a literal value would be silently ignored',
        };
      }
      if (metric.field !== '') {
        return {
          measured: false,
          reason:
            'the runtime contains metric searches the whole prediction, so a field selector would ' +
            'be silently ignored',
        };
      }
      return {
        measured: true,
        name: 'contains',
        deterministic: true,
        expression: 'NormalizedContains()',
      };
    case 'json-schema':
      return {
        measured: true,
        name: 'json-valid',
        deterministic: true,
        expression: 'JsonSchemaValid()',
      };
    case 'llm-judge':
      if (metric.field !== undefined) {
        return {
          measured: false,
          reason: 'the runtime judge scores the whole prediction, so a field selector cannot apply',
        };
      }
      if (metric.threshold !== undefined) {
        return {
          measured: false,
          reason: 'the runtime judge passes at a fixed score of 0.5, so a threshold cannot apply',
        };
      }
      if (metric.model === undefined || metric.model === '') {
        return {
          measured: false,
          reason: 'an llm-judge metric must name the model alias that judges',
        };
      }
      return {
        measured: true,
        name: 'llm-judge',
        deterministic: false,
        expression: `LlmJudge(judge_call, rubric=${pythonString(metric.rubric)})`,
      };
    case 'cost':
      return {
        measured: false,
        reason:
          'the runtime has no cost metric; cost ceilings belong to ModelGateway budgets, which a ' +
          'generated eval does not wire',
      };
    case 'latency':
      return {
        measured: false,
        reason: 'the runtime has no latency metric; a p95 budget is a declared Phase 0 deferral',
      };
    case 'tool-trace':
      return {
        measured: false,
        reason: 'the runtime records tool calls but no metric compares them',
      };
    case 'retrieval':
      return {
        measured: false,
        reason:
          'the runtime has no retrieval metric; a retrieval eval measures a retriever this ' +
          'target does not ship',
      };
  }
}

/** The distinct runtime metric names an eval measures, sorted. */
export function measuredMetrics(evaluation: EvalShape): string[] {
  const names = new Set<string>();
  for (const metric of evaluation.metrics) {
    const mapping = mapMetric(metric);
    if (mapping.measured) names.add(mapping.name);
  }
  return [...names].sort();
}

/** One measured metric: its runtime name, whether it is deterministic, and how to build it. */
export interface MetricBinding {
  readonly name: string;
  readonly deterministic: boolean;
  readonly expression: string;
}

/**
 * The metrics to instantiate, in sorted metric-name order.
 *
 * Two IR metrics may map onto the same runtime metric (an `exact` and a `contains` both
 * mean "compare the text"); the runtime keys metrics by name, so the first declaration
 * wins and the duplicate is dropped -- otherwise the registry would raise on the
 * duplicate name at import time.
 */
export function metricBindings(evaluation: EvalShape): MetricBinding[] {
  const byName = new Map<string, MetricBinding>();
  for (const metric of evaluation.metrics) {
    const mapping = mapMetric(metric);
    if (!mapping.measured) continue;
    if (!byName.has(mapping.name)) {
      byName.set(mapping.name, {
        name: mapping.name,
        deterministic: mapping.deterministic,
        expression: mapping.expression,
      });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The metric expressions to instantiate, in sorted metric-name order. */
export function metricExpressions(evaluation: EvalShape): string[] {
  return metricBindings(evaluation).map((binding) => binding.expression);
}

/**
 * The measured metrics a gate may threshold on.
 *
 * The runtime refuses to threshold on a model-backed metric (`BaselineGate` cannot
 * distinguish a regression from sampling noise in a judge), so these are exactly the
 * metrics a `Threshold` may name -- and therefore the ones every eval must declare at
 * least one of.
 */
export function deterministicMetrics(evaluation: EvalShape): MetricBinding[] {
  return metricBindings(evaluation).filter((binding) => binding.deterministic);
}

/** Whether the eval's metrics need the LLM judge, and therefore a gateway alias. */
export function usesJudge(evaluation: EvalShape): boolean {
  return evaluation.metrics.some((metric) => metric.kind === 'llm-judge');
}

/**
 * The schema a `json-schema` metric validates against.
 *
 * `JsonSchemaValid` reads the schema from `case.metadata["json_schema"]`, so the
 * generated eval injects this type's JSON schema into every case; the IR declares it
 * once and the dataset file does not repeat it.
 */
export function jsonSchemaMetric(evaluation: EvalShape): TypeRef | undefined {
  for (const metric of evaluation.metrics) {
    if (metric.kind === 'json-schema') return metric.schema;
  }
  return undefined;
}

/** The declared model alias an `llm-judge` metric judges with. */
export function judgeAlias(evaluation: EvalShape): string | undefined {
  for (const metric of evaluation.metrics) {
    if (metric.kind === 'llm-judge') return metric.model;
  }
  return undefined;
}
