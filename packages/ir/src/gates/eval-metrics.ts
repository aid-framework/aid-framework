/**
 * The eval-metric gate — whether a declared trajectory metric can ever fail.
 *
 * A metric that cannot fail is worse than no metric: it is a green check that costs a
 * reviewer's attention and answers nothing. Two of the trajectory metrics have a
 * document-visible way to be unanswerable while looking complete, and both are answerable
 * from the IR alone:
 *
 *   - `step-count` is a ceiling on model calls, and the agent already declares one. A case
 *     ceiling at or above the agent's own `maxSteps` is reached by the budget first, so the
 *     run is stopped before the metric can ever score a step over the ceiling. The metric
 *     would then only ever report what the agent's own bound did.
 *   - `approval-respected` reads the pauses a run took. An agent that declares no
 *     `humanInTheLoop` and calls no tool with `requiresConfirmation` never pauses, so the
 *     metric either passes trivially (a case supplying no decisions) or fails every case (a
 *     case supplying one). Neither is a measurement.
 *
 * The `evals/trajectory` gate asks a different question -- whether the *target* can report a
 * trajectory at all -- and both are needed: a metric can be unreachable on a target that
 * reports trajectories perfectly well.
 *
 * `forbidden-tool` has no check here. Its only document-visible failure is naming a tool
 * that does not exist, which is `ir/metric-tool-unresolved` in the referential gate, the
 * same code `tool-trace` already reports. Forbidding a tool the agent cannot reach is a
 * legitimate statement rather than a vacuous one: "this agent must never pay a refund" is
 * the point of the metric, not a defect in it.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { AgentShape, IR, MetricShape, ToolShape } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

type Reporter = ReturnType<typeof reporter>;

export function evalMetricGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const agents = new Map(ir.agents.map((agent) => [agent.id, agent]));
  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));

  for (const evalShape of ir.evals) {
    if (evalShape.target.kind !== 'agent') continue;
    const agent = agents.get(evalShape.target.id);
    // An unresolvable target is the referential gate's diagnostic, not this one's.
    if (agent === undefined) continue;

    evalShape.metrics.forEach((metric, index) => {
      const path = ['evals', evalShape.id, 'metrics', index];
      if (metric.kind === 'step-count') {
        const vacuous = stepCeilingDiagnostic(agent, metric, report, path);
        if (vacuous !== undefined) diagnostics.push(vacuous);
      }
      if (metric.kind === 'approval-respected') {
        const vacuous = approvalReachabilityDiagnostic(agent, tools, report, path);
        if (vacuous !== undefined) diagnostics.push(vacuous);
      }
    });
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

function stepCeilingDiagnostic(
  agent: AgentShape,
  metric: Extract<MetricShape, { kind: 'step-count' }>,
  report: Reporter,
  path: (string | number)[],
): IrDiagnostic | undefined {
  // Equal is the case the rule exists for. A case ceiling equal to the budget is reached by
  // the budget first, so a run that would exceed it is stopped with a budget error and the
  // metric never scores anything.
  if (metric.maxSteps < agent.maxSteps) return undefined;
  return report.error({
    code: IR_DIAGNOSTIC_CODES.evalMetricVacuous,
    message: `the eval-metric gate rejected this step-count ceiling: it allows ${metric.maxSteps} steps and the "${agent.id}" agent's own maxSteps is ${agent.maxSteps}, so the agent's budget stops a run before the ceiling can be exceeded and the metric can only pass`,
    path: [...path, 'maxSteps'],
    hint: `set maxSteps below ${agent.maxSteps} -- the ceiling this case should finish inside -- or drop the metric and let the agent's own budget be the bound`,
  });
}

function approvalReachabilityDiagnostic(
  agent: AgentShape,
  tools: Map<string, ToolShape>,
  report: Reporter,
  path: (string | number)[],
): IrDiagnostic | undefined {
  // A pause comes from exactly two places (`AgentRuntime._needs_approval`): the agent's
  // `humanInTheLoop` policy, or a tool that declares `requiresConfirmation`. With neither,
  // there is nothing to pause on and nothing for the metric to score.
  if (agent.humanInTheLoop !== undefined) return undefined;
  const confirming = agent.tools.filter((id) => tools.get(id)?.requiresConfirmation === true);
  if (confirming.length > 0) return undefined;
  return report.error({
    code: IR_DIAGNOSTIC_CODES.evalMetricVacuous,
    message: `the eval-metric gate rejected this approval-respected metric: the "${agent.id}" agent declares no humanInTheLoop policy and calls no tool with requiresConfirmation, so its run never pauses and the metric has no decision to score`,
    path,
    hint: `declare humanInTheLoop on "${agent.id}", or set requiresConfirmation: true on the tool the run must ask about, or drop the metric`,
  });
}
