import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  EMITTED_KEY,
  emitStep,
  FakeDeterministicEmbedder,
  FakeProvider,
  generateStep,
  InMemoryVectorStore,
  Pipeline,
  PipelineContext,
  PipelineError,
  PromptRegistry,
  PromptTemplate,
  RetrievalResult,
  Retriever,
  resolveSource,
  retrieveStep,
  structuredOutput,
  Tool,
  type ToolCall,
  ToolExecutor,
  type ToolResult,
  toolStep,
} from '../src/index.js';
import { binding, document, modelGateway, SMALL_ALIAS } from './support.js';

/**
 * The leaf step factories: read, call, ask, and project.
 *
 * Mirrors `tests/test_steps.py` in the Python runtime, case for case, so the two
 * describe the same surface. Each factory is a thin wrapper over a primitive the
 * generated code already calls, so what is asserted is the part that is *not* the
 * primitive: what gets bound, under which name, in which shape, and what happens when
 * the primitive fails. Those are the places a wrapper silently disagrees with the
 * emitted step -- a bound-but-wrong name, an error swallowed into a value, a rendered
 * prompt that never reached the gateway -- so almost every assertion below fails if
 * the wrapper is mutated rather than if the runtime changed.
 *
 * `emitStep` gets the most attention because it is the one constructor with no emitted
 * counterpart yet: the generated route builds its event object itself, so nothing in
 * codegen would catch this surface drifting away from `responsePlan`. The pipeline
 * test at the bottom pins the two properties a naive implementation gets wrong: the
 * projection keeps the order it was declared in, and the step **binds without
 * stopping**, because a stopping step's value is discarded and a later step still runs
 * in the emitted route.
 */

const ANSWER = structuredOutput('answer', z.object({ verdict: z.string() }));

const TICKET = { subject: 'Refund', body: 'Where is it?' };

function context(values: Readonly<Record<string, unknown>> = {}): PipelineContext {
  return new PipelineContext(values);
}

function prompts(template = 'Hi {name}'): PromptRegistry {
  return new PromptRegistry([new PromptTemplate({ name: 'greet', version: '1', template })]);
}

describe('emit', () => {
  it('reads a source without an attribute as the whole binding', () => {
    expect(resolveSource(context({ ticket: 'T-1' }), 'ticket')).toBe('T-1');
  });

  it('reads the named field of a source with an attribute', () => {
    expect(resolveSource(context({ ticket: TICKET }), 'ticket.subject')).toBe('Refund');
  });

  it('says which key is missing when the binding is absent', () => {
    expect(() => resolveSource(context(), 'ticket.subject')).toThrow(
      "pipeline context has no 'ticket'",
    );
  });

  it('says which source and field when the attribute is absent', () => {
    // Distinct from a missing binding on purpose: "the field is not there" and "the
    // binding is not there" are different mistakes, and a response that silently
    // drops one of them is worse than one that fails loudly.
    expect(() => resolveSource(context({ ticket: TICKET }), 'ticket.status')).toThrow(
      /'ticket\.status'.*'status'/,
    );
  });

  it('refuses more than one attribute below a binding', () => {
    expect(() => resolveSource(context({ ticket: TICKET }), 'ticket.subject.text')).toThrow(
      /more than one attribute/,
    );
  });

  it('refuses a field that lives only on the prototype', () => {
    // An own property is where a declared field lands; a prototype member is not a
    // field, so inheriting `subject` must not read as carrying it.
    const inherited = Object.create({ subject: 'Refund' }) as Record<string, unknown>;
    expect(() => resolveSource(context({ ticket: inherited }), 'ticket.subject')).toThrow(
      /'ticket\.subject'.*'subject'/,
    );
  });

  it('projects the declared fields in the declared order', async () => {
    const step = emitStep({ subject: 'ticket.subject', body: 'ticket.body' });

    const payload = (await step(context({ ticket: TICKET }))).require(EMITTED_KEY);

    expect(Object.keys(payload as Record<string, unknown>)).toEqual(['subject', 'body']);
    expect(payload).toEqual({ subject: 'Refund', body: 'Where is it?' });
  });

  it('binds under the key it was given', async () => {
    const step = emitStep({ id: 'ticket' }, { key: 'event' });

    const after = await step(context({ ticket: 'T-1' }));

    expect(after.require('event')).toEqual({ id: 'T-1' });
    expect(after.get(EMITTED_KEY)).toBeUndefined();
  });

  it('binds and lets the pipeline continue', async () => {
    // Stopping would lose the payload: both runtimes return the *pre-step* context
    // when a step stops, so a stopping emit could not bind anything. A generated
    // route does not stop at its emit either -- it runs every step and only then
    // builds the response object.
    const after = await Pipeline.of(
      emitStep({ id: 'ticket' }, { name: 'emit' }),
      async (seen: PipelineContext) => seen.withValues({ after: true }),
    ).run(context({ ticket: 'T-1' }));

    expect(after.require(EMITTED_KEY)).toEqual({ id: 'T-1' });
    expect(after.require('after')).toBe(true);
  });
});

async function seededRetriever(...texts: readonly string[]): Promise<Retriever> {
  const retriever = new Retriever(binding({ topK: 2 }), {
    embedder: new FakeDeterministicEmbedder(),
    store: new InMemoryVectorStore(),
  });
  await retriever.ingest(texts.map((text, index) => document(`${index}.md`, text)));
  return retriever;
}

