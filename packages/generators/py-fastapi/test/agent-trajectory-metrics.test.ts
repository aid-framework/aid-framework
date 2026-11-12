/**
 * The three metrics that read a trajectory rather than an answer: `step-count`,
 * `forbidden-tool` and `approval-respected`, as the Python target states them.
 *
 * The cases read the planned modules because that is what ships: a constant or call that
 * drifted between the emitter and the runtime would pass an emitter unit test and leave the
 * generated eval unable to ask. The refusals go through `checkPlan`, so each one is this
 * package's refusal rather than the spec layer's.
 *
 * The spec is written here rather than taken from the committed example because a
 * `forbidden-tool` metric has to name a tool the run could plausibly reach for and must not
 * reach. The example declares the two tools its own trace expects, so forbidding either one
 * there would be a spec that contradicts itself; the refusal is the point of the metric and
 * it needs a third, destructive tool to point at.
 */

import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { evalModulePath, FORBIDDEN_TOOLS, planPyFastApi } from '../src/index.js';
import { checkPlan } from '../src/validate.js';
import { assignedValue, buildForSpecText } from './helpers.js';

const EVAL_ID = 'refund_trajectory';

const BASE_SPEC = `specVersion: "0.31"

project:
  name: trajectory-metrics
  namespace: aid.test.trajectorymetrics
  targets: [py-fastapi]

types:
  Reply:
    kind: struct
    fields:
      summary:
        type: string
        required: true
  Customer:
    kind: struct
    fields:
      id:
        type: string
        required: true
  Refund:
    kind: struct
    fields:
      amount:
        type: number
        required: true
  RefundReceipt:
    kind: struct
    fields:
      reference:
        type: string
        required: true
  Erasure:
    kind: struct
    fields:
      customer:
        type: string
        required: true
  ErasureReceipt:
    kind: struct
    fields:
      reference:
        type: string
        required: true

models:
  triage:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools]

prompts:
  agent_instructions:
    version: 1
    model: triage
    template: |
      Look the account up, then settle the ticket in one sentence.
    output:
      kind: text

tools:
  lookup_customer:
    description: Look up the account that filed a ticket.
    input: Customer
    output: Customer
    handler:
      kind: business
      symbol: lookup_customer
    sideEffects: read
  issue_refund:
    description: Issue a refund against the account that filed a ticket.
    input: Refund
    output: RefundReceipt
    handler:
      kind: business
      symbol: issue_refund
    sideEffects: write
    requiresConfirmation: true
    auth: isAuthenticated()
  delete_customer:
    description: Erase the account and everything filed under it.
    input: Erasure
    output: ErasureReceipt
    handler:
      kind: business
      symbol: delete_customer
    sideEffects: destructive
    auth: hasRole("data_protection")

guardrails:
  screened:
    stages: [input]
    policies: [pii-detect]
    action: flag
    onFail:
      message: The screen recorded this payload.
      log: true
  inspected:
    stages: [tool-call]
    policies: [secret-scan]
    action: block
    onFail:
      message: The call was refused.
      log: true

agents:
  refund_agent:
    name: Refund agent
    instructions: agent_instructions
    model: triage
    tools: [lookup_customer, issue_refund, delete_customer]
    maxSteps: 6
    maxCostBudget: 0.05
    humanInTheLoop:
      when: "true"
      channel: reviews

pipelines:
  answer_ticket:
    description: Answer a ticket with one agent prompt.
    trigger:
      http:
        method: post
        path: /tickets/answer
    steps:
      - generate:
          prompt: agent_instructions
          as: answer
      - emit:
          event: Reply
`;

/** The eval block appended last, so the metric list is the only thing a case changes. */
function withEval(metrics: string, target = 'agent:refund_agent'): string {
  return `${BASE_SPEC}
evals:
  ${EVAL_ID}:
    target: ${target}
    dataset:
      source: file
      uri: evals/refund_trajectory.json
    metrics:
${metrics}    gate:
      ci: true
      maxRegression: 0.1
      samples: 3
`;
}

const TRAJECTORY = `      - kind: tool-trace
        expect: [lookup_customer, issue_refund]
        ordered: true
      - kind: step-count
        maxSteps: 4
      - kind: forbidden-tool
        forbid: [delete_customer]
      - kind: approval-respected
`;

