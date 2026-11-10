/**
 * Reading a source: a local directory, an `s3://` prefix, or one `http(s)://` url.
 *
 * Spec 0.21 implements three of the five kinds the IR names. `db` and `mcp` are
 * still reserved and raise {@link FeatureDeferredError} here rather than indexing an
 * empty corpus and looking healthy.
 *
 * **Document identity is the POSIX path relative to the source root.** That is
 * the vocabulary the IR's retrieval metric already uses -- its `expectDocs` hold
 * `getting-started.md`, not `./docs/getting-started.md` -- and it is
 * machine-independent, so the same corpus indexed on Windows and on Linux yields
 * the same ids and the same eval outcome. Absolute paths would make a baseline
 * non-portable.
 *
 * The remote kinds keep that property: an object's id is its key with the source
 * prefix stripped, so a corpus indexed out of a bucket and out of a checkout yields
 * the same ids and the same eval outcome. Everything the three kinds share -- the
 * glob grammar, the document-size limit, the suffix rule -- lives once, because a
 * corpus that matched a recursive glob locally and not in S3 would be a reindex that
 * silently drops documents.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { ConfigurationError, FeatureDeferredError } from '../errors.js';
import { repr } from '../internal/json.js';
import { rfc3986, type Sigv4Credentials, sigv4Headers } from '../internal/sigv4.js';
import type { SourceKind, SourceSpec } from './types.js';

/** The largest document a remote source will read into memory. */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** How many `GetObject` calls may be in flight at once. */
const S3_CONCURRENCY = 8;

const S3_SERVICE = 's3';

/**
 * Compile a `*`/`**`/`?` glob into a matcher over POSIX relative paths.
 *
 * This used to build a regex, which is the compact spelling and the unsafe one: a glob
 * is configuration input, and a double-star-plus-slash group compiles to a nested
 * quantifier -- a star class inside a repeated group -- so a pattern with a dozen such
 * groups costs a pathologically large number of steps to *fail* against a deep path.
 * A glob repeating that group and pointing at a file the tree does not contain is an
 * outage, not a typo.
 *
 * So this walks pattern tokens against positions instead: one pass per token over the
 * path, no backtracking, `O(tokens * length)` in the worst case regardless of shape.
 * The supported syntax is unchanged and still spelled out rather than approximated --
 * anything beyond `*`, `**` and `?` matches literally.
 */
type GlobToken =
  | { readonly kind: 'literal'; readonly char: string }
  | { readonly kind: 'any-one' }
  | { readonly kind: 'star' }
  | { readonly kind: 'globstar' }
  | { readonly kind: 'globstar-segment' };

function tokenizeGlob(pattern: string): readonly GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          tokens.push({ kind: 'globstar-segment' });
        } else {
          tokens.push({ kind: 'globstar' });
        }
      } else {
        tokens.push({ kind: 'star' });
      }
    } else if (char === '?') {
      tokens.push({ kind: 'any-one' });
    } else {
      tokens.push({ kind: 'literal', char });
    }
  }
  return tokens;
}

function compileGlob(pattern: string): (path: string) => boolean {
  const tokens = tokenizeGlob(pattern);
  return (path: string): boolean => {
    let reachable: boolean[] = new Array<boolean>(path.length + 1).fill(false);
    reachable[0] = true;
    for (const token of tokens) {
      const next = new Array<boolean>(path.length + 1).fill(false);
      switch (token.kind) {
        case 'literal':
          for (let end = 1; end <= path.length; end += 1) {
            next[end] = reachable[end - 1] === true && path[end - 1] === token.char;
          }
          break;
        case 'any-one':
          for (let end = 1; end <= path.length; end += 1) {
            next[end] = reachable[end - 1] === true && path[end - 1] !== '/';
          }
          break;
        case 'star':
          // Zero or more non-slash characters: stay put, or extend a run that has
          // already stayed inside one segment.
          for (let end = 0; end <= path.length; end += 1) {
            const extendsRun = end > 0 && next[end - 1] === true && path[end - 1] !== '/';
            next[end] = reachable[end] === true || extendsRun;
          }
          break;
        case 'globstar':
          // Zero or more of any character, slashes included.
          for (let end = 0; end <= path.length; end += 1) {
            const extendsRun = end > 0 && next[end - 1] === true;
            next[end] = reachable[end] === true || extendsRun;
          }
          break;
        case 'globstar-segment':
          // `(?:[^/]*/)*`: zero or more whole segments, so it lands on any boundary
          // that follows a slash, including the one it started on.
          {
            let anyBefore = false;
            for (let end = 0; end <= path.length; end += 1) {
              const lands = anyBefore && end > 0 && path[end - 1] === '/';
              next[end] = reachable[end] === true || lands;
              if (reachable[end] === true) anyBefore = true;
            }
          }
          break;
      }
      reachable = next;
    }
    return reachable[path.length] === true;
  };
}

