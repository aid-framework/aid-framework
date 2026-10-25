/**
 * Orchestration — one gate, `orchestration/deepagents`.
 *
 * An agent that delegates its loop to a framework is a different kind of dependency
 * from one AID runs itself: the framework's behaviour is no longer described by the
 * IR, so the version has to be pinned in the spec or the build is not reproducible, and
 * the loop has to be able to call tools or the framework has nothing to drive. Both
 * failures are cheap to state and expensive to discover, so neither is a warning.
 *
 * The gate reads the model's declared capability rather than a catalog: a model whose
 * capability set lives in the IR is what the capability gate negotiates with, and the
 * two must not disagree.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

export function orchestrationDeepagentsGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const models = new Map(ir.models.map((model) => [model.id, model]));

  for (const agent of ir.agents) {
    if (agent.engine !== 'deepagents') continue;

    if (agent.engineVersion === undefined || agent.engineVersion.trim() === '') {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.orchestrationDeepagents,
          message: `the orchestration gate rejected "${agent.id}": engine is "deepagents" but no engineVersion is pinned, so the generated app would depend on whatever the framework resolves to`,
          path: ['agents', agent.id, 'engineVersion'],
          hint: 'pin the framework version in engineVersion',
        }),
      );
    }

    const model = models.get(agent.model);
    // An unresolved model is `agents/refs-resolve`'s diagnostic; do not double-report.
    if (model === undefined) continue;
    if (model.capabilities.includes('tool-calling')) continue;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.orchestrationDeepagents,
        message: `the orchestration gate rejected "${agent.id}": engine "deepagents" drives a tool-calling loop, but its model "${model.id}" does not declare the "tool-calling" capability`,
        path: ['agents', agent.id, 'model'],
        hint: 'bind a model that declares tool-calling, or use engine: native',
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
