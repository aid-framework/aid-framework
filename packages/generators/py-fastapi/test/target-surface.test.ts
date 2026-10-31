/**
 * The P7a target surface: `deployments`, `guardrails`, and streaming.
 *
 * Before P7a a spec at `specVersion: "0.2"` could not be generated at all, and the block
 * was three-way rather than two-way: the security gate refuses an HTTP `generate` route
 * with no `input` guardrail, the capability gate refuses a guardrail on a target that
 * does not declare `guardrails`, and `planPyFastApi` refused the collection outright.
 * `d1d-evidence.md` in the session report holds the three rejections verbatim.
 *
 * These tests pin the closure from both sides. The positive cases prove the wiring is
 * emitted and ordered so a block cannot reach the model; the negative cases prove the
 * gate that demanded the guardrail is still there. `agents` and `memory` were refused
 * here until P7b emitted them; that refusal now lives in `agents-memory.test.ts`, which
 * pins the constant as empty rather than listing what is missing.
 *
 * The behavioural half of the same claims -- a block answering 400 without calling the
 * provider, a redaction changing the text the provider sees, SSE frames with a terminal
 * `done` -- runs against the generated app rather than its source, in
 * `examples/support-copilot/tests/test_app.py`. That split is deliberate: the emitter
 * tests prove what was written, the example tests prove the runtime accepts it.
 */

import type { IR } from '@aid-framework/ir';
import { buildIR, runGates } from '@aid-framework/ir';
import { checkSpecText } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { PY_FASTAPI_MANIFEST, PY_FASTAPI_TARGET, planPyFastApi } from '../src/index.js';
import { checkPlan, UNSUPPORTED_COLLECTIONS } from '../src/validate.js';
import { buildForSpecText, example, examplePlan, fileMap, type SpecDiagnostic } from './helpers.js';

/** A 0.2 spec with one streaming deployment, one generate step and one `emit`. */
const BASE_SPEC = `specVersion: "0.2"

project:
  name: surface
  namespace: aid.test.surface
  description: A single HTTP generate route, for exercising the P7a surface.
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
    capabilities: [json-schema, streaming]

prompts:
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

pipelines:
  handle:
    description: Summarise a ticket.
    trigger:
      http:
        method: post
        path: /handle
    steps:
      - generate:
          prompt: ask
          input:
            subject: "{{ event.subject }}"
          as: answer
      - emit:
          event: Reply
`;

const BLOCKING_GUARDRAIL = `
guardrails:
  intake:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: This text reads as an attempt to redirect the assistant.
      log: true
`;

const REDACTING_GUARDRAIL = `
guardrails:
  contact_details:
    stages: [input]
    policies: [pii-detect]
    action: redact
    redact: [text]
    onFail:
      message: Contact details were masked before the model saw them.
      log: false
`;

const STREAMING_DEPLOYMENT = `
deployments:
  api:
    target: container
    streaming: true
    secrets: [OPENAI_API_KEY]
`;

function specText(...sections: string[]): string {
  return BASE_SPEC + sections.join('');
}

/** The diagnostics the build gates produce for a spec, without throwing on them. */
function gateDiagnostics(text: string): SpecDiagnostic[] {
  const spec = checkSpecText(text, { file: 'surface.spec.yaml' });
  if (spec.value === undefined) return spec.diagnostics;
  const { ir, diagnostics } = buildIR(spec.value, { file: 'surface.spec.yaml' });
  if (diagnostics.some((line) => line.severity === 'error')) return diagnostics;
  const gates = runGates(ir, {
    targetCapabilities: { [PY_FASTAPI_TARGET]: PY_FASTAPI_MANIFEST.capabilities },
  });
  return gates.diagnostics;
}

/** One planned file's content, or `undefined` when the plan does not emit it. */
function planned(plan: { files: readonly { path: string; content: string }[] }, path: string) {
  return fileMap(plan.files).get(path);
}

/** The plan-problem codes for an IR, in order. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

/** The single pipeline a minimal surface spec builds, without an unchecked index. */
function onlyPipeline(ir: IR): IR['pipelines'][number] {
  const [pipeline] = ir.pipelines;
  if (pipeline === undefined) throw new Error('the spec built no pipeline');
  return pipeline;
}

