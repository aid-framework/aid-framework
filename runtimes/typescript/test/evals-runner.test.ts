import { describe, expect, it } from 'vitest';
import {
  CompletionRequest,
  Dataset,
  DatasetRun,
  type EvalCase,
  ExactMatch,
  evaluateOnce,
  FakeProvider,
  GatewayRunner,
  gatewayJudge,
  NormalizedContains,
  runEvaluation,
} from '../src/index.js';
import { at, capitalsDataset, modelGateway } from './support.js';

const ANSWERS = {
  'capital-fr': 'Paris',
  'capital-jp': 'Tokyo',
  'capital-pe': 'Lima',
  'capital-ke': 'Nairobi',
} as const;

/** A runner that answers from a table, so the loop can be tested without a provider. */
function tableRunner(answers: Readonly<Record<string, string>>) {
  const seen: string[] = [];
  return {
    seen,
    runner: async (entry: EvalCase): Promise<string> => {
      seen.push(entry.id);
      return answers[entry.id] ?? 'unknown';
    },
  };
}

/** A gateway over a fake provider whose calls the test can inspect. */
function inspectableGateway(provider: FakeProvider = new FakeProvider({ accuracy: 1.0 })) {
  return { provider, gateway: modelGateway(provider) };
}

function lastRequest(provider: FakeProvider): CompletionRequest {
  return at(provider.calls, provider.calls.length - 1);
}

describe('evaluateOnce', () => {
  it('scores every case with every metric, in order', async () => {
    const { runner } = tableRunner(ANSWERS);
    const result = await evaluateOnce(capitalsDataset(), runner, [
      new ExactMatch(),
      new NormalizedContains(),
    ]);

    expect(result.dataset).toBe('capitals');
    expect(result.datasetVersion).toBe('1.0.0');
    expect(result.outcomes.map((outcome) => outcome.caseId)).toEqual([
      'capital-fr',
      'capital-jp',
      'capital-pe',
      'capital-ke',
    ]);
    expect(result.outcomes.map((outcome) => outcome.scores.length)).toEqual([2, 2, 2, 2]);
    expect(result.means()).toEqual({ 'exact-match': 1, contains: 1 });
  });

  it('marks a case passed only when every metric passed', async () => {
    const { runner } = tableRunner({ 'capital-fr': 'the capital of france is paris' });
    const result = await evaluateOnce(capitalsDataset(), runner, [
      new ExactMatch(),
      new NormalizedContains(),
    ]);

    // ExactMatch misses, Contains hits: the case fails because one metric failed.
    expect(result.outcome('capital-fr').passed).toBe(false);
    expect(result.outcome('capital-fr').scores.map((score) => score.passed)).toEqual([false, true]);
  });

  it('lists failures and names a miss', async () => {
    const { runner } = tableRunner({ ...ANSWERS, 'capital-jp': 'Kyoto' });
    const result = await evaluateOnce(capitalsDataset(), runner, [new ExactMatch()]);

    expect(result.failures().map((outcome) => outcome.caseId)).toEqual(['capital-jp']);
    expect(() => result.outcome('atlantis')).toThrow(/no outcome recorded for case 'atlantis'/);
  });

  it('summarizes the pass rate, the means and each failure', async () => {
    const { runner } = tableRunner({ ...ANSWERS, 'capital-jp': 'Kyoto' });
    const result = await evaluateOnce(capitalsDataset(), runner, [new ExactMatch()]);
    const summary = result.summary();

    expect(summary.split('\n')[0]).toBe('capitals@1.0.0: 3/4 cases passed');
    expect(summary).toContain('  exact-match: 0.7500');
    expect(summary).toContain("  FAIL capital-jp: exact-match: expected 'Tokyo'");
  });

  it('refuses an empty metric list', async () => {
    const { runner } = tableRunner({});

    await expect(evaluateOnce(capitalsDataset(), runner, [])).rejects.toThrow(
      /at least one metric is required/,
    );
  });

  it('refuses a run with no outcomes', () => {
    expect(() => new DatasetRun({ dataset: 'd', datasetVersion: '1', outcomes: [] })).toThrow(
      /a dataset run needs at least one outcome/,
    );
  });
});

