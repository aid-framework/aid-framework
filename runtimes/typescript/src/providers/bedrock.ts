/**
 * A provider for Amazon Bedrock's Converse API.
 *
 * Bedrock is not an endpoint that accepts an API key, so it cannot be an
 * OpenAI-compatible base URL. Every request is SigV4-signed with credentials the
 * environment supplies, which also means an empty secret is a *valid*
 * configuration: on ECS the task role hands the container temporary credentials
 * through the container credentials endpoint, and no `api_key_env` exists.
 *
 * Converse is the portable surface: one request shape covers every model Bedrock
 * serves, so this adapter knows nothing about Anthropic, Llama or Titan wire
 * dialects. Three translations are structural rather than cosmetic:
 *
 * 1. Converse has no system role; the prompt is a top-level `system` array.
 * 2. `inferenceConfig.maxTokens` is required.
 * 3. Tool results are `toolResult` blocks in a `user` turn, and adjacent results
 *    are merged into one turn so the conversation keeps alternating roles.
 *
 * No `stream`: `/converse-stream` frames events in AWS's binary event-stream
 * format rather than SSE, and {@link FetchLike} cannot read an incremental body.
 * The adapter therefore does not advertise `streaming`, and the capability gate
 * refuses a spec that asks for it instead of failing mid-run.
 */

import { createHash, createHmac } from 'node:crypto';

import { ProviderError, ProviderResponseError } from '../errors.js';
import { stripTrailingSlashes } from '../internal/text.js';
import {
  type Capability,
  type CompletionRequest,
  CompletionResponse,
  type FinishReason,
  type Message,
  type ModelSpec,
  TokenUsage,
  ToolCall,
} from '../types.js';
import type { Provider } from './base.js';
import type { FetchLike } from './http.js';

/** The SigV4 service name for model invocation. */
export const BEDROCK_SERVICE = 'bedrock';

/** The default endpoint host, used when no base URL is configured. */
export function defaultBedrockBaseUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * Statuses worth retrying: the request was well-formed and may succeed unchanged.
 *
 * 424 is Bedrock's "dependency failed"; it is not a standard client error, so
 * omitting it would make a transient model-side failure permanent.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 424, 425, 429, 500, 502, 503, 504,
]);

/** The wire names `stopReason` can take, mapped to the runtime's vocabulary. */
const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool-calls',
  guardrail_intervened: 'content-filter',
  content_filtered: 'content-filter',
};

/** Refresh container credentials this long before they expire. */
const CREDENTIAL_REFRESH_MS = 5 * 60 * 1000;

export interface BedrockOptions {
  /** Region the model is invoked in. Defaults to `AWS_REGION`, then `AWS_DEFAULT_REGION`. */
  readonly region?: string;
  /** Static credentials. When absent, the environment supplies them. */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly sessionToken?: string;
  /** Overrides the endpoint host; tests point this at a stub. */
  readonly baseUrl?: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  /** Supplied by tests, or to share a connection pool. */
  readonly fetchImpl?: FetchLike;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Supplied by tests so signatures are reproducible. */
  readonly now?: () => Date;
}

interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Epoch milliseconds. Absent for credentials that do not expire. */
  readonly expiresAt?: number;
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

/**
 * Percent-encode one path segment the way SigV4 defines it.
 *
 * `encodeURIComponent` leaves `!*'()` alone, and AWS does not: a signature over a
 * path the server decodes differently fails with `SignatureDoesNotMatch`.
 */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** `20261102T051711Z`, the format SigV4 signs. */
function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** One entry in the wire `messages` array. */
interface WireMessage {
  role: 'user' | 'assistant';
  content: Record<string, unknown>[];
}