/** A copy of an IR with one pipeline's steps replaced, leaving the shared fixture intact. */
function withSteps(
  ir: IR,
  pipelineId: string,
  mutate: (steps: IR['pipelines'][number]['steps']) => IR['pipelines'][number]['steps'],
): IR {
  return {
    ...ir,
    pipelines: ir.pipelines.map((pipeline) =>
      pipeline.id === pipelineId ? { ...pipeline, steps: mutate(pipeline.steps) } : pipeline,
    ),
  };
}

describe('a 0.2 spec with guardrails and a streaming deployment', () => {
  it('generates cleanly', () => {
    const { ir, plan } = buildForSpecText(specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT));

    expect(checkPlan(ir)).toEqual([]);
    expect(plan.files.length).toBeGreaterThan(0);
  });

  it('emits the guardrail wiring, and runs it before the model is reached', () => {
    const { plan } = buildForSpecText(specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT));

    const guardrails = planned(plan, 'app/generated/guardrails.py');
    expect(guardrails).toBeDefined();
    // The table holds definitions, not identifiers. Emitting ids here type-checks in the
    // emitter and fails on the first request, which is the wrong place to find out.
    expect(guardrails).toContain('GuardrailDefinition(');
    expect(guardrails).toContain('id="intake"');
    expect(guardrails).toContain('INPUT_GUARDRAILS: tuple[GuardrailDefinition, ...]');
    // The stage table is read only from the route module, so the file has to say it is
    // part of the surface: a generated module that leaves it implicit reads as dead code.
    expect(guardrails).toContain('__all__ = [');
    expect(guardrails).toContain('"INPUT_GUARDRAILS"');

    const pipeline = planned(plan, 'app/generated/pipelines/handle.py') ?? '';
    expect(pipeline).toContain(
      'from ..guardrails import ENGINE, INPUT_GUARDRAILS, enforce_guardrail',
    );
    // The check sits between rendering and the request, so the verdict's text -- which is
    // the redacted text -- is what the model is asked about and a block stops the call.
    const rendered = pipeline.indexOf('.prompts.render(');
    const checked = pipeline.indexOf('enforce_guardrail(ENGINE.check_input(INPUT_GUARDRAILS');
    const sent = pipeline.indexOf('deps.gateway.');
    expect(rendered).toBeGreaterThanOrEqual(0);
    expect(checked).toBeGreaterThan(rendered);
    expect(sent).toBeGreaterThan(-1);
  });

  it('does not need a guardrail to be called `text` unless it redacts', () => {
    // A `flag` guardrail inspects the same payload but never rewrites it, so naming a
    // field would be meaningless rather than wrong. Only `redact` fields are checked.
    const { ir } = buildForSpecText(specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT));
    expect(codes(ir)).not.toContain('unsupported-redact');
  });
});

describe('the security gate that demanded the guardrail is still there', () => {
  it('rejects a 0.2 HTTP generate route with no input guardrail', () => {
    const diagnostics = gateDiagnostics(specText(STREAMING_DEPLOYMENT));
    const text = diagnostics.map((line) => `${line.severity}: ${line.message}`).join('\n');

    expect(text).toContain('security gate rejected this endpoint');
    expect(text).toContain('declares no guardrail with an "input" stage');
  });

  it('accepts the same route once an input guardrail is declared', () => {
    // One warning survives and is expected: no eval gates on this pipeline, so the
    // eval-coverage gate has nothing to cover. It is a warning rather than an error, and
    // asserting `[]` here would pin an unrelated message into this file.
    const errors = gateDiagnostics(specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT)).filter(
      (line) => line.severity === 'error',
    );
    expect(errors).toEqual([]);
  });
});

describe('a `redact` guardrail names the field the stage payload actually has', () => {
  it('refuses a name other than `text` for the input stage', () => {
    const swapped = REDACTING_GUARDRAIL.replace('redact: [text]', 'redact: [subject]');
    expect(() => buildForSpecText(specText(swapped, STREAMING_DEPLOYMENT))).toThrow(
      /unsupported-redact[\s\S]*name 'text'/,
    );
  });

  it('accepts `text`, because the input payload is exactly {"text": ...}', () => {
    const { ir } = buildForSpecText(specText(REDACTING_GUARDRAIL, STREAMING_DEPLOYMENT));
    expect(codes(ir)).not.toContain('unsupported-redact');
  });

  it('refuses a policy that detects intent rather than a maskable value', () => {
    const wrong = REDACTING_GUARDRAIL.replace(
      'policies: [pii-detect]',
      'policies: [prompt-injection]',
    );
    expect(() => buildForSpecText(specText(wrong, STREAMING_DEPLOYMENT))).toThrow(
      /unsupported-redact[\s\S]*detects intent rather than/,
    );
  });
});

