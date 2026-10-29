/**
 * The four composites, as the pipeline module emits them.
 *
 * Each case is a whole spec through `buildForSpecText`, which is the same road the CLI
 * takes -- spec checks, lowering, build gates, then the planner -- so a composite that
 * emitted but could not be planned, or planned but could not be gated, fails here rather
 * than in a later layer.
 *
 * The fixture is `specVersion: "0.2"` because `parallel`/`map`/`reduce` are refused
 * without a `deployments.*.concurrency` cap, and `deployments` is a 0.2 section. Nothing
 * here declares a guardrail: the security gate only requires one when a *top-level*
 * `generate` takes caller text, and every `generate` in these fixtures sits inside a
 * composite. That keeps these cases out of the collection question entirely.
 */

import { describe, expect, it } from 'vitest';

import { emitPipelineModule } from '../src/emit/pipelines.js';
import { buildForSpecText, fileMap } from './helpers.js';

/**
 * A spec whose only interesting part is its step list.
 *
 * `handbook` is bound by a `retrieve` rather than by a `generate` so that `map` and
 * `reduce` have a *bound name* to iterate while no top-level `generate` exists to trip the
 * input-guardrail gate. The plan checks that the name is bound, not what it holds, so this
 * reaches the emitter; the runtime is what insists on an array. No construct in the spec
 * language binds one -- `over` is a binding name, `event` is always an object, and nothing
 * carries a list between steps -- so the emitted `mapStep`/`reduceStep` calls below are
 * proved here and reachable only from an IR, not from a spec. The retriever is inline
 * rather than shared with the example because a fixture that reached into the example's
 * spec would move whenever it did.
 */
function specWith(steps: string): string {
  return `specVersion: "0.2"

project:
  name: demo
  namespace: aid.demo
  targets:
    - ts-vercel

types:
  Answer:
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
    topK: 3
    refresh:
      mode: full

prompts:
  classify:
    version: 1
    model: fast
    template: |
      Classify {{ subject }}.
    variables:
      subject:
        type: string
        required: true
    output:
      kind: structured
      schema: Answer

pipelines:
  demo:
    description: A pipeline whose shape is the whole point.
    trigger:
      http:
        method: post
        path: /demo
    steps:
${steps}

deployments:
  api:
    target: container
    concurrency: 4
    secrets: []
`;
}

/** The pipeline module a spec emits, proved to be the one the plan ships. */
function moduleFor(steps: string): string {
  const build = buildForSpecText(specWith(steps));
  const pipeline = build.ir.pipelines[0];
  if (pipeline === undefined) throw new Error('the fixture lowered to no pipeline');
  const content = emitPipelineModule(build.ir, pipeline).content;
  expect(fileMap(build.plan.files).get('app/generated/pipelines/demo.ts')).toBe(content);
  return content;
}

/** A `retrieve` that binds the name every `map`/`reduce` case iterates. */
const RETRIEVE = `      - retrieve:
          retriever: handbook
          query: "{{ event.subject }}"
          as: handbook`;

const BRANCH_WITH_ELSE = `${RETRIEVE}
      - branch:
          when: 'hasRole("admin")'
          then:
            - generate:
                prompt: classify
                input:
                  subject: "admin"
                as: answer
          else:
            - generate:
                prompt: classify
                input:
                  subject: "plain"
                as: answer`;

const BRANCH_WITHOUT_ELSE = `${RETRIEVE}
      - branch:
          when: 'hasRole("admin")'
          then:
            - generate:
                prompt: classify
                input:
                  subject: "admin"
                as: answer`;

const PARALLEL = `${RETRIEVE}
      - parallel:
          branches:
            - - generate:
                  prompt: classify
                  input:
                    subject: "left"
                  as: left
            - - generate:
                  prompt: classify
                  input:
                    subject: "right"
                  as: right`;

const MAP = `${RETRIEVE}
      - map:
          over: handbook
          as: mapped
          step:
            generate:
              prompt: classify
              input:
                subject: "each"
              as: each`;

const REDUCE = `${RETRIEVE}
      - reduce:
          over: handbook
          prompt: classify
          as: summaries`;

describe('the branch composite', () => {
  it('emits both arms as `Pipeline`s and registers the wrapper as the step', () => {
    const text = moduleFor(BRANCH_WITH_ELSE);

    expect(text).toContain('branch({');
    // Answered from the principal, not from a binding: the policy is passed through as
    // the IR parsed it rather than re-rendered into something the context could decide.
    expect(text).toContain(
      "    when: { args: [{ kind: 'string', value: 'admin' }], kind: 'call', name: 'hasRole' },",
    );
    expect(text).toContain("    then: new Pipeline([['answer', demoStep1Then0AnswerStep]]),");
    expect(text).toContain("    otherwise: new Pipeline([['answer', demoStep1Else0AnswerStep]]),");
    // Both arms bind `answer`, so the two constants cannot be named after the binding
    // alone; the path is what keeps them unique, and the arms are separate functions.
    expect(text).toContain('export const demoStep1Then0AnswerStep: Step = async (context) => {');
    expect(text).toContain('export const demoStep1Else0AnswerStep: Step = async (context) => {');
    // The composite binds nothing outward, so the pipeline registers it under its own
    // constant rather than under a binding name; the `retrieve` before it still binds.
    expect(text).toContain(
      "  return new Pipeline([\n    ['handbook', demoHandbookStep],\n" +
        "    ['demoStep1BranchStep', demoStep1BranchStep],\n  ]);",
    );
  });

  it('omits `otherwise` when the spec has no else arm, so the step escapes instead', () => {
    const text = moduleFor(BRANCH_WITHOUT_ELSE);

    expect(text).toContain("    then: new Pipeline([['answer', demoStep1Then0AnswerStep]]),");
    expect(text).not.toContain('otherwise:');
  });

  it('names the depth bound after the runtime constant rather than a number', () => {
    const text = moduleFor(BRANCH_WITH_ELSE);

    expect(text).toContain('maxDepth: MAX_STEP_DEPTH,');
    expect(text).not.toContain('maxDepth: 4');
  });
});

