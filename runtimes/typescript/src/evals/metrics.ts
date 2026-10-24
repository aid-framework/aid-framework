/**
 * Eval metrics.
 *
 * A metric turns `(case, prediction)` into a score in `[0, 1]`. Each metric declares
 * whether it is *deterministic*, and the gate uses that flag to refuse to be built on
 * a metric that calls a model. This is the enforcement point for a Phase 0 decision:
 * implement `llm-judge`, never make CI depend on it.
 */

import { z } from 'zod';
// biome-ignore lint/suspicious/noShadowRestrictedNames: the framework's own error name, matching the Python runtime's public surface
import { EvalError } from '../errors.js';
import { repr } from '../internal/json.js';
import { runStructured, structuredOutput } from '../structured.js';
import type { EvalCase } from './dataset.js';

const WHITESPACE = /\s+/g;

/** One metric's verdict on one prediction. */
export class MetricResult {
  readonly metric: string;
  readonly score: number;
  readonly passed: boolean;
  readonly detail: string;

  constructor(init: {
    readonly metric: string;
    readonly score: number;
    readonly passed: boolean;
    readonly detail?: string;
  }) {
    if (!(init.score >= 0.0 && init.score <= 1.0)) {
      throw new RangeError('score must be between 0 and 1');
    }
    this.metric = init.metric;
    this.score = init.score;
    this.passed = init.passed;
    this.detail = init.detail ?? '';
  }
}

/** Scores a single prediction. */
export interface Metric {
  /** Stable identifier used in baselines and thresholds. */
  readonly name: string;
  /**
   * Whether the same prediction always yields the same score.
   *
   * A model-backed metric is not deterministic, and the gate refuses to threshold on
   * one: a CI signal that itself varies run to run cannot distinguish a regression
   * from its own noise.
   */
  readonly deterministic: boolean;
  score(entry: EvalCase, prediction: string): Promise<MetricResult>;
}

