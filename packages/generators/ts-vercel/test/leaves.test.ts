/**
 * The three newer leaves -- `rerank`, `guard`, `agent` -- and the generate step's
 * guardrail calls, as the pipeline module emits them.
 *
 * Every emission case is a whole spec through `buildForSpecText`, so a leaf that emitted
 * but could not be planned fails here rather than in a later layer. Every refusal case
 * calls `checkPlan` on an IR that already passed the spec checks and the build gates,
 * which is what makes the refusal this package's rather than an earlier stage's.
 *
 * The fixture declares a guardrail at three stages, which is what a spec has to do
 * before it can contain both a `guard` step and a top-level `generate`: the security
 * gate demands an `input` stage when caller text reaches a prompt, and F-B's output
 * check is emitted only when some guardrail declares `output`.
 */

import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { emitPipelineModule } from '../src/emit/pipelines.js';
import { planTsVercel } from '../src/index.js';
import { checkPlan } from '../src/validate.js';
import { buildForSpecText, fileMap, irForSpecText } from './helpers.js';

/** A spec whose only interesting part is its step list and its one guardrail. */
function specWith(steps: string, stages = '[input, output, retrieval]'): string {
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
  lexical:
    provider: fake
    modelId: lexical-rerank-1
  triage:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools]
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 400

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
  brief:
    version: 1
    model: triage
    template: |
      Triage the ticket in one sentence.
    output:
      kind: text

guardrails:
  handbook_pii:
    stages: ${stages}
    policies: [pii-detect]
    action: block
    onFail:
      message: The payload was refused.
      log: true

memory:
  thread:
    kind: buffer
    scope: thread
    tokenBudget: 2000

agents:
  triage_agent:
    name: Triage
    instructions: brief
    model: triage
    tools: []
    guardrails: [handbook_pii]
    memory: [thread]
    maxSteps: 4
    maxCostBudget: 0.05

pipelines:
  demo:
    description: A pipeline whose shape is the whole point.
    trigger:
      http:
        method: post
        path: /demo
    steps:
