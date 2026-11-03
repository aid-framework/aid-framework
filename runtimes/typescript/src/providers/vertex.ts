/**
 * A provider for Gemini on Vertex AI.
 *
 * Vertex does not accept an API key: it authenticates with an OAuth2 bearer
 * token. The token is resolved once per call from an explicit value, the
 * environment, or the GCE metadata server that Cloud Run and Cloud Functions
 * provide, so `api_key_env` is absent from the spec and an empty one is valid.
 *
 * The wire translation -- `contents` of `parts`, the `systemInstruction` join, the
 * `functionResponse` turns and the response read -- is shared with the Gemini API
 * adapter in `gemini-wire.ts`. This file owns only what is Vertex-specific: the
 * endpoint, the project and location, and the OAuth2 bearer token.
 *
 * No `stream`: the TypeScript seam is request/response only, matching every
 * other TS provider, so this adapter does not advertise `streaming`.
 */

import { ProviderError, ProviderResponseError } from '../errors.js';
import { stripTrailingSlashes } from '../internal/text.js';
import type { Capability, CompletionRequest, CompletionResponse, ModelSpec } from '../types.js';
import type { Provider } from './base.js';
import {
  buildPayload,
  DEFAULT_RETRYABLE_STATUSES,
  isObject,
  parseCompletion,
  postJson,
} from './gemini-wire.js';
import type { FetchLike } from './http.js';

/** The default location when none is configured. */
export const DEFAULT_VERTEX_LOCATION = 'us-central1';

/** Where the metadata server mints a token for the default service account. */
export const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** The environment variable a developer sets off GCP (`gcloud auth print-access-token`). */
export const VERTEX_TOKEN_ENV = 'GOOGLE_ACCESS_TOKEN';

/** The default endpoint host, used when no base URL is configured. */
export function defaultVertexBaseUrl(location: string): string {
  return `https://${location}-aiplatform.googleapis.com`;
}

/** Refresh a metadata token this long before it expires. */
const TOKEN_REFRESH_MS = 60 * 1000;

export interface VertexOptions {
  /** The GCP project. Defaults to `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`. */
  readonly project?: string;
  /** The location. Defaults to `GOOGLE_CLOUD_REGION`, then `us-central1`. */
  readonly location?: string;
  /** A bearer token. When absent, the environment or the metadata server supplies one. */
  readonly accessToken?: string;
  /** Overrides the endpoint host; tests point this at a stub. */
  readonly baseUrl?: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  /** Supplied by tests, or to share a connection pool. */
  readonly fetchImpl?: FetchLike;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Supplied by tests so token caching is reproducible. */
  readonly now?: () => number;
  /** Supplied by tests, or to plug in a different credential source. */
  readonly tokenProvider?: () => Promise<string>;
}

interface CachedToken {
  readonly token: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

function env(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value.length === 0 ? undefined : value;
}

export class VertexProvider implements Provider {
  private readonly _project: string | undefined;
  private readonly _location: string | undefined;
  private readonly _accessToken: string | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _name: string;
  private readonly _timeoutSeconds: number;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _fetch: FetchLike;
  private readonly _extraHeaders: Readonly<Record<string, string>>;
  private readonly _now: () => number;
  private readonly _tokenProvider: (() => Promise<string>) | undefined;
  private _cachedToken: CachedToken | undefined;
  private _closed = false;

  constructor(options: VertexOptions = {}) {
    this._project = options.project;
    this._location = options.location;
    this._accessToken = options.accessToken;
    this._baseUrl = options.baseUrl;
    this._name = options.name ?? 'google';
    this._timeoutSeconds = options.timeoutSeconds ?? 60;
    this._maxAttempts = options.maxAttempts ?? 3;
    this._backoffSeconds = options.backoffSeconds ?? 0.5;
    this._fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this._extraHeaders = options.extraHeaders ?? {};
    this._now = options.now ?? (() => Date.now());
    this._tokenProvider = options.tokenProvider;
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
    const text = await this.post(this.endpoint(model), body);
    return parseCompletion(text, model, this._name);
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  private project(): string {
    const project = this._project ?? env('GOOGLE_CLOUD_PROJECT') ?? env('GCLOUD_PROJECT');
    if (project === undefined) {
      throw new ProviderError(
        `${this._name} needs a project: set provider 'project' or GOOGLE_CLOUD_PROJECT`,
      );
    }
    return project;
  }

  private location(): string {
    return (
      this._location ??
      env('GOOGLE_CLOUD_REGION') ??
      env('VERTEX_LOCATION') ??
      DEFAULT_VERTEX_LOCATION
    );
  }

  private endpoint(model: ModelSpec): string {
    const location = this.location();
    const base = stripTrailingSlashes(this._baseUrl ?? defaultVertexBaseUrl(location));
    return `${base}/v1/projects/${this.project()}/locations/${location}/publishers/google/models/${model.name}:generateContent`;
  }

  private async token(): Promise<string> {
    if (this._accessToken !== undefined) return this._accessToken;
    const fromEnv = env(VERTEX_TOKEN_ENV) ?? env('VERTEX_ACCESS_TOKEN');
    if (fromEnv !== undefined) return fromEnv;
    const cached = this._cachedToken;
    if (cached !== undefined && cached.expiresAt - this._now() > TOKEN_REFRESH_MS) {
      return cached.token;
    }
    const minted = await this.mintToken();
    this._cachedToken = minted;
    return minted.token;
  }

  private async mintToken(): Promise<CachedToken> {
    if (this._tokenProvider !== undefined) {
      return { token: await this._tokenProvider(), expiresAt: this._now() + 5 * 60 * 1000 };
    }
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this._fetch(METADATA_TOKEN_URL, {
        method: 'GET',
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(this._timeoutSeconds * 1000),
      });
    } catch (error) {
      throw new ProviderError(
        `${this._name} has no credentials: set ${VERTEX_TOKEN_ENV} or run on GCP where the ` +
          `metadata server mints a token (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(
        `${this._name} metadata token request returned ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderResponseError(`${this._name} metadata token is not JSON`);
    }
    const token = isObject(body) ? body.access_token : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      throw new ProviderResponseError(`${this._name} metadata response had no access_token`);
    }
    const rawExpiry = isObject(body) ? body.expires_in : undefined;
    const seconds = typeof rawExpiry === 'number' ? rawExpiry : 300;
    return { token, expiresAt: this._now() + seconds * 1000 };
  }

  private async post(url: string, body: string): Promise<string> {
    return postJson(
      url,
      body,
      {
        authorization: `Bearer ${await this.token()}`,
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
  }
}
