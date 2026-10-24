import { describe, expect, it } from 'vitest';

import {
  defaultMetrics,
  EvalCase,
  ExactMatch,
  EvalError as FrameworkEvalError,
  JsonSchemaValid,
  LlmJudge,
  MetricResult,
  metricNames,
  NormalizedContains,
  normalize,
} from '../src/index.js';

const capitals = new EvalCase({ id: 'france', input: 'Capital of France?', expected: 'Paris' });

describe('normalize', () => {
  it('collapses every whitespace run, not just the first', () => {
    // The reference collapses all runs; a single non-global replace would leave one.
    expect(normalize('a  b   c')).toBe('a b c');
    expect(normalize('a\t\n b')).toBe('a b');
  });

  it('strips surrounding punctuation and spaces', () => {
    expect(normalize('  "Paris."  ')).toBe('paris');
    expect(normalize("'Paris!'")).toBe('paris');
  });

  it('folds case beyond toLowerCase alone', () => {
    // Python's str.casefold() folds 'ß' to 'ss'; plain toLowerCase does not.
    expect(normalize('STRAßE')).toBe('strasse');
    expect(normalize('PARIS')).toBe('paris');
  });

  it('leaves inner punctuation alone', () => {
    expect(normalize('New  York, NY')).toBe('new york, ny');
  });
});

describe('MetricResult', () => {
  it('defaults detail to an empty string', () => {
    const result = new MetricResult({ metric: 'm', score: 1, passed: true });

    expect(result.detail).toBe('');
  });

  it('refuses a score outside [0, 1]', () => {
    expect(() => new MetricResult({ metric: 'm', score: 1.1, passed: false })).toThrow(
      /score must be between 0 and 1/,
    );
    expect(() => new MetricResult({ metric: 'm', score: -0.1, passed: false })).toThrow(
      /score must be between 0 and 1/,
    );
    expect(() => new MetricResult({ metric: 'm', score: Number.NaN, passed: false })).toThrow(
      /score must be between 0 and 1/,
    );
  });
});

describe('ExactMatch', () => {
  it('names itself and is deterministic', () => {
    const metric = new ExactMatch();

    expect(metric.name).toBe('exact-match');
    expect(metric.deterministic).toBe(true);
    expect(new ExactMatch({ name: 'strict' }).name).toBe('strict');
  });

  it('matches after normalization', async () => {
    const result = await new ExactMatch().score(capitals, '  "paris" ');

    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.detail).toBe('');
  });

  it('explains a miss', async () => {
    const result = await new ExactMatch().score(capitals, 'Lyon');

    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.detail).toBe("expected 'Paris'");
  });

  it('refuses a case with no expected value', async () => {
    const entry = new EvalCase({ id: 'x', input: 'y' });

    await expect(new ExactMatch().score(entry, 'anything')).rejects.toThrow(
      /case 'x' has no expected value for exact-match/,
    );
  });
});

describe('NormalizedContains', () => {
  it('names itself and is deterministic', () => {
    expect(new NormalizedContains().name).toBe('contains');
    expect(new NormalizedContains().deterministic).toBe(true);
  });

  it('accepts a prediction that contains the expectation', async () => {
    const result = await new NormalizedContains().score(capitals, 'The capital is  PARIS.');

    expect(result.passed).toBe(true);
  });

  it('explains a miss', async () => {
    const result = await new NormalizedContains().score(capitals, 'The capital is Lyon.');

    expect(result.score).toBe(0);
    expect(result.detail).toBe("missing 'Paris'");
  });

  it('refuses a case with no expected value', async () => {
    await expect(
      new NormalizedContains().score(new EvalCase({ id: 'x', input: 'y' }), 'z'),
    ).rejects.toThrow(/has no expected value for contains/);
  });
});