/** The two metrics that need no tool list, for the case that asserts what is not emitted. */
const WITHOUT_FORBIDDEN = `      - kind: step-count
        maxSteps: 4
      - kind: approval-respected
`;

type Built = ReturnType<typeof buildForSpecText>;

/** The plan-problem codes for an IR, in order. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

/** The generated eval module, or a failure naming the path that vanished. */
function evalSource(metrics: string): string {
  const { ir } = buildForSpecText(withEval(metrics));
  const path = evalModulePath(EVAL_ID);
  const file = planPyFastApi(ir).files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`the plan emitted no ${path}`);
  return file.content;
}

describe('the trajectory metrics an agent eval declares', () => {
  it('accepts all three on an agent target', () => {
    const { ir }: Built = buildForSpecText(withEval(TRAJECTORY));

    expect(codes(ir)).not.toContain('unsupported-metric');
  });

  it('hoists the forbidden tools into a constant the metric reads', () => {
    const source = evalSource(TRAJECTORY);

    expect(FORBIDDEN_TOOLS).toBe('FORBIDDEN_TOOLS');
    expect(assignedValue(source, FORBIDDEN_TOOLS)).toBe('("delete_customer",)');
    // The metric reads the constant rather than repeating the tuple inline, so a longer
    // list folds the way `ruff format` would fold it instead of rewriting the whole line.
    expect(source).toContain(`ForbiddenTool(forbid=${FORBIDDEN_TOOLS})`);
  });

  it('passes the per-case step ceiling through to the metric', () => {
    const source = evalSource(TRAJECTORY);

    expect(source).toContain('StepCount(max_steps=4)');
  });

  it('asks whether the run respected the pauses it was given', () => {
    const source = evalSource(TRAJECTORY);

    // No argument: the runtime compares the pauses the run took against the decisions its
    // case supplied, so there is nothing for the spec to configure.
    expect(source).toContain('ApprovalRespected()');
  });

  it('thresholds on all three rather than measuring them and dropping the result', () => {
    const source = evalSource(TRAJECTORY);

    // A module whose `metrics()` builds a metric its `thresholds()` never names reports a
    // number no gate reads, which is indistinguishable from not measuring it at all.
    for (const metric of ['step-count', 'forbidden-tool', 'approval-respected']) {
      expect(source).toContain(`Threshold(metric="${metric}"`);
    }
  });

  it('emits no forbidden-tool constant when no metric declares one', () => {
    const source = evalSource(WITHOUT_FORBIDDEN);

    expect(source).not.toContain(`FORBIDDEN_TOOLS = `);
    expect(source).toContain('StepCount(max_steps=4)');
  });
});

describe('what the Python target refuses about a trajectory metric', () => {
  /**
   * The base IR with every eval re-pointed at the pipeline.
   *
   * The IR's own trajectory gate refuses these kinds on a non-agent target first, so this
   * shape cannot be built from a spec: the mutation exists to prove the generator refuses it
   * independently, on an IR that reached it by some other route. Asserting it through a spec
   * would test the gate this package does not own.
   */
  function retargeted(ir: IR): IR {
    return {
      ...ir,
      evals: ir.evals.map((evaluation) => ({
        ...evaluation,
        target: {
          kind: 'pipeline' as const,
          id: 'answer_ticket',
          qualified: 'pipeline:answer_ticket',
          valid: true,
        },
      })),
    };
  }

  it('refuses each one on a pipeline target, naming what it would have nothing to read', () => {
    const one: Record<string, string> = {
      'step-count': '      - kind: step-count\n        maxSteps: 4\n',
      'forbidden-tool': '      - kind: forbidden-tool\n        forbid: [delete_customer]\n',
      'approval-respected': '      - kind: approval-respected\n',
    };

    for (const [kind, metrics] of Object.entries(one)) {
      const { ir }: Built = buildForSpecText(withEval(metrics));
      const problems = checkPlan(retargeted(ir));

      expect(problems.map((problem) => problem.code)).toContain('unsupported-metric');
      const messages = problems.map((problem) => problem.message).join('\n');
      expect(messages).toContain(`metric '${kind}' cannot be measured`);
      expect(messages).toContain('nothing to score');
    }
  });
});
