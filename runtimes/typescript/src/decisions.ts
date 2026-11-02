/**
 * The TypeSafe AI (Jev) decision client.
 *
 * Jev is a *System One* model, not a chat model: it takes a state and typed
 * questions and returns typed answers. It has no `/chat/completions` surface,
 * no free-text output and no tool calls, so it is deliberately not a member of
 * `providers/`. Putting it there would let a pipeline select it as the model
 * that writes an answer, which it cannot do.
 *
 * The three primitives map to the places a pipeline already needs a judgment:
 *
 * `choice`
 *     one label out of a list -- routing, classification.
 * `score`
 *     a position on an ordered rubric -- eval scoring.
 * `noul`
 *     a probability in `[0, 1]` -- a cheap pre-filter.
 *
 * Two facts drive the shape of this module:
 *
 * **`noul` answers carry no `confidence` at all.** `choice` and `score`
 * answers do. A caller that branches on confidence must therefore refuse a
 * `noul` decision rather than defaulting the missing value to zero, which
 * would silently disable the branch.
 *
 * **A moving model alias cannot be used where a result must be reproducible.**
 * `jev-latest` is legal for interactive routing and refused when
 * `reproducible: true`, which is what the eval harness passes.
 */

import { ConfigurationError, ProviderError, ProviderResponseError } from './errors.js';
import { stripTrailingSlashes } from './internal/text.js';
import { ATTRIBUTES, recordCost, recordUsage, withLlmSpan } from './tracing.js';

export const DEFAULT_TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

/**
 * The first-party SDK reads `TYPESAFE_API_KEY`; Vercel's provider reads
 * `TYPESAFE_AI_API_KEY`. Accept both, first-party name first.
 */
export const TYPESAFE_API_KEY_ENVS = ['TYPESAFE_API_KEY', 'TYPESAFE_AI_API_KEY'] as const;

export const TYPESAFE_BASE_URL_ENV = 'TYPESAFE_BASE_URL';

/**
 * Aliases that move to a new model version. Legal interactively, refused under
 * `reproducible: true`.
 */
export const JEV_MOVING_ALIASES: ReadonlySet<string> = new Set(['jev-latest', 'jev-preview']);

/**
 * Jev bills input tokens at $42 per billion ($0.042 per million) and states
 * that output tokens are free. A call therefore needs an input row only, and a
 * decision must never be reported as unpriceable.
 */
export const JEV_INPUT_USD_PER_MTOK = 0.042;

export type DecisionQuestionType = 'choice' | 'score' | 'noul';

const QUESTION_TYPES: ReadonlySet<string> = new Set(['choice', 'score', 'noul']);

/**
 * 429 and 529 are the retryable classes the vendor names; both may carry
 * `retry-after`. The rest are caller errors and are not retried.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 529]);

/** A response body as much as this client needs to read it. */
export interface DecisionHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null } | undefined;
  text(): Promise<string>;
}

/** The narrow fetch seam this client needs; tests supply their own. */
export type DecisionFetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<DecisionHttpResponse>;

export interface DecisionClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  /** Supplied by tests, or to share a connection pool. */
  readonly fetchImpl?: DecisionFetchLike;
}

export interface DecisionQuestionOptions {
  readonly type: DecisionQuestionType;
  readonly instructions: string;
  readonly criteria?: readonly string[];
}

/**
 * Return the first configured TypeSafe key, or `undefined`.
 *
 * An empty string counts as unset, so a workflow that exports a missing secret
 * does not authenticate with `""`.
 */
export function decisionKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  for (const name of TYPESAFE_API_KEY_ENVS) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** Whether `model` is pinned to one version rather than a moving alias. */
export function isReproducibleModel(model: string): boolean {
  return !JEV_MOVING_ALIASES.has(model);
}

/**
 * Price one decision call from its input tokens alone.
 *
 * Output tokens are free by contract, so they are deliberately not part of the
 * arithmetic: a caller that passed a total would overcharge the run. `undefined`
 * means the vendor reported no usage; `DecisionClient.decide` then records no cost
 * at all, so the call stays unknown rather than free.
 */
export function decisionCostUsd(inputTokens?: number): number {
  if (inputTokens === undefined) return 0;
  return (inputTokens / 1_000_000) * JEV_INPUT_USD_PER_MTOK;
}

/**
 * One typed question.
 *
 * `criteria` is required by `choice` and `score` and forbidden by `noul`,
 * because a probability has nothing to choose between. `score` criteria are
 * ordered: the position is the score.
 */
export class DecisionQuestion {
  readonly type: DecisionQuestionType;
  readonly instructions: string;
  readonly criteria: readonly string[] | undefined;

