/**
 * Memory — one gate.
 *
 * Every reference a memory tier makes must resolve, and each tier kind must name the
 * thing that makes it work: a `summary` tier with no model has nothing to summarize
 * with, and a `semantic`/`episodic`/`vector` tier with no store has nowhere to persist.
 * Reporting that at build time is the difference between "declared" and "declared and
 * possible"; the runtime is not asked to discover it on the first request.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR, MemoryShape } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/** The tier kinds that need somewhere to persist, as opposed to staying in the run. */
const PERSISTENT_KINDS: ReadonlyArray<MemoryShape['kind']> = ['semantic', 'episodic', 'vector'];

export function memoryRefsGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const stores = new Set(ir.stores.map((store) => store.id));
  const models = new Set(ir.models.map((model) => model.id));

  for (const memory of ir.memory) {
    if (memory.store !== undefined && !stores.has(memory.store)) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.memoryRef,
          message: `the memory gate rejected "${memory.id}": store names "${memory.store}", which is not a declared store`,
          path: ['memory', memory.id, 'store'],
          hint: `declared stores: ${[...stores].sort().join(', ') || 'none'}`,
        }),
      );
    }
    if (
      memory.backend !== undefined &&
      memory.backend !== 'in-process' &&
      !stores.has(memory.backend)
    ) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.memoryRef,
          message: `the memory gate rejected "${memory.id}": backend names "${memory.backend}", which is neither a declared store nor "in-process"`,
          path: ['memory', memory.id, 'backend'],
          hint: `use "in-process" or one of: ${[...stores].sort().join(', ') || 'no stores declared'}`,
        }),
      );
    }
    if (memory.summarizeModel !== undefined && !models.has(memory.summarizeModel)) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.memoryRef,
          message: `the memory gate rejected "${memory.id}": summarizeModel names "${memory.summarizeModel}", which is not a declared model`,
          path: ['memory', memory.id, 'summarizeModel'],
          hint: `declared models: ${[...models].sort().join(', ') || 'none'}`,
        }),
      );
    }
    if (memory.kind === 'summary' && memory.summarizeModel === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.memoryRef,
          message: `the memory gate rejected "${memory.id}": kind is "summary" but no summarizeModel is declared, so nothing can produce the summary`,
          path: ['memory', memory.id, 'summarizeModel'],
          hint: 'name the model that summarizes, or use a window tier',
        }),
      );
    }
    if (
      PERSISTENT_KINDS.includes(memory.kind) &&
      memory.store === undefined &&
      (memory.backend === undefined || memory.backend === 'in-process')
    ) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.memoryRef,
          message: `the memory gate rejected "${memory.id}": kind "${memory.kind}" outlives the run but names neither a store nor an external backend`,
          path: ['memory', memory.id, 'store'],
          hint: 'declare store or backend, or use a buffer/window tier',
        }),
      );
    }
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}
