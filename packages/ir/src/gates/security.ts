/**
 * Gate 5 — security. Fail-closed by default.
 *
 * The asymmetry is deliberate: a tool that writes or destroys and declares no `auth`
 * is an error rather than a warning, because the safe reading of "no policy" is "no
 * access", never "open access". The one rule Phase 0 cannot enforce — guarding model
 * input and output with a guardrail runtime — is reported as suppressed, so it is
 * visibly deferred rather than silently passing.
 */

import { sensitiveNames } from '../build.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { PolicyNode } from '../policy/index.js';
import type { IR, ObservabilityShape, PipelineShape, ToolShape } from '../shapes.js';
import { type GateOptions, type GateResult, reporter, type SuppressedCheck } from './contract.js';

/** Builtins whose presence means the policy actually authenticates the caller. */
const AUTHENTICATING_BUILTINS = ['isAuthenticated', 'hasRole', 'hasScope'] as const;

const SUPPRESSED: SuppressedCheck[] = [
  {
    check: 'security/input-output-guardrails',
    reason:
      'Phase 0 has no guardrail runtime, so whether a pipeline routes model input and output through a guardrail cannot be enforced; §7.4 defers the rule to the phase that ships one',
  },
];

export function securityGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  for (const tool of ir.tools) {
    checkToolAuth(tool, diagnostics, report);
  }

  checkRedaction(ir, diagnostics, report);

  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));
  for (const pipeline of ir.pipelines) {
    checkUnauthenticatedPath(pipeline, tools, diagnostics, report);
  }

  return { diagnostics, suppressed: SUPPRESSED };
}

type Reporter = ReturnType<typeof reporter>;

function checkToolAuth(tool: ToolShape, diagnostics: IrDiagnostic[], report: Reporter): void {
  const mutates = tool.sideEffects === 'write' || tool.sideEffects === 'destructive';

  if (mutates && tool.auth === undefined) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.securityMissingAuth,
        message: `the security gate rejected this tool: "${tool.id}" has sideEffects "${tool.sideEffects}" but declares no auth, so it is callable by anyone`,
        path: ['tools', tool.id, 'auth'],
        hint: "declare a policy such as isAuthenticated() and hasScope('x')",
      }),
    );
  }

  if (tool.sideEffects === 'destructive' && !tool.requiresConfirmation) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.securityMissingConfirmation,
        message: `the security gate rejected this tool: "${tool.id}" is destructive but does not require confirmation`,
        path: ['tools', tool.id, 'requiresConfirmation'],
        hint: 'set requiresConfirmation: true',
      }),
    );
  }
}

/**
 * A trace config that is on must redact every field the IR marks as sensitive. An
 * absent config is the builder's default (which redacts the whole sensitive set), so
 * only a *declared* config can under-cover.
 */
function checkRedaction(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  const sensitive = sensitiveNames(ir);
  if (sensitive.length === 0) return;

  checkRedactSet(ir.observability, sensitive, ['observability', 'redact'], diagnostics, report);

  for (const pipeline of ir.pipelines) {
    checkRedactSet(
      pipeline.observability,
      sensitive,
      ['pipelines', pipeline.id, 'observability', 'redact'],
      diagnostics,
      report,
    );
  }
}

function checkRedactSet(
  observability: ObservabilityShape,
  sensitive: readonly string[],
  path: (string | number)[],
  diagnostics: IrDiagnostic[],
  report: Reporter,
): void {
  if (!observability.trace) return;
  const missing = sensitive.filter((name) => !observability.redact.includes(name));
  if (missing.length === 0) return;
  diagnostics.push(
    report.error({
      code: IR_DIAGNOSTIC_CODES.securityRedactionIncomplete,
      message: `the security gate rejected this trace config: it is on but does not redact ${missing.join(', ')}, which the spec marks as sensitive`,
      path,
      hint: `add ${missing.join(', ')} to redact, or turn tracing off`,
    }),
  );
}

/**
 * A pipeline behind an HTTP trigger must not reach a write or destructive tool
 * through a policy that does not authenticate. A tool with *no* auth at all is
 * already an error wherever it is used, so this narrows to the case that rule cannot
 * see: auth is declared, but it is not an authentication predicate.
 */
function checkUnauthenticatedPath(
  pipeline: PipelineShape,
  tools: Map<string, ToolShape>,
  diagnostics: IrDiagnostic[],
  report: Reporter,
): void {
  const trigger = pipeline.trigger;
  if (trigger.kind !== 'http') return;

  pipeline.steps.forEach((step, index) => {
    if (step.kind !== 'tool') return;
    const tool = tools.get(step.tool);
    if (tool === undefined) return;
    if (tool.sideEffects !== 'write' && tool.sideEffects !== 'destructive') return;
    if (tool.auth === undefined || policyAuthenticates(tool.auth)) return;

    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.securityUnauthenticatedPath,
        message: `the security gate rejected this endpoint: the ${trigger.method.toUpperCase()} ${trigger.path} trigger reaches "${tool.id}", which ${tool.sideEffects === 'write' ? 'writes' : 'destroys'} and whose declared policy does not authenticate the caller`,
        path: ['pipelines', pipeline.id, 'steps', index, 'tool'],
        hint: `give "${tool.id}" a policy built from ${AUTHENTICATING_BUILTINS.join(', ')}`,
      }),
    );
  });
}

/**
 * True when the policy mentions a builtin that establishes caller identity. `not` is
 * deliberately not transparent: `not isAuthenticated()` denies what it names, so
 * treating it as authenticating would be the fail-open reading.
 */
export function policyAuthenticates(node: PolicyNode): boolean {
  switch (node.kind) {
    case 'call':
      return (
        (AUTHENTICATING_BUILTINS as readonly string[]).includes(node.name) ||
        node.args.some(policyAuthenticates)
      );
    case 'comparison':
      return policyAuthenticates(node.left) || policyAuthenticates(node.right);
    case 'and':
    case 'or':
      return policyAuthenticates(node.left) || policyAuthenticates(node.right);
    case 'not':
      return false;
    default:
      return false;
  }
}
