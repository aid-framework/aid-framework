/**
 * The `guard` step's three modelled stages, as the pipeline module emits them.
 *
 * Before this file the suite held no `guard` step at all. The only guard call any test
 * asserted was the route-level `check_input(INPUT_GUARDRAILS, ...)` that the `generate`
 * step emits, and that call is assembled by interpolating the stage name rather than by
 * reading `GUARD_METHODS`. So an arm of that table could be renamed onto a neighbouring
 * stage without reddening a single test. Each case here asserts the exact engine method
 * the emitted step calls, because "a guardrail was wired" is a claim the wrong method
 * satisfies too.
 *
 * The stage is asserted twice per case -- once as the `ENGINE.check_*` callee and once in
 * the step's docstring -- because both are emitted from the same field, and a stage that
 * reached one but not the other would be a step whose prose lies about what it ran.
 *
 * The two refusal cases pin the rest of the closure, and they are two *different* layers.
 * An unmodelled stage cannot come out of validated text at all: the schema closes `stage`
 * to four names, so the spec layer is where it dies. `tool-call` is one of those four
 * names and is refused later, by this generator, because a pipeline step has no call to
 * gate. Each case names which layer it pins, and the two codes are not interchangeable.
 */

import type { IR } from '@aid-framework/ir';
import { checkSpecText, formatPath } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { checkPlan, planPyFastApi } from '../src/index.js';
import { buildForSpecText, fileMap, lowerForSpecText } from './helpers.js';

/**
 * A 0.2 spec whose only interesting parts are its step list and its one guardrail.
 *
 * Two prompts are declared because a guard step interpolates its payload as text and the
 * plan refuses a placeholder that resolves to a struct (`unsupported-placeholder`). The
 * `output` case therefore guards a `text` prompt's binding, which is what an output-stage
 * guardrail actually inspects; the `emit` still needs the structured one.
 */
const BASE_SPEC = `specVersion: "0.2"

project:
  name: guards
  namespace: aid.test.guards
  targets: [py-fastapi]

types:
  Reply:
    kind: struct
    fields:
      summary:
        type: string
        required: true

models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]
  embed:
    provider: fake
    modelId: text-embedding-3-small
    capabilities: [embeddings]

stores:
  handbook:
    kind: memory
    dimensions: 1536

retrievers:
  handbook:
    source:
      kind: file
      uri: ./docs
      glob: "**/*.md"
    chunking:
      strategy: recursive
      size: 800
      overlap: 100
    embedModel: embed
    store: handbook
    index:
      metric: cosine
    topK: 5
    refresh:
      mode: full

prompts:
  draft:
    version: 1
    model: fast
    template: |
      Draft a reply to this ticket: {{ subject }}
    variables:
      subject:
        type: string
        required: true
    output:
      kind: text
  ask:
    version: 1
    model: fast
    template: |
      Summarise this ticket in one sentence: {{ subject }}
    variables:
      subject:
        type: string
        required: true
    output:
      kind: structured
      schema: Reply
`;

/** The steps that make the pipeline answerable, so a guard case can sit in front of them. */
const ANSWER_TAIL = `      - generate:
          prompt: ask
          input:
            subject: "{{ event.subject }}"
          as: answer
      - emit:
          event: Reply`;

/** A spec whose step list and guardrail stages this case chooses. */
function specWith(steps: string, stages = '[input, output, retrieval]'): string {
  return `${BASE_SPEC}
guardrails:
  screen:
    stages: ${stages}
    policies: [prompt-injection]
    action: flag
    onFail:
      message: The screen recorded this payload.
      log: true

pipelines:
  handle:
    description: Exercise one guard stage.
    trigger:
      http:
        method: post
        path: /handle
    steps:
${steps}
`;
}

/** The emitted pipeline module for a spec built from these steps. */
function pipelineFor(steps: string, stages?: string): string {
  const { plan } = buildForSpecText(specWith(steps, stages));
  const content = fileMap(plan.files).get('app/generated/pipelines/handle.py');
  if (content === undefined) throw new Error('the plan emitted no handle pipeline module');
  return content;
}

