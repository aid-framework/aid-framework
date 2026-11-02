/**
 * The TypeSafe AI decision client, against a stub `fetch`.
 *
 * No network is touched: the client's job is to shape a System One request and to
 * interpret the typed reply, and both are asserted on the bytes that would have
 * gone over the wire.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionAnswer, DecisionFetchLike, DecisionResponse } from '../src/index.js';
import {
  ATTRIBUTES,
  ConfigurationError,
  DEFAULT_TYPESAFE_BASE_URL,
  DecisionClient,
  DecisionQuestion,
  decisionCostUsd,
  decisionKey,
  isReproducibleModel,
  JEV_INPUT_USD_PER_MTOK,
  ProviderError,
  ProviderResponseError,
} from '../src/index.js';
import { TRACE_DIR_ENV } from '../src/local-trace.js';
import { at } from './support.js';

const API_KEY = 'ts-test-not-a-real-key';
const MODEL = 'jev-1.14.0';

const ENV_KEYS = ['TYPESAFE_API_KEY', 'TYPESAFE_AI_API_KEY', 'TYPESAFE_BASE_URL'] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

const created: string[] = [];

function traceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aid-decide-trace-'));
  created.push(dir);
  process.env[TRACE_DIR_ENV] = dir;
  return dir;
}

function traceLines(dir: string): Record<string, unknown>[] {
  const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  expect(names).toHaveLength(1);
  return readFileSync(join(dir, names[0] as string), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env[TRACE_DIR_ENV];
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Reply {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A `DecisionFetchLike` that replays `replies` in order and records what it was sent. */
function stubFetch(replies: readonly Reply[]): {
  readonly fetchImpl: DecisionFetchLike;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: DecisionFetchLike = (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const reply = replies[index];
    index += 1;
    if (reply === undefined) throw new Error('no reply queued');
    const status = reply.status ?? 200;
    const headers = new Map(Object.entries(reply.headers ?? {}));
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers.get(name) ?? null },
      text: () => Promise.resolve(reply.body ?? ''),
    });
  };
  return { fetchImpl, calls };
}

function body(answers: Record<string, unknown>, model = MODEL): string {
  return JSON.stringify({
    model,
    answers,
    usage: { input_tokens: 430, output_tokens: 0 },
  });
}

function clientFor(
  fetchImpl: DecisionFetchLike,
  overrides: Partial<ConstructorParameters<typeof DecisionClient>[0]> = {},
): DecisionClient {
  return new DecisionClient({ apiKey: API_KEY, fetchImpl, ...overrides });
}

const urgent = (): DecisionQuestion =>
  new DecisionQuestion({ type: 'noul', instructions: 'Is it urgent' });

function answer(response: DecisionResponse, key: string): DecisionAnswer {
  const found = response.answers[key];
  if (found === undefined) throw new Error(`no answer for question ${JSON.stringify(key)}`);
  return found;
}

describe('key resolution', () => {
  it('prefers the first-party name', () => {
    expect(decisionKey({ TYPESAFE_API_KEY: 'a', TYPESAFE_AI_API_KEY: 'b' })).toBe('a');
  });

  it('falls back to the Vercel spelling', () => {
    expect(decisionKey({ TYPESAFE_AI_API_KEY: 'b' })).toBe('b');
  });

  it('counts an empty key as unset', () => {
    expect(decisionKey({ TYPESAFE_API_KEY: '', TYPESAFE_AI_API_KEY: 'b' })).toBe('b');
    expect(decisionKey({})).toBeUndefined();
  });

  it('is a configuration error when no key is configured', () => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_AI_API_KEY;
    expect(() => new DecisionClient()).toThrow(ConfigurationError);
    expect(() => new DecisionClient()).toThrow(/TYPESAFE_API_KEY/);
  });
});

