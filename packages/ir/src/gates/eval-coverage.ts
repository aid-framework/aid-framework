/**
 * Gate 6 — eval coverage.
 *
 * A pipeline Phase 0 actually serves and that no CI-gating eval covers is a warning,
 * not an error: a partially evaluated app is legitimate, a *silently* uncovered
 * endpoint is not.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { type GateOptions, type GateResult, reporter, type SuppressedCheck } from './contract.js';

const SUPPRESSED: SuppressedCheck[] = [];

type Reporter = ReturnType<typeof reporter>;

export function evalCoverageGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  const covered = new Set(
    ir.evals
      .filter((evalShape) => evalShape.gate.ci && evalShape.target.kind === 'pipeline')
      .map((evalShape) => evalShape.target.id),
  );

  for (const pipeline of ir.pipelines) {
    if (pipeline.trigger.kind !== 'http' || covered.has(pipeline.id)) continue;
    diagnostics.push(
      report.warn({
        code: IR_DIAGNOSTIC_CODES.evalUncovered,
        message: `the eval-coverage gate flagged this pipeline: "${pipeline.id}" is served over HTTP but no eval with gate.ci: true targets it`,
        path: ['pipelines', pipeline.id],
        hint: `add an eval targeting "pipeline:${pipeline.id}" and set gate.ci: true`,
      }),
    );
  }

  checkRetrievalCoverage(ir, diagnostics, report);

  return { diagnostics, suppressed: SUPPRESSED };
}

/**
 * A retrieval surface with no retrieval metric is unmeasured: an `exact-match` eval says
 * nothing about whether the right chunks were retrieved, because it only sees the answer
 * that retrieval fed into. The rule is spec-wide rather than per-retriever because a
 * `retrieval` metric names no retriever -- it asserts what a query should bring back.
 */
function checkRetrievalCoverage(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  if (ir.retrievers.length === 0) return;
  const measured = ir.evals.some((evalShape) =>
    evalShape.metrics.some((metric) => metric.kind === 'retrieval'),
  );
  if (measured) return;
  const names = ir.retrievers.map((retriever) => retriever.id).join(', ');
  diagnostics.push(
    report.warn({
      code: IR_DIAGNOSTIC_CODES.evalUncovered,
      message: `the eval-coverage gate flagged this retrieval surface: the IR declares the retriever(s) ${names} but no eval carries a "retrieval" metric, so nothing measures what they retrieve`,
      path: ['retrievers'],
      hint: 'add an eval with a metric of kind "retrieval", and gate it in CI so the measurement runs',
    }),
  );
}
