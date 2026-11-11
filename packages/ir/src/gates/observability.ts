/**
 * Observability — the two gates that make a declared trace and a declared eval mean
 * something.
 *
 * `export: otlp` is a promise about where spans go, so it has to agree with `trace`: a
 * document that turns tracing off and still declares an export has promised a stream it
 * has switched off, and resolving that contradiction silently in either direction is
 * exactly the approximation AID refuses. The enterprise profile raises the same question
 * from the other side. Its audit-sink requirement is only answerable if the run records
 * something, so an enterprise deployment whose spans stay in the process cannot produce
 * the trail the profile promises. Both checks are scoped to spec 0.27 and above, because
 * a 0.26 document has no `observability` key to satisfy them with.
 *
 * The trajectory gate covers the two things a 0.27 document can say about a run that this
 * build cannot honour, and it refuses each with its own reason. An `agent:` target is
 * expressible so a spec can state what it means, but no generator emits an agent eval --
 * the runner drives one prediction per case through a prompt, and an agent run has no such
 * single subject. A `tool-trace` metric compares tool calls, which nothing here compares,
 * so declaring one promises a score that will never be produced. `cost` and `latency` are
 * *not* refused even though the runner cannot score them either, because each carries a
 * second meaning this build does honour: a `cost` ceiling becomes the eval's `costBudget`
 * and is checked against a static estimate by the cost gate, and a `latency` ceiling
 * becomes `latencyBudgetP95Ms` and reaches the deploy plan. Refusing them would delete a
 * working check to make a point; they stay refused at generation, where they always were.
 * Refusing the rest here rather than in codegen is the point -- `aid validate` says it
 * before a generator is ever entered.
 */

import { specVersionAtLeast } from '@aid-framework/spec';
import { sensitiveNames } from '../build.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { FeedbackSignalShape, IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/** The spec version that first let a document state where its spans go. */
export const OBSERVABILITY_MIN_VERSION = '0.27';

/** The spec version that first let a document declare a feedback intake. */
export const FEEDBACK_MIN_VERSION = '0.28';

export function observabilityExportGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  if (!specVersionAtLeast(ir.specVersion, OBSERVABILITY_MIN_VERSION)) {
    return { diagnostics, suppressed: NO_SUPPRESSIONS };
  }

  const observability = ir.observability;
  const exportsOtlp = observability.export === 'otlp';

  if (exportsOtlp && !observability.trace) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.observabilityExport,
        message:
          'the observability gate rejected this document: it declares `export: otlp` while `trace` is false, so there is nothing to export',
        path: ['observability', 'export'],
        hint: 'set `trace: true` to record the spans you are exporting, or `export: none` to keep them in the process',
      }),
    );
    return { diagnostics, suppressed: NO_SUPPRESSIONS };
  }

  if (ir.profile === 'enterprise' && !exportsOtlp) {
    const declared = observability.export === undefined ? 'nothing' : `\`${observability.export}\``;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.observabilityExport,
        message: `the observability gate rejected this deployment: profile enterprise promises an audit trail, but observability exports ${declared}, so every span stays inside the process`,
        path: ['observability', 'export'],
        hint: 'add `observability: { trace: true, export: otlp, endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT }`; the variable holds the collector address, and AID installs no exporter for you',
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

export function evalTrajectoryGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  for (const evalShape of ir.evals) {
    const target = evalShape.target;

    // An `agent:` target is expressible from 0.27 so a document can say what it means,
    // but no generator emits an agent eval: the runner drives one prediction per case
    // through a prompt, and an agent run has no such single subject. Refusing here rather
    // than at generation is the whole point of the gate -- `aid validate` says it before a
    // generator is entered, and it names the missing piece instead of pretending the agent
    // is undeclared.
    if (target.kind === 'agent') {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.evalTrajectory,
          message: `the trajectory gate rejected "${evalShape.id}": target "${target.qualified}" names an agent, and this build emits evals over a prompt, not over an agent run`,
          path: ['evals', evalShape.id, 'target'],
          hint: `evaluate the pipeline that runs the agent (\`target: pipeline:<id>\`) for now; an agent eval needs a runner that carries a trajectory, which is not built yet`,
        }),
      );
      continue;
    }

    evalShape.metrics.forEach((metric, index) => {
      if (metric.kind !== 'tool-trace') return;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.evalTrajectory,
          message: `the trajectory gate rejected "${evalShape.id}": metric ${index} compares tool calls, and "${target.qualified}" returns a response with no tool calls to compare`,
          path: ['evals', evalShape.id, 'metrics', index],
          hint: 'no metric in this build inspects a trajectory; score the response with exact, contains, json-schema, llm-judge or assert',
        }),
      );
    });
  }
  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

