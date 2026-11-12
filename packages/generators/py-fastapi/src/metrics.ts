/**
 * The IR's eval metric vocabulary mapped onto the runtime's metrics.
 *
 * The mapping is partial in its kinds and in its options. Of the IR's ten kinds, every one
 * reaches a runtime metric, but `tool-trace` reaches one only when the eval runs an agent:
 * a prompt or pipeline response has no calls to compare, so the mapping refuses there rather
 * than emitting a metric that raises on its first case. And a declaration the runtime cannot
 * honour is *rejected* rather than silently dropped, because a metric that is declared but
 * not measured makes a baseline report a passing gate over an unmeasured claim, which is
 * worse than refusing to generate -- and every rejection carries its reason.
 * `cost` and `latency` are measured from the numbers the harness already collects around
 * each case; `tool-trace` is measured from the `Trajectory` only the agent runner reports.
 *
 * `retrieval` is measured, but not by the prediction-per-case harness: the runtime scores
 * a ranked, cited retrieved set with `RetrievalGate` over the family `retrieval_metrics`
 * builds, so its mapping names the IR kind rather than one runtime metric -- the runtime
 * names those itself, and the generated thresholds are built from the metric objects so
 * the two cannot drift. `expectDocs` and `k` reach the runtime through `RetrievalCase`,
 * which is why the expression takes no arguments. Because that harness is not the
 * prediction-per-case one, an eval that declares `retrieval` alongside a prediction metric
 * is refused in `checkEvals` rather than half-measured.
 *
 * The same reasoning rejects the parts of a supported metric the runtime cannot see -- `ExactMatch` and `NormalizedContains` compare the whole
 * prediction against the case's `expected`, so a `field` selector would be ignored.
 *
 * Everything here is pure: the table is data, so every branch (including the rejection
 * messages) is reachable from a unit test.
 */

import type { EvalShape, MetricShape, TypeRef } from '@aid-framework/ir';

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

/**
 * What about the eval decides whether a metric can be measured.
 *
 * Currently one thing: a trajectory is observable only when the case ran an agent, because
 * only the agent runner reports the calls it made. Everything else is a property of the
 * metric declaration alone.
 */
export interface MetricMappingOptions {
  /** Whether the eval runs an agent, which is what makes a trajectory observable. */
  readonly agent?: boolean;
}

/**
 * The module constant a generated agent eval carries its expected tool calls in.
 *
 * The expectation is hoisted out of the metric expression rather than inlined because a
 * tool name is arbitrary in length: `ToolTrace(expect=("a", "b", ...))` grows with the
 * list, and `pythonTuple` never wraps, so a spec with a handful of tools would emit a line
 * `ruff format` rewrites -- which is a failing CI check on generated output rather than a
 * cosmetic difference. The name lives here so the mapper and the emitter that writes the
 * constant cannot disagree about it.
 */
export const TOOL_TRACE_EXPECT = 'EXPECT_TOOLS';

/** How the runtime measures one IR metric. */
export function mapMetric(metric: MetricShape, options: MetricMappingOptions = {}): MetricMapping {
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
      // The harness already reads the gateway ledger around each case, so the declared
      // ceiling is enforced as a per-case budget rather than a separate accounting pass.
      return {
        measured: true,
        name: 'cost',
        deterministic: true,
        expression: `CostCeiling(max_usd=${metric.max})`,
      };
    case 'latency':
      return {
        measured: true,
        name: 'latency',
        deterministic: true,
        expression: `LatencyCeiling(max_ms=${metric.maxMs})`,
      };
    case 'tool-trace':
      // A trajectory is observable only through the agent runner: it is the one generated
      // runner that returns the calls a case made. A prompt or pipeline response has no tool
      // calls, so emitting the metric there would produce a module that raises on its first
      // case -- and `ir/eval-trajectory` refuses that spec before generation for the same
      // reason, which is why the two messages name the same missing half.
      if (options.agent !== true) {
        return {
          measured: false,
          reason:
            'no generated runner reports the tool calls a case made, so the runtime trace metric ' +
            'would have no trajectory to compare; an agent run does report them, so score the ' +
            'agent with a `target: agent:<id>` eval',
        };
      }
      return {
        measured: true,
        name: 'tool-trace',
        deterministic: true,
        expression: `ToolTrace(expect=${TOOL_TRACE_EXPECT}, ordered=${metric.ordered ? 'True' : 'False'})`,
      };
    case 'retrieval':
      return {
        measured: true,
        name: 'retrieval',
        deterministic: true,
        expression: 'retrieval_metrics()',
      };
    case 'decision':
      return {
        measured: true,
        name: 'decision',
        deterministic: false,
        // The decision travels as a module constant (`SCORE_DECISION`), so the generated
        // eval carries the rubric the spec declared and asks the vendor the same question
        // the guardrail path would. No floor: a model-produced score is reported, and
        // `BaselineGate` refuses to gate on it.
        expression: 'DecisionScore(SCORE_DECISION)',
      };
    case 'assert':
      return {
        measured: true,
        name: 'assert',
        deterministic: true,
        // The parsed AST lives in a module-level constant (`ASSERT_EXPR`), so the
        // predicate travels as data and the generated eval needs no parser of its own
        // and cannot drift from the one that validated it. Hoisting it also keeps the
        // emission a single short line whatever the expression's depth.
        expression: `AssertMetric(expr=ASSERT_EXPR, message=${pythonString(metric.message)})`,
      };
  }
}

/**
 * Whether this eval is measured by the retrieval harness rather than the
 * prediction-per-case one.
 *
 * True when the eval declares at least one metric and every one of them is `retrieval`:
 * the retrieval harness drives `RetrievalGate` over a ranked retrieved set, which does not
 * compose with a prediction-per-case run, so `checkEvals` refuses an eval that declares a
 * retrieval metric alongside another kind. This is therefore either all or nothing, and
 * the emitter can branch on it.
 */
export function isRetrievalEval(evaluation: EvalShape): boolean {
  return (
    evaluation.metrics.length > 0 &&
    evaluation.metrics.every((metric) => metric.kind === 'retrieval')
  );
}

/** The distinct runtime metric names an eval measures, sorted. */
export function measuredMetrics(
  evaluation: EvalShape,
  options: MetricMappingOptions = {},
): string[] {
  const names = new Set<string>();
  for (const metric of evaluation.metrics) {
    const mapping = mapMetric(metric, options);
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
export function metricBindings(
  evaluation: EvalShape,
  options: MetricMappingOptions = {},
): MetricBinding[] {
  const byName = new Map<string, MetricBinding>();
  for (const metric of evaluation.metrics) {
    const mapping = mapMetric(metric, options);
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
export function metricExpressions(
  evaluation: EvalShape,
  options: MetricMappingOptions = {},
): string[] {
  return metricBindings(evaluation, options).map((binding) => binding.expression);
}

/**
 * The measured metrics a gate may threshold on.
 *
 * The runtime refuses to threshold on a model-backed metric (`BaselineGate` cannot
 * distinguish a regression from sampling noise in a judge), so these are exactly the
 * metrics a `Threshold` may name -- and therefore the ones every eval must declare at
 * least one of.
 */
export function deterministicMetrics(
  evaluation: EvalShape,
  options: MetricMappingOptions = {},
): MetricBinding[] {
  return metricBindings(evaluation, options).filter((binding) => binding.deterministic);
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