  constructor(options: DecisionQuestionOptions) {
    const { type, instructions } = options;
    const criteria = options.criteria;
    if (!QUESTION_TYPES.has(type)) {
      throw new ConfigurationError(
        `unknown decision question type ${JSON.stringify(type)}; expected one of ` +
          [...QUESTION_TYPES].sort().join(', '),
      );
    }
    if (instructions.trim() === '') {
      throw new ConfigurationError('a decision question needs instructions');
    }
    if (type === 'noul') {
      if (criteria !== undefined) {
        throw new ConfigurationError('a noul question takes no criteria');
      }
      this.type = type;
      this.instructions = instructions;
      this.criteria = undefined;
      return;
    }
    if (criteria === undefined || criteria.length === 0) {
      throw new ConfigurationError(`a ${type} question needs at least one criterion`);
    }
    if (type === 'score' && (criteria.length < 2 || criteria.length > 10)) {
      throw new ConfigurationError(
        `a score question needs between 2 and 10 ordered criteria; got ${criteria.length}`,
      );
    }
    if (type === 'choice' && criteria.length > 255) {
      throw new ConfigurationError('a choice question takes at most 255 criteria');
    }
    this.type = type;
    this.instructions = instructions;
    this.criteria = [...criteria];
  }

  asPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      type: this.type,
      instructions: this.instructions,
    };
    if (this.criteria !== undefined) payload.criteria = [...this.criteria];
    return payload;
  }
}

/** One typed answer, with every field the question type can produce. */
export interface DecisionAnswer {
  readonly type: DecisionQuestionType;
  readonly choice?: string;
  readonly score?: number;
  readonly noul?: number;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly legend?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/**
 * `model` is echoed by the vendor, so a trace records the version that
 * actually answered -- the only way to explain a score that moved.
 */
export interface DecisionResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface DecideOptions {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  /**
   * Refuse a moving alias. Two runs of an eval would otherwise score two
   * different models under one name.
   */
  readonly reproducible?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function intOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Calls `POST /v1/systemone` and maps the reply to typed answers. */
export class DecisionClient {
  private readonly _name: string;
  private readonly _baseUrl: string;
  private readonly _apiKey: string;
  private readonly _timeoutSeconds: number;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _fetch: DecisionFetchLike;

  constructor(options: DecisionClientOptions = {}) {
    const resolvedKey = options.apiKey ?? decisionKey();
    if (resolvedKey === undefined || resolvedKey === '') {
      throw new ConfigurationError(
        'TypeSafe AI needs an API key; set TYPESAFE_API_KEY (or TYPESAFE_AI_API_KEY)',
      );
    }
    const resolvedBase =
      options.baseUrl ?? process.env[TYPESAFE_BASE_URL_ENV] ?? DEFAULT_TYPESAFE_BASE_URL;
    if (!/^https?:\/\/[^/]/i.test(resolvedBase)) {
      throw new ConfigurationError(
        `base_url must be an absolute http(s) URL, got ${JSON.stringify(resolvedBase)}`,
      );
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (maxAttempts < 1) throw new ConfigurationError('max_attempts must be at least 1');
    this._name = options.name ?? 'typesafe';
    this._baseUrl = stripTrailingSlashes(resolvedBase);
    this._apiKey = resolvedKey;
    this._timeoutSeconds = options.timeoutSeconds ?? 60;
    this._maxAttempts = maxAttempts;
    this._backoffSeconds = options.backoffSeconds ?? 0.5;
    this._fetch = options.fetchImpl ?? (globalThis.fetch as unknown as DecisionFetchLike);
  }

  get name(): string {
    return this._name;
  }

  async decide(options: DecideOptions): Promise<DecisionResponse> {
    const { model, state, questions } = options;
    if (Object.keys(questions).length === 0) {
      throw new ConfigurationError('a decision needs at least one question');
    }
    if (options.reproducible === true && !isReproducibleModel(model)) {
      throw new ConfigurationError(
        `${JSON.stringify(model)} is a moving alias and cannot be used where the result ` +
          "must be reproducible; pin a version such as 'jev-1.14.0'",
      );
    }
    const payload: Record<string, unknown> = {
      model,
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([key, question]) => [key, question.asPayload()]),
      ),
    };
    // A decision is billed like any other model call, so it gets the same span:
    // `aid cost` and the eval budget read `aid.cost.usd` off it.
    return withLlmSpan({ operation: 'decision', model, system: this._name }, async (handle) => {
      const body = await this.post(payload);
      const response = this.parse(body, questions);
      if (response.inputTokens !== undefined) {
        recordUsage(handle.span, response.inputTokens, response.outputTokens ?? 0);
        recordCost(handle.span, decisionCostUsd(response.inputTokens));
      }
      handle.span.setAttribute(ATTRIBUTES.responseModel, response.model);
      return response;
    });
  }

