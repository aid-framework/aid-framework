/**
 * Which pipelines serve SSE, decided once.
 *
 * Three places need this answer: `./validate.ts` refuses a document that asks to stream
 * without it, `./emit/pipelines.ts` emits the `Accept` branch only when it holds, and
 * `./plan.ts` decides whether the negotiation module exists. Restating the rule in each
 * of them would be three chances to disagree about which routes stream -- and the way
 * that disagreement shows up is a route that advertises SSE and returns JSON.
 *
 * The rule is the shape of what a stream can carry. `ModelGateway.stream` yields the
 * model's own text deltas, so a stream is only truthful when the response *is* one
 * `generate` step's output. Two things follow, and both are restrictions rather than
 * preferences:
 *
 * * exactly one step may generate -- two model calls have one response no single stream
 *   can produce;
 * * every step after it may only *project* the response, which today means an `emit`
 *   step naming an event. A later step that performs an effect, or that reads the
 *   model's text to change text or state, would leave its effect unperformed and its
 *   change unapplied on the streaming path while the JSON path still performed them --
 *   so such a pipeline cannot stream, and `./validate.ts` refuses the document instead
 *   of emitting a route that would quietly skip those steps.
 *
 * Steps *before* the generate step are not a restriction: they run on the streaming path
 * exactly as they do on the JSON path, so the tool and retrieval guardrails they apply
 * still apply. That is what lets the shipped example -- tool, retrieve, generate, emit --
 * stream without losing its retrieval.
 */

import type { IR, PipelineShape } from '@aid-framework/ir';

/** The index of the one `generate` step, or `undefined` when there is not exactly one. */
function generateIndex(pipeline: PipelineShape): number | undefined {
  const indexes = (pipeline.steps ?? []).flatMap((step, index) =>
    step.kind === 'generate' ? [index] : [],
  );
  return indexes.length === 1 ? indexes[0] : undefined;
}

/**
 * The index of the step a stream carries, or `undefined` when no single stream can.
 *
 * The allowlist is `emit` rather than "not an effect", so a step kind added later is
 * excluded until someone decides it is a projection. Guessing that a new step is
 * projection-shaped is how a streaming route starts silently skipping work.
 */
export function streamedStepIndex(pipeline: PipelineShape): number | undefined {
  const index = generateIndex(pipeline);
  if (index === undefined) return undefined;
  const trailing = (pipeline.steps ?? []).slice(index + 1);
  return trailing.every((step) => step.kind === 'emit') ? index : undefined;
}

/** Whether one `generate` step produces this pipeline's whole response. */
export function streamablePipeline(pipeline: PipelineShape): boolean {
  return streamedStepIndex(pipeline) !== undefined;
}

/** Whether any deployment asks the app to serve SSE at all. */
export function streamingRequested(ir: IR): boolean {
  return (ir.deployments ?? []).some((deployment) => deployment.streaming);
}

/**
 * Whether this pipeline's route negotiates `Accept: text/event-stream`.
 *
 * A `generate` step served over SSE is the only combination the runtime can honour, so
 * the two conditions are both required and neither implies the other.
 */
export function streams(ir: IR, pipeline: PipelineShape): boolean {
  return (
    pipeline.trigger?.kind === 'http' && streamingRequested(ir) && streamablePipeline(pipeline)
  );
}
