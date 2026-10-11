/**
 * Emission order for every collection the generator walks.
 *
 * Ordering is a byte-level promise, not a style choice: two runs over the same IR
 * must agree, and so must a run over an IR whose author reordered a list. Every
 * collection is therefore ordered by a *declared identity* (`compareIds` from the
 * generator SDK) rather than by authoring order or by a locale-sensitive sort.
 */

import { compareIds, sortById } from '@aid/generator-sdk';
import type { EvalShape, IR, ModelShape, PipelineShape, PromptShape, ToolShape } from '@aid/ir';

export function orderedModels(ir: IR): ModelShape[] {
  return sortById(ir.models);
}

export function orderedTools(ir: IR): ToolShape[] {
  return sortById(ir.tools);
}

export function orderedPipelines(ir: IR): PipelineShape[] {
  return sortById(ir.pipelines);
}

export function orderedEvals(ir: IR): EvalShape[] {
  return sortById(ir.evals);
}

/**
 * Prompts in `(id, version)` order.
 *
 * A prompt's identity includes its version, so ordering by id alone would leave two
 * versions of one prompt in authoring order -- and a change of version could then
 * reorder unrelated lines.
 */
export function orderedPrompts(ir: IR): PromptShape[] {
  return [...ir.prompts].sort((left, right) => {
    const byId = compareIds(left.id, right.id);
    return byId !== 0 ? byId : left.version - right.version;
  });
}
