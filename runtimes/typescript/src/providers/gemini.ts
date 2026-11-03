/**
 * The public Gemini API -- not Vertex AI.
 *
 * The wire is Vertex's (see `gemini-wire.ts`); what differs is everything around it: one
 * API key in `x-goog-api-key` instead of an OAuth2 bearer token, a fixed host with no
 * project or location, and the `v1beta` endpoint. The key goes in a header rather than
 * the `?key=` query string Google also accepts, because query strings leak into access
 * logs, proxy history and error reports far more readily.
 *
 * No `stream`: the TypeScript seam is request/response only, so this adapter does not
 * advertise `streaming` -- matching `VertexProvider` rather than the Python runtime.
 */

import { ProviderError } from '../errors.js';
import { stripTrailingSlashes } from '../internal/text.js';
import type { Capability, CompletionRequest, CompletionResponse, ModelSpec } from '../types.js';
import type { Provider } from './base.js';
import {
  buildPayload,
  DEFAULT_RETRYABLE_STATUSES,
  parseCompletion,
  postJson,
} from './gemini-wire.js';
import type { FetchLike } from './http.js';

/** The default endpoint host, used when no base URL is configured. */
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

/** The environment variable the generator writes into the deployment. */
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

/** Read a non-empty value from the environment. */
function env(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value.length === 0 ? undefined : value;
}

export interface GeminiOptions {
  /** An API key. When absent, `GEMINI_API_KEY` supplies one. */
  readonly apiKey?: string;
  /** Overrides the endpoint host; tests point this at a stub. */
  readonly baseUrl?: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  /** Supplied by tests, or to share a connection pool. */
  readonly fetchImpl?: FetchLike;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export class GeminiProvider implements Provider {
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _name: string;
  private readonly _timeoutSeconds: number;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _fetch: FetchLike;
  private readonly _extraHeaders: Readonly<Record<string, string>>;
  private _closed = false;

  constructor(options: GeminiOptions = {}) {
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl;
    this._name = options.name ?? 'gemini';
    this._timeoutSeconds = options.timeoutSeconds ?? 60;
    this._maxAttempts = options.maxAttempts ?? 3;
    this._backoffSeconds = options.backoffSeconds ?? 0.5;
    this._fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this._extraHeaders = options.extraHeaders ?? {};
  }

  get name(): string {
    return this._name;
  }

  get capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(['tool-calling', 'structured-output']);
  }

  async complete(request: CompletionRequest, model: ModelSpec): Promise<CompletionResponse> {
    if (this._closed) throw new ProviderError(`${this._name} is closed`);
    const body = JSON.stringify(buildPayload(request, model));
    const text = await postJson(
      this.endpoint(model),
      body,
      {
        'x-goog-api-key': this.key(),
        'content-type': 'application/json',
        ...this._extraHeaders,
      },
      {
        name: this._name,
        timeoutSeconds: this._timeoutSeconds,
        maxAttempts: this._maxAttempts,
        backoffSeconds: this._backoffSeconds,
        fetchImpl: this._fetch,
      },
      DEFAULT_RETRYABLE_STATUSES,
    );
    return parseCompletion(text, model, this._name);
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  private endpoint(model: ModelSpec): string {
    const base = stripTrailingSlashes(this._baseUrl ?? DEFAULT_GEMINI_BASE_URL);
    return `${base}/v1beta/models/${model.name}:generateContent`;
  }

  private key(): string {
    const key = this._apiKey ?? env(GEMINI_API_KEY_ENV);
    if (key === undefined) {
      throw new ProviderError(
        `${this._name} has no API key: set provider 'apiKeyEnv' or ${GEMINI_API_KEY_ENV}`,
      );
    }
    return key;
  }
}
