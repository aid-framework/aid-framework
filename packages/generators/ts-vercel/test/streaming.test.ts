/**
 * Streaming: which routes negotiate `text/event-stream`, and what the emitted app does.
 *
 * The shape rule lives in `../src/streaming.ts` and is consumed by three places, so these
 * tests are written against the rule rather than against a rendered string wherever they
 * can be. The emitted-app block is the exception: a rule that never reaches the route is
 * a rule nobody honours, so one test per rendered fact pins the wiring.
 *
 * The document under test is the example's IR, mutated rather than re-authored as a
 * spec. The example as authored **cannot** stream -- its `inbound` guardrail declares an
 * `output` stage, and `triage` runs a `guard` step after its `generate` -- and one test
 * below pins that, because it is the reason the committed example was not flipped to
 * streaming. The rest use `streamableExampleIR`, the rearranged copy in `helpers.ts` that
 * `compile.test.ts` also compiles, so the fixture a refusal is tested against is the same
 * one the compiler is pointed at.
 */

import type { IR, PipelineShape } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { checkPlan } from '../src/index.js';
import { filesFor } from '../src/plan.js';
import {
  nonStreamableReason,
  streamablePipeline,
  streamingRequested,
  streams,
} from '../src/streaming.js';
import { example, streamableExampleIR } from './helpers.js';

/** A private copy, because every test below mutates what it is given. */
function exampleIR(): IR {
  return structuredClone(example().ir);
}

/** The pipeline the example's answer route runs, by id rather than by position. */
function answerPipeline(ir: IR): PipelineShape {
  const pipeline = ir.pipelines.find((candidate) => candidate.id === 'answer_ticket');
  if (pipeline === undefined) throw new Error('the example has no answer_ticket pipeline');
  return pipeline;
}

function generateIndex(pipeline: PipelineShape): number {
  const index = (pipeline.steps ?? []).findIndex((step) => step.kind === 'generate');
  if (index < 0) throw new Error('the pipeline has no generate step');
  return index;
}

/** The emitted file whose POSIX path ends with `suffix`, or `undefined` when none is. */
function emitted(ir: IR, suffix: string): string | undefined {
  return filesFor(ir).find((file) => file.path.endsWith(suffix))?.content;
}

