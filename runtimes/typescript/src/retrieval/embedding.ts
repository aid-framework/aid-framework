/**
 * Turning text into vectors.
 *
 * One fake plus one adapter per wire the pinned providers speak: an
 * OpenAI-compatible client, Gemini's `batchEmbedContents`, Bedrock's `InvokeModel`
 * and Vertex AI's `:predict`. They are separate adapters rather than base URLs
 * because the envelopes differ -- nested content parts, `embedding` versus
 * `predictions[].embeddings.values`, API key versus SigV4 versus bearer token. The
 * fake is not a testing afterthought -- it is the adapter the eval gate runs
 * against, because a gate that needed an API key could not run offline in CI. That
 * is the same reason the spec DSL already has `provider: fake` ("deterministic and
 * keyless, which is what lets the eval gate run offline").
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
import { stripTrailingSlashes } from '../internal/text.js';
import { BedrockProvider } from '../providers/bedrock.js';
import { DEFAULT_GEMINI_BASE_URL, GEMINI_API_KEY_ENV } from '../providers/gemini.js';
import { DEFAULT_BASE_URL, type FetchLike } from '../providers/http.js';
import { VertexProvider } from '../providers/vertex.js';
import { TokenUsage } from '../types.js';
import type { PinnedEmbedding } from './types.js';

/**
 * Statuses worth a second attempt: the request was well-formed and the server was
 * momentarily unwilling. Mirrors the chat provider's set so retry behaviour is one
 * rule in this runtime rather than one rule per adapter.
 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** `batchEmbedContents` takes at most this many inputs per call. */
const GEMINI_EMBEDDING_BATCH_LIMIT = 100;

/** `:predict` takes at most this many embedding instances per call. */
const VERTEX_EMBEDDING_BATCH_LIMIT = 250;

/** Models that accept `outputDimensionality`; the older ones reject the field. */
const GEMINI_DIMENSIONED_MODELS: ReadonlySet<string> = new Set(['gemini-embedding-001']);

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
    this._baseUrl = stripTrailingSlashes(baseUrl);
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
    return postJsonEmbeddings(`${this._baseUrl}${path}`, payload, this.headers(), {
      name: this._name,
      maxAttempts: this._maxAttempts,
      backoffSeconds: this._backoffSeconds,
      fetchImpl: this._fetch,
    });
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

/**
 * `batchEmbedContents` on the Gemini API.
 *
 * Not an OpenAI-compatible endpoint with a different base URL: the text is nested in
 * `content.parts[].text`, the response is `embeddings[].values` rather than
 * `data[].embedding`, and the key travels in `x-goog-api-key`. A batch over 100 inputs
 * is split and reassembled in order. The response carries no token counts, so usage is
 * the same offline estimate the fake adapter reports -- a budget signal, not a bill.
 */
export class GeminiEmbedder implements Embedder {
  private readonly _baseUrl: string;
  private readonly _apiKey: string | undefined;
  private readonly _name: string;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _extraHeaders: Readonly<Record<string, string>>;
  private readonly _fetch: FetchLike;
  private _closed = false;