/** The plan-problem codes for an IR, in order. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

describe('a guard step calls the engine method its stage names', () => {
  it('calls check_input at the input stage', () => {
    const content = pipelineFor(`      - guard:
          guardrail: screen
          stage: input
          text: "{{ event.subject }}"
${ANSWER_TAIL}`);

    expect(content).toContain('async def _guard_1(ctx: PipelineContext) -> PipelineContext:');
    expect(content).toContain('Run the `screen` guardrail at the `input` stage');
    expect(content).toContain('_payload = f"{event.subject}"');
    expect(content).toContain(
      'enforce_guardrail(ENGINE.check_input((BY_ID["screen"],), _payload))',
    );
  });

  it('calls check_output at the output stage', () => {
    const content = pipelineFor(`      - generate:
          prompt: draft
          input:
            subject: "{{ event.subject }}"
          as: draft
      - guard:
          guardrail: screen
          stage: output
          text: "{{ draft }}"
${ANSWER_TAIL}`);

    expect(content).toContain('async def _guard_1(ctx: PipelineContext) -> PipelineContext:');
    expect(content).toContain('Run the `screen` guardrail at the `output` stage');
    expect(content).toContain('_payload = f"{draft}"');
    expect(content).toContain(
      'enforce_guardrail(ENGINE.check_output((BY_ID["screen"],), _payload))',
    );
  });

  it('calls check_retrieval at the retrieval stage, over the passages', () => {
    const content = pipelineFor(`      - retrieve:
          retriever: handbook
          query: "{{ event.subject }}"
          as: handbook
      - guard:
          guardrail: screen
          stage: retrieval
          text: "{{ handbook }}"
${ANSWER_TAIL}`);

    expect(content).toContain('async def _guard_1(ctx: PipelineContext) -> PipelineContext:');
    expect(content).toContain('Run the `screen` guardrail at the `retrieval` stage');
    // The retrieval stage takes the strings a model would be handed, not the result
    // object: a guard railed here has to see each passage, and the projection is what
    // makes the difference between guarding text and guarding a container of it.
    expect(content).toContain('_payload = [item.chunk.text for item in handbook.items]');
    expect(content).toContain(
      'enforce_guardrail(ENGINE.check_retrieval((BY_ID["screen"],), _payload))',
    );
  });
});

describe('the stages a guard step cannot take', () => {
  it('refuses an unmodelled stage at the spec layer, before anything is built', () => {
    const result = checkSpecText(
      specWith(`      - guard:
          guardrail: screen
          stage: runtime
          text: "{{ event.subject }}"
${ANSWER_TAIL}`),
      { file: 'guards.spec.yaml' },
    );

    // The code is the evidence for which layer refused it: the schema's `stage` enum is
    // closed to the four names the IR models, so this is a schema violation reported
    // while reading the document, not a plan problem found after lowering it.
    //
    // The step union is a `oneOf` over kind-keyed shapes, so a failing guard step also
    // reports every other step kind's missing keys. The violation that names the enum is
    // the one under `.guard.stage`, and it is the only one that says why the document
    // was refused.
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    const atStage = result.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === 'spec/schema-violation' &&
        formatPath(diagnostic.path) === 'pipelines.handle.steps[0].guard.stage',
    );
    expect(atStage).toHaveLength(1);
    expect(atStage[0]?.message).toContain(
      'must be one of "input", "output", "retrieval", "tool-call"',
    );
  });

  it('refuses the tool-call stage at plan time, where the spec schema admits it', () => {
    // `tool-call` passes the enum, so this refusal is this target's rather than the
    // schema's -- which is exactly why the code and the path are asserted rather than
    // just the throw. The path is `.stage`, not `.guardrail`: the escalate/redact
    // refusal lands on the guardrail, and mistaking one for the other would pin the
    // wrong rule.
    const ir = lowerForSpecText(
      specWith(
        `      - guard:
          guardrail: screen
          stage: tool-call
          text: "x"
${ANSWER_TAIL}`,
        '[input, output, retrieval, tool-call]',
      ),
    );

    expect(codes(ir)).toContain('unsupported-param');
    const refusal = checkPlan(ir).find((problem) => problem.code === 'unsupported-param');
    expect(refusal?.path).toBe('pipelines.handle.steps[0].stage');
    expect(refusal?.message).toContain("'tool-call' stage has none to name");
    expect(() => planPyFastApi(ir)).toThrow(/tool-call/);
  });
});
