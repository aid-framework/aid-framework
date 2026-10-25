/**
 * Deployment — one gate, `deploy/streaming`.
 *
 * A deployment that asks for streaming asks for something a target can only honour if
 * it declares the capability. The Python `ModelGateway.stream()` produces SSE bytes
 * (Phase 2 L5) and the py-fastapi generator now emits a `text/event-stream` branch on
 * the pipeline route (P7a), so py-fastapi declares `streaming` and this gate passes for
 * it. The TypeScript gateway still raises `FeatureDeferredError` (ratified L6), so the
 * TypeScript target still declares nothing and still fails closed here.
 *
 * The decision is read from the injected declarations rather than hard-coded, which is
 * what keeps the gate honest in both directions: it fails while a target has no
 * streaming route, and it passes only once that target actually declares the capability
 * -- declaring it is what removes the false declaration this layer exists to catch
 * (defect D-1).
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
