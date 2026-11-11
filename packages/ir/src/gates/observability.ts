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
 * The trajectory gate is the honest-maturity gate, and it is deliberately narrow: it
 * refuses `tool-trace` and nothing else. That kind exists for exactly one purpose -- to
 * compare the tool calls a run made against an expectation -- and nothing in this build
 * compares them, so declaring it promises a score that will never be produced. `cost` and
 * `latency` are *not* refused here even though the eval harness cannot score them either,
 * because each carries a second meaning this build does honour: a `cost` ceiling becomes
 * the eval's `costBudget` and is checked against a static estimate by the cost gate, and a
 * `latency` ceiling becomes `latencyBudgetP95Ms` and reaches the deploy plan. Refusing
 * them here would delete a working check to make a point. They stay refused at generation,
 * where they have always been refused. Moving the `tool-trace` refusal from codegen to the
 * IR is the point -- `aid validate` now says it before a generator is ever entered.
 */

import { specVersionAtLeast } from '@aid-framework/spec';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/** The spec version that first let a document state where its spans go. */
export const OBSERVABILITY_MIN_VERSION = '0.27';

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
    evalShape.metrics.forEach((metric, index) => {
      if (metric.kind !== 'tool-trace') return;
      const target = evalShape.target;

      if (target.kind !== 'agent') {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.evalTrajectory,
            message: `the trajectory gate rejected "${evalShape.id}": metric ${index} compares tool calls, and "${target.qualified}" returns a response with no tool calls to compare`,
            path: ['evals', evalShape.id, 'metrics', index],
            hint: 'point the eval at an agent with `target: agent:<id>`, or score the response with exact, contains, json-schema, llm-judge or assert',
          }),
        );
        return;
      }

      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.evalTrajectory,
          message: `the trajectory gate rejected "${evalShape.id}": metric ${index} compares tool calls, which spec 0.27 lets you declare on "${target.qualified}" but this build does not measure yet`,
          path: ['evals', evalShape.id, 'metrics', index],
          hint: 'the eval runner hands its metrics a response string and no trajectory, so this metric would be reported as unmeasured; score the response instead until trajectory measurement ships',
        }),
      );
    });
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