describe('JsonSchemaValid', () => {
  const metric = new JsonSchemaValid();

  it('names itself and is deterministic', () => {
    expect(metric.name).toBe('json-valid');
    expect(metric.deterministic).toBe(true);
  });

  it('reports invalid JSON without throwing', async () => {
    const result = await metric.score(capitals, '{');

    expect(result.score).toBe(0);
    expect(result.detail).toMatch(/^invalid JSON: /);
  });

  it('accepts JSON when the case carries no schema', async () => {
    const result = await metric.score(capitals, '{"a": 1}');

    expect(result.passed).toBe(true);
    expect(result.detail).toBe('parsed');
  });

  const schema = JSON.stringify({
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' }, age: { type: 'integer' } },
  });
  const withSchema = new EvalCase({
    id: 'person',
    input: 'who',
    metadata: { json_schema: schema },
  });

  it('accepts a payload that satisfies the schema', async () => {
    const result = await metric.score(withSchema, '{"name":"Ada","age":36}');

    expect(result.passed).toBe(true);
    expect(result.detail).toBe('');
  });

  it('names a wrong type with its path', async () => {
    const result = await metric.score(withSchema, '{"name":"Ada","age":"old"}');

    expect(result.passed).toBe(false);
    expect(result.detail).toBe('$.age: expected integer, got str');
  });

  it('names a missing required property', async () => {
    const result = await metric.score(withSchema, '{}');

    expect(result.detail).toBe("$: missing required property 'name'");
  });

  it('walks arrays and nested objects', async () => {
    const entry = new EvalCase({
      id: 'list',
      input: 'x',
      metadata: {
        json_schema: JSON.stringify({
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'string' } } },
        }),
      },
    });

    const result = await metric.score(entry, '{"items":["a",2]}');

    expect(result.detail).toBe('$.items[1]: expected string, got int');
  });

  it('names the top-level type mismatch', async () => {
    expect((await metric.score(withSchema, '[]')).detail).toBe('$: expected object, got list');
    expect((await metric.score(withSchema, 'null')).detail).toBe(
      '$: expected object, got NoneType',
    );
    expect((await metric.score(withSchema, '1.5')).detail).toBe('$: expected object, got float');
  });
});

describe('LlmJudge', () => {
  it('names itself and is never deterministic', () => {
    const judge = new LlmJudge(async () => '{}', { rubric: 'be fair' });

    expect(judge.name).toBe('llm-judge');
    expect(judge.deterministic).toBe(false);
    expect(new LlmJudge(async () => '{}', { rubric: 'r', name: 'strict-judge' }).name).toBe(
      'strict-judge',
    );
  });

  it('scores from the model verdict and passes at half', async () => {
    const judge = new LlmJudge(async () => '{"score":0.5,"reason":"close"}', { rubric: 'be fair' });

    const result = await judge.score(capitals, 'Paris');

    expect(result.score).toBe(0.5);
    expect(result.passed).toBe(true);
    expect(result.detail).toBe('close');
  });

  it('fails below half', async () => {
    const judge = new LlmJudge(async () => '{"score":0.25}', { rubric: 'be fair' });

    expect((await judge.score(capitals, 'Lyon')).passed).toBe(false);
  });

  it('turns an unparseable verdict into a zero score rather than throwing', async () => {
    const judge = new LlmJudge(async () => 'no json here', { rubric: 'be fair', retries: 0 });

    const result = await judge.score(capitals, 'Paris');

    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/^judge failed: JudgeVerdict not produced from 1 attempt\(s\)/);
  });

  it('builds a prompt naming the input, reference and candidate', async () => {
    let seen = '';
    const judge = new LlmJudge(
      async (prompt) => {
        seen = prompt;
        return '{"score":1}';
      },
      { rubric: 'RUBRIC' },
    );

    await judge.score(capitals, 'CANDIDATE');

    expect(seen).toContain('RUBRIC');
    expect(seen).toContain('Input: Capital of France?');
    expect(seen).toContain('Reference: Paris');
    expect(seen).toContain('Candidate: CANDIDATE');
    expect(seen).toContain('"score"');
  });

  it('shows a missing reference as a placeholder', async () => {
    let seen = '';
    const judge = new LlmJudge(
      async (prompt) => {
        seen = prompt;
        return '{"score":1}';
      },
      { rubric: 'RUBRIC' },
    );

    await judge.score(new EvalCase({ id: 'x', input: 'i' }), 'c');

    expect(seen).toContain('Reference: <not provided>');
  });
});

describe('defaultMetrics', () => {
  it('returns the three deterministic metrics in order', () => {
    expect(metricNames(defaultMetrics())).toEqual(['exact-match', 'contains', 'json-valid']);
    expect(defaultMetrics().map((metric) => metric.deterministic)).toEqual([true, true, true]);
  });
});

describe('metric wiring', () => {
  it('raises the framework error type for a missing expectation', async () => {
    await expect(
      new ExactMatch().score(new EvalCase({ id: 'x', input: 'y' }), 'z'),
    ).rejects.toBeInstanceOf(FrameworkEvalError);
  });
});
