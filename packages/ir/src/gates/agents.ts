/**
 * Agents — four separate gates, because they answer four different questions.
 *
 * `agents/refs-resolve`: every name an agent uses exists. An agent whose tool or
 * guardrail does not resolve is not a partially-working agent; it is a runtime
 * failure that would surface only on the first request that reaches the missing
 * branch, so it fails at build time instead.
 *
 * `agents/handoff-cycles`: handoffs form a graph, and a cycle in it is an unbounded
 * transfer loop. Lexical cycles are reported once per cycle, at the agent that closes
 * it, because reporting every member would multiply one defect into N diagnostics.
 *
 * `agents/budgets`: an agent that can take more than one step must say what stops it.
 * Phase 2 L1 has no runtime, so this is the only place a runaway loop can be caught,
 * and "no budget declared" is read as "unbounded", never as "some default".
 *
 * `agents/budget-degrade`: `onBudgetExhausted: degrade` is a promise that a budget
 * breach has somewhere cheaper to go. Degrade only helps against a *cost* ceiling
 * (switching aliases does not make tokens cheaper), and it can only be proven if the
 * model's declared fallbacks contain one whose pinned cost is strictly lower. An
 * agent that asks for degrade without either would fail at run time, on the one path
 * the field was added to survive, so it fails here instead.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { AgentShape, IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

type Reporter = ReturnType<typeof reporter>;

/** What each agent field refers to, so one loop can check all six collections. */
const REF_FIELDS = [
  { field: 'instructions', section: 'prompts', kind: 'prompt' },
  { field: 'model', section: 'models', kind: 'model' },
  { field: 'retrievers', section: 'retrievers', kind: 'retriever' },
  { field: 'memory', section: 'memory', kind: 'memory tier' },
  { field: 'guardrails', section: 'guardrails', kind: 'guardrail' },
  { field: 'handoffs', section: 'agents', kind: 'agent' },
  { field: 'delegates', section: 'agents', kind: 'agent' },
] as const;

export function agentsRefsGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  for (const { field, section, kind } of REF_FIELDS) {
    const declared = new Set(
      (ir[section] as ReadonlyArray<{ id: string }>).map((entry) => entry.id),
    );
    const available = [...declared].sort();
    for (const agent of ir.agents) {
      const value = agent[field];
      if (Array.isArray(value)) {
        for (const ref of value) {
          if (declared.has(ref)) continue;
          diagnostics.push(
            report.error({
              code: IR_DIAGNOSTIC_CODES.agentsRefUnresolved,
              message: `the agents gate rejected "${agent.id}": ${field} names "${ref}", which is not a declared ${kind}`,
              path: ['agents', agent.id, field],
              hint: `declared ${kind}s: ${available.join(', ') || 'none'}`,
            }),
          );
        }
        continue;
      }
      if (typeof value !== 'string' || value === '' || declared.has(value)) continue;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.agentsRefUnresolved,
          message: `the agents gate rejected "${agent.id}": ${field} names "${value}", which is not a declared ${kind}`,
          path: ['agents', agent.id, field],
          hint: `declared ${kind}s: ${available.join(', ') || 'none'}`,
        }),
      );
    }
  }

  checkToolRefs(ir, diagnostics, report);
  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

/** Tools are a field of their own: an agent may use none, but never a phantom one. */
function checkToolRefs(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  const declared = new Set(ir.tools.map((tool) => tool.id));
  for (const agent of ir.agents) {
    for (const ref of agent.tools) {
      if (declared.has(ref)) continue;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.agentsRefUnresolved,
          message: `the agents gate rejected "${agent.id}": tools names "${ref}", which is not a declared tool`,
          path: ['agents', agent.id, 'tools'],
          hint: `declared tools: ${[...declared].sort().join(', ') || 'none'}`,
        }),
      );
    }
  }
}

export function agentsHandoffGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  const byId = new Map(ir.agents.map((agent) => [agent.id, agent]));
  // `visiting` is the DFS stack, `done` the agents whose subtree is proven acyclic.
  const visiting: string[] = [];
  const done = new Set<string>();
  const reported = new Set<string>();

  const walk = (agent: AgentShape): void => {
    if (done.has(agent.id)) return;
    visiting.push(agent.id);
    for (const next of agent.handoffs) {
      const target = byId.get(next);
      // A missing handoff target is `agents/refs-resolve`'s diagnostic, not ours.
      if (target === undefined) continue;
      const at = visiting.indexOf(next);
      if (at !== -1) {
        const cycle = [...visiting.slice(at), next];
        const key = [...cycle].sort().join('>');
        if (reported.has(key)) continue;
        reported.add(key);
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.agentsHandoffCycle,
            message: `the agents gate rejected a handoff cycle: ${cycle.join(' -> ')}; a handoff transfers the conversation and never returns, so a cycle is an unbounded transfer`,
            path: ['agents', visiting[at] ?? next, 'handoffs'],
            hint: 'use delegates for a sub-task that returns to the caller, or break the cycle',
          }),
        );
        continue;
      }
      walk(target);
    }
    visiting.pop();
    done.add(agent.id);
  };

  for (const agent of ir.agents) walk(agent);
  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

