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

  return { diagnostics, suppressed: SUPPRESSED };
}