  constructor(
    options: {
      readonly baseUrl?: string;
      readonly apiKey?: string;
      readonly name?: string;
      readonly maxAttempts?: number;
      readonly backoffSeconds?: number;
      readonly fetchImpl?: FetchLike;
      readonly extraHeaders?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const baseUrl = options.baseUrl ?? DEFAULT_GEMINI_BASE_URL;
    if (!/^https?:\/\/./i.test(baseUrl)) {
      throw new ConfigurationError(
        `base_url must be an absolute http(s) URL, got ${repr(baseUrl)}`,
      );
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (maxAttempts < 1) {
      throw new ConfigurationError('max_attempts must be at least 1');
    }
    this._baseUrl = stripTrailingSlashes(baseUrl);
    this._apiKey = options.apiKey;
    this._name = options.name ?? 'gemini-embedder';
    this._maxAttempts = maxAttempts;
    this._backoffSeconds = options.backoffSeconds ?? 0.5;
    this._extraHeaders = { ...(options.extraHeaders ?? {}) };
    this._fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  get name(): string {
    return this._name;
  }

  async embed(
    texts: readonly string[],
    init: { readonly model: PinnedEmbedding },
  ): Promise<EmbeddingBatch> {
    if (this._closed) throw new ProviderError(`${this._name} is closed`);
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += GEMINI_EMBEDDING_BATCH_LIMIT) {
      const batch = texts.slice(start, start + GEMINI_EMBEDDING_BATCH_LIMIT);
      const body = await this.post(batch, init.model);
      vectors.push(...this.parse(body, init.model, batch.length));
    }
    return new EmbeddingBatch({
      vectors,
      usage: new TokenUsage({
        inputTokens: texts.reduce((total, text) => total + estimateTokens(text), 0),
        outputTokens: 0,
      }),
    });
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  private headers(): Record<string, string> {
    const apiKey = this._apiKey ?? process.env[GEMINI_API_KEY_ENV];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ProviderError(
        `${this._name} has no API key: set embedding provider 'apiKeyEnv' or ${GEMINI_API_KEY_ENV}`,
      );
    }
    return { 'x-goog-api-key': apiKey, 'content-type': 'application/json', ...this._extraHeaders };
  }

  private async post(
    texts: readonly string[],
    model: PinnedEmbedding,
  ): Promise<Record<string, unknown>> {
    const requests = texts.map((text) => ({
      model: `models/${model.modelId}`,
      content: { parts: [{ text }] },
      ...(GEMINI_DIMENSIONED_MODELS.has(model.modelId)
        ? { outputDimensionality: model.dimensions }
        : {}),
    }));
    const url = `${this._baseUrl}/v1beta/models/${model.modelId}:batchEmbedContents`;
    return postJsonEmbeddings(url, { requests }, this.headers(), {
      name: this._name,
      maxAttempts: this._maxAttempts,
      backoffSeconds: this._backoffSeconds,
      fetchImpl: this._fetch,
    });
  }

  private parse(
    body: Record<string, unknown>,
    model: PinnedEmbedding,
    expected: number,
  ): number[][] {
    const entries = body.embeddings;
    if (!Array.isArray(entries) || entries.length !== expected) {
      const found = Array.isArray(entries) ? entries.length : 0;
      throw new ProviderResponseError(
        `${this._name} returned ${found} embeddings for ${expected} input(s)`,
      );
    }
    const vectors: number[][] = [];
    for (const entry of entries as unknown[]) {
      const values =
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
          ? (entry as Record<string, unknown>).values
          : undefined;
      if (!Array.isArray(values)) {
        throw new ProviderResponseError(`${this._name} returned a non-list embedding`);
      }
      const vector: number[] = [];
      for (const value of values) {
        const numeric = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numeric)) {
          throw new ProviderResponseError(`${this._name} returned a non-numeric embedding`);
        }
        vector.push(numeric);
      }
      if (vector.length !== model.dimensions) {
        throw new ProviderResponseError(
          `${this._name} returned ${vector.length} dimensions for ${repr(model.modelId)} but ` +
            `${model.dimensions} are pinned; the pin and the response must agree`,
        );
      }
      vectors.push(vector);
    }
    return vectors;
  }
}

/**
 * `InvokeModel` on Bedrock, one input per signed request.
 *
 * Titan's embeddings endpoint takes a single `inputText`; InvokeModel has no batch
 * variant, so a batch is one request per text and input order is preserved by
 * construction. Region, the credential chain, SigV4 and retry stay in
 * {@link BedrockProvider} rather than being re-derived here: the same identity
 * invokes a chat model and an embedding model.
 */
export class BedrockEmbedder implements Embedder {
  private readonly _provider: BedrockProvider;
  private readonly _ownsProvider: boolean;
  private readonly _name: string;
  private _closed = false;

