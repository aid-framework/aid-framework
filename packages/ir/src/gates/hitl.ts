/**
 * Human-in-the-loop — one gate.
 *
 * An agent that can reach a tool which writes or destroys has two acceptable states:
 * it declares a HITL policy (so the run stops for a human), or every such tool
 * declares `requiresConfirmation: true` (so the approval is attached to the tool
 * itself, where it cannot be forgotten when a new agent is added). Anything else is a
 * side effect reachable with nobody in the loop, which fails closed.
 *
 * The gate deliberately does not evaluate the HITL policy expression: that is the
 * parser's job at build time and the runtime's job at run time. It checks presence,
 * because absence is the failure this layer can decide.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR, ToolShape } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

export function hitlSideEffectGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));

  for (const agent of ir.agents) {
    if (agent.humanInTheLoop !== undefined) continue;
    const ungranted = agent.tools
      .map((id) => tools.get(id))
      .filter((tool): tool is ToolShape => tool !== undefined)
      .filter((tool) => tool.sideEffects === 'write' || tool.sideEffects === 'destructive')
      .filter((tool) => !tool.requiresConfirmation);
    if (ungranted.length === 0) continue;

    const names = ungranted.map((tool) => `"${tool.id}" (${tool.sideEffects})`).join(', ');
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.hitlSideEffect,
        message: `the HITL gate rejected "${agent.id}": it can call ${names}, which ${ungranted.length === 1 ? 'has' : 'have'} side effects, but it declares no humanInTheLoop policy and the tool does not require confirmation`,
        path: ['agents', agent.id, 'humanInTheLoop'],
        hint: 'declare humanInTheLoop, or set requiresConfirmation: true on the tool',
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
