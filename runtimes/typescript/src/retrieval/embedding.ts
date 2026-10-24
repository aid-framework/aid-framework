/**
 * Turning text into vectors.
 *
 * Two adapters, and that is the whole Phase 1 surface: one deterministic fake and
 * one OpenAI-compatible HTTP client. The fake is not a testing afterthought -- it is
 * the adapter the eval gate runs against, because a gate that needed an API key
 * could not run offline in CI. That is the same reason the spec DSL already has
 * `provider: fake` ("deterministic and keyless, which is what lets the eval gate run
 * offline").
 *
 * The pinning rule lives in the seam, not in the adapters: `embed` takes a
 * {@link PinnedEmbedding} and uses its `modelId` and `dimensions`. Nothing here
 * resolves an alias, and the fake hashes the *pinned* model id into its vector, so a
 * silently changed pin produces different vectors rather than a store full of
 * incomparable ones.
 */

import { createHash } from 'node:crypto';

import { ConfigurationError, ProviderError, ProviderResponseError } from '../errors.js';
import { repr } from '../internal/json.js';
import { DEFAULT_BASE_URL, type FetchLike } from '../providers/http.js';
import { TokenUsage } from '../types.js';
import type { PinnedEmbedding } from './types.js';

/**
 * Statuses worth a second attempt: the request was well-formed and the server was
 * momentarily unwilling. Mirrors the chat provider's set so retry behaviour is one
 * rule in this runtime rather than one rule per adapter.
 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Rough tokeniser. Deliberately the same arithmetic as `estimatePromptCostUsd`
 * (4 characters per token, rounded up), so an offline estimate and an offline charge
 * cannot disagree about what a text costs.
 */
const CHARS_PER_TOKEN = 4;

/** Vectors plus the usage that prices them. */
export class EmbeddingBatch {
  readonly vectors: readonly (readonly number[])[];
  readonly usage: TokenUsage;

  constructor(init: {
    readonly vectors: readonly (readonly number[])[];
    readonly usage: TokenUsage;
  }) {
    this.vectors = init.vectors.map((vector) => [...vector]);
    this.usage = init.usage;
  }
}

/**
 * Text to vectors, with the model pinned by the caller.
 *
 * `close` must be idempotent, matching `Provider`: a client's lifetime is owned by
 * the caller, so closing twice is a caller's mistake that must stay harmless.
 */
export interface Embedder {
  readonly name: string;
  embed(
    texts: readonly string[],
    init: { readonly model: PinnedEmbedding },
  ): Promise<EmbeddingBatch>;
  close(): Promise<void>;
}

/** The offline token estimate used for the fake's usage and for budgets. */
export function estimateTokens(text: string): number {
  return (text.length + CHARS_PER_TOKEN - 1) >> 2;
}

/**
 * Keyless, offline, and byte-identical across runs and platforms.
 *
 * Vectors come from SHAKE-128, a hash-based extensible output function, rather than
 * from a seeded PRNG. The reason is the same property the rest of this runtime
 * depends on: re-ingesting a corpus has to reproduce the vectors exactly, and
 * re-embedding a *query* has to reproduce what ingest stored. A PRNG seeded per call
 * would be stable too, but a hash makes "same text, same vector" true by
 * construction rather than by discipline, and it cannot drift if a vector is later
 * requested one element at a time.
 *
 * Similarity is meaningless here, and that is the deliberate limitation rather than
 * a bug. Lexical retrieval still works over these vectors because the store keeps
 * the text and hybrid search reads it; what the fake proves is the *pipeline*, and
 * what it deliberately does not prove is embedding quality.
 */
export class FakeDeterministicEmbedder implements Embedder {
  private readonly _name: string;

  constructor(init: { readonly name?: string } = {}) {
    this._name = init.name ?? 'fake-embedder';
  }

  get name(): string {
    return this._name;
  }

  async embed(
    texts: readonly string[],
    init: { readonly model: PinnedEmbedding },
  ): Promise<EmbeddingBatch> {
    return new EmbeddingBatch({
      vectors: texts.map((text) => this.vector(text, init.model)),
      usage: new TokenUsage({
        inputTokens: texts.reduce((total, text) => total + estimateTokens(text), 0),
        outputTokens: 0,
      }),
    });
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  private vector(text: string, model: PinnedEmbedding): readonly number[] {
    // The pinned model id is part of the input so the same text under a different
    // pin embeds differently: a changed pin must invalidate stored vectors rather
    // than silently mix two vector spaces in one table.
    const seed = `${model.modelId}:${model.dimensions}\u0000${text}`;
    const raw = createHash('shake128', { outputLength: model.dimensions * 2 })
      .update(seed, 'utf8')
      .digest();
    const values: number[] = [];
    for (let index = 0; index < model.dimensions; index += 1) {
      values.push(raw.readUInt16BE(index * 2) / 32767.5 - 1.0);
    }
    const norm = Math.sqrt(values.reduce((total, value) => total + value * value, 0)) || 1.0;
    return values.map((value) => value / norm);
  }
}

/** One POST to `/embeddings` on any OpenAI-compatible endpoint. */
export class OpenAICompatibleEmbedder implements Embedder {
  private readonly _baseUrl: string;
  private readonly _apiKey: string | undefined;
  private readonly _name: string;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _extraHeaders: Readonly<Record<string, string>>;
  private readonly _fetch: FetchLike;
  private readonly _ownsClient: boolean;
  private _closed = false;