  async close(): Promise<void> {
    // There is no connection pool to release; nothing to do, and calling twice is safe.
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this._apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  private async post(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this._baseUrl}/v1/systemone`;
    let last = 'no attempt was made';
    for (let attempt = 1; attempt <= this._maxAttempts; attempt += 1) {
      try {
        const response = await this._fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this._timeoutSeconds * 1000),
        });
        const text = await response.text();
        if (RETRYABLE_STATUSES.has(response.status) && attempt < this._maxAttempts) {
          await delay(this.retryDelay(response, attempt));
          continue;
        }
        if (response.status >= 400) {
          throw new ProviderError(
            `${this._name} returned ${response.status}: ${text.slice(0, 500)}`,
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new ProviderResponseError(`${this._name} returned non-JSON`);
        }
        if (!isObject(parsed)) {
          throw new ProviderResponseError(`${this._name} returned a non-object body`);
        }
        return parsed;
      } catch (error) {
        if (error instanceof ProviderError || error instanceof ProviderResponseError) throw error;
        last = `${this._name} request failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        if (attempt >= this._maxAttempts) throw new ProviderError(last);
        await delay(this._backoffSeconds * attempt);
      }
    }
    throw new ProviderError(`${this._name} failed after ${this._maxAttempts} attempt(s): ${last}`);
  }

  private retryDelay(response: DecisionHttpResponse, attempt: number): number {
    const raw = response.headers?.get('retry-after');
    if (raw !== undefined && raw !== null) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds)) return Math.max(0, seconds);
    }
    return this._backoffSeconds * attempt;
  }

  private parse(
    body: Record<string, unknown>,
    questions: Readonly<Record<string, DecisionQuestion>>,
  ): DecisionResponse {
    const model = body.model;
    const answers = body.answers;
    if (typeof model !== 'string' || !isObject(answers)) {
      throw new ProviderResponseError(`${this._name} response is missing 'model' or 'answers'`);
    }
    const parsed: Record<string, DecisionAnswer> = {};
    for (const [key, question] of Object.entries(questions)) {
      const raw = answers[key];
      if (!isObject(raw)) {
        throw new ProviderResponseError(
          `${this._name} response is missing an answer for question ${JSON.stringify(key)}`,
        );
      }
      parsed[key] = this.answer(question.type, raw);
    }
    const usage = isObject(body.usage) ? body.usage : undefined;
    return {
      model,
      answers: parsed,
      inputTokens: intOrUndefined(usage?.input_tokens),
      outputTokens: intOrUndefined(usage?.output_tokens),
      raw: body,
    };
  }

  /**
   * Map one answer, refusing a shape the question type cannot produce.
   *
   * The confidence rule is the important one: a `noul` answer has no
   * `confidence` field, so inventing one here would make a guardrail that
   * branches on confidence look satisfiable when it never is.
   */
  private answer(type: DecisionQuestionType, raw: Record<string, unknown>): DecisionAnswer {
    if (type === 'noul') {
      const noul = numberOrUndefined(raw.noul);
      if (noul === undefined) {
        throw new ProviderResponseError("a noul answer must carry 'noul'");
      }
      if (Object.hasOwn(raw, 'confidence')) {
        throw new ProviderResponseError("a noul answer must not carry 'confidence'");
      }
      return { type, noul, raw };
    }

    const confidence = numberOrUndefined(raw.confidence);
    if (confidence === undefined) {
      throw new ProviderResponseError(`a ${type} answer must carry 'confidence'`);
    }
    const probabilities = this.probabilities(raw.probabilities);
    if (type === 'choice') {
      const choice = raw.choice;
      if (typeof choice !== 'string') {
        throw new ProviderResponseError("a choice answer must carry 'choice'");
      }
      return { type, choice, confidence, probabilities, raw };
    }
    const score = numberOrUndefined(raw.score);
    if (score === undefined) {
      throw new ProviderResponseError("a score answer must carry 'score'");
    }
    const legend = typeof raw.legend === 'string' ? raw.legend : undefined;
    return { type, score, confidence, probabilities, legend, raw };
  }

  private probabilities(value: unknown): Readonly<Record<string, number>> | undefined {
    if (!isObject(value)) return undefined;
    const mapped: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'number' && Number.isFinite(entry)) mapped[key] = entry;
    }
    return mapped;
  }
}