/** One document read from a source, before chunking. */
export class SourceDocument {
  /** POSIX path relative to the source root; the document's identity everywhere. */
  readonly docId: string;
  /** The absolute resolved location, for a human reading a citation. Never matched on. */
  readonly uri: string;
  readonly text: string;
  readonly metadata: Readonly<Record<string, string>>;

  constructor(init: {
    readonly docId: string;
    readonly uri: string;
    readonly text: string;
    readonly metadata?: Readonly<Record<string, string>>;
  }) {
    if (init.docId.length === 0) {
      throw new ConfigurationError('docId must not be empty');
    }
    if (init.uri.length === 0) {
      throw new ConfigurationError('uri must not be empty');
    }
    this.docId = init.docId;
    this.uri = init.uri;
    this.text = init.text;
    this.metadata = { ...(init.metadata ?? {}) };
  }
}

/** A source that yields documents in a deterministic order. */
export interface Connector {
  readonly kind: SourceKind;
  documents(): Promise<readonly SourceDocument[]>;
  close(): Promise<void>;
}

/**
 * Reads `*.md`-style files under a local directory.
 *
 * Files are read and returned in sorted `docId` order, never in directory order:
 * directory order is a filesystem accident, and a corpus whose chunk ids depend on
 * it would reindex itself differently on a different machine.
 */
export class FileConnector implements Connector {
  private readonly _root: string;
  private readonly _glob: string | null;

  constructor(root: string, options: { readonly glob?: string | null } = {}) {
    this._root = root;
    if (!existsSync(this._root)) {
      throw new ConfigurationError(`source path ${repr(this._root)} does not exist`);
    }
    if (!statSync(this._root).isDirectory()) {
      throw new ConfigurationError(`source path ${repr(this._root)} is not a directory`);
    }
    this._glob = options.glob ?? null;
  }

  get kind(): SourceKind {
    return 'file';
  }

  async documents(): Promise<readonly SourceDocument[]> {
    return this.paths().map((path) => this.read(path));
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  private paths(): readonly string[] {
    const pattern = this._glob ?? '**/*';
    const matcher = compileGlob(pattern);
    const found: string[] = [];
    const walk = (absolute: string): void => {
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        const child = `${absolute}${sep}${entry.name}`;
        if (entry.isDirectory()) {
          walk(child);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue;
        if (!matcher(this.docId(child))) continue;
        found.push(child);
      }
    };
    walk(this._root);
    return found.sort((left, right) => {
      const a = this.docId(left);
      const b = this.docId(right);
      if (a < b) return -1;
      return a > b ? 1 : 0;
    });
  }

  private docId(path: string): string {
    return relative(this._root, path).split(sep).join('/');
  }

  private read(path: string): SourceDocument {
    const docId = this.docId(path);
    const suffix = docId.includes('.') ? `.${docId.split('.').pop() as string}` : '';
    return new SourceDocument({
      docId,
      uri: path,
      text: readFileSync(path, 'utf8'),
      metadata: { path: docId, suffix },
    });
  }
}

/**
 * The extension of a document's final path segment, or `''`.
 *
 * The final segment, not the final dot: `v1.2/readme` has no suffix, and a key like
 * `api.v2/reference.md` must not inherit `v2`. A dot at the start of the segment is
 * a hidden file, not an extension.
 */
function suffix(docId: string): string {
  const segments = docId.split('/');
  const name = segments[segments.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

/** The part of a `fetch` response a loader reads: status, length and bytes. */
export interface RemoteResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Present on a streaming response; read in bounded chunks when it is. */
  readonly body?: ReadableStream<Uint8Array> | null;
}

/**
 * The `fetch` surface the remote connectors use.
 *
 * Narrower than `FetchLike` in `providers/http.ts` on purpose: a loader needs the
 * bytes and the declared length, and never the SSE plumbing. A test can therefore
 * answer with three fields, and the global `fetch` still satisfies it as-is.
 */
export type RemoteFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
) => Promise<RemoteResponse>;

/** The bytes behind a 2xx response, refusing anything over the document limit. */
async function readCapped(response: RemoteResponse, label: string): Promise<Uint8Array> {
  const declared = response.headers?.get('content-length') ?? null;
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_DOCUMENT_BYTES) {
    throw new ConfigurationError(
      `${label} is ${declared} bytes, over the ${MAX_DOCUMENT_BYTES}-byte limit`,
    );
  }
  const stream = response.body ?? null;
  if (stream === null) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > MAX_DOCUMENT_BYTES) {
      throw new ConfigurationError(
        `${label} exceeds the ${MAX_DOCUMENT_BYTES}-byte document limit`,
      );
    }
    return buffer;
  }
  // A body without a usable `content-length` is still capped: the limit protects the
  // indexer from a source that answers with an endless stream.
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (let read = await reader.read(); read.done !== true; read = await reader.read()) {
      total += read.value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) {
        throw new ConfigurationError(
          `${label} exceeds the ${MAX_DOCUMENT_BYTES}-byte document limit`,
        );
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** One `GET` that requires a 2xx, then reads the body under the document limit. */
async function getBytes(
  fetchImpl: RemoteFetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  label: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const body = new Uint8Array(await response.arrayBuffer()).slice(0, 200);
    const detail = new TextDecoder('utf-8', { fatal: false }).decode(body).trim();
    throw new ConfigurationError(
      `${label} returned HTTP ${response.status}${detail.length === 0 ? '' : `: ${detail}`}`,
    );
  }
  return readCapped(response, label);
}