describe('the decision', () => {
  it('reads the deployment, and only the deployment, for whether to stream at all', () => {
    // The pipeline in the shipped example is streamable; what is missing is a deployment
    // that asks. Two independent conditions, and this pins that one does not imply the
    // other -- a `streams()` written as `streamablePipeline(pipeline)` alone would turn
    // SSE on for every app that never asked for it.
    expect(streamingRequested(example().ir)).toBe(false);
    expect(streamablePipeline(answerPipeline(example().ir))).toBe(true);
    expect(streams(example().ir, answerPipeline(example().ir))).toBe(false);

    const ir = streamableExampleIR();
    expect(streamingRequested(ir)).toBe(true);
    expect(streams(ir, answerPipeline(ir))).toBe(true);
  });

  it('refuses a pipeline whose generate is followed by an effect', () => {
    // `emit` is an allowlist, not "anything that is not an effect": the JSON path would
    // run this step and the streaming path would silently skip it, which is the exact
    // divergence the refusal exists to prevent. The step is copied from before the
    // generate so the copy is a well-formed step, not a hand-built one.
    const ir = streamableExampleIR();
    const pipeline = answerPipeline(ir);
    const steps = pipeline.steps ?? [];
    const index = generateIndex(pipeline);
    const copied = steps[0];
    if (copied === undefined) throw new Error('the pipeline has no steps to copy');
    steps.splice(index + 1, 0, structuredClone(copied));

    expect(streamablePipeline(pipeline)).toBe(false);
    expect(nonStreamableReason(pipeline)).toContain(`is \`${copied.kind}\``);

    const problems = checkPlan(ir).filter((problem) => problem.code === 'streaming-unsupported');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe('pipelines.answer_ticket');
  });

  it('refuses two generate steps, which one response cannot carry', () => {
    const ir = streamableExampleIR();
    const pipeline = answerPipeline(ir);
    const steps = pipeline.steps ?? [];
    const index = generateIndex(pipeline);
    const generated = steps[index];
    if (generated === undefined) throw new Error('the pipeline has no generate step');
    steps.splice(index + 1, 0, structuredClone(generated));

    expect(streamablePipeline(pipeline)).toBe(false);
    expect(nonStreamableReason(pipeline)).toContain('has 2');
  });

  it('refuses a pipeline with no top-level generate', () => {
    const ir = streamableExampleIR();
    const pipeline = answerPipeline(ir);
    pipeline.steps = (pipeline.steps ?? []).filter((step) => step.kind !== 'generate');

    expect(streamablePipeline(pipeline)).toBe(false);
    expect(nonStreamableReason(pipeline)).toContain('no top-level `generate` step');
  });

  it('refuses an output-stage guardrail, which a stream would never reach', () => {
    // The model's text leaves as it is produced, so there is no point at which an output
    // policy could rewrite it. Accepting both would be a plan that says it redacts when
    // it does not.
    const ir = streamableExampleIR();
    const guardrail = ir.guardrails[0];
    if (guardrail === undefined) throw new Error('the example declares no guardrail to mutate');
    guardrail.stages = ['output'];

    const problems = checkPlan(ir).filter((problem) => problem.code === 'streaming-unsupported');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe(`deployments.${ir.deployments[0]?.id ?? ''}`);
    expect(problems[0]?.message).toContain('output');
  });

  it('plans the rearranged example cleanly, so the refusals are not blanket', () => {
    // Strings rather than objects, because vitest elides object fields in the diff and
    // the point of this test is which problem, at which path.
    expect(
      checkPlan(streamableExampleIR()).map(
        (problem) => `${problem.code}@${problem.path}: ${problem.message}`,
      ),
    ).toEqual([]);
  });

  it('names both obstacles in the example as authored', () => {
    // This is why the committed example still does not stream. A refusal that only said
    // "cannot stream" would leave the author guessing; both are named, at their paths.
    const ir = exampleIR();
    for (const deployment of ir.deployments) deployment.streaming = true;

    const problems = checkPlan(ir).filter((problem) => problem.code === 'streaming-unsupported');
    expect(problems.map((problem) => problem.path)).toEqual([
      `deployments.${ir.deployments[0]?.id ?? ''}`,
      'pipelines.triage',
    ]);
    expect(problems[1]?.message).toContain('`guard`');
  });
});

describe('the emitted app', () => {
  it('plans the negotiation module only when some pipeline streams', () => {
    // `sse.ts` is dead code in an app that never negotiates, and this target's rule is
    // that a generated file exists because something imports it.
    expect(emitted(example().ir, '/generated/sse.ts')).toBeUndefined();
    expect(emitted(streamableExampleIR(), '/generated/sse.ts')).toContain(
      'export const EVENT_STREAM',
    );
  });

  it('compares the media type exactly, so a lookalike does not switch the route', () => {
    // `includes('text/event-stream')` would accept `text/event-stream-extra` and
    // `text/event-stream;q=0` -- the first is not the type, the second explicitly refuses
    // it. Splitting on `;` and comparing is what keeps both out.
    const sse = emitted(streamableExampleIR(), '/generated/sse.ts') ?? '';
    expect(sse).toContain(".split(';')[0]");
    expect(sse).toContain('=== EVENT_STREAM');
    expect(sse).not.toContain('accept.includes(');
  });

  it('adds the Accept branch to the route that can honour it', () => {
    const route = emitted(streamableExampleIR(), '/generated/routes/answer_ticket.ts') ?? '';
    expect(route).toContain('wantsEventStream(request.headers)');
    expect(route).toContain('getDeps().gateway.stream');
    expect(route).toContain("'cache-control': 'no-store'");
    expect(route).toContain('answerTicketStreamRequest');
    // The refusal happens before a byte is sent: the request is rendered and its input
    // guardrail applied before the stream is handed to the response, so an invalid ticket
    // answers 400 rather than a stream that opens and then dies.
    expect(route.indexOf('answerTicketStreamRequest(')).toBeLessThan(
      route.indexOf('toEventStream('),
    );
  });

  it('leaves the committed, buffered route untouched', () => {
    // The shipped example does not ask to stream, so its route must not advertise the
    // negotiation -- and the golden test is what proves the rest of the tree is identical.
    const route = emitted(example().ir, '/generated/routes/answer_ticket.ts') ?? '';
    expect(route).not.toContain('wantsEventStream');
    expect(route).not.toContain('answerTicketStreamRequest');
  });
});