/** Casefold and collapse whitespace, then strip surrounding punctuation. */
export function normalize(text: string): string {
  // Upper-then-lower approximates Python's `str.casefold()`, which folds further than
  // `toLowerCase()` alone: 'ß' folds to 'ss', 'ſ' to 's', 'Σ' to 'σ'.
  return text
    .trim()
    .replace(WHITESPACE, ' ')
    .toUpperCase()
    .toLowerCase()
    .replace(/^[ .!?'"]+/, '')
    .replace(/[ .!?'"]+$/, '');
}

/** Normalized string equality against `case.expected`. */
export class ExactMatch implements Metric {
  private readonly _name: string;

  constructor(options: { readonly name?: string } = {}) {
    this._name = options.name ?? 'exact-match';
  }

  get name(): string {
    return this._name;
  }

  get deterministic(): boolean {
    return true;
  }

  async score(entry: EvalCase, prediction: string): Promise<MetricResult> {
    if (entry.expected === null) {
      throw new EvalError(`case ${repr(entry.id)} has no expected value for ${this.name}`);
    }
    const ok = normalize(prediction) === normalize(entry.expected);
    return new MetricResult({
      metric: this.name,
      score: ok ? 1.0 : 0.0,
      passed: ok,
      detail: ok ? '' : `expected ${repr(entry.expected)}`,
    });
  }
}

/** Whether the normalized prediction contains the normalized expectation. */
export class NormalizedContains implements Metric {
  private readonly _name: string;

  constructor(options: { readonly name?: string } = {}) {
    this._name = options.name ?? 'contains';
  }

  get name(): string {
    return this._name;
  }

  get deterministic(): boolean {
    return true;
  }

  async score(entry: EvalCase, prediction: string): Promise<MetricResult> {
    if (entry.expected === null) {
      throw new EvalError(`case ${repr(entry.id)} has no expected value for ${this.name}`);
    }
    const ok = normalize(prediction).includes(normalize(entry.expected));
    return new MetricResult({
      metric: this.name,
      score: ok ? 1.0 : 0.0,
      passed: ok,
      detail: ok ? '' : `missing ${repr(entry.expected)}`,
    });
  }
}

/** The Python `type(value).__name__` for a JSON value. */
function typeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'dict';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  return typeof value;
}

function typeOk(value: unknown, declared: string): boolean {
  switch (declared) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Check the JSON Schema subset a dataset realistically uses. */
function schemaProblems(schema: unknown, value: unknown, path: string): string[] {
  const problems: string[] = [];
  if (!isObject(schema)) return problems;

  const declared = schema.type;
  if (typeof declared === 'string' && !typeOk(value, declared)) {
    problems.push(`${path}: expected ${declared}, got ${typeName(value)}`);
  }

  if (isObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === 'string' && !Object.hasOwn(value, name)) {
          problems.push(`${path}: missing required property ${repr(name)}`);
        }
      }
    }
    const properties = schema.properties;
    if (isObject(properties)) {
      for (const [name, subschema] of Object.entries(properties)) {
        if (Object.hasOwn(value, name)) {
          problems.push(...schemaProblems(subschema, value[name], `${path}.${name}`));
        }
      }
    }
  }

  if (Array.isArray(value) && isObject(schema.items)) {
    for (const [index, item] of value.entries()) {
      problems.push(...schemaProblems(schema.items, item, `${path}[${index}]`));
    }
  }

  return problems;
}

/**
 * Whether the prediction parses as JSON and satisfies the case's schema.
 *
 * The schema lives in the case's metadata under `json_schema` as a JSON string, which
 * keeps datasets in a single file format.
 */
export class JsonSchemaValid implements Metric {
  private readonly _name: string;

  constructor(options: { readonly name?: string } = {}) {
    this._name = options.name ?? 'json-valid';
  }

  get name(): string {
    return this._name;
  }

  get deterministic(): boolean {
    return true;
  }

  async score(entry: EvalCase, prediction: string): Promise<MetricResult> {
    const schema = entry.metadata.json_schema;
    let parsed: unknown;
    try {
      parsed = JSON.parse(prediction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new MetricResult({
        metric: this.name,
        score: 0.0,
        passed: false,
        detail: `invalid JSON: ${message}`,
      });
    }
    if (schema === undefined) {
      return new MetricResult({ metric: this.name, score: 1.0, passed: true, detail: 'parsed' });
    }

    const problems = schemaProblems(JSON.parse(schema) as unknown, parsed, '$');
    return new MetricResult({
      metric: this.name,
      score: problems.length === 0 ? 1.0 : 0.0,
      passed: problems.length === 0,
      detail: problems.join('; '),
    });
  }
}

/** The structured output an LLM judge must return. */
export const JudgeVerdict = structuredOutput(
  'JudgeVerdict',
  z.object({
    score: z.number().min(0.0).max(1.0),
    reason: z.string().default(''),
  }),
);

/** A judge call: one prompt in, one model answer out. */
export type JudgeCall = (prompt: string) => Promise<string>;

/**
 * Scores a prediction with a model, as a *metric only*.
 *
 * `deterministic` is `false` and must stay that way. Using this metric for a CI
 * threshold would make the gate's own verdict probabilistic; the gate raises rather
 * than allow it. It is implemented because a judge is the right way to explore quality
 * locally and to produce a second opinion next to a deterministic gate -- not because
 * it can be trusted as the gate.
 */
export class LlmJudge implements Metric {
  private readonly _call: JudgeCall;
  private readonly _rubric: string;
  private readonly _name: string;
  private readonly _retries: number;

  constructor(
    call: JudgeCall,
    options: { readonly rubric: string; readonly name?: string; readonly retries?: number },
  ) {
    this._call = call;
    this._rubric = options.rubric;
    this._name = options.name ?? 'llm-judge';
    this._retries = options.retries ?? 2;
  }

  get name(): string {
    return this._name;
  }

  get deterministic(): boolean {
    return false;
  }

  async score(entry: EvalCase, prediction: string): Promise<MetricResult> {
    const prompt = this.buildPrompt(entry, prediction);
    try {
      const verdict = await runStructured(this._call, JudgeVerdict, prompt, {
        retries: this._retries,
      });
      return new MetricResult({
        metric: this.name,
        score: verdict.score,
        passed: verdict.score >= 0.5,
        detail: verdict.reason,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new MetricResult({
        metric: this.name,
        score: 0.0,
        passed: false,
        detail: `judge failed: ${message}`,
      });
    }
  }

  private buildPrompt(entry: EvalCase, prediction: string): string {
    const expected = entry.expected ?? '<not provided>';
    return (
      `${this._rubric}\n\n` +
      `Input: ${entry.input}\n` +
      `Reference: ${expected}\n` +
      `Candidate: ${prediction}\n\n` +
      'Reply with JSON: {"score": <0.0-1.0>, "reason": "<short>"}'
    );
  }
}

/** The deterministic gate metrics: everything that needs no model call. */
export function defaultMetrics(): Metric[] {
  return [new ExactMatch(), new NormalizedContains(), new JsonSchemaValid()];
}

export function metricNames(metrics: readonly Metric[]): string[] {
  return metrics.map((metric) => metric.name);
}
