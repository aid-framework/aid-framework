/**
 * The emitted shape of a composite step: an `async def` that builds the runtime's callable
 * and hands it the step functions for its arms.
 *
 * Two things are easy to get wrong here and neither is visible in a diff of the example,
 * because the example's `parallel` does not change its response bytes. The first is
 * *reachability*: a composite that names an arm nobody emitted produces a module that
 * raises `NameError` on the first request. Python's module scope is flat and `Pipeline`
 * refuses duplicate step names, so every nested step needs a name unique across the whole
 * module even though its binding name is unique only within its scope -- otherwise the
 * second branch arm silently shadows the first and both arms run the same body. The
 * second is *ordering*: the arm functions have to be defined before the composite that
 * refers to them.
 *
 * Both are asserted by reading the emitted module, not by asking the emitter what it
 * thinks it did. A helper that returns the right name into a body that then ignores it is
 * exactly the defect class these tests exist to catch.
 *
 * Every block ends with a mutation that has been shown to be caught.
 */

import { describe, expect, it } from 'vitest';

import { MAX_LINE } from '../src/python.js';
import { compositePlan, fileAt, irForSpecText, planForSpecText } from './composite.js';
import { EXAMPLE_SPEC_PATH, example, exampleSpecText } from './helpers.js';

const TRIAGE = 'app/generated/pipelines/triage.py';
const GUARDED = 'app/generated/pipelines/guarded.py';
const ANSWER = 'app/generated/pipelines/answer_ticket.py';

/**
 * A branch with no `else`, whose then-arm binds a name nothing downstream reads.
 *
 * Both halves matter: omitting `otherwise` is only sound when the arm's bindings are not
 * needed after the branch, so a spec that read `note` afterwards would be rejected by the
 * validator rather than emitted.
 */
const NO_ELSE_SPEC = `specVersion: "0.2"
project:
  name: noelse
  description: A branch with no alternative, whose arm binds nothing read later.
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
    modelId: fake-echo
    capabilities: [json-schema]
prompts:
  note:
    version: 1
    model: fast
    template: "Write a note about {{subject}}"
    variables:
      subject:
        type: string
        required: true
    output:
      kind: text
  compose:
    version: 1
    model: fast
    template: "Compose the reply from {{source}}"
    variables:
      source:
        type: string
        required: true
    output:
      kind: structured
      schema: Reply
deployments:
  prod:
    target: serverless
    secrets: [FAKE_API_KEY]
    concurrency: 2
pipelines:
  guarded:
    trigger:
      http:
        method: post
        path: /guarded
    steps:
      - branch:
          when: "hasRole('agent')"
          then:
            - generate:
                prompt: note
                input:
                  subject: "{{event.subject}}"
                as: note
      - generate:
          prompt: compose
          input:
            source: "{{event.subject}}"
          as: report
      - emit:
          event: Reply
`;

/**
 * A module whose only read of a request field is inside a composite arm.
 *
 * The request model is derived from what the pipeline reads, so a body that reads a local
 * the enclosing module never opened fails at request time with a 422 or a `NameError`
 * rather than at build time. Putting the only read of `event.body` inside an arm is the
 * smallest spec that asks whether composite children are walked at all.
 */
const NESTED_ROOT_SPEC = `specVersion: "0.2"
project:
  name: nestedroots
  description: A composite whose only read of a request field is inside one arm.
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
    modelId: fake-echo
    capabilities: [json-schema]
prompts:
  annotate:
    version: 1
    model: fast
    template: "Note about {{subject}} in the light of {{body}}"
    variables:
      subject:
        type: string
        required: true
      body:
        type: string
        required: true
    output:
      kind: text
  reply:
    version: 1
    model: fast
    template: "Reply from {{source}}"
    variables:
      source:
        type: string
        required: true
    output:
      kind: structured
      schema: Reply
deployments:
  prod:
    target: serverless
    secrets: [FAKE_API_KEY]
    concurrency: 2
pipelines:
  nested:
    trigger:
      http:
        method: post
        path: /nested
    steps:
      - parallel:
          branches:
            - - generate:
                  prompt: annotate
                  input:
                    subject: "{{event.subject}}"
                    body: "{{event.body}}"
                  as: note
            - - generate:
                  prompt: annotate
                  input:
                    subject: "{{event.subject}}"
                    body: "{{event.body}}"
                  as: advice
      - generate:
          prompt: reply
          input:
            source: "{{note}} {{advice}}"
          as: report
      - emit:
          event: Reply
`;

