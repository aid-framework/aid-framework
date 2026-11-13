/**
 * Delivery — the two gates that make a durable run and a step approval mean something.
 *
 * `state` is only a control if the agents that need it are held to it. An agent that can
 * call a tool with side effects is an agent whose run must survive a restart: it can be
 * paused mid-write, and a paused run with no store dies with the process, leaving a write
 * the operator cannot account for. So the state gate requires a declared store from every
 * enterprise agent that can reach a writing tool. It is scoped to `specVersion: "0.26"`
 * and above because 0.25 has no `state` key to satisfy it with, and to the enterprise
 * profile because the `.env`-only standard path has no database to point it at.
 *
 * `approvals` is only a control if asking for one is not inert. `requiresApproval: true`
 * on a step whose tool cannot change anything pauses a run to ask a human about a read:
 * the operator learns to approve without reading, which is worse than no approval step at
 * all. So the approval gate refuses an approval on a tool with no side effects, and does
 * so for every profile, because the mistake is the same in a standard deployment.
 *
 * Neither gate decides policy. It checks that the document declares the control it relies
 * on, and where the control is missing it names the agent, the tool, and the fix.
 */

import { specVersionAtLeast } from '@aid-framework/spec';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR, StepShape, ToolShape, ToolStep } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';
import { DELIVERY_CONTROLS_MIN_VERSION } from './profile.js';

/** True when calling this tool can change something outside the run. */
function writes(tool: ToolShape): boolean {
  return tool.sideEffects === 'write' || tool.sideEffects === 'destructive';
}

/** Every tool step in a step list, however deeply nested. */
type FoundStep = { step: ToolStep; path: (string | number)[] };

function toolSteps(steps: readonly StepShape[]): FoundStep[] {
  const found: FoundStep[] = [];
  const visitList = (list: readonly StepShape[], prefix: (string | number)[]): void => {
    list.forEach((step, index) => {
      visitStep(step, [...prefix, index]);
    });
  };
  // The path is the JSON pointer to the step, so a `map`'s single child is addressed as
  // `step` and not as `step[0]`: there is no list to index there.
  const visitStep = (step: StepShape, path: (string | number)[]): void => {
    switch (step.kind) {
      case 'tool':
        found.push({ step, path });
        return;
      case 'branch':
        visitList(step.then, [...path, 'then']);
        visitList(step.else, [...path, 'else']);
        return;
      case 'route':
        for (const [label, arm] of Object.entries(step.on)) visitList(arm, [...path, 'on', label]);
        if (step.default !== undefined) visitList(step.default, [...path, 'default']);
        return;
      case 'parallel':
        step.branches.forEach((arm, armIndex) => {
          visitList(arm, [...path, 'branches', armIndex]);
        });
        return;
      case 'map':
        visitStep(step.step, [...path, 'step']);
        return;
      default:
        return;
    }
  };
  visitList(steps, []);
  return found;
}

export function stateGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  if (ir.profile !== 'enterprise') return { diagnostics, suppressed: NO_SUPPRESSIONS };
  if (!specVersionAtLeast(ir.specVersion, DELIVERY_CONTROLS_MIN_VERSION)) {
    return { diagnostics, suppressed: NO_SUPPRESSIONS };
  }

  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));
  for (const agent of ir.agents) {
    if (agent.state !== undefined) continue;
    const writers = agent.tools
      .map((id) => tools.get(id))
      .filter((tool): tool is ToolShape => tool !== undefined)
      .filter(writes);
    if (writers.length === 0) continue;

    const named = writers.map((tool) => `"${tool.id}" (${tool.sideEffects})`).join(', ');
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.agentsStateStore,
        message: `the state gate rejected "${agent.id}": it can call ${named}, which ${writers.length === 1 ? 'has' : 'have'} side effects, and it declares no durable state, so the first resume of a paused write is remembered only by the process that issued it -- a replayed answer reaches a second replica, or a restarted one, and is accepted`,
        path: ['agents', agent.id, 'state'],
        hint: 'add `state: { kind: postgres, urlEnv: DATABASE_URL }` to the agent or to the document, so the checkpoint nonce is claimed where the store already points and the app has a declared place to persist a paused run (AID generates the claim, not the persistence)',
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

export function approvalGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));

  for (const pipeline of ir.pipelines) {
    for (const { step, path } of toolSteps(pipeline.steps)) {
      if (step.requiresApproval !== true) continue;
      const tool = tools.get(step.tool);
      if (tool !== undefined && !writes(tool)) {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.approvalStepTool,
            message: `the approval gate rejected "${pipeline.id}": step ${path.join('.')} sets requiresApproval on "${step.tool}", which has no side effects, so the pause asks a human to approve a read`,
            path: ['pipelines', pipeline.id, 'steps', ...path, 'tool', 'requiresApproval'],
            hint: 'set requiresApproval only on tools whose sideEffects is write or destructive; a read needs no sign-off',
          }),
        );
      }

      // A pause is only real if the run survives between the request that starts it and
      // the one that resumes it; with no store the generated code would have to hold the
      // run in memory and the approval would silently never resume.
      if (ir.state === undefined) {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.approvalStepTool,
            message: `the approval gate rejected "${pipeline.id}": step ${path.join('.')} waits for approval and the document declares no durable state store, so the pending decision has no declared place to live and the checkpoint nonce is remembered only in the process that issued it`,
            path: ['state'],
            hint: 'add a top-level `state: { kind: postgres, urlEnv: DATABASE_URL }` so the checkpoint nonce is claimed durably and the app has a declared place to persist the paused run (AID generates the claim, not the persistence)',
          }),
        );
      }
    }
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