describe('the parallel composite', () => {
  it('emits one raw `Pipeline` per arm, in declaration order', () => {
    const text = moduleFor(PARALLEL);

    expect(text).toContain('parallel({');
    expect(text).toContain('  MAX_STEP_DEPTH,');
    // Raw arrays rather than a per-arm constant: `parallel` takes a `Pipeline` of what
    // each arm binds, and arm order is the order it merges them in.
    expect(text).toContain(
      "    branches: [\n      new Pipeline([['left', demoStep1Arm00LeftStep]]),\n" +
        "      new Pipeline([['right', demoStep1Arm10RightStep]]),\n    ],",
    );
    expect(text).toContain('Run all 2 arms concurrently');
    expect(text).toContain('maxDepth: MAX_STEP_DEPTH,');
  });
});

describe('the map composite', () => {
  it('emits `mapStep` over the binding name, with the body as its `step`', () => {
    const text = moduleFor(MAP);

    expect(text).toContain('mapStep({');
    // `over` names a context binding, which is why it stays a literal rather than
    // becoming a `context.require` at the call site: the helper reads it itself.
    expect(text).toContain("    over: 'handbook',");
    expect(text).toContain("    as: 'mapped',");
    expect(text).toContain("    step: new Pipeline([['each', demoStep1Step0EachStep]]),");
    expect(text).toContain('maxDepth: MAX_STEP_DEPTH,');
  });

  it('is emitted for a binding the plan does not type, because the runtime is the checker', () => {
    // What this pins: the emitter hands `over` to the helper as a name and the plan is
    // satisfied by *binding*, not by shape. `handbook` here is a `RetrievalResult`, which
    // `itemsOf` rejects at run time, and the module still emits cleanly -- so the gap is
    // in the spec language (nothing binds a list), not in the emitter, and it must be
    // stated rather than papered over by a plan-time shape check the IR cannot supply.
    const text = moduleFor(MAP);

    expect(text).toContain("    over: 'handbook',");
    expect(text).not.toContain("over: context.require('handbook')");
    // The iteratee is a nested `Pipeline` keyed by the plan's own step name, and the
    // runtime seeds the item and index under its own keys inside `mapStep` -- so the
    // emitter never spells either one, and never needs to know the element type.
    expect(text).toContain("step: new Pipeline([['each', demoStep1Step0EachStep]]),");
    expect(text).not.toContain('ITEM_KEY');
  });
});

describe('the reduce composite', () => {
  it('synthesises the per-item generate and collects it as `reduced`', () => {
    const text = moduleFor(REDUCE);

    expect(text).toContain('reduceStep({');
    expect(text).toContain("    over: 'handbook',");
    expect(text).toContain("    as: 'summaries',");
    // The body is a generate the emitter makes up, so the name it binds is the runtime's
    // to choose and is not the spec's to reuse.
    expect(text).toContain("    step: new Pipeline([['reduced', demoStep1ItemReducedStep]]),");
    expect(text).toContain('export const demoStep1ItemReducedStep: Step = async (context) => {');
  });

  it('reads the iteration item out of the context, which is what makes the body compile', () => {
    const text = moduleFor(REDUCE);

    // A bare `item` identifier does not resolve inside the emitted step function; the
    // value has to come from the context the runtime seeded for this iteration.
    expect(text).toContain("    subject: context.require('item'),");
    expect(text).toContain('const rendered = deps.prompts.render');
  });
});

describe('composite nesting', () => {
  it('emits a composite inside a composite, each with its own depth bound', () => {
    const text = moduleFor(`${RETRIEVE}
      - branch:
          when: 'hasRole("admin")'
          then:
            - map:
                over: handbook
                as: mapped
                step:
                  generate:
                    prompt: classify
                    input:
                      subject: "each"
                    as: each`);

    expect(text).toContain('branch({');
    expect(text).toContain('mapStep({');
    // The nested composite is an ordinary member of the arm's `Pipeline`. It registers
    // under its constant rather than under `mapped`: the runtime binds through
    // `withValues`, so the registered name is for tracing, and the constant is the only
    // one of the two that is unique across arms.
    expect(text).toContain(
      "    then: new Pipeline([['demoStep1Then0MappedStep', demoStep1Then0MappedStep]]),",
    );
    // One bound per composite, both naming the runtime's constant.
    expect(text.match(/maxDepth: MAX_STEP_DEPTH,/gu)).toHaveLength(2);
    expect(text.match(/name: 'demoStep/gu)).toHaveLength(2);
  });
});

describe('composite arm scope', () => {
  it('refuses a later step that reads a name an arm bound', () => {
    // `Pipeline` scopes a binding to its own pipeline, so `answer` does not exist after
    // the `branch` returns. The emitter must refuse rather than emit a `context.require`
    // that would throw on the first request. The reader is nested because the security
    // gate refuses any top-level `generate` on caller text without an input guardrail,
    // and that gate would answer first.
    const steps = `${RETRIEVE}
      - branch:
          when: 'hasRole("admin")'
          then:
            - generate:
                prompt: classify
                input:
                  subject: "admin"
                as: answer
      - parallel:
          branches:
            - - generate:
                  prompt: classify
                  input:
                    subject: "later"
                  context: answer
                  as: final`;

    expect(() => moduleFor(steps)).toThrow(/answer/u);
  });
});
