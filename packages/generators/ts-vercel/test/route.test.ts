/**
 * The `route` composite, as the pipeline module emits it.
 *
 * Each case is a whole spec through `buildForSpecText`, which is the same road the CLI
 * takes -- spec checks, lowering, build gates, then the planner. The prompt is
 * `structured` and the model declares `json-schema` because this target emits structured
 * answers only; the first step is the route itself, so nothing has to bind a name the
 * route's input could interpolate.
 */

import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { emitPipelineModule } from '../src/emit/pipelines.js';
import { planTsVercel } from '../src/index.js';
import { buildForSpecText, fileMap } from './helpers.js';

const DEFAULT_CRITERIA = `      product: A question about features
      billing: A question about an invoice
      off_topic: Anything unrelated`;

/** A spec whose only interesting part is its route step. */
function specWith(route: string, criteria?: string): string {
  return `specVersion: "0.9"

project:
  name: demo
  namespace: aid.demo
  targets:
    - ts-vercel

types:
  Answer:
    kind: struct
    fields:
      reply:
        type: string
        required: true

decisions:
  topic:
    provider: typesafe
    model: jev-1.14.0
    type: choice
    instructions: Which part of the product is this question about
    criteria:
${criteria ?? DEFAULT_CRITERIA}

models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]

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
    description: A route picks the arm from the decision's answer.
    trigger:
      http:
        method: post
        path: /demo
    steps:
${route}

deployments:
  api:
    target: container
    secrets: []
`;
}

/** The pipeline module a spec emits, proved to be the one the plan ships. */
function moduleFor(route: string, criteria?: string): string {
  const build = buildForSpecText(specWith(route, criteria));
  const pipeline = build.ir.pipelines[0];
  if (pipeline === undefined) throw new Error('the fixture lowered to no pipeline');
  const content = emitPipelineModule(build.ir, pipeline).content;
  expect(fileMap(build.plan.files).get('app/generated/pipelines/demo.ts')).toBe(content);
  return content;
}

const EXHAUSTIVE = `      - route:
          decision: topic
          input: "the customer wrote in"
          on:
            product:
              - generate:
                  prompt: classify
                  input:
                    subject: "product"
                  as: reply
            billing:
              - generate:
                  prompt: classify
                  input:
                    subject: "billing"
                  as: reply
            off_topic:
              - generate:
                  prompt: classify
                  input:
                    subject: "other"
                  as: reply
          as: path`;

const WITH_DEFAULT = `      - route:
          decision: topic
          input: "the customer wrote in"
          on:
            product:
              - generate:
                  prompt: classify
                  input:
                    subject: "product"
                  as: reply
          default:
            - generate:
                prompt: classify
                input:
                  subject: "other"
                as: reply
          as: path`;

describe('the route composite', () => {
  it('asks the decision and runs the arm its label names', () => {
    const text = moduleFor(EXHAUSTIVE);

    expect(text).toContain('route({');
    expect(text).toContain("    decision: 'topic',");
    // A literal input is the text it is: no template, and so no interpolation.
    expect(text).toContain('    state: `the customer wrote in`,');
    expect(text).toContain(
      "    on: {\n      'billing': new Pipeline([['reply', demoStep0On00ReplyStep]]),\n" +
        "      'off_topic': new Pipeline([['reply', demoStep0On10ReplyStep]]),\n" +
        "      'product': new Pipeline([['reply', demoStep0On20ReplyStep]]),\n    },",
    );
    expect(text).toContain("    as: 'path',");
    expect(text).toContain('    decisions: DECISIONS,');
    expect(text).toContain('    maxDepth: MAX_STEP_DEPTH,');
    expect(text).toContain("    name: 'demoStep0RouteStep',");
  });

  it('carries one definition table for the decisions its routes name', () => {
    const text = moduleFor(EXHAUSTIVE);

    expect(text).toContain('const DECISIONS: Record<string, RouteDecision> = {');
    expect(text).toContain(
      "  'topic': {\n    model: 'jev-1.14.0',\n" +
        "    instructions: 'Which part of the product is this question about',\n" +
        "    criteria: ['billing', 'off_topic', 'product'],\n  },",
    );
    expect(text).toContain('type RouteDecision,');
  });

  it('gives every arm its own constant, even when the arms bind one name', () => {
    const text = moduleFor(EXHAUSTIVE);

    // All three arms bind `reply`; naming the constants after the binding alone would
    // emit three `replyStep` constants, two of which could never be referenced.
    expect(text).toContain('export const demoStep0On00ReplyStep: Step = async (context) => {');
    expect(text).toContain('export const demoStep0On10ReplyStep: Step = async (context) => {');
    expect(text).toContain('export const demoStep0On20ReplyStep: Step = async (context) => {');
  });

  it('omits `otherwise` when `on` already covers every label', () => {
    const text = moduleFor(EXHAUSTIVE);

    expect(text).not.toContain('otherwise:');
  });

  it('keeps arms apart when two labels fold to the same identifier', () => {
    // Both labels sanitize to `offTopic`, so naming a constant after the label alone
    // would emit the same name twice and only one arm would be reachable.
    const text = moduleFor(
      `      - route:
          decision: topic
          input: "the customer wrote in"
          on:
            off-topic:
              - generate:
                  prompt: classify
                  input:
                    subject: "hyphens"
                  as: reply
            off_topic:
              - generate:
                  prompt: classify
                  input:
                    subject: "underscores"
                  as: reply`,
      `      off-topic: A question about hyphens
      off_topic: A question about underscores`,
    );

    expect(text).toContain('export const demoStep0On00ReplyStep: Step = async (context) => {');
    expect(text).toContain('export const demoStep0On10ReplyStep: Step = async (context) => {');
  });

  it('passes a default arm as `otherwise` and binds the answered label', () => {
    const text = moduleFor(WITH_DEFAULT);

    expect(text).toContain("    otherwise: new Pipeline([['reply', demoStep0Default0ReplyStep]]),");
    expect(text).toContain("    as: 'path',");
    expect(text).not.toContain("    'off_topic':");
  });
});

/** The IR a valid exhaustive route lowers to, for cases only an IR can express. */
function routeIr(): IR {
  return buildForSpecText(specWith(EXHAUSTIVE)).ir;
}

describe('the route plan checks', () => {
  it('refuses a decision that cannot name an arm', () => {
    const ir = structuredClone(routeIr()) as unknown as {
      decisions: { type: string }[];
    };
    const decision = ir.decisions[0];
    if (decision === undefined) throw new Error('the fixture declared no decision');
    decision.type = 'noul';

    expect(() => planTsVercel(ir as unknown as IR)).toThrow(
      /is a noul decision; a route asks which arm to run, so it needs a choice decision/,
    );
  });

  it('refuses a default that a mapped set already covers', () => {
    const ir = structuredClone(routeIr()) as unknown as {
      pipelines: { steps: Record<string, unknown>[] }[];
    };
    const route = ir.pipelines[0]?.steps[0];
    if (route === undefined) throw new Error('the fixture has no route step');
    route.default = [{ kind: 'emit', event: 'Answer' }];

    expect(() => planTsVercel(ir as unknown as IR)).toThrow(
      /declares a default, but every label is already mapped, so the arm can never run/,
    );
  });
});