${steps}
`;
}

/** The pipeline module a spec emits, proved to be the one the plan ships. */
function moduleFor(steps: string, stages?: string): string {
  const build = buildForSpecText(specWith(steps, stages));
  const pipeline = build.ir.pipelines[0];
  if (pipeline === undefined) throw new Error('the fixture lowered to no pipeline');
  const content = emitPipelineModule(build.ir, pipeline).content;
  expect(fileMap(build.plan.files).get('app/generated/pipelines/demo.ts')).toBe(content);
  return content;
}

/** Codes `checkPlan` reports, without planning -- the shape py's suite uses. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

/** An IR that passed the spec checks and the gates, for a refusal case to plan. */
function irFor(steps: string, stages?: string): IR {
  return irForSpecText(specWith(steps, stages));
}

const RETRIEVE = `      - retrieve:
          retriever: handbook
          query: "{{ event.subject }}"
          as: handbook`;

describe('the rerank leaf', () => {
  it('rebuilds the retrieval around the rescored items rather than binding a bare list', () => {
    const content = moduleFor(`${RETRIEVE}
      - rerank:
          over: handbook
          query: "{{ event.subject }}"
          model: lexical
          topN: 2
          as: ranked`);

    expect(content).toContain('export const demoRankedStep: Step = async (context) => {');
    expect(content).toContain("const over = context.require('handbook') as RetrievalResult;");
    expect(content).toContain(
      "const reranker = rerankerFor(new RerankSpec({ model: 'lexical', topN: 2 }));",
    );
    expect(content).toContain('if (reranker === null) {');
    expect(content).toContain('const ranked = new RetrievalResult({');
    // The retriever, the query and the citations survive: only the order changes, which is
    // what lets a later step still read `.context` and `.top(n)` off `ranked`.
    expect(content).toContain('  retriever: over.retriever,');
    expect(content).toContain('  query: over.query,');
    expect(content).toContain('  items: await reranker.rerank(query, over.items, { topN: 2 }),');
    expect(content).toContain('return context.withValues({ ranked: ranked });');
  });

  it('refuses a model that is not a lexical reranker', () => {
    const ir = irFor(`${RETRIEVE}
      - rerank:
          over: handbook
          query: "rescore"
          model: fast
          topN: 2
          as: ranked`);

    expect(codes(ir)).toContain('step-unsupported');
    expect(() => planTsVercel(ir)).toThrow(/lexical/);
  });
});

describe('the guard leaf', () => {
  it('enforces the one declaration it names, at the retrieval stage, over the strings', () => {
    const content = moduleFor(`${RETRIEVE}
      - guard:
          guardrail: handbook_pii
          stage: retrieval
          text: "{{ handbook }}"`);

    expect(content).toContain('export const demoStep1GuardStep: Step = async (context) => {');
    expect(content).toContain("const over = context.require('handbook') as RetrievalResult;");
    expect(content).toContain('const payload = over.items.map((item) => item.chunk.text);');
    expect(content).toContain(
      "enforceGuardrail(ENGINE.checkRetrieval([guardrailById('handbook_pii')], payload));",
    );
    // A guard step binds nothing and returns the context it was handed: the runtime raises
    // a `block`, so there is no verdict here for a caller to ignore.
    expect(content).toContain('  return context;');
    const guard = content.slice(content.indexOf('export const demoStep1GuardStep'));
    expect(guard).not.toContain('withValues');
  });

  it('renders the template it is handed at the input stage', () => {
    const content = moduleFor(`      - generate:
          prompt: classify
          input:
            subject: "literal"
          as: answer
      - guard:
          guardrail: handbook_pii
          stage: input
          text: "{{ answer }}"`);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source, not interpolation
    expect(content).toContain("const payload = `${context.require('answer')}`;");
    expect(content).toContain(
      "enforceGuardrail(ENGINE.checkInput([guardrailById('handbook_pii')], payload));",
    );
  });

  it('refuses the tool-call stage, which the loop already guards', () => {
    const ir = irFor(`      - guard:
          guardrail: handbook_pii
          stage: tool-call
          text: "x"`);

    expect(codes(ir)).toContain('step-unsupported');
    expect(() => planTsVercel(ir)).toThrow(/tool-call/);
  });

  it('refuses a stage the named guardrail does not declare', () => {
    const ir = irFor(
      `${RETRIEVE}
      - guard:
          guardrail: handbook_pii
          stage: output
          text: "{{ handbook }}"`,
      '[input, retrieval]',
    );

    expect(codes(ir)).toContain('step-invalid');
    expect(() => planTsVercel(ir)).toThrow(/does not declare the output stage/);
  });

  it('refuses a retrieval-stage guard that names no binding to guard', () => {
    const ir = irFor(`${RETRIEVE}
      - guard:
          guardrail: handbook_pii
          stage: retrieval
          text: "nothing to guard"`);

    expect(codes(ir)).toContain('step-invalid');
    expect(() => planTsVercel(ir)).toThrow(/exactly one retrieval binding/);
  });
});

describe('the agent leaf', () => {
  it('runs the declared agent over the rendered text and binds the completed answer', () => {
    const content = moduleFor(`      - agent:
          agent: triage_agent
          text: "{{ event.subject }}"
          as: triaged`);

    expect(content).toContain('export const demoTriagedStep: Step = async (context) => {');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitted source, not interpolation
    expect(content).toContain('const text = `${event.subject}`;');
    expect(content).toContain(
      "const outcome = await buildAgentRuntime(deps).run('triage_agent', text, {",
    );
    expect(content).toContain('    principal: principalOf(context),');
    // A run that stopped short -- budget exhausted, a guardrail that escalates -- has no
    // answer or a partial one, and an `emit` downstream cannot tell that from a finished
    // one, so the step raises rather than binding it.
    expect(content).toContain(
      "if (outcome.status !== 'completed' || outcome.answer === undefined) {",
    );
    expect(content).toContain('throw new PipelineError(`agent triage_agent did not complete:');
    expect(content).toContain('const triaged = outcome.answer;');
    expect(content).toContain('return context.withValues({ triaged: triaged });');
  });

  it('refuses an agent that is not declared', () => {
    // The referential gate already refuses this from spec text, so the plan-level branch is
    // reached by mutating an IR that passed the gates -- otherwise the assertion would
    // pin the gate's message rather than this package's.
    const ir = irFor(`      - agent:
          agent: triage_agent
          text: "x"
          as: triaged`);
    const pipeline = ir.pipelines[0];
    if (pipeline === undefined) throw new Error('the fixture lowered to no pipeline');
    const rewritten: IR = {
      ...ir,
      pipelines: [
        {
          ...pipeline,
          steps: pipeline.steps.map((step) =>
            step.kind === 'agent' ? { ...step, agent: 'missing_agent' } : step,
          ),
        },
      ],
    };

    expect(codes(rewritten)).toContain('reference-unresolved');
    expect(() => planTsVercel(rewritten)).toThrow(/missing_agent/);
  });

  it('refuses an instructions prompt whose variables the loop never renders', () => {
    const ir = irFor(`      - agent:
          agent: triage_agent
          text: "x"
          as: triaged`);

    // Re-point the agent at `classify`, which declares `subject`; the loop hands the
    // template to the model verbatim, so `{{ subject }}` would reach it unrendered.
    const rewritten: IR = {
      ...ir,
      agents: ir.agents.map((agent) => ({ ...agent, instructions: 'classify' })),
    };

    expect(codes(rewritten)).toContain('agent-unsupported');
    expect(() => planTsVercel(rewritten)).toThrow(/variables/);
  });
});

describe("the generate leaf's guardrail calls (F-B)", () => {
  it('sends the answer through the output guardrail before binding it', () => {
    const content = moduleFor(`      - generate:
          prompt: classify
          input:
            subject: "{{ event.subject }}"
          as: answer`);

    // The check is inside the `call` closure, so the retry `runStructured` performs is
    // guarded too -- an answer that trips the guardrail is never bound, not even once.
    expect(content).toContain(
      'return enforceGuardrail(ENGINE.checkOutput(OUTPUT_GUARDRAILS, result.text)).text;',
    );
    expect(content).toContain(
      'const verdict = enforceGuardrail(ENGINE.checkInput(INPUT_GUARDRAILS, rendered.text));',
    );
  });

  it('emits no output check when no guardrail declares the output stage', () => {
    // The `input` stage stays declared: the security gate refuses caller text reaching a
    // prompt without one, and the point here is the output side alone.
    const content = moduleFor(
      `      - generate:
          prompt: classify
          input:
            subject: "{{ event.subject }}"
          as: answer`,
      '[input, retrieval]',
    );

    expect(content).not.toContain('checkOutput(');
    expect(content).not.toContain('OUTPUT_GUARDRAILS');
  });
});
