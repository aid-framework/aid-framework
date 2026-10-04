/**
 * Gate 3 — capability.
 *
 * A target generator declares the capabilities it implements; the IR derives what it
 * requires from its own content. The gate intersects the two and fails on any unmet
 * requirement, so a generator is never handed work it cannot express.
 *
 * `packages/generator-sdk` does not exist in layer 2, so the declarations arrive as
 * an injected parameter. Layer 3 supplies real generator declarations and nothing
 * else in this module changes.
 */

import {
  REQUIRED_CAPABILITIES,
  type RequiredCapability,
  resolveRequiredCapability,
} from '../capabilities.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR } from '../shapes.js';
import { type GateOptions, type GateResult, reporter, type SuppressedCheck } from './contract.js';

const SUPPRESSED: SuppressedCheck[] = [];

type Reporter = ReturnType<typeof reporter>;

export function capabilityGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);

  const required = new Set<RequiredCapability>(ir.requiredCapabilities);
  for (const target of ir.project.targets) {
    const declared = options.targetCapabilities[target];
    if (declared === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.targetUnknown,
          message: `the capability gate rejected this target: no capability declaration is registered for "${target}", so nothing it can generate is known`,
          path: ['project', 'targets'],
          hint: `Phase 0 declares ${Object.keys(options.targetCapabilities).join(', ') || 'no targets'}`,
        }),
      );
      continue;
    }

    const capabilities = new Set<RequiredCapability>();
    for (const entry of declared) {
      const resolved = resolveRequiredCapability(entry);
      if (resolved === undefined) {
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.capabilityUnknown,
            message: `the capability gate rejected this declaration: "${entry}" is not a capability of the vocabulary (${REQUIRED_CAPABILITIES.join(', ')})`,
            path: ['project', 'targets'],
            hint: 'declare a capability from the vocabulary, or extend it deliberately',
          }),
        );
        continue;
      }
      capabilities.add(resolved);
    }

    for (const capability of required) {
      if (capabilities.has(capability)) continue;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.capabilityMissing,
          message: `the capability gate rejected target "${target}": the IR requires "${capability}", which this target does not declare`,
          path: ['project', 'targets'],
          hint: `declare "${capability}" for "${target}", or drop the feature that needs it`,
        }),
      );
    }
  }

  checkStructuredOutputModels(ir, diagnostics, report);

  return { diagnostics, suppressed: SUPPRESSED };
}

/**
 * A structured-output prompt needs a model that can constrain its output, otherwise
 * the schema the IR carries is unenforceable at the only layer that could enforce it.
 */
function checkStructuredOutputModels(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  const models = new Map(ir.models.map((model) => [model.id, model]));
  for (const prompt of ir.prompts) {
    if (prompt.output.kind !== 'structured') continue;
    const model = models.get(prompt.model);
    if (model === undefined) continue;
    if (model.capabilities.includes('json-schema')) continue;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.modelCapabilityMissing,
        message: `the capability gate rejected this prompt: "${prompt.id}" declares structured output, but its model "${model.id}" does not declare the "json-schema" capability`,
        path: ['prompts', prompt.id, 'model'],
        hint: 'bind a model that declares json-schema, or use a text output',
      }),
    );
  }
}
