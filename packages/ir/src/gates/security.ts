/**
 * Gate 5 — security. Fail-closed by default.
 *
 * The asymmetry is deliberate: a tool that writes or destroys and declares no `auth`
 * is an error rather than a warning, because the safe reading of "no policy" is "no
 * access", never "open access". Every rule this gate states is now live: the one it
 * used to suppress is enforced below.
 *
 * The same asymmetry covers retrieval: a store reaches its backing service through
 * `env:NAME`, so a connection string that appears literally in the IR is an error. No
 * required gate touches a database -- the rule reads the declarations, never the store.
 */

import { sensitiveNames } from '../build.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { PolicyNode } from '../policy/index.js';
import type { IR, ObservabilityShape, PipelineShape, ToolShape } from '../shapes.js';
import { type GateOptions, type GateResult, reporter, type SuppressedCheck } from './contract.js';

/** Builtins whose presence means the policy actually authenticates the caller. */
const AUTHENTICATING_BUILTINS = ['isAuthenticated', 'hasRole', 'hasScope'] as const;

/** The one uri form a store may carry: a reference into the environment. */
const ENV_REFERENCE = /^env:[A-Z][A-Z0-9_]{0,63}$/;

/**
 * A uri whose authority carries userinfo, i.e. a credential inlined before the host.
 * The userinfo cannot span a `/`, so a path segment that contains `@` is not a match.
 */
const URI_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i;

/**
 * Empty, and empty on purpose. This was Phase 0's one suppressed rule:
 *
 *   check: 'security/input-output-guardrails'
 *   reason: 'Phase 0 has no guardrail runtime, so whether a pipeline routes model
 *            input and output through a guardrail cannot be enforced; §7.4 defers
 *            the rule to the phase that ships one'
 *
 * It is no longer suppressed. Spec v0.2 makes `guardrails` declarable, so the question
 * "does an endpoint that hands untrusted text to a model route it through an input
 * guardrail?" can be answered from the declarations, and `checkInputGuardrails`
 * answers it. What still has no runtime is *evaluating* the policy; that is the
 * guardrails engine's layer, and a declared policy is the most this layer can honestly
 * require.
 */
const SUPPRESSED: SuppressedCheck[] = [];

export function securityGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  for (const tool of ir.tools) {
    checkToolAuth(tool, diagnostics, report);
  }

  checkRedaction(ir, diagnostics, report);
  checkStoreSecrets(ir, diagnostics, report);
  checkInputGuardrails(ir, diagnostics, report);

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
 * A retrieval store is a connection to something outside the app, so the only form a
 * store `uri` may take is a reference into the environment. A literal DSN in the IR is
 * a credential in the IR: it is serialized into the golden files, printed by any tool
 * that reads them, and committed. The check is repeated here rather than left to the
 * spec schema because the IR is a published contract that a non-TypeScript producer can
 * write directly.
 *
 * A retriever's `source.uri` is legitimately a literal -- a path, or a bucket URL for
 * the reserved kinds -- so it is not restricted to `env:`. What it may not do is inline
 * a credential into the authority, which is what the userinfo scan catches.
 */
function checkStoreSecrets(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  for (const store of ir.stores) {
    if (store.uri === undefined || ENV_REFERENCE.test(store.uri)) continue;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.securityStoreSecret,
        message: `the security gate rejected this store: "${store.id}" declares uri "${store.uri}", a literal connection string; a store reaches its backing service through env:NAME, so the value stays out of the IR`,
        path: ['stores', store.id, 'uri'],
        hint: 'set uri to env:<NAME> and provide the value through the environment',
      }),
    );
  }

  for (const retriever of ir.retrievers) {
    if (!URI_USERINFO.test(retriever.source.uri)) continue;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.securityStoreSecret,
        message: `the security gate rejected this source: "${retriever.id}" declares a uri with an inline credential in its authority, which the IR would then carry everywhere it is written`,
        path: ['retrievers', retriever.id, 'source', 'uri'],
        hint: 'drop the credentials from the uri and supply them through the environment',
      }),
    );
  }
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
 * §7.4, now live: an HTTP endpoint hands untrusted text straight to a model, so the IR
 * has to show a guardrail that inspects it first. "Untrusted" is the HTTP trigger and
 * only that trigger — a scheduled job and a manual run carry no caller-supplied text,
 * and demanding a guardrail for them would be a declaration with nothing to inspect.
 *
 * The rule is scoped to specifications that declare the `guardrails` section, for the
 * same reason `guardrails/coverage` is: a spec written against v0.1 predates the
 * section and cannot opt into it, and retroactively failing every such project is a
 * breaking change rather than a safety improvement. A spec that names a guardrail has
 * opted in, and from then on the endpoint that reaches a model must be covered. The
 * demand to make it unconditional belongs to the layer that ships the engine able to
 * satisfy it.
 */
function checkInputGuardrails(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  if (ir.guardrails.length === 0) return;
  if (!ir.guardrails.some((guardrail) => guardrail.stages.includes('input'))) {
    for (const pipeline of ir.pipelines) {
      const trigger = pipeline.trigger;
      if (trigger.kind !== 'http') continue;
      const generate = pipeline.steps.find((step) => step.kind === 'generate');
      if (generate === undefined) continue;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.securityInputGuardrail,
          message: `the security gate rejected this endpoint: the ${trigger.method.toUpperCase()} ${trigger.path} trigger passes caller-supplied text to prompt "${generate.prompt}", but the specification declares no guardrail with an "input" stage`,
          path: ['pipelines', pipeline.id, 'steps', pipeline.steps.indexOf(generate)],
          hint: 'declare a guardrail with stages: [input]',
        }),
      );
    }
  }
}

/**
 * True when the policy mentions a builtin that establishes caller identity. `not` is
 * deliberately not transparent: `not isAuthenticated()` denies what it names, so
 * treating it as authenticating would be the fail-open reading.
 */ export function policyAuthenticates(node: PolicyNode): boolean {
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