/** UTF-8 decode, refusing a body that is not text. */
function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`${label} is not valid UTF-8: ${detail}`);
  }
}

/** One object named by a ListObjectsV2 page. */
interface ListedObject {
  readonly key: string;
  readonly etag: string;
  readonly lastModified: string;
}

interface S3Environment {
  readonly credentials: Sigv4Credentials;
  readonly region: string;
  readonly endpoint: string | null;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return null;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/**
 * The credentials, region and optional endpoint an `s3` source reads.
 *
 * Read from the environment rather than the spec because the manifest is committed
 * and a credential is not; a spec that could name a secret would be a spec that leaks
 * one. The endpoint override is the same pair the AWS SDKs honour, so a local S3
 * stand-in needs no source-specific configuration.
 */
function s3Environment(env: Readonly<Record<string, string | undefined>>): S3Environment {
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? '';
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? '';
  if (accessKeyId.length === 0 || secretAccessKey.length === 0) {
    throw new ConfigurationError(
      'an s3 source needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment',
    );
  }
  const region = firstNonEmpty(env.AWS_REGION, env.AWS_DEFAULT_REGION);
  if (region === null) {
    throw new ConfigurationError(
      'an s3 source needs a region: set AWS_REGION or AWS_DEFAULT_REGION',
    );
  }
  const sessionToken = firstNonEmpty(env.AWS_SESSION_TOKEN);
  const endpoint = firstNonEmpty(env.AWS_ENDPOINT_URL_S3, env.AWS_ENDPOINT_URL);
  return {
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === null ? {} : { sessionToken }),
    },
    region,
    endpoint: endpoint === null ? null : stripTrailingSlashes(endpoint),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const LISTING_PARSER = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (tagName) => tagName === 'Contents',
});

/**
 * Read one ListObjectsV2 page: its objects and the next continuation token.
 *
 * `parseTagValue: false` keeps every key a string, so a key that happens to look like
 * a number or a date is not silently retyped into one.
 */
function parseListing(body: Uint8Array): {
  readonly objects: readonly ListedObject[];
  readonly nextToken: string | null;
} {
  let parsed: unknown;
  try {
    parsed = LISTING_PARSER.parse(new TextDecoder('utf-8', { fatal: false }).decode(body));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigurationError(`the s3 ListObjectsV2 response is not valid XML: ${detail}`);
  }
  const root = isRecord(parsed) ? parsed.ListBucketResult : undefined;
  if (!isRecord(root)) {
    throw new ConfigurationError(
      'the s3 ListObjectsV2 response is not a ListBucketResult document',
    );
  }
  const objects: ListedObject[] = [];
  const contents = root.Contents;
  if (Array.isArray(contents)) {
    for (const entry of contents) {
      if (!isRecord(entry)) continue;
      const key = textOf(entry.Key);
      if (key.length === 0) continue;
      objects.push({
        key,
        etag: textOf(entry.ETag).replace(/^"|"$/g, ''),
        lastModified: textOf(entry.LastModified),
      });
    }
  }
  const truncated = textOf(root.IsTruncated).trim().toLowerCase() === 'true';
  const token = textOf(root.NextContinuationToken).trim();
  return { objects, nextToken: truncated && token.length > 0 ? token : null };
}