describe('decide', () => {
  it('round-trips a choice and asserts the exact request', async () => {
    const recorded = stubFetch([
      {
        body: body({
          triage: {
            choice: 'billing',
            confidence: 0.91,
            probabilities: { billing: 0.91, technical: 0.09 },
          },
        }),
      },
    ]);
    const response = await clientFor(recorded.fetchImpl).decide({
      model: MODEL,
      state: { message: 'I was charged twice' },
      questions: {
        triage: new DecisionQuestion({
          type: 'choice',
          instructions: 'Which team should handle this',
          criteria: ['billing', 'technical'],
        }),
      },
    });

    const request = at(recorded.calls, 0);
    expect(request.method).toBe('POST');
    expect(request.url).toBe(`${DEFAULT_TYPESAFE_BASE_URL}/v1/systemone`);
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(request.body)).toEqual({
      model: MODEL,
      state: { message: 'I was charged twice' },
      questions: {
        triage: {
          type: 'choice',
          instructions: 'Which team should handle this',
          criteria: ['billing', 'technical'],
        },
      },
    });

    const triage = answer(response, 'triage');
    expect(triage.type).toBe('choice');
    expect(triage.choice).toBe('billing');
    expect(triage.confidence).toBe(0.91);
    expect(triage.probabilities).toEqual({ billing: 0.91, technical: 0.09 });
    expect(response.model).toBe(MODEL);
    expect(response.inputTokens).toBe(430);
    expect(response.outputTokens).toBe(0);
  });

  it('keeps the legend on a score', async () => {
    const recorded = stubFetch([
      {
        body: body({
          quality: {
            score: 3,
            confidence: 0.7,
            legend: 'bad',
            probabilities: { bad: 0.7, good: 0.3 },
          },
        }),
      },
    ]);
    const response = await clientFor(recorded.fetchImpl).decide({
      model: MODEL,
      state: 'the answer',
      questions: {
        quality: new DecisionQuestion({
          type: 'score',
          instructions: 'Rate the answer',
          criteria: ['bad', 'good'],
        }),
      },
    });

    const quality = answer(response, 'quality');
    expect(quality.score).toBe(3);
    expect(quality.legend).toBe('bad');
    expect(quality.confidence).toBe(0.7);
  });

  it('gives a noul no confidence field', async () => {
    const recorded = stubFetch([{ body: body({ urgent: { noul: 0.12 } }) }]);
    const response = await clientFor(recorded.fetchImpl).decide({
      model: MODEL,
      state: 'when is this due',
      questions: { urgent: urgent() },
    });

    const urgentAnswer = answer(response, 'urgent');
    expect(urgentAnswer.noul).toBe(0.12);
    expect(urgentAnswer.confidence).toBeUndefined();
    expect(JSON.parse(at(recorded.calls, 0).body).questions.urgent).toEqual({
      type: 'noul',
      instructions: 'Is it urgent',
    });
  });

  it('refuses a noul answer that carries confidence', async () => {
    const recorded = stubFetch([{ body: body({ urgent: { noul: 0.12, confidence: 0.9 } }) }]);
    await expect(
      clientFor(recorded.fetchImpl).decide({
        model: MODEL,
        state: 'x',
        questions: { urgent: urgent() },
      }),
    ).rejects.toThrow(/must not carry 'confidence'/);
  });

  it('refuses a choice answer without confidence', async () => {
    const recorded = stubFetch([{ body: body({ triage: { choice: 'billing' } }) }]);
    await expect(
      clientFor(recorded.fetchImpl).decide({
        model: MODEL,
        state: 'x',
        questions: {
          triage: new DecisionQuestion({
            type: 'choice',
            instructions: 'Which',
            criteria: ['billing', 'technical'],
          }),
        },
      }),
    ).rejects.toThrow(/must carry 'confidence'/);
  });

  it('retries a 429 and honours retry-after', async () => {
    const recorded = stubFetch([
      { status: 429, headers: { 'retry-after': '0' } },
      { body: body({ urgent: { noul: 0.4 } }) },
    ]);
    const response = await clientFor(recorded.fetchImpl).decide({
      model: MODEL,
      state: 'x',
      questions: { urgent: urgent() },
    });

    expect(recorded.calls).toHaveLength(2);
    expect(answer(response, 'urgent').noul).toBe(0.4);
  });

  it('does not retry a 4xx', async () => {
    const recorded = stubFetch([{ status: 400, body: 'bad request' }]);
    await expect(
      clientFor(recorded.fetchImpl).decide({
        model: MODEL,
        state: 'x',
        questions: { urgent: urgent() },
      }),
    ).rejects.toThrow(ProviderError);
    expect(recorded.calls).toHaveLength(1);
  });

  it('refuses a moving alias when the result must be reproducible', async () => {
    const recorded = stubFetch([]);
    await expect(
      clientFor(recorded.fetchImpl).decide({
        model: 'jev-latest',
        state: 'x',
        questions: { urgent: urgent() },
        reproducible: true,
      }),
    ).rejects.toThrow(/moving alias/);
    expect(recorded.calls).toHaveLength(0);
  });

  it('rejects an empty question set', async () => {
    const recorded = stubFetch([]);
    await expect(
      clientFor(recorded.fetchImpl).decide({ model: MODEL, state: 'x', questions: {} }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('reports a non-JSON body as a provider response error', async () => {
    const recorded = stubFetch([{ body: 'not json' }]);
    await expect(
      clientFor(recorded.fetchImpl).decide({
        model: MODEL,
        state: 'x',
        questions: { urgent: urgent() },
      }),
    ).rejects.toThrow(ProviderResponseError);
  });
});

describe('questions', () => {
  it('validates the shape each type can produce', () => {
    expect(
      () =>
        new DecisionQuestion({
          type: 'noul' as const,
          instructions: 'x',
          criteria: ['a'],
        }),
    ).toThrow(/takes no criteria/);
    expect(() => new DecisionQuestion({ type: 'choice', instructions: 'x' })).toThrow(
      /needs at least one criterion/,
    );
    expect(
      () => new DecisionQuestion({ type: 'score', instructions: 'x', criteria: ['a'] }),
    ).toThrow(/between 2 and 10/);
    expect(() => new DecisionQuestion({ type: 'noul', instructions: '  ' })).toThrow(
      /needs instructions/,
    );
  });

  it('knows which aliases move', () => {
    expect(isReproducibleModel('jev-1.14.0')).toBe(true);
    expect(isReproducibleModel('jev-latest')).toBe(false);
    expect(isReproducibleModel('jev-preview')).toBe(false);
  });
});

describe('cost', () => {
  it('prices input tokens only', () => {
    expect(JEV_INPUT_USD_PER_MTOK).toBe(0.042);
    // $42 per billion: a ~430-token classification is about $0.000018.
    expect(decisionCostUsd(430)).toBeCloseTo(0.00001806, 12);
    expect(decisionCostUsd(1_000_000)).toBeCloseTo(JEV_INPUT_USD_PER_MTOK, 12);
    expect(decisionCostUsd(0)).toBe(0);
    // No reported usage is unknown; the client records no cost at all rather than
    // claiming the call was free.
    expect(decisionCostUsd(undefined)).toBe(0);
  });

  it('records usage and cost on the decision span', async () => {
    const dir = traceDir();

    await clientFor(
      stubFetch([{ body: body({ triage: { choice: 'billing', confidence: 0.9 } }) }]).fetchImpl,
    ).decide({
      model: MODEL,
      state: { message: 'I was charged twice' },
      questions: {
        triage: new DecisionQuestion({
          type: 'choice',
          instructions: 'Which team should handle this',
          criteria: ['billing', 'technical'],
        }),
      },
    });

    const [record = {}] = traceLines(dir);
    const attributes = record.attributes as Record<string, unknown>;
    expect(record.name).toBe(`decision ${MODEL}`);
    expect(record.kind).toBe('decision');
    expect(attributes[ATTRIBUTES.system]).toBe('typesafe');
    expect(attributes[ATTRIBUTES.operation]).toBe('decision');
    expect(attributes[ATTRIBUTES.inputTokens]).toBe(430);
    expect(attributes[ATTRIBUTES.outputTokens]).toBe(0);
    expect(attributes[ATTRIBUTES.costUsd] as number).toBeCloseTo(0.00001806, 12);
    expect(attributes[ATTRIBUTES.responseModel]).toBe(MODEL);
  });

  it('records no cost when the reply carries no usage', async () => {
    const dir = traceDir();
    const reply = JSON.stringify({ model: MODEL, answers: { urgent: { noul: 0.2 } } });

    await clientFor(stubFetch([{ body: reply }]).fetchImpl).decide({
      model: MODEL,
      state: 'x',
      questions: { urgent: urgent() },
    });

    const [record = {}] = traceLines(dir);
    const attributes = record.attributes as Record<string, unknown>;
    expect(attributes[ATTRIBUTES.costUsd]).toBeUndefined();
    expect(attributes[ATTRIBUTES.inputTokens]).toBeUndefined();
    // The serving model is recorded even when the vendor omits usage.
    expect(attributes[ATTRIBUTES.responseModel]).toBe(MODEL);
  });
});