describe('retrieve', () => {
  it('binds the result of the real retriever', async () => {
    const retriever = await seededRetriever('Reset the password from the settings page.');
    const step = retrieveStep(retriever, {
      binding: 'passages',
      query: 'how do I reset my password',
    });

    const found = (await step(context())).require('passages');

    expect(found).toBeInstanceOf(RetrievalResult);
    // The query is the one the step was given, not the binding's default: a wrapper
    // that dropped its argument would still return results.
    expect((found as RetrievalResult).query).toBe('how do I reset my password');
    expect((found as RetrievalResult).items.map((item) => item.chunk.docId)).toEqual(['0.md']);
  });

  it('narrows to topK', async () => {
    const retriever = await seededRetriever(
      'Reset the password from settings.',
      'Contact support by email.',
    );
    const narrowed = retrieveStep(retriever, { binding: 'passages', query: 'password', topK: 1 });
    const ceiling = retrieveStep(retriever, { binding: 'passages', query: 'password' });

    // The binding's own ceiling is 2, so only topK can bring this down to one. A
    // wrapper that ignored topK would leave both calls at the ceiling.
    expect(((await narrowed(context())).require('passages') as RetrievalResult).items).toHaveLength(
      1,
    );
    expect(((await ceiling(context())).require('passages') as RetrievalResult).items).toHaveLength(
      2,
    );
  });
});

const CITY_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' }, days: { type: 'integer' } },
  required: ['city'],
  additionalProperties: false,
} as const;

const weather = ({ city, days = 1 }: Record<string, unknown>): Record<string, unknown> => ({
  city,
  days,
});

const explode = (): Record<string, unknown> => {
  throw new Error('upstream is down');
};

function weatherTools(): ToolExecutor {
  return new ToolExecutor([
    Tool.of({
      name: 'weather',
      handler: weather,
      description: 'Report the weather.',
      parameters: CITY_SCHEMA,
    }),
  ]);
}

describe('tool', () => {
  it('binds the parsed content', async () => {
    const step = toolStep(weatherTools(), {
      binding: 'forecast',
      tool: 'weather',
      arguments: { city: 'Paris' },
    });

    expect((await step(context())).require('forecast')).toEqual({ city: 'Paris', days: 1 });
  });

  it('parses content into a declared output type', async () => {
    const forecastType = structuredOutput(
      'forecast',
      z.object({ city: z.string(), days: z.number() }),
    );
    const step = toolStep(weatherTools(), {
      binding: 'forecast',
      tool: 'weather',
      arguments: { city: 'Paris' },
      output: forecastType,
    });

    expect((await step(context())).require('forecast')).toEqual({ city: 'Paris', days: 1 });
  });

  it('raises rather than binding an error outcome', async () => {
    const tools = new ToolExecutor([
      Tool.of({ name: 'explode', handler: explode, description: 'Fail.', parameters: CITY_SCHEMA }),
    ]);
    const step = toolStep(tools, {
      binding: 'forecast',
      tool: 'explode',
      arguments: { city: 'Paris' },
    });

    await expect(step(context())).rejects.toThrow(PipelineError);
    await expect(step(context())).rejects.toThrow('tool explode failed: Error: upstream is down');
  });

  it('names the binding as the call id', async () => {
    // A real executor that keeps the call, so the id is observable.
    class Recording extends ToolExecutor {
      readonly seen: ToolCall[] = [];

      override async execute(call: ToolCall): Promise<ToolResult> {
        this.seen.push(call);
        return super.execute(call);
      }
    }

    const tools = new Recording([
      Tool.of({
        name: 'weather',
        handler: weather,
        description: 'Report the weather.',
        parameters: CITY_SCHEMA,
      }),
    ]);
    const step = toolStep(tools, {
      binding: 'forecast',
      tool: 'weather',
      arguments: { city: 'Paris' },
    });

    await step(context());

    expect(tools.seen.map((call) => call.id)).toEqual(['forecast']);
    expect(tools.seen.map((call) => call.name)).toEqual(['weather']);
    expect(tools.seen.map((call) => call.args)).toEqual([{ city: 'Paris' }]);
  });
});

describe('generate', () => {
  it('renders the prompt and binds the answer', async () => {
    const provider = new FakeProvider({
      answers: { 'Hi Ada': 'hello Ada' },
      accuracy: 1.0,
      seed: 0,
    });
    const step = generateStep(modelGateway(provider), prompts(), {
      binding: 'greeting',
      prompt: 'greet',
      model: SMALL_ALIAS,
      values: { name: 'Ada' },
    });

    const after = await step(context());

    expect(after.require('greeting')).toBe('hello Ada');
    // Interpolation belongs to the registry; a wrapper that passed the raw template
    // through would send "{name}" and the answer map would not have matched.
    expect(provider.calls[0]?.messages.at(-1)?.content).toBe('Hi Ada');
  });

  it('binds a structured answer', async () => {
    const gateway = modelGateway(new FakeProvider({ responder: () => '{"verdict": "accept"}' }));
    const step = generateStep(gateway, prompts(), {
      binding: 'decision',
      prompt: 'greet',
      model: SMALL_ALIAS,
      values: { name: 'Ada' },
      structured: ANSWER,
    });

    expect((await step(context())).require('decision')).toEqual({ verdict: 'accept' });
  });

  it('repairs a malformed structured answer', async () => {
    let calls = 0;
    const gateway = modelGateway(
      new FakeProvider({
        responder: (_request, turn) => {
          calls += 1;
          return turn === 0 ? 'not json' : '{"verdict": "accept"}';
        },
      }),
    );
    const step = generateStep(gateway, prompts(), {
      binding: 'decision',
      prompt: 'greet',
      model: SMALL_ALIAS,
      values: { name: 'Ada' },
      structured: ANSWER,
    });

    expect((await step(context())).require('decision')).toEqual({ verdict: 'accept' });
    // A wrapper that let the parse error escape, or one that re-rendered between
    // attempts, would not reach exactly two calls.
    expect(calls).toBe(2);
  });
});