/**
 * The feedback gate — what a declared signal may store.
 *
 * Feedback is the one place this framework tells a user to send real user text back into
 * the app, so it is the one place where "we keep what they told us" has to be answerable
 * from the document. Two things are unanswerable as written and each gets its own reason:
 *
 *   - a persistent store with no `retentionDays` keeps whatever it is given forever. A
 *     spec may say that, but it may not say it by omission, so the absence is the refusal.
 *   - a `correction` is free text. Once it is stored, any field the spec itself marks
 *     sensitive and does not name in `pii.redact` is stored in the clear, which is the
 *     same under-covering the trace gate refuses for spans.
 *
 * A `thumbs` vote and an `escalation` outcome carry no prose, so neither pulls in the
 * redaction rule: refusing them would make the honest, minimal signal the expensive one.
 * Both checks are scoped to spec 0.28 and above, because a 0.27 document has no
 * `feedback` key to satisfy them with.
 */
export function feedbackPiiGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  if (!specVersionAtLeast(ir.specVersion, FEEDBACK_MIN_VERSION)) {
    return { diagnostics, suppressed: NO_SUPPRESSIONS };
  }
  const feedback = ir.observability.feedback;
  if (feedback === undefined) return { diagnostics, suppressed: NO_SUPPRESSIONS };

  if (feedback.persistent === true && feedback.retentionDays === undefined) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.feedbackPii,
        message:
          'the feedback gate rejected this document: the feedback store is declared persistent with no retentionDays, so every signal it receives is kept indefinitely',
        path: ['observability', 'feedback', 'retentionDays'],
        hint: 'set a retentionDays limit, or `persistent: false` to keep feedback for the request only',
      }),
    );
  }

  const storesText =
    feedback.persistent === true &&
    (feedback.retentionDays === undefined || feedback.retentionDays > 0);
  if (!storesText) return { diagnostics, suppressed: NO_SUPPRESSIONS };

  const textSignals = feedback.signals.filter((signal) => carriesText(signal));
  if (textSignals.length === 0) return { diagnostics, suppressed: NO_SUPPRESSIONS };

  const sensitive = sensitiveNames(ir);
  const missing = sensitive.filter((name) => !feedback.redact.includes(name));
  if (missing.length === 0) return { diagnostics, suppressed: NO_SUPPRESSIONS };

  const names = textSignals.map((signal) => `"${signal.id}"`).join(', ');
  diagnostics.push(
    report.error({
      code: IR_DIAGNOSTIC_CODES.feedbackPii,
      message: `the feedback gate rejected this document: signal ${names} stores free text under pii.redact entries that do not cover ${missing.join(', ')}, and the store is declared as persistent`,
      path: ['observability', 'feedback', 'pii', 'redact'],
      hint: `add ${missing.join(', ')} to observability.feedback.pii.redact, or take the text signal out of the persistent store`,
    }),
  );
  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

/** The only declared kind that records prose rather than an outcome. */
function carriesText(signal: FeedbackSignalShape): boolean {
  return signal.kind === 'correction';
}
