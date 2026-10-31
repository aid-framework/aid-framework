/**
 * Emission order for every collection the generator walks.
 *
 * Ordering is a byte-level promise, not a style choice: two runs over the same IR
 * must agree, and so must a run over an IR whose author reordered a list. Every
 * collection is therefore ordered by a *declared identity* (`compareIds` from the
 * generator SDK) rather than by authoring order or by a locale-sensitive sort.
 */

import { compareIds, sortById } from '@aid-framework/generator-sdk';
import type {
  AgentShape,
  EmbeddingShape,
  EvalShape,
  GuardrailShape,
  IR,
  MemoryShape,
  ModelShape,
  PipelineShape,
  PromptShape,
  RetrieverShape,
  ToolShape,
  VectorStoreShape,
} from '@aid-framework/ir';

export function orderedModels(ir: IR): ModelShape[] {
  return sortById(ir.models);
}

/** Agent declarations in declared-id order; the order their tables are emitted in. */
export function orderedAgents(ir: IR): AgentShape[] {
  return sortById(ir.agents ?? []);
}

/** Memory tiers in declared-id order. */
export function orderedMemory(ir: IR): MemoryShape[] {
  return sortById(ir.memory ?? []);
}

/** Guardrails in declared-id order, which is the order their tables are emitted in. */
export function orderedGuardrails(ir: IR): GuardrailShape[] {
  return sortById(ir.guardrails);
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

/** Embedding models in declared-id order. */
export function orderedEmbeddings(ir: IR): EmbeddingShape[] {
  return sortById(ir.embeddings);
}

/** Vector stores in declared-id order. */
export function orderedStores(ir: IR): VectorStoreShape[] {
  return sortById(ir.stores);
}

/** Retrievers in declared-id order. */
export function orderedRetrievers(ir: IR): RetrieverShape[] {
  return sortById(ir.retrievers);
}