/** Every `async def` name in a module. */
function definedNames(source: string): string[] {
  return [...source.matchAll(/^async def (\w+)\(/gm)].map((match) => match[1] as string);
}

/** Every name a module hands to `Pipeline.of(...)`, flattened out of nested calls. */
function pipedNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/Pipeline\.of\(([^)]*)\)/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim();
      if (name !== '') names.push(name);
    }
  }
  return names;
}

/** The index of the line that defines a function, or -1. */
function definitionLine(source: string, name: string): number {
  return source.split('\n').findIndex((line) => line.startsWith(`async def ${name}(`));
}

describe('a composite names step functions that exist', () => {
  it('emits every arm before the composite that hands it to the runtime', () => {
    const triage = fileAt(compositePlan(), TRIAGE);

    // A composite with a missing arm is a `NameError` on the first request, and an arm
    // defined after the composite is the same failure one import earlier.
    for (const name of pipedNames(triage)) {
      expect(definitionLine(triage, name), `${name} is piped but never defined`).toBeGreaterThan(
        -1,
      );
    }

    const composite = definitionLine(triage, '_branch_1');
    for (const arm of ['_branch_1_then_1_escalation', '_branch_1_else_1_escalation']) {
      expect(definitionLine(triage, arm), `${arm} is not defined`).toBeGreaterThan(-1);
      expect(definitionLine(triage, arm), `${arm} is defined after its composite`).toBeLessThan(
        composite,
      );
    }
  });

  it('gives every nested step a name unique in the module', () => {
    // Python's module scope is flat, so two arms both called `escalation` would mean the
    // second definition shadowed the first and *both* arms ran the same body. The binding
    // name is unique per scope, which is why the step name cannot be the binding name.
    const names = definedNames(fileAt(compositePlan(), TRIAGE));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size, `duplicate definitions among ${names.join(', ')}`).toBe(
      names.length,
    );

    // Both arms bind `escalation`, so the two functions share a suffix and differ in the
    // position segment. That is the property, not a spelling to remember.
    expect(names).toContain('_branch_1_then_1_escalation');
    expect(names).toContain('_branch_1_else_1_escalation');
  });

  it('walks into as many levels as the spec nested', () => {
    // `map` inside a pipeline, and a `reduce` that synthesises its own body step: both are
    // children of a composite rather than of the pipeline, so a non-recursive walk would
    // emit the wrapper and none of the work.
    const triage = fileAt(compositePlan(), TRIAGE);
    expect(triage).toContain('async def _map_3_body_1_one_grade(');
    expect(triage).toContain('async def _reduce_4_item(');
    expect(triage).toContain('step=Pipeline.of(_map_3_body_1_one_grade)');
    expect(triage).toContain('step=Pipeline.of(_reduce_4_item)');
  });
});