export function agentsBudgetGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  for (const agent of ir.agents) {
    if (!Number.isInteger(agent.maxSteps) || agent.maxSteps < 1) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.agentsBudget,
          message: `the agents gate rejected "${agent.id}": maxSteps is ${agent.maxSteps}, so the agent can never complete a step`,
          path: ['agents', agent.id, 'maxSteps'],
          hint: 'set maxSteps to at least 1',
        }),
      );
    }
    if (agent.maxTokensBudget !== undefined && agent.maxTokensBudget < 1) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.agentsBudget,
          message: `the agents gate rejected "${agent.id}": maxTokensBudget is ${agent.maxTokensBudget}, which no run can satisfy`,
          path: ['agents', agent.id, 'maxTokensBudget'],
          hint: 'set maxTokensBudget to at least 1, or omit it',
        }),
      );
    }
    if (agent.maxCostBudget !== undefined && !(agent.maxCostBudget > 0)) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.agentsBudget,
          message: `the agents gate rejected "${agent.id}": maxCostBudget is ${agent.maxCostBudget}, which no run can satisfy`,
          path: ['agents', agent.id, 'maxCostBudget'],
          hint: 'set maxCostBudget above zero, or omit it',
        }),
      );
    }

    const loopable = agent.maxSteps > 1;
    const bounded = agent.maxTokensBudget !== undefined || agent.maxCostBudget !== undefined;
    if (loopable && !bounded) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.agentsBudget,
          message: `the agents gate rejected "${agent.id}": it may take up to ${agent.maxSteps} steps but declares neither maxTokensBudget nor maxCostBudget, so nothing bounds what one run costs`,
          path: ['agents', agent.id, 'maxTokensBudget'],
          hint: 'declare maxTokensBudget or maxCostBudget, or set maxSteps: 1',
        }),
      );
    }
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

/**
 * A degrade request must have somewhere cheaper to go, and that somewhere must be
 * provable from the pinned cost profiles rather than assumed.
 */
export function agentsBudgetDegradeGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const models = new Map(ir.models.map((model) => [model.id, model]));

  for (const agent of ir.agents) {
    if (agent.onBudgetExhausted !== 'degrade') continue;

    if (agent.maxCostBudget === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.agentsBudgetDegrade,
          message: `the agents gate rejected "${agent.id}": onBudgetExhausted is "degrade" but it declares no maxCostBudget, and switching aliases cannot make a token ceiling cheaper`,
          path: ['agents', agent.id, 'onBudgetExhausted'],
          hint: 'declare maxCostBudget, or set onBudgetExhausted: fail',
        }),
      );
    }

    const model = models.get(agent.model);
    // An unresolved model is `agents/refs-resolve`'s diagnostic, not ours.
    if (model === undefined) continue;
    if (cheaperFallbacks(ir, model).length > 0) continue;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.agentsBudgetDegrade,
        message: `the agents gate rejected "${agent.id}": onBudgetExhausted is "degrade" but model "${model.id}" has no fallback alias that is strictly cheaper, so a budget breach would still be a hard failure at run time`,
        path: ['agents', agent.id, 'onBudgetExhausted'],
        hint: degradeHint(model, ir),
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

/** Fallback aliases that are strictly cheaper than `model`, in declaration order. */
function cheaperFallbacks(ir: IR, model: { id: string; fallbacks: string[] }): string[] {
  const models = new Map(ir.models.map((entry) => [entry.id, entry]));
  const current = aliasCost(models.get(model.id));
  if (current === undefined) return [];
  return model.fallbacks.filter((id) => {
    const candidate = aliasCost(models.get(id));
    return candidate !== undefined && candidate < current;
  });
}

function aliasCost(
  model: { costProfile?: { inputPerMTok: number; outputPerMTok: number } } | undefined,
): number | undefined {
  if (model?.costProfile === undefined) return undefined;
  return model.costProfile.inputPerMTok + model.costProfile.outputPerMTok;
}

function degradeHint(model: { id: string; fallbacks: string[] }, ir: IR): string {
  const models = new Map(ir.models.map((entry) => [entry.id, entry]));
  if (model.fallbacks.length === 0) {
    return `declare at least one cheaper alias in models.${model.id}.fallbacks, or set onBudgetExhausted: fail`;
  }
  const current = aliasCost(models.get(model.id));
  if (current === undefined) {
    return `models.${model.id} has no costProfile, so no fallback can be proven cheaper; declare one, or set onBudgetExhausted: fail`;
  }
  const priced = model.fallbacks.map((id) => {
    const cost = aliasCost(models.get(id));
    return cost === undefined ? `${id} (unpriced)` : `${id} (${cost})`;
  });
  return `fallbacks ${priced.join(', ')} are not cheaper than ${current} (sum of input and output list price); declare a cheaper alias, or set onBudgetExhausted: fail`;
}