describe('runEvaluation', () => {
  it('samples the dataset the requested number of times', async () => {
    const { runner, seen } = tableRunner(ANSWERS);
    const result = await runEvaluation(capitalsDataset(), runner, [new ExactMatch()], { runs: 3 });

    expect(seen).toHaveLength(12);
    expect(result.runs).toBe(3);
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]?.metric).toBe('exact-match');
    expect(result.metrics[0]?.values).toEqual([1, 1, 1]);
  });

  it('defaults to five runs', async () => {
    const { runner, seen } = tableRunner(ANSWERS);
    const result = await runEvaluation(capitalsDataset(), runner, [new ExactMatch()]);

    expect(result.runs).toBe(5);
    expect(seen).toHaveLength(20);
  });

  it('records a mean per metric per run', async () => {
    // The answer alternates, so successive runs carry different means.
    let pass = 0;
    const runner = async (): Promise<string> => {
      pass += 1;
      return pass % 2 === 0 ? 'Paris' : 'Lyon';
    };
    const single = Dataset.fromRecords('one', '1', [
      { id: 'capital-fr', input: 'q', expected: 'Paris' },
    ]);
    const result = await runEvaluation(single, runner, [new ExactMatch()], { runs: 2 });

    expect(result.metrics[0]?.values).toEqual([0, 1]);
  });

  it('records one value per metric per run', async () => {
    const { runner } = tableRunner(ANSWERS);
    const result = await runEvaluation(
      capitalsDataset(),
      runner,
      [new ExactMatch(), new NormalizedContains()],
      { runs: 2 },
    );

    expect(result.metrics.map((metric) => metric.metric)).toEqual(['exact-match', 'contains']);
    expect(result.metrics.map((metric) => metric.values.length)).toEqual([2, 2]);
  });

  it('refuses fewer than one run', async () => {
    const { runner } = tableRunner({});

    await expect(
      runEvaluation(capitalsDataset(), runner, [new ExactMatch()], { runs: 0 }),
    ).rejects.toThrow(/runs must be at least 1/);
  });

  it('refuses an empty metric list', async () => {
    const { runner } = tableRunner({});

    await expect(runEvaluation(capitalsDataset(), runner, [])).rejects.toThrow(
      /at least one metric is required/,
    );
  });
});

describe('GatewayRunner', () => {
  it('resolves the alias at construction and remembers it', () => {
    const { gateway } = inspectableGateway();

    expect(new GatewayRunner(gateway, 'small').alias).toBe('small');
    expect(() => new GatewayRunner(gateway, 'absent')).toThrow(/unknown model alias 'absent'/);
  });

  it('sends the case input as a user message', async () => {
    const { provider, gateway } = inspectableGateway(
      new FakeProvider({ answers: { 'What is the capital of France?': 'Paris' } }),
    );
    const runner = new GatewayRunner(gateway, 'small');

    expect(await runner.run(capitalsDataset().case('capital-fr'))).toBe('Paris');
    expect(lastRequest(provider).messages).toHaveLength(1);
    expect(lastRequest(provider).messages[0]?.content).toBe('What is the capital of France?');
  });

  it('puts a system message first when one is configured', async () => {
    const { provider, gateway } = inspectableGateway(
      new FakeProvider({ answers: { 'What is the capital of France?': 'Paris' } }),
    );
    const runner = new GatewayRunner(gateway, 'small', { system: 'be terse' });
    await runner.run(capitalsDataset().case('capital-fr'));

    const request = lastRequest(provider);
    expect(request.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(request.messages[0]?.content).toBe('be terse');
  });

  it('accepts a request factory instead of the default shape', async () => {
    const { provider, gateway } = inspectableGateway(
      new FakeProvider({ answers: { 'q:capital-fr': 'Paris' } }),
    );
    const runner = new GatewayRunner(gateway, 'small', {
      system: 'ignored',
      requestFor: (entry) => CompletionRequest.prompt(`q:${entry.id}`),
    });

    expect(await runner.run(capitalsDataset().case('capital-fr'))).toBe('Paris');
    expect(lastRequest(provider).messages.map((message) => message.role)).toEqual(['user']);
  });

  it('forwards fallbacks to the gateway', async () => {
    const provider = new FakeProvider({ failWith: ['small'] });
    const gateway = modelGateway(provider);
    const runner = new GatewayRunner(gateway, 'small', { fallbacks: ['large'] });

    // 'large' answers, so the fallback carried the request.
    expect(await runner.run(capitalsDataset().case('capital-fr'))).toBeTypeOf('string');
    expect(provider.calls.length).toBeGreaterThan(1);
  });

  it('exposes the gateway spend', async () => {
    const { gateway } = inspectableGateway(
      new FakeProvider({ answers: { 'What is the capital of France?': 'Paris' } }),
    );
    const runner = new GatewayRunner(gateway, 'small');
    await runner.run(capitalsDataset().case('capital-fr'));

    expect(runner.costUsd).toBe(gateway.ledger.costUsd);
    expect(runner.costUsd).toBeGreaterThan(0);
  });
});

describe('gatewayJudge', () => {
  it('returns the model text for a prompt', async () => {
    const { provider, gateway } = inspectableGateway(
      new FakeProvider({ answers: { 'rate this': '{"score":1}' } }),
    );
    const judge = gatewayJudge(gateway, 'small', { system: 'be strict' });

    expect(await judge('rate this')).toBe('{"score":1}');
    expect(lastRequest(provider).messages.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
  });
});
