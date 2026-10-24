/**
 * Structured output: zod validation plus a repair loop.
 *
 * The repair loop is the whole contract. "The model must be right the first time" is not
 * achievable; "the model must eventually be right, given its own validation errors" is.
 * These tests drive that loop with a scripted caller, so no model is involved.
 */

import { describe, expect, it } from 'vitest';
import type { AgentModel } from '../src/index.js';
import {
  buildAgent,
  formatProblems,
  parseStructured,
  repairPrompt,
  runStructured,
  StructuredOutputError,
  structuredOutput,
} from '../src/index.js';
import { REPAIR_INSTRUCTION, z } from '../src/structured.js';
import { at, failure } from './support.js';

const Capital = structuredOutput(
  'Capital',
  z.object({ city: z.string(), population: z.number().int().positive() }),
);

describe('structuredOutput', () => {
  it('names a schema so diagnostics can say which type failed', () => {
    expect(Capital.name).toBe('Capital');
    const parsed: { city: string; population: number } = Capital.schema.parse({
      city: 'Paris',
      population: 2_100_000,
    });
    expect(parsed.city).toBe('Paris');
  });

  it('refuses an unnamed schema', () => {
    expect(() => structuredOutput('', z.object({}))).toThrow(/needs a name/);
  });
});

describe('parseStructured', () => {
  it('returns the validated value', () => {
    expect(parseStructured('{"city":"Paris","population":2100000}', Capital)).toEqual({
      city: 'Paris',
      population: 2_100_000,
    });
  });

  it('strips a ```json fence, because models wrap their answers', () => {
    const text = '```json\n{"city":"Lima","population":9700000}\n```';
    expect(parseStructured(text, Capital).city).toBe('Lima');
  });

  it('strips an unlabelled fence too', () => {
    expect(parseStructured('```\n{"city":"Tokyo","population":13900000}\n```', Capital).city).toBe(
      'Tokyo',
    );
  });

  it('reports an empty answer as such rather than as a JSON error', () => {
    const error = (() => {
      try {
        parseStructured('   ', Capital);
        return null;
      } catch (caught) {
        return caught as StructuredOutputError;
      }
    })();

    expect(error).toBeInstanceOf(StructuredOutputError);
    expect(error?.message).toBe('model returned empty output for Capital after 1 attempt(s)');
  });

  it('treats unparseable text as an invalid JSON problem', () => {
    const error = (() => {
      try {
        parseStructured('not json at all', Capital);
        return null;
      } catch (caught) {
        return caught as StructuredOutputError;
      }
    })();

    expect(error?.message).toBe(
      'output did not validate as Capital after 1 attempt(s): <root>: invalid JSON',
    );
  });

  it('reports every validation problem, not just the first', () => {
    const error = (() => {
      try {
        parseStructured('{"population":-1}', Capital);
        return null;
      } catch (caught) {
        return caught as StructuredOutputError;
      }
    })();

    expect(error?.problems).toHaveLength(2);
    // The missing string and the rejected negative integer are both reported.
    expect(error?.problems.join('\n')).toMatch(/city/);
    expect(error?.problems.join('\n')).toMatch(/population/);
  });

  it('names the failing path in every problem', () => {
    const Nested = structuredOutput('Nested', z.object({ outer: z.object({ inner: z.number() }) }));
    const error = (() => {
      try {
        parseStructured('{"outer":{"inner":"text"}}', Nested);
        return null;
      } catch (caught) {
        return caught as StructuredOutputError;
      }
    })();

    expect(at(error?.problems ?? [], 0)).toMatch(/^outer\.inner: /);
  });
});

describe('formatProblems', () => {
  it('renders a path, or <root> when there is none', () => {
    expect(
      formatProblems([
        { path: ['a', 'b'], message: 'is required' },
        { path: [], message: 'is not an object' },
      ]),
    ).toEqual(['a.b: is required', '<root>: is not an object']);
  });
});