  constructor(
    options: {
      readonly provider?: BedrockProvider;
      readonly baseUrl?: string;
      readonly name?: string;
      readonly fetchImpl?: FetchLike;
    } = {},
  ) {
    this._provider =
      options.provider ??
      new BedrockProvider({
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
    this._ownsProvider = options.provider === undefined;
    this._name = options.name ?? 'bedrock-embedder';
  }

  get name(): string {
    return this._name;
  }

  async embed(
    texts: readonly string[],
    init: { readonly model: PinnedEmbedding },
  ): Promise<EmbeddingBatch> {
    if (this._closed) throw new ProviderError(`${this._name} is closed`);
    const vectors: number[][] = [];
    let inputTokens = 0;
    for (const text of texts) {
      const answer = await this._provider.invokeModel(init.model.modelId, { inputText: text });
      vectors.push(embeddingVector(answer.embedding, this._name, init.model));
      const counted = answer.inputTextTokenCount;
      inputTokens += typeof counted === 'number' ? counted : estimateTokens(text);
    }
    return new EmbeddingBatch({
      vectors,
      usage: new TokenUsage({ inputTokens, outputTokens: 0 }),
    });
  }

  async close(): Promise<void> {
    this._closed = true;
    if (this._ownsProvider) await this._provider.close();
  }
}

/**
 * `:predict` on Vertex AI, in batches of up to 250 instances.
 *
 * Vertex is not the Gemini API: the host is regional, the path carries the project
 * and location, auth is the adapter's bearer token, and the envelopes are
 * `instances`/`predictions[].embeddings.values`. Project, location and token are
 * delegated to {@link VertexProvider} so the embedder cannot address a different
 * deployment than the chat model in the same app.
 */
export class VertexEmbedder implements Embedder {
  private readonly _provider: VertexProvider;
  private readonly _ownsProvider: boolean;
  private readonly _name: string;
  private _closed = false;

  constructor(
    options: {
      readonly provider?: VertexProvider;
      readonly baseUrl?: string;
      readonly name?: string;
      readonly fetchImpl?: FetchLike;
    } = {},
  ) {
    this._provider =
      options.provider ??
      new VertexProvider({
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
    this._ownsProvider = options.provider === undefined;
    this._name = options.name ?? 'vertex-embedder';
  }

  get name(): string {
    return this._name;
  }

  async embed(
    texts: readonly string[],
    init: { readonly model: PinnedEmbedding },
  ): Promise<EmbeddingBatch> {
    if (this._closed) throw new ProviderError(`${this._name} is closed`);
    const vectors: number[][] = [];
    let inputTokens = 0;
    for (let start = 0; start < texts.length; start += VERTEX_EMBEDDING_BATCH_LIMIT) {
      const batch = texts.slice(start, start + VERTEX_EMBEDDING_BATCH_LIMIT);
      const answer = await this._provider.predict(init.model.modelId, {
        instances: batch.map((text) => ({ content: text })),
        parameters: { outputDimensionality: init.model.dimensions },
      });
      const predictions = answer.predictions;
      if (!Array.isArray(predictions) || predictions.length !== batch.length) {
        throw new ProviderResponseError(
          `${this._name} returned ${Array.isArray(predictions) ? predictions.length : 0} ` +
            `embeddings for ${batch.length} input(s)`,
        );
      }
      const tokens: number[] = [];
      for (const prediction of predictions as unknown[]) {
        const embeddings =
          typeof prediction === 'object' && prediction !== null && !Array.isArray(prediction)
            ? (prediction as Record<string, unknown>).embeddings
            : undefined;
        const values =
          typeof embeddings === 'object' && embeddings !== null && !Array.isArray(embeddings)
            ? (embeddings as Record<string, unknown>).values
            : undefined;
        vectors.push(embeddingVector(values, this._name, init.model));
        const statistics =
          typeof embeddings === 'object' && embeddings !== null && !Array.isArray(embeddings)
            ? (embeddings as Record<string, unknown>).statistics
            : undefined;
        const counted =
          typeof statistics === 'object' && statistics !== null && !Array.isArray(statistics)
            ? (statistics as Record<string, unknown>).token_count
            : undefined;
        if (typeof counted === 'number') tokens.push(counted);
      }
      // A single prediction without a count makes the batch total unknown; falling
      // back to the estimate keeps the sum from silently under-reporting.
      inputTokens +=
        tokens.length === batch.length
          ? tokens.reduce((total, count) => total + count, 0)
          : batch.reduce((total, text) => total + estimateTokens(text), 0);
    }
    return new EmbeddingBatch({
      vectors,
      usage: new TokenUsage({ inputTokens, outputTokens: 0 }),
    });
  }

  async close(): Promise<void> {
    this._closed = true;
    if (this._ownsProvider) await this._provider.close();
  }
}

/** Validate one wire vector against the pin, so a misconfigured model fails loudly. */
function embeddingVector(values: unknown, name: string, model: PinnedEmbedding): number[] {
  if (!Array.isArray(values)) {
    throw new ProviderResponseError(`${name} returned a non-list embedding`);
  }
  const vector: number[] = [];
  for (const value of values) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new ProviderResponseError(`${name} returned a non-numeric embedding`);
    }
    vector.push(numeric);
  }
  if (vector.length !== model.dimensions) {
    throw new ProviderResponseError(
      `${name} returned ${vector.length} dimensions for ${repr(model.modelId)} but ` +
        `${model.dimensions} are pinned; the pin and the response must agree`,
    );
  }
  return vector;
}

interface EmbeddingPostOptions {
  readonly name: string;
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
  readonly fetchImpl: FetchLike;
}

/** One POST with the retry rule the keyed HTTP embedding adapters share. */
async function postJsonEmbeddings(
  url: string,
  payload: unknown,
  headers: Readonly<Record<string, string>>,
  options: EmbeddingPostOptions,
): Promise<Record<string, unknown>> {
  const { name, maxAttempts, backoffSeconds, fetchImpl } = options;
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response:
      | { readonly ok: boolean; readonly status: number; text(): Promise<string> }
      | undefined;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (response !== undefined) {
      const text = await response.text();
      if (response.status < 400) {
        return asObject(text, name);
      }
      const failure = `${name} returned HTTP ${response.status}: ${text.slice(0, 200)}`;
      // A status outside the retryable set is a decision, not a hiccup: retrying a
      // 400 only wastes the caller's time.
      if (!RETRYABLE_STATUS.has(response.status)) {
        throw new ProviderError(failure);
      }
      lastError = failure;
    }
    if (attempt < maxAttempts) {
      await delay(backoffSeconds * 2 ** (attempt - 1));
    }
  }
  throw new ProviderError(`${name} failed after ${maxAttempts} attempt(s): ${lastError}`);
}

function asObject(text: string, name: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderResponseError(`${name} returned a body that is not JSON`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProviderResponseError(`${name} returned a JSON body that is not an object`);
  }
  return body as Record<string, unknown>;
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
  if (model.provider === 'bedrock') {
    return new BedrockEmbedder({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
  if (model.provider === 'google') {
    // `google`, not `gemini`: `gemini` is the AI Studio API key, `google` is Vertex
    // AI, which authenticates with a bearer token instead.
    return new VertexEmbedder({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
  if (model.provider === 'gemini') {
    return new GeminiEmbedder({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
  return new OpenAICompatibleEmbedder({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
  });
}
