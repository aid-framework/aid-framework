/**
 * An offline gateway and dependency bundle for the example's tests.
 *
 * Mirrors `examples/support-copilot/tests/fake_gateway.py`: the same provider answers
 * both the `fake` and `openai` provider names, so the `fast` alias can never reach the
 * network, and the canned answers are keyed by a phrase the rendered prompt contains.
 */

import { FakeProvider, type Retriever, type ToolExecutor } from '@aid/runtime';

import { buildDeps, type Deps } from '../app/generated/deps.js';
import { buildGateway } from '../app/generated/gateway/index.js';

function answer(category: string, confidence: number, summary: string): string {
  return JSON.stringify({ category, confidence, summary });
}

/** Answers keyed by a distinctive phrase of the ticket each one classifies. */
export const IDEAL_ANSWERS: Readonly<Record<string, string>> = {
  'charged twice': answer('billing', 0.93, 'The customer was charged twice for one period.'),
  'export a report': answer('bug', 0.88, 'Exporting a report fails, so this is a defect report.'),
  'to a CSV file': answer('howto', 0.81, 'The customer asks how to export their data as CSV.'),
};

export interface FakeProviderOptions {
  readonly accuracy?: number;
  readonly seed?: number;
}

/** A deterministic provider that answers the three canned prompts above. */
export function fakeProvider(options: FakeProviderOptions = {}): FakeProvider {
  return new FakeProvider({
    answers: IDEAL_ANSWERS,
    accuracy: options.accuracy ?? 1.0,
    seed: options.seed ?? 0,
  });
}

export interface FakeDepsOptions extends FakeProviderOptions {
  readonly tools?: ToolExecutor;
  readonly retrievers?: ReadonlyMap<string, Retriever>;
}

/**
 * Build dependencies over the fake provider.
 *
 * `tools` and `retrievers` are spread in only when given: both are optional on
 * `BuildDepsOptions`, and an explicit `undefined` would be a different thing.
 */
export function fakeDeps(options: FakeDepsOptions = {}): Deps {
  const provider = fakeProvider({ accuracy: options.accuracy ?? 1.0, seed: options.seed ?? 0 });
  const overrides: {
    tools?: ToolExecutor;
    retrievers?: ReadonlyMap<string, Retriever>;
  } = {};
  if (options.tools !== undefined) overrides.tools = options.tools;
  if (options.retrievers !== undefined) overrides.retrievers = options.retrievers;
  return buildDeps({
    gateway: buildGateway({ providers: { fake: provider, openai: provider } }),
    ...overrides,
  });
}