describe('runStructured', () => {
  it('returns the first valid answer without asking again', async () => {
    const prompts: string[] = [];
    const value = await runStructured(
      (prompt) => {
        prompts.push(prompt);
        return Promise.resolve('{"city":"Paris","population":2100000}');
      },
      Capital,
      'where is the capital of France?',
    );

    expect(value.city).toBe('Paris');
    expect(prompts).toHaveLength(1);
    expect(at(prompts, 0)).toBe('where is the capital of France?');
  });

  it('feeds the validation errors back and asks again', async () => {
    const prompts: string[] = [];
    const answers = ['{"city":"Paris"}', '{"city":"Paris","population":2100000}'];

    const value = await runStructured(
      (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(answers[prompts.length - 1] ?? '');
      },
      Capital,
      'question',
    );

    expect(value.population).toBe(2_100_000);
    expect(prompts).toHaveLength(2);
    // The retry carries the original prompt plus the correction turn.
    expect(at(prompts, 1)).toMatch(/^question\n\n/);
    expect(at(prompts, 1)).toContain('population');
  });

  it('gives up after the configured number of repair attempts', async () => {
    let calls = 0;
    const error = await failure(
      runStructured(
        () => {
          calls += 1;
          return Promise.resolve('still not json');
        },
        Capital,
        'question',
        { retries: 2 },
      ),
    );

    // `retries` counts repairs beyond the first call.
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect(error.message).toContain('Capital not produced from 3 attempt(s)');
    expect((error as StructuredOutputError).attempts).toBe(3);
    expect((error as StructuredOutputError).problems).toEqual(['<root>: invalid JSON']);
  });

  it('defaults to two repairs, so three calls in total', async () => {
    let calls = 0;
    await runStructured(
      () => {
        calls += 1;
        return Promise.resolve('{}');
      },
      Capital,
      'question',
    ).catch(() => undefined);

    expect(calls).toBe(3);
  });

  it('makes exactly one call when retries is zero', async () => {
    let calls = 0;
    await runStructured(
      () => {
        calls += 1;
        return Promise.resolve('{}');
      },
      Capital,
      'question',
      { retries: 0 },
    ).catch(() => undefined);

    expect(calls).toBe(1);
  });

  it('refuses a negative retry budget', async () => {
    await expect(
      runStructured(() => Promise.resolve('{}'), Capital, 'q', { retries: -1 }),
    ).rejects.toThrow(/retries must not be negative/);
  });

  it('lets a non-validation error propagate without repairing it', async () => {
    let calls = 0;
    await expect(
      runStructured(
        () => {
          calls += 1;
          return Promise.reject(new Error('provider is down'));
        },
        Capital,
        'question',
      ),
    ).rejects.toThrow(/provider is down/);

    expect(calls).toBe(1);
  });
});

describe('repairPrompt', () => {
  it('embeds the problems in the correction turn', () => {
    const error = new StructuredOutputError('nope', {
      attempts: 1,
      problems: ['city: expected string'],
    });

    const prompt = repairPrompt(error);
    expect(prompt.startsWith(REPAIR_INSTRUCTION.split('{problems}')[0] ?? '')).toBe(true);
    expect(prompt).toContain('city: expected string');
    expect(prompt).not.toContain('{problems}');
  });

  it('falls back to the message when there are no problems', () => {
    const error = new StructuredOutputError('the model said nothing', { attempts: 1 });
    expect(repairPrompt(error)).toContain('the model said nothing');
  });
});

/** A scripted model that replays its answers and records the prompts it saw. */
function scripted(answers: readonly string[]): AgentModel & { readonly prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete(prompt: string): Promise<string> {
      prompts.push(prompt);
      return Promise.resolve(answers[prompts.length - 1] ?? '');
    },
  };
}

describe('buildAgent', () => {
  it('runs a prompt through the repair loop and returns the typed value', async () => {
    const model = scripted(['{"city":"Kenya"}', '{"city":"Nairobi","population":4400000}']);
    const agent = buildAgent(model, Capital);

    const value = await agent.run('capital of Kenya');

    expect(value.city).toBe('Nairobi');
    expect(model.prompts).toHaveLength(2);
  });

  it('prepends the system prompt to the first call', async () => {
    const model = scripted(['{"city":"Lima","population":9700000}']);
    await buildAgent(model, Capital, { systemPrompt: 'You are terse.' }).run('capital of Peru');

    expect(at(model.prompts, 0)).toBe('You are terse.\n\ncapital of Peru');
  });

  it('honours a retry override', async () => {
    const model = scripted(['{}', '{}', '{}']);
    await buildAgent(model, Capital, { retries: 1 })
      .run('q')
      .catch(() => undefined);

    expect(model.prompts).toHaveLength(2);
  });

  it('fails loudly once it runs out of repairs', async () => {
    const agent = buildAgent(scripted(['{}']), Capital, { retries: 0 });
    await expect(agent.run('q')).rejects.toThrow(StructuredOutputError);
  });
});