/** Talks to Bedrock's `/model/{id}/converse` endpoint. */
export class BedrockProvider implements Provider {
  private readonly _region: string | undefined;
  private readonly _static: Credentials | undefined;
  private readonly _baseUrl: string | undefined;
  private readonly _name: string;
  private readonly _timeoutSeconds: number;
  private readonly _maxAttempts: number;
  private readonly _backoffSeconds: number;
  private readonly _fetch: FetchLike;
  private readonly _extraHeaders: Readonly<Record<string, string>>;
  private readonly _now: () => Date;
  private _cached: Credentials | undefined;
  private _closed = false;

  constructor(options: BedrockOptions = {}) {
    const maxAttempts = options.maxAttempts ?? 3;
    if (maxAttempts < 1) throw new RangeError('max_attempts must be at least 1');
    this._region = options.region;
    this._static =
      options.accessKeyId !== undefined && options.secretAccessKey !== undefined
        ? {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
          }
        : undefined;
    this._baseUrl =
      options.baseUrl === undefined ? undefined : stripTrailingSlashes(options.baseUrl);
    this._name = options.name ?? 'bedrock';
    this._timeoutSeconds = options.timeoutSeconds ?? 60;
    this._maxAttempts = maxAttempts;
    this._backoffSeconds = options.backoffSeconds ?? 0.5;
    this._fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this._extraHeaders = options.extraHeaders ?? {};
    this._now = options.now ?? (() => new Date());
  }

  get name(): string {
    return this._name;
  }