describe('the arms a composite is given', () => {
  it('are all of a parallel’s branches, in the order the spec declared them', () => {
    const triage = fileAt(compositePlan(), TRIAGE);
    const parallel = triage.slice(triage.indexOf('async def _parallel_2('));
    const body = parallel.slice(0, parallel.indexOf('async def ', 10));

    expect(body).toContain('branches=[');
    expect(body).toContain('Pipeline.of(_parallel_2_arm_1_1_summary)');
    expect(body).toContain('Pipeline.of(_parallel_2_arm_2_1_advice)');
    // Input order is the merge order the runtime promises, so the order here is not
    // cosmetic: reversing it would reverse which arm's value wins for a shared name.
    expect(body.indexOf('_parallel_2_arm_1_1_summary')).toBeLessThan(
      body.indexOf('_parallel_2_arm_2_1_advice'),
    );
  });

  it('are both of a branch’s arms, with `else` spelled `otherwise`', () => {
    const triage = fileAt(compositePlan(), TRIAGE);
    const branch = triage.slice(triage.indexOf('async def _branch_1('));
    const body = branch.slice(0, branch.indexOf('async def ', 10));

    // `when` travels as the parsed PolicyExpr AST, not as the spec's source text, so the
    // runtime never re-parses a policy and `evaluate_policy` stays the only evaluator.
    expect(body).toContain('when={');
    expect(body).toContain('"name": "hasRole"');
    expect(body).toContain('"value": "agent"');
    expect(body).toContain('then=Pipeline.of(_branch_1_then_1_escalation)');
    expect(body).toContain('otherwise=Pipeline.of(_branch_1_else_1_escalation)');
  });

  it('omit `otherwise` entirely when the spec declared no else arm', () => {
    // `branch` without an `else` binds nothing at all, so passing an empty arm would be a
    // second, different statement about what the composite does. Nothing downstream reads
    // the then-arm's `note`, which is what keeps the spec valid: a name bound by only one
    // arm and read later is a validation error, not something this test may sidestep.
    const branch = fileAt(planForSpecText(NO_ELSE_SPEC, 'no-else.yaml'), GUARDED);
    const body = branch.slice(branch.indexOf('async def _branch_1('));

    expect(body).toContain('then=Pipeline.of(_branch_1_then_1_note)');
    expect(body).not.toContain('otherwise=');
  });

  it('pass the iteration source as the key the runtime requires, not as a local', () => {
    // The wrapper body opens no locals: every arm is its own step function and opens what
    // it needs. `over` therefore travels as the string key the runtime resolves, which is
    // also what keeps a composite replayable by the streaming path.
    const triage = fileAt(compositePlan(), TRIAGE);
    const map = triage.slice(triage.indexOf('async def _map_3('));
    const body = map.slice(0, map.indexOf('async def ', 10));

    expect(body).toContain('over="excerpts"');
    expect(body).toContain('as_="grades"');
    expect(body).not.toContain('ctx.require("excerpts")');
  });
});

describe('the reduce body', () => {
  it('binds `reduced`, the name the runtime collects, not the step name', () => {
    // The body is synthesised from the reduce's prompt, and its function name is the
    // reduce's own plus a suffix. Its *binding* name is not free: `reduce_step` looks for
    // `REDUCED_KEY` in what the body returned, so renaming the binding to match the
    // function would make every reduce raise at run time.
    const triage = fileAt(compositePlan(), TRIAGE);
    const body = triage.slice(triage.indexOf('async def _reduce_4_item('));

    expect(body).toContain('return ctx.with_values(reduced=');
    expect(body).toContain('item = ctx.require("item")');
  });
});

describe('the depth bound reaches every composite', () => {
  it('passes the emitted constant as `max_depth` at each one', () => {
    const triage = fileAt(compositePlan(), TRIAGE);
    const composites = definedNames(triage).filter((name) =>
      /^_(branch|parallel|map|reduce)_\d+$/.test(name),
    );
    expect(composites.length).toBe(4);
    expect(triage.match(/max_depth=MAX_STEP_DEPTH/g)?.length).toBe(composites.length);
    expect(triage).toContain('from ..control import MAX_STEP_DEPTH');
  });
});

