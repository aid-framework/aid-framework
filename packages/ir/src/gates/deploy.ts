/**
 * Deployment — one gate, `deploy/streaming`.
 *
 * A deployment that asks for streaming asks for something a target can only honour if
 * it declares the capability. No target does yet: the Python `ModelGateway.stream()`
 * now produces SSE bytes (Phase 2 L5), but the py-fastapi generator still emits no
 * streaming route and the TypeScript gateway still raises `FeatureDeferredError`
 * (ratified L6), so declaring the capability on a target would remain the false
 * declaration this layer exists to remove (defect D-1, now only partially closed).
 * The gate therefore fails closed today and starts passing on the day a target
 * declares `streaming` — it is never a no-op, because the decision is read from the
 * injected declarations rather than hard-coded here.
 *
 * The check covers every configured target: a project that generates for two targets
 * and asks for streaming must not ship a deployment one of them silently cannot serve.
 */

import { resolveRequiredCapability } from '../capabilities.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

export function deployStreamingGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  for (const deployment of ir.deployments) {
    if (!deployment.streaming) continue;
    const unable = ir.project.targets.filter((target) => {
      const declared = options.targetCapabilities[target] ?? [];
      return !declared.some((entry) => resolveRequiredCapability(entry) === 'streaming');
    });
    if (unable.length === 0) continue;

    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.deployStreaming,
        message: `the deploy gate rejected "${deployment.id}": it requests streaming, but ${unable.map((target) => `"${target}"`).join(', ')} ${unable.length === 1 ? 'does' : 'do'} not declare the "streaming" capability`,
        path: ['deployments', deployment.id, 'streaming'],
        hint: 'set streaming: false until a target implements it, or generate for a target that declares it',
      }),
    );
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