  constructor(
    options: {
      readonly baseUrl?: string;
      readonly apiKey?: string;
      readonly name?: string;
      readonly timeoutSeconds?: number;
      readonly maxAttempts?: number;
      readonly backoffSeconds?: number;
      readonly fetchImpl?: FetchLike;
      readonly extraHeaders?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    if (!/^https?:\/\/./i.test(baseUrl)) {
      throw new ConfigurationError(
        `base_url must be an absolute http(s) URL, got ${repr(baseUrl)}`,
      );
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (maxAttempts < 1) {
      throw new ConfigurationError('max_attempts must be at least 1');
    }
    this._baseUrl = baseUrl.replace(/\/+$/, '');
    this._apiKey = options.apiKey;
    this._name = options.name ?? 'openai-compatible-embedder';
    this._maxAttempts = maxAttempts;
    this._backoffSeconds = options.backoffSeconds ?? 0.5;
    this._extraHeaders = { ...(options.extraHeaders ?? {}) };
    // Eager, like the chat provider: the caller may inject a transport (a test's
    // stub, or a shared pool). Whoever constructed it closes it, so ownership is
    // tracked rather than assumed.
    this._ownsClient = options.fetchImpl === undefined;
    this._fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  get name(): string {
    return this._name;
  }

  async embed(
    texts: readonly string[],
    init: { readonly model: PinnedEmbedding },
  ): Promise<EmbeddingBatch> {
    const body = await this.post('/embeddings', { model: init.model.modelId, input: [...texts] });
    return this.parse(body, init.model);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    // An injected transport belongs to its injector; there is nothing owned to close.
    if (!this._ownsClient) return;
    return Promise.resolve();
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this._extraHeaders,
    };
    if (this._apiKey !== undefined && this._apiKey.length > 0) {
      // A real bearer token, not the chat provider's redacted placeholder: a request
      // that claims to be authenticated and is not fails with a 401 that reads like a
      // credentials problem at the far end.
      headers.authorization = `Bearer ${this._apiKey}`;
    }
    return headers;
  }

  private async post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const url = `${this._baseUrl}${path}`;
    let lastError: string = 'unknown error';
    for (let attempt = 1; attempt <= this._maxAttempts; attempt += 1) {
      let response:
        | { readonly ok: boolean; readonly status: number; text(): Promise<string> }
        | undefined;
      try {
        response = await this._fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (response !== undefined) {
        const text = await response.text();
        if (response.status < 400) {
          return this.asObject(text);
        }
        const failure = `${this._name} returned HTTP ${response.status}: ${text.slice(0, 200)}`;
        // A status outside the retryable set is a decision, not a hiccup: retrying a
        // 400 only wastes the caller's time.
        if (!RETRYABLE_STATUS.has(response.status)) {
          throw new ProviderError(failure);
        }
        lastError = failure;
      }
      if (attempt < this._maxAttempts) {
        await delay(this._backoffSeconds * 2 ** (attempt - 1));
      }
    }
    throw new ProviderError(
      `${this._name} failed after ${this._maxAttempts} attempt(s): ${lastError}`,
    );
  }

  private asObject(text: string): Record<string, unknown> {
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderResponseError(`${this._name} returned a body that is not JSON`);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ProviderResponseError(`${this._name} returned a JSON body that is not an object`);
    }
    return body as Record<string, unknown>;
  }

  private parse(body: Record<string, unknown>, model: PinnedEmbedding): EmbeddingBatch {
    const entries = body.data;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ProviderResponseError(`${this._name} returned no embeddings`);
    }
    const list = entries as unknown[];

    const ordered: { readonly index: number; readonly vector: unknown }[] = [];
    for (const [position, entry] of list.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new ProviderResponseError(`${this._name} returned a non-object embedding entry`);
      }
      const record = entry as Record<string, unknown>;
      const index = record.index ?? position;
      if (!Number.isInteger(index)) {
        throw new ProviderResponseError(`${this._name} returned a non-integer embedding index`);
      }
      ordered.push({ index: index as number, vector: record.embedding });
    }
    ordered.sort((left, right) => left.index - right.index);

    const vectors: number[][] = [];
    for (const entry of ordered) {
      if (!Array.isArray(entry.vector)) {
        throw new ProviderResponseError(`${this._name} returned a non-list embedding`);
      }
      const values: number[] = [];
      for (const value of entry.vector) {
        const numeric = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numeric)) {
          throw new ProviderResponseError(`${this._name} returned a non-numeric embedding`);
        }
        values.push(numeric);
      }
      if (values.length !== model.dimensions) {
        throw new ProviderResponseError(
          `${this._name} returned ${values.length} dimensions for ${repr(model.modelId)} but ` +
            `${model.dimensions} are pinned; the pin and the response must agree`,
        );
      }
      vectors.push(values);
    }

    const usage = body.usage;
    const found =
      typeof usage === 'object' && usage !== null
        ? (usage as Record<string, unknown>).prompt_tokens
        : undefined;
    const promptTokens = typeof found === 'number' && Number.isInteger(found) ? found : 0;
    return new EmbeddingBatch({
      vectors,
      usage: new TokenUsage({ inputTokens: promptTokens, outputTokens: 0 }),
    });
  }
}

function delay(seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

/**
 * Pick the adapter for a pinned embedding model.
 *
 * This selects a *provider*, never a model: the model id and its width arrive
 * already pinned, and are passed straight through to whichever adapter is chosen.
 * `fake` is chosen for the same reason the spec can declare it -- so a gate runs
 * keyless and offline.
 */
export function embedderFor(
  model: PinnedEmbedding,
  options: {
    readonly apiKey?: string;
    readonly baseUrl?: string;
    readonly fetchImpl?: FetchLike;
  } = {},
): Embedder {
  if (model.provider === 'fake') {
    return new FakeDeterministicEmbedder();
  }
  return new OpenAICompatibleEmbedder({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
  });
}