export interface S3ConnectorOptions {
  readonly glob?: string | null;
  /** Supplied by tests, or to share a connection pool. */
  readonly fetchImpl?: RemoteFetch;
  readonly timeoutMs?: number;
  /** Supplied by tests so a signature is reproducible. */
  readonly now?: () => Date;
  /** Defaults to `process.env`; supplied by tests so they need not mutate it. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Reads an `s3://bucket[/prefix]` corpus, one document per object.
 *
 * An object's `docId` is its key with the source prefix stripped, so the same corpus
 * indexed out of a bucket and out of a directory yields the same ids. Objects are
 * fetched concurrently -- bounded, so a bucket with a thousand keys does not open a
 * thousand sockets -- and emitted in sorted `docId` order regardless.
 */
export class S3Connector implements Connector {
  private readonly _bucket: string;
  private readonly _prefix: string;
  private readonly _glob: string | null;
  private readonly _environment: S3Environment;
  private readonly _fetch: RemoteFetch;
  private readonly _timeoutMs: number;
  private readonly _now: () => Date;

  constructor(uri: string, options: S3ConnectorOptions = {}) {
    const parsed = new URL(uri);
    if (parsed.protocol !== 's3:' || parsed.hostname.length === 0) {
      throw new ConfigurationError(
        `s3 source uri ${repr(uri)} must be an absolute 's3://<bucket>[/<prefix>]' uri`,
      );
    }
    this._bucket = parsed.hostname;
    const raw = parsed.pathname.replace(/^\/+/, '');
    // A prefix names a directory: without the trailing slash, `docs` would also list
    // `docs-archive/` objects that are not under the source at all.
    this._prefix = raw.length === 0 || raw.endsWith('/') ? raw : `${raw}/`;
    this._glob = options.glob ?? null;
    this._environment = s3Environment(options.env ?? process.env);
    this._fetch = options.fetchImpl ?? (globalThis.fetch as unknown as RemoteFetch);
    this._timeoutMs = options.timeoutMs ?? 30_000;
    this._now = options.now ?? (() => new Date());
  }

  get kind(): SourceKind {
    return 's3';
  }

  async documents(): Promise<readonly SourceDocument[]> {
    const matcher = this._glob === null ? null : compileGlob(this._glob);
    const selected: { item: ListedObject; docId: string }[] = [];
    for (const item of await this._listObjects()) {
      if (item.key.endsWith('/')) continue;
      const docId = this._relativeKey(item.key);
      if (matcher !== null && !matcher(docId)) continue;
      selected.push({ item, docId });
    }
    const documents = await this._fetchAll(selected);
    return documents.sort((left, right) => {
      if (left.docId < right.docId) return -1;
      return left.docId > right.docId ? 1 : 0;
    });
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  private _relativeKey(key: string): string {
    if (this._prefix.length > 0 && key.startsWith(this._prefix)) {
      return key.slice(this._prefix.length).replace(/^\/+/, '');
    }
    return key.replace(/^\/+/, '');
  }

  private _listRequest(token: string | null): { url: string; query: string } {
    const params: [string, string][] = [['list-type', '2']];
    if (this._prefix.length > 0) params.push(['prefix', this._prefix]);
    if (token !== null) params.push(['continuation-token', token]);
    const query = params
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
      .join('&');
    const base =
      this._environment.endpoint === null
        ? `https://${this._bucket}.s3.${this._environment.region}.amazonaws.com`
        : `${this._environment.endpoint}/${this._bucket}`;
    return { url: `${base}/?${query}`, query };
  }

  private _objectUrl(key: string): string {
    const encoded = key.split('/').map(rfc3986).join('/');
    const base =
      this._environment.endpoint === null
        ? `https://${this._bucket}.s3.${this._environment.region}.amazonaws.com`
        : `${this._environment.endpoint}/${this._bucket}`;
    return `${base}/${encoded}`;
  }

  private _headers(url: string, query: string | null): Record<string, string> {
    return sigv4Headers({
      url,
      body: '',
      region: this._environment.region,
      service: S3_SERVICE,
      credentials: this._environment.credentials,
      now: this._now(),
      method: 'GET',
      ...(query === null ? {} : { query }),
    });
  }

  private _signal(): AbortSignal | undefined {
    return this._timeoutMs > 0 ? AbortSignal.timeout(this._timeoutMs) : undefined;
  }

  private async _listObjects(): Promise<readonly ListedObject[]> {
    const listed: ListedObject[] = [];
    let token: string | null = null;
    for (;;) {
      const { url, query } = this._listRequest(token);
      const body = await getBytes(
        this._fetch,
        url,
        this._headers(url, query),
        'the s3 listing',
        this._signal(),
      );
      const page = parseListing(body);
      listed.push(...page.objects);
      if (page.nextToken === null) return listed;
      token = page.nextToken;
    }
  }

  private async _fetchAll(
    selected: readonly { item: ListedObject; docId: string }[],
  ): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = new Array<SourceDocument>(selected.length);
    let cursor = 0;
    const take = (): number | null => {
      if (cursor >= selected.length) return null;
      const index = cursor;
      cursor += 1;
      return index;
    };
    const worker = async (): Promise<void> => {
      for (let index = take(); index !== null; index = take()) {
        const entry = selected[index] as { item: ListedObject; docId: string };
        documents[index] = await this._fetchObject(entry.item, entry.docId);
      }
    };
    const workers = Math.min(S3_CONCURRENCY, selected.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return documents;
  }

  private async _fetchObject(item: ListedObject, docId: string): Promise<SourceDocument> {
    const url = this._objectUrl(item.key);
    const body = await getBytes(
      this._fetch,
      url,
      this._headers(url, null),
      `the s3 object ${repr(item.key)}`,
      this._signal(),
    );
    return new SourceDocument({
      docId,
      uri: `s3://${this._bucket}/${item.key}`,
      text: decodeUtf8(body, `the s3 object ${repr(item.key)}`),
      metadata: {
        path: docId,
        suffix: suffix(docId),
        etag: item.etag,
        lastModified: item.lastModified,
      },
    });
  }
}

export interface HttpConnectorOptions {
  readonly glob?: string | null;
  readonly fetchImpl?: RemoteFetch;
  readonly timeoutMs?: number;
}

/**
 * Reads exactly one document from an absolute `http://` or `https://` url.
 *
 * An http source names a document, not a set, which is why it takes no `glob`: a
 * pattern there would describe documents the connector deliberately does not fetch.
 * The validator refuses one too, so this check only fires for a hand-built spec.
 */
export class HttpConnector implements Connector {
  private readonly _uri: string;
  private readonly _segments: readonly string[];
  private readonly _fetch: RemoteFetch;
  private readonly _timeoutMs: number;