describe('streaming is negotiated on the request, same route', () => {
  it('emits the `Accept` branch, and leaves the JSON path as the fallthrough', () => {
    const { plan } = buildForSpecText(specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT));
    const route = planned(plan, 'app/generated/routes/handle.py') ?? '';

    expect(planned(plan, 'app/generated/sse.py')).toContain('EVENT_STREAM = "text/event-stream"');
    expect(route).toContain('if wants_event_stream(request):');
    expect(route).toContain(
      'return StreamingResponse(deps.gateway.stream(_alias, _request), media_type=EVENT_STREAM)',
    );
    // One route, not two: the JSON return is still the end of the same function.
    expect(route.match(/@handle_router\.post/g)?.length).toBe(1);
    expect(route).toContain('return Reply(');
    // The route imports only what it names: `PipelineContext` is the pipeline module's
    // annotation, and an import the route never reads is a lint failure in the example.
    expect(route).not.toContain('PipelineContext');
  });

  it('emits no `Accept` branch when no deployment asks to stream', () => {
    const { ir, plan } = buildForSpecText(specText(BLOCKING_GUARDRAIL));

    expect(checkPlan(ir)).toEqual([]);
    expect(planned(plan, 'app/generated/sse.py')).toBeUndefined();
    expect(planned(plan, 'app/generated/routes/handle.py')).not.toContain('wants_event_stream');
  });

  it('runs the steps before `generate` in the streaming preflight, not just on the JSON path', () => {
    // A stream carries only the model's text, so everything the pipeline does first --
    // retrieval, tool calls, and the guardrails over them -- still has to happen before
    // the first frame. `_stream_request` is what runs them.
    const plan = examplePlan();
    const pipeline = planned(plan, 'app/generated/pipelines/answer_ticket.py') ?? '';

    expect(pipeline).toContain('async def _stream_request(');
    const body = pipeline.slice(pipeline.indexOf('async def _stream_request('));
    const preflight = body.slice(0, body.indexOf('def answer_ticket_pipeline'));
    expect(preflight).toContain('ctx = await customer(ctx)');
    expect(preflight).toContain('ctx = await handbook(ctx)');
    // The wiring steps run here too, not only on the JSON path: a stream cannot carry a
    // guardrail block or a reranked subset, so they have to happen before the first frame.
    expect(preflight).toContain('ctx = await _guard_1(ctx)');
    expect(preflight).toContain('ctx = await triage(ctx)');
    expect(preflight).toContain('ctx = await ranked(ctx)');
    expect(preflight).toContain('ctx = await _guard_2(ctx)');
    // `ctx.require` rather than a local: a local named after a binding would shadow the
    // step function of the same name and rebind it as an unbound local. The prompt reads
    // the reranked subset, so that is the binding this asserts.
    expect(preflight).toContain('ctx.require("ranked")');
  });

  it('keeps the signature inline when it fits and one parameter per line when it does not', () => {
    // The example's signature is 99 characters against a 100-column budget, so it stays on
    // one line. That is the only branch the committed fixture exercises, so the fallback
    // has to be proved separately -- and proved against ruff's canonical exploded form,
    // which puts *one* parameter per line. Two parameters on one line is itself a shape
    // `ruff format --check` rewrites, which would make the generated tree drift from a
    // fresh generation the moment anyone formatted it.
    const inline = planned(examplePlan(), 'app/generated/pipelines/answer_ticket.py') ?? '';
    expect(inline).toContain(
      'async def _stream_request(deps: Deps, event: AnswerTicketRequest)' +
        ' -> tuple[str, CompletionRequest]:',
    );

    // `HandleEscalationRequest` pushes the signature to 103 characters, past the budget,
    // so this spec lands in the fallback rather than the inline branch.
    const long = buildForSpecText(
      specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT).replaceAll('handle', 'handle_escalation'),
    );
    const exploded = planned(long.plan, 'app/generated/pipelines/handle_escalation.py') ?? '';

    expect(exploded).toContain(
      [
        'async def _stream_request(',
        '    deps: Deps,',
        '    event: HandleEscalationRequest,',
        ') -> tuple[str, CompletionRequest]:',
      ].join('\n'),
    );
    // The pre-fix fallback wrote both parameters on one line, which ruff reformats.
    expect(exploded).not.toContain('deps: Deps, event: HandleEscalationRequest');
  });
});

