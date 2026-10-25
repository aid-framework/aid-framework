/**
 * Guardrails — two gates.
 *
 * `guardrails/coverage`: a tool that writes or destroys must reach a guardrail stage
 * that can inspect the call before it happens. The check is conditional on the IR
 * declaring at least one guardrail, and that condition is reported as a suppressed
 * check rather than left implicit. The suppression covers two different populations,
 * and since v0.2 exists it is no longer accurate to describe them as one: a 0.1 spec
 * predates the section and cannot opt in at all, while a 0.2 spec that declares none
 * has made a choice. Neither can be enforced here, because no Phase 2 L1 runtime
 * evaluates a policy — demanding the declaration would be unbuildable rather than
 * fail-closed, and calling that "enforced" would be the same false assurance as
 * suppressing it silently.
 *
 * `guardrails/policies`: the closed policy vocabulary is re-checked here because the IR
 * is a published contract a non-TypeScript producer can write directly, plus the two
 * rules the schema deliberately leaves to this layer — a `redact` action must name what
 * it redacts, and a guardrail may only cover tools that exist.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import { GUARDRAIL_POLICY_KINDS, type IR, isGuardrailPolicyKind } from '../shapes.js';
import {
  type GateOptions,
  type GateResult,
  NO_SUPPRESSIONS,
  reporter,
  type SuppressedCheck,
} from './contract.js';

const SUPPRESSED: SuppressedCheck[] = [
  {
    check: 'guardrails/coverage-without-declaration',
    reason:
      'Whether a spec that declares no guardrail at all should still be required to add one is a decision for the guardrails engine layer (design §7.4): no Phase 2 L1 runtime evaluates a policy, so requiring a declaration here would protect nothing. It would also fail two different populations for different reasons — a 0.1 spec predates the section and cannot opt in at all, while a 0.2 spec that declares none has made a choice this layer cannot yet enforce. What this layer can decide — that a declared guardrail actually covers the side-effecting tools it exists for — is enforced below.',
  },
];

export function guardrailCoverageGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  if (ir.guardrails.length === 0) return { diagnostics, suppressed: SUPPRESSED };

  for (const tool of ir.tools) {
    if (tool.sideEffects !== 'write' && tool.sideEffects !== 'destructive') continue;
    const covered = ir.guardrails.some(
      (guardrail) =>
        guardrail.stages.includes('tool-call') &&
        (guardrail.tools.length === 0 || guardrail.tools.includes(tool.id)),
    );
    if (covered) continue;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.guardrailCoverage,
        message: `the guardrails gate rejected "${tool.id}": the tool has sideEffects "${tool.sideEffects}" but no declared guardrail covers it at the "tool-call" stage`,
        path: ['tools', tool.id, 'sideEffects'],
        hint: `add a guardrail with stages: [tool-call] whose tools list is empty or names "${tool.id}"`,
      }),
    );
  }

  return { diagnostics, suppressed: SUPPRESSED };
}

export function guardrailPolicyGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const tools = new Set(ir.tools.map((tool) => tool.id));
  const prompts = new Set(ir.prompts.map((prompt) => prompt.id));

  for (const guardrail of ir.guardrails) {
    if (guardrail.stages.length === 0) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.guardrailPolicy,
          message: `the guardrails gate rejected "${guardrail.id}": it declares no stage, so no runtime could ever invoke it`,
          path: ['guardrails', guardrail.id, 'stages'],
          hint: 'name at least one of input, output, retrieval, tool-call',
        }),
      );
    }
    if (guardrail.policies.length === 0) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.policyEmpty,
          message: `the guardrails gate rejected "${guardrail.id}": it declares no policy, so there is nothing for the stage to evaluate`,
          path: ['guardrails', guardrail.id, 'policies'],
          hint: `name one of ${GUARDRAIL_POLICY_KINDS.join(', ')}`,
        }),
      );
    }
    guardrail.policies.forEach((policy, index) => {
      if (isGuardrailPolicyKind(policy)) return;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.guardrailPolicy,
          message: `the guardrails gate rejected "${guardrail.id}": policy "${policy}" is not in the closed vocabulary (${GUARDRAIL_POLICY_KINDS.join(', ')})`,
          path: ['guardrails', guardrail.id, 'policies', index],
          hint: 'name a policy the guardrails engine implements, or extend the vocabulary deliberately',
        }),
      );
    });
    if (guardrail.action === 'redact' && guardrail.redact.length === 0) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.guardrailPolicy,
          message: `the guardrails gate rejected "${guardrail.id}": action is "redact" but it names no field to redact, so the action cannot be executed or tested`,
          path: ['guardrails', guardrail.id, 'redact'],
          hint: 'list the field names the redaction removes',
        }),
      );
    }
    guardrail.tools.forEach((tool, index) => {
      if (tools.has(tool)) return;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.guardrailPolicy,
          message: `the guardrails gate rejected "${guardrail.id}": tools names "${tool}", which is not a declared tool`,
          path: ['guardrails', guardrail.id, 'tools', index],
          hint: `declared tools: ${[...tools].sort().join(', ') || 'none'}`,
        }),
      );
    });
    const fallback = guardrail.onFail.fallbackPrompt;
    if (fallback !== undefined && !prompts.has(fallback)) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.guardrailPolicy,
          message: `the guardrails gate rejected "${guardrail.id}": onFail.fallbackPrompt names "${fallback}", which is not a declared prompt`,
          path: ['guardrails', guardrail.id, 'onFail', 'fallbackPrompt'],
          hint: `declared prompts: ${[...prompts].sort().join(', ') || 'none'}`,
        }),
      );
    }
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