  constructor(uri: string, options: HttpConnectorOptions = {}) {
    if (options.glob !== undefined && options.glob !== null) {
      throw new ConfigurationError(
        `http source ${repr(uri)} takes no 'glob': an http source is exactly one ` +
          'document, and a pattern describes a set',
      );
    }
    const parsed = new URL(uri);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.hostname.length === 0
    ) {
      throw new ConfigurationError(
        `http source uri ${repr(uri)} must be an absolute 'http://' or 'https://' url`,
      );
    }
    this._uri = uri;
    this._segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    this._fetch = options.fetchImpl ?? (globalThis.fetch as unknown as RemoteFetch);
    this._timeoutMs = options.timeoutMs ?? 30_000;
  }

  get kind(): SourceKind {
    return 'http';
  }

  async documents(): Promise<readonly SourceDocument[]> {
    const body = await getBytes(
      this._fetch,
      this._uri,
      {},
      `the http source ${repr(this._uri)}`,
      this._timeoutMs > 0 ? AbortSignal.timeout(this._timeoutMs) : undefined,
    );
    const docId = this._segments[this._segments.length - 1] ?? 'index';
    return [
      new SourceDocument({
        docId,
        uri: this._uri,
        text: decodeUtf8(body, `the http source ${repr(this._uri)}`),
        metadata: { path: docId, suffix: suffix(docId) },
      }),
    ];
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface OpenConnectorOptions {
  /** Resolves a relative `file` source `uri`. */
  readonly baseDir?: string | null;
  readonly fetchImpl?: RemoteFetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Open the connector for a source entry.
 *
 * `baseDir` resolves a relative `file` source `uri`; it is explicit because the
 * runtime has no opinion about a working directory, and a corpus must not depend on
 * where a process happened to be started. The remote kinds do not consult it: their
 * `uri` is absolute by definition.
 */
export function openConnector(spec: SourceSpec, options: OpenConnectorOptions = {}): Connector {
  if (spec.kind === 's3') {
    return new S3Connector(spec.uri, {
      glob: spec.glob,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }
  if (spec.kind === 'http') {
    return new HttpConnector(spec.uri, {
      glob: spec.glob,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }
  if (spec.kind !== 'file') {
    throw new FeatureDeferredError(
      `source kind ${repr(spec.kind)} is still reserved: the s3 and http loaders ` +
        'shipped in spec 0.21, and db and mcp remain part of the design but unimplemented',
    );
  }
  let root = spec.uri;
  if (!isAbsolute(root) && options.baseDir !== undefined && options.baseDir !== null) {
    root = `${options.baseDir}${sep}${root}`;
  }
  return new FileConnector(root, { glob: spec.glob });
}