describe('a pipeline that cannot be streamed is refused at plan time', () => {
  it('refuses a second `generate`, rather than dropping it from the stream', () => {
    const { ir } = buildForSpecText(specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT));
    const generate = onlyPipeline(ir).steps.find((step) => step.kind === 'generate');
    expect(generate).toBeDefined();
    const twoGenerate = withSteps(ir, 'handle', (steps) => [
      ...steps,
      ...(generate === undefined ? [] : [{ ...generate, as: 'answer_again' } as typeof generate]),
    ]);

    expect(codes(twoGenerate)).toContain('unsupported-streaming');
  });

  it('refuses a step after `generate` that performs an effect', () => {
    // The example is the fixture with a tool and a retriever, so a copy of its leading
    // `tool` step is a real effect step rather than a hand-built one.
    const pipeline = example().ir.pipelines.find((entry) => entry.id === 'answer_ticket');
    const tool = pipeline?.steps.find((step) => step.kind === 'tool');
    expect(tool).toBeDefined();
    const trailing = withSteps(example().ir, 'answer_ticket', (steps) => [
      ...steps,
      ...(tool === undefined ? [] : [{ ...tool, as: 'customer_again' } as typeof tool]),
    ]);

    expect(codes(trailing)).toContain('unsupported-streaming');
  });

  it('says why, and does not silently downgrade to JSON', () => {
    const { ir } = buildForSpecText(specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT));
    const generate = onlyPipeline(ir).steps.find((step) => step.kind === 'generate');
    const broken = withSteps(ir, 'handle', (steps) => [
      ...steps,
      ...(generate === undefined ? [] : [{ ...generate, as: 'second' } as typeof generate]),
    ]);

    const message = checkPlan(broken)
      .filter((problem) => problem.code === 'unsupported-streaming')
      .map((problem) => problem.message)
      .join('\n');
    expect(message).toContain('exactly one step may generate');
    expect(message).toContain('would be skipped on the streaming path');
    expect(() => planPyFastApi(broken)).toThrow(/unsupported-streaming/);
  });
});

describe('guardrail actions a pipeline route cannot honour', () => {
  it('refuses `escalate`, because a pipeline route has no checkpoint to resume', () => {
    const { ir } = buildForSpecText(specText(BLOCKING_GUARDRAIL, STREAMING_DEPLOYMENT));
    const escalated: IR = {
      ...ir,
      guardrails: ir.guardrails.map((guardrail) => ({ ...guardrail, action: 'escalate' as const })),
    };

    expect(codes(escalated)).toContain('unsupported-guardrail');
    expect(() => planPyFastApi(escalated)).toThrow(/escalate[\s\S]*checkpoint and resume/);
  });
});

describe('the collections P7b owns are no longer refused', () => {
  it('leaves nothing unsupported, because both emitters now exist', () => {
    // Named as an exact list rather than a length: this constant shrinking is the layer
    // landing, so a collection added back here has to be written down and justified, and
    // P21's rule -- shrink only when the emitter exists -- stays visible in the assertion.
    expect([...UNSUPPORTED_COLLECTIONS]).toEqual([]);
  });

  it('emits an agent router for the example rather than refusing its agent', () => {
    const files = fileMap(examplePlan().files);

    expect(files.get('app/generated/agents.py')).toBeDefined();
  });
});

describe('the shipped example', () => {
  it('is a 0.2 spec that declares an input guardrail and a streaming deployment', () => {
    const { ir } = example();

    expect(ir.specVersion).toBe('0.2');
    expect(ir.guardrails.some((guardrail) => guardrail.stages.includes('input'))).toBe(true);
    expect(ir.deployments.some((deployment) => deployment.streaming)).toBe(true);
    expect(checkPlan(ir)).toEqual([]);
  });

  it('plans deterministically and idempotently', () => {
    const first = examplePlan();
    const second = planPyFastApi(example().ir);

    expect(second.files).toEqual(first.files);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