describe('a composite child that reads a request field', () => {
  it('gets a module that opens it, and a request model that declares it', () => {
    const plan = planForSpecText(NESTED_ROOT_SPEC, 'nested-roots.yaml');
    const pipeline = fileAt(plan, 'app/generated/pipelines/nested.py');
    const requests = fileAt(plan, 'app/generated/requests.py');

    // The arm is the only reader of `body`, so both halves are needed: the child body has
    // to open `event`, and the request model has to carry the field.
    const arm = pipeline.slice(pipeline.indexOf('async def _parallel_1_arm_1_1_note('));
    expect(arm.slice(0, arm.indexOf('async def ', 10))).toContain(
      'event = cast(NestedRequest, ctx.require("event"))',
    );
    expect(pipeline).toContain('event.body');
    expect(requests).toMatch(/class NestedRequest\(/);
    expect(requests).toContain('body: str');
  });
});

describe('the shipped example’s parallel', () => {
  it('is given both arms, and reads the binding that nothing else read', () => {
    // `customer` was bound but referenced nowhere before this layer, so the parallel was
    // the only consumer and, without this assertion, could have been dropped without
    // changing a byte of the response. That is why the example proves *wiring*: it shows
    // both arms exist and run under the cap, not that the output changed.
    const answer = fileAt(example().plan, ANSWER);

    const parallel = answer.slice(answer.indexOf('async def _parallel_1('));
    const body = parallel.slice(0, parallel.indexOf('async def ', 10));
    expect(body).toContain('Pipeline.of(_parallel_1_arm_1_1_customer_note)');
    expect(body).toContain('Pipeline.of(_parallel_1_arm_2_1_handbook_note)');

    // Both arms are reachable from the pipeline the route runs, in declared order.
    expect(answer).toContain(
      'Pipeline.of(_guard_1, customer, handbook, _parallel_1, triage, ranked, _guard_2, answer)',
    );

    // And each arm reads a binding that existed before it: the tool result and the
    // retrieval result. An arm that read only event fields would prove nothing about the
    // ordering the runtime promises over values earlier steps bound.
    const first = answer.slice(answer.indexOf('async def _parallel_1_arm_1_1_customer_note('));
    expect(first.slice(0, first.indexOf('async def ', 10))).toContain(
      'customer = cast(Customer, ctx.require("customer"))',
    );
    const second = answer.slice(answer.indexOf('async def _parallel_1_arm_2_1_handbook_note('));
    expect(second.slice(0, second.indexOf('async def ', 10))).toContain(
      'handbook = ctx.require("handbook")',
    );
  });

  it('declares the cap that bounds it, and imports the single limiter', () => {
    const answer = fileAt(example().plan, ANSWER);
    expect(answer).toContain('"limiter": deps.limiter');

    // The spec change is part of the layer: a fan-out with no declared cap is refused at
    // build time, so the example's parallel is evidence the cap was declared and threaded.
    const spec = exampleSpecText();
    expect(spec).toContain('concurrency: 4');
    expect(
      irForSpecText(spec, EXAMPLE_SPEC_PATH).deployments.some((d) => d.concurrency === 4),
    ).toBe(true);
  });

  it('is emitted into the tree the golden test compares', () => {
    // Both prompt modules the arms render must be planned, or the arm would import a
    // module the tree does not carry.
    for (const path of [
      'app/generated/prompts/customer_note.py',
      'app/generated/prompts/handbook_note.py',
    ]) {
      expect(fileAt(example().plan, path)).toContain('= PromptTemplate(');
    }
  });
});

describe('every emitted line fits the width the target formatter enforces', () => {
  // The tree this generator writes is checked with `ruff format --check`, so an emitted
  // line that overflows is a lint failure in the consumer's project. The width helpers
  // size their output for the column they are handed, which means a caller that hands one
  // a shallow indent reports a value as short enough while the line it lands on is not --
  // exactly what a four-entry context seed did at 101 columns behind a
  // `ctx = PipelineContext(values=` prefix. These tests read the emitted bytes rather than
  // the emitter's opinion of them.
  const overlong = (files: readonly { path: string; content: string }[]): string[] =>
    files
      .filter((file) => file.path.endsWith('.py'))
      .flatMap((file) =>
        file.content
          .split('\n')
          .map((line, index) => ({ number: index + 1, length: line.length }))
          .filter((line) => line.length > MAX_LINE)
          .map((line) => `${file.path}:${line.number} is ${line.length} columns`),
      );

  it('in the shipped example', () => {
    expect(overlong(example().plan.files)).toEqual([]);
  });

  it('in a tree whose composites nest as deep as the bound allows', () => {
    expect(overlong(compositePlan().files)).toEqual([]);
  });
});