  get capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(['tool-calling', 'structured-output']);
  }

  async complete(request: CompletionRequest, model: ModelSpec): Promise<CompletionResponse> {
    if (this._closed) throw new ProviderError(`${this._name} is closed`);
    const body = JSON.stringify(this.payload(request, model));
    const region = this.region();
    const credentials = await this.credentials();
    const url = this.endpoint(model, region);
    const headers = this.headers(url, body, region, credentials, this._now());
    const text = await this.post(url, headers, body);
    return this.parse(text, model);
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  private region(): string {
    const region = this._region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (region === undefined || region.length === 0) {
      throw new ProviderError(
        `${this._name} needs a region: pass region, or set AWS_REGION (Bedrock model ids are regional)`,
      );
    }
    return region;
  }

  private endpoint(model: ModelSpec, region: string): string {
    const base = this._baseUrl ?? defaultBedrockBaseUrl(region);
    return `${base}/model/${rfc3986(model.name)}/converse`;
  }

  /**
   * Static credentials, else the environment, else the container credentials
   * endpoint. Resolution is lazy so importing a generated app cannot fail when a
   * role supplies credentials only once the process is running.
   */
  private async credentials(): Promise<Credentials> {
    if (this._static !== undefined) return this._static;
    if (this._cached !== undefined) {
      const expiresAt = this._cached.expiresAt;
      if (expiresAt === undefined || expiresAt > Date.now() + CREDENTIAL_REFRESH_MS) {
        return this._cached;
      }
    }
    const env = process.env;
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    if (accessKeyId !== undefined && accessKeyId.length > 0 && secretAccessKey !== undefined) {
      return {
        accessKeyId,
        secretAccessKey,
        ...(env.AWS_SESSION_TOKEN === undefined ? {} : { sessionToken: env.AWS_SESSION_TOKEN }),
      };
    }
    const relative = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    const url =
      relative !== undefined && relative.length > 0 ? `http://169.254.170.2${relative}` : full;
    if (url !== undefined && url.length > 0) {
      const fetched = await this.fetchCredentials(url);
      this._cached = fetched;
      return fetched;
    }
    throw new ProviderError(
      `${this._name} has no credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run where AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is set (a task role)`,
    );
  }

  /** Reads the JSON the ECS/EKS container credentials endpoint returns. */
  private async fetchCredentials(url: string): Promise<Credentials> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this._fetch(url, { method: 'GET', headers: {}, body: '' });
    } catch (error) {
      throw new ProviderError(
        `${this._name} could not reach the container credentials endpoint: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(
        `${this._name} container credentials endpoint returned ${response.status}: ${text}`,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderResponseError(
        `${this._name} credentials endpoint returned a non-JSON body`,
      );
    }
    if (!isObject(body)) {
      throw new ProviderResponseError(`${this._name} credentials endpoint returned no object`);
    }
    const accessKeyId = body.AccessKeyId;
    const secretAccessKey = body.SecretAccessKey;
    if (typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string') {
      throw new ProviderResponseError(
        `${this._name} credentials endpoint returned no AccessKeyId/SecretAccessKey`,
      );
    }
    const token = body.Token;
    const expiration = body.Expiration;
    const expiresAt = typeof expiration === 'string' ? Date.parse(expiration) : Number.NaN;
    return {
      accessKeyId,
      secretAccessKey,
      ...(typeof token === 'string' && token.length > 0 ? { sessionToken: token } : {}),
      ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    };
  }

  private headers(
    url: string,
    body: string,
    region: string,
    credentials: Credentials,
    now: Date,
  ): Record<string, string> {
    const date = now.toISOString().slice(0, 10).replace(/-/g, '');
    const stamp = amzDate(now);
    const host = new URL(url).host;
    const canonicalHeaders: [string, string][] = [
      ['content-type', 'application/json'],
      ['host', host],
      ['x-amz-date', stamp],
    ];
    if (credentials.sessionToken !== undefined) {
      canonicalHeaders.push(['x-amz-security-token', credentials.sessionToken]);
    }
    const signedHeaders = canonicalHeaders.map(([name]) => name).join(';');
    const canonicalRequest = [
      'POST',
      new URL(url).pathname,
      '',
      canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join(''),
      signedHeaders,
      sha256Hex(body),
    ].join('\n');
    const scope = `${date}/${region}/${BEDROCK_SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), BEDROCK_SERVICE),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-amz-date': stamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...this._extraHeaders,
    };
    if (credentials.sessionToken !== undefined) {
      headers['x-amz-security-token'] = credentials.sessionToken;
    }
    return headers;
  }

  private payload(request: CompletionRequest, model: ModelSpec): Record<string, unknown> {
    const inferenceConfig: Record<string, unknown> = {
      maxTokens: Math.min(request.maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens),
    };
    if (request.temperature !== undefined) inferenceConfig.temperature = request.temperature;
    if (request.stop.length > 0) inferenceConfig.stopSequences = [...request.stop];
    const payload: Record<string, unknown> = {
      messages: this.wireMessages(request.messages),
      inferenceConfig,
    };
    const system = this.systemPrompt(request.messages);
    if (system.length > 0) payload.system = [{ text: system }];
    if (request.tools.length > 0) {
      payload.toolConfig = {
        tools: request.tools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: { json: tool.parameters },
          },
        })),
      };
    }
    return payload;
  }

  /** Converse takes one `system` array, so adjacent system turns are joined. */
  private systemPrompt(messages: readonly Message[]): string {
    const parts: string[] = [];
    for (const message of messages) {
      if (message.role !== 'system') continue;
      if (message.content.length === 0) continue;
      parts.push(message.content);
    }
    return parts.join('\n\n');
  }

  /**
   * Translate the portable message list into the wire shape.
   *
   * An assistant turn carrying tool calls sends `toolUse` blocks, or the following
   * `toolResult` has no caller; adjacent `tool` turns collapse into one `user`
   * turn, because Converse requires the conversation to alternate roles.
   */
  private wireMessages(messages: readonly Message[]): WireMessage[] {
    const wire: WireMessage[] = [];
    let previousWasToolResult = false;
    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') {
        if (message.toolCallId === undefined) {
          throw new ProviderError(`${this._name} cannot send a tool result without a tool_call_id`);
        }
        const block: Record<string, unknown> = {
          toolResult: {
            toolUseId: message.toolCallId,
            content: [{ text: message.content }],
          },
        };
        const last = wire[wire.length - 1];
        if (previousWasToolResult && last !== undefined) {
          last.content.push(block);
        } else {
          wire.push({ role: 'user', content: [block] });
        }
        previousWasToolResult = true;
        continue;
      }
      previousWasToolResult = false;
      if (message.role === 'user') {
        // Converse rejects an empty text block, so an empty turn is dropped rather
        // than sent as `content: []`.
        if (message.content.length === 0) continue;
        wire.push({ role: 'user', content: [{ text: message.content }] });
        continue;
      }
      const blocks: Record<string, unknown>[] = [];
      if (message.content.length > 0) blocks.push({ text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ toolUse: { toolUseId: call.id, name: call.name, input: call.args } });
      }
      if (blocks.length === 0) continue;
      wire.push({ role: 'assistant', content: blocks });
    }
    return wire;
  }

  private async post(url: string, headers: Record<string, string>, body: string): Promise<string> {
    let last = 'no attempt was made';
    for (let attempt = 1; attempt <= this._maxAttempts; attempt += 1) {
      try {
        const response = await this._fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this._timeoutSeconds * 1000),
        });
        const text = await response.text();
        if (!response.ok) {
          last = `${this._name} returned ${response.status}: ${text}`;
          if (RETRYABLE_STATUSES.has(response.status) && attempt < this._maxAttempts) {
            await delay(this._backoffSeconds * 2 ** (attempt - 1));
            continue;
          }
          throw new ProviderError(last);
        }
        return text;
      } catch (error) {
        if (error instanceof ProviderResponseError || error instanceof ProviderError) throw error;
        last = `${this._name} request failed: ${error instanceof Error ? error.message : String(error)}`;
        if (attempt < this._maxAttempts) {
          await delay(this._backoffSeconds * 2 ** (attempt - 1));
          continue;
        }
        throw new ProviderError(last);
      }
    }
    throw new ProviderError(`${this._name} failed after ${this._maxAttempts} attempt(s): ${last}`);
  }

  private parse(text: string, model: ModelSpec): CompletionResponse {
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new ProviderResponseError(`${this._name} returned a body that is not JSON`);
    }
    if (!isObject(body)) {
      throw new ProviderResponseError(`${this._name} returned a JSON body that is not an object`);
    }
    const output = body.output;
    const message = isObject(output) ? output.message : undefined;
    const blocks = isObject(message) ? message.content : undefined;
    if (!Array.isArray(blocks)) {
      throw new ProviderResponseError(`${this._name} returned no content blocks`);
    }
    const parts: string[] = [];
    const calls: ToolCall[] = [];
    for (const entry of blocks) {
      if (!isObject(entry)) continue;
      if (typeof entry.text === 'string') {
        parts.push(entry.text);
        continue;
      }
      const toolUse = entry.toolUse;
      if (!isObject(toolUse)) continue;
      const id = toolUse.toolUseId;
      const name = toolUse.name;
      if (typeof id !== 'string' || id.length === 0) continue;
      if (typeof name !== 'string' || name.length === 0) continue;
      calls.push(
        new ToolCall({ id, name, arguments: isObject(toolUse.input) ? toolUse.input : {} }),
      );
    }
    return new CompletionResponse({
      text: parts.join(''),
      model: model.name,
      provider: this._name,
      usage: this.usage(body),
      toolCalls: calls,
      finishReason: this.finishReason(body.stopReason, calls.length > 0),
    });
  }

  private usage(body: Record<string, unknown>): TokenUsage {
    const raw = isObject(body.usage) ? body.usage : {};
    const input = raw.inputTokens;
    const output = raw.outputTokens;
    return new TokenUsage({
      inputTokens: typeof input === 'number' ? Math.trunc(input) : 0,
      outputTokens: typeof output === 'number' ? Math.trunc(output) : 0,
    });
  }

  private finishReason(raw: unknown, sawToolCall: boolean): FinishReason {
    if (typeof raw !== 'string') return sawToolCall ? 'tool-calls' : 'stop';
    return FINISH_REASONS[raw] ?? 'stop';
  }
}
