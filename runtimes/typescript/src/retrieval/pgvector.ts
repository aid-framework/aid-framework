/**
 * A pgvector-backed store, provisioned locally and never touched by CI.
 *
 * The driver is optional, so this module must be importable without it. Nothing at
 * module scope imports it; the load happens inside {@link loadDriver} on first use,
 * and a missing driver becomes a {@link ConfigurationError} that names the package to
 * install. Importing the retrieval package therefore cannot fail because a database
 * dependency is absent, which is what lets the default dependency set stay unchanged
 * and what keeps every required gate on the in-memory store.
 *
 * Two consequences of that choice are deliberate and visible:
 *
 * - The driver arrives as an untyped value, so `unknown` reaches this file. It is
 *   confined to this one adapter rather than spreading a suppressed import across the
 *   retrieval package.
 * - Every statement is a fixed string with positional placeholders. The embedding
 *   column is declared dimension-less rather than `vector(1536)`, so no computed
 *   identifier is ever interpolated into SQL, and the pinned width is enforced where
 *   the pin actually lives: the caller's `PinnedEmbedding`.
 *
 * Correctness here is expected to match the in-memory adapter, but nothing checks
 * that: this adapter is not gate-covered, and its SQL path runs only on a machine
 * where someone brought the database up themselves.
 */

import { createRequire } from 'node:module';

import { ConfigurationError, ProviderError } from '../errors.js';
import { dumpsSorted, repr } from '../internal/json.js';
import { SearchHit, StoreRecord } from './stores.js';
import type { StoreKind } from './types.js';
import { Chunk } from './types.js';

const ENV_PREFIX = 'env:';
const DRIVER = 'pg';

const CREATE_EXTENSION = 'CREATE EXTENSION IF NOT EXISTS vector';
const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS aid_chunks (
    chunk_id text PRIMARY KEY,
    doc_id text NOT NULL,
    uri text NOT NULL,
    chunk_index integer NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    body text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    embedding vector NOT NULL
)
`;

const UPSERT = `
INSERT INTO aid_chunks (
    chunk_id, doc_id, uri, chunk_index, start_offset, end_offset, body, metadata, embedding
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::vector
)
ON CONFLICT (chunk_id) DO UPDATE SET
    doc_id = EXCLUDED.doc_id,
    uri = EXCLUDED.uri,
    chunk_index = EXCLUDED.chunk_index,
    start_offset = EXCLUDED.start_offset,
    end_offset = EXCLUDED.end_offset,
    body = EXCLUDED.body,
    metadata = EXCLUDED.metadata,
    embedding = EXCLUDED.embedding
`;

const COLUMNS =
  'chunk_id, doc_id, uri, chunk_index, start_offset, end_offset, body, metadata, embedding';

const CORPUS = `SELECT ${COLUMNS} FROM aid_chunks ORDER BY chunk_id`;

// `<=>` is cosine distance, `<#>` is negative inner product and `<->` is L2 distance.
// Each is rewritten into "higher is better" so callers see one orientation, matching
// `stores.similarity`. The tie-break on `chunk_id` matches the in-memory adapter too:
// equal scores must rank identically on both.
//
// Every statement is spelled out in full rather than assembled from a column list, so
// that no statement is ever *constructed*: the only values that reach SQL are bound
// parameters.
const SEARCH: Readonly<Record<string, string>> = {
  cosine:
    `SELECT ${COLUMNS}, 1 - (embedding <=> $1::vector) AS score FROM aid_chunks ` +
    'ORDER BY embedding <=> $1::vector, chunk_id LIMIT $2',
  dot:
    `SELECT ${COLUMNS}, -(embedding <#> $1::vector) AS score FROM aid_chunks ` +
    'ORDER BY embedding <#> $1::vector, chunk_id LIMIT $2',
  l2:
    `SELECT ${COLUMNS}, -(embedding <-> $1::vector) AS score FROM aid_chunks ` +
    'ORDER BY embedding <-> $1::vector, chunk_id LIMIT $2',
};

/** The slice of the driver this adapter uses. */
interface PgClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[][] }>;
  end(): Promise<void>;
}

interface PgModule {
  readonly Client: new (options: { readonly connectionString: string }) => PgClient;
}

const requireFromHere = createRequire(import.meta.url);

/** Import the optional driver, or explain how to install it. */
function loadDriver(): PgModule {
  try {
    return requireFromHere(DRIVER) as PgModule;
  } catch {
    throw new ConfigurationError(
      'the pgvector store needs its driver; install it with `pnpm add pg` in the ' +
        'generated app (the default runtime install omits it)',
    );
  }
}

/**
 * Resolve an `env:NAME` reference to the variable's value.
 *
 * An `env:` reference names a variable, not an alias: nothing here reaches the model
 * catalog, so resolving it at run time cannot silently change which store a run wrote
 * to.
 */
export function resolveUri(uri: string | null | undefined): string {
  if (uri === null || uri === undefined) {
    throw new ConfigurationError('the pgvector store requires a uri');
  }
  if (!uri.startsWith(ENV_PREFIX)) {
    return uri;
  }
  const name = uri.slice(ENV_PREFIX.length);
  if (name.length === 0) {
    throw new ConfigurationError(`store uri ${repr(uri)} names an empty environment variable`);
  }
  const value = process.env[name];
  if (value === undefined) {
    throw new ConfigurationError(
      `store uri ${repr(uri)} refers to environment variable ${repr(name)}, which is unset`,
    );
  }
  return value;
}

/**
 * A float as Python's `repr` spells it, so the literal form matches the Python adapter.
 *
 * `String(-0)` is `'0'`, but `repr(-0.0)` is `'-0.0'`; the sign is part of the literal
 * Python emits, and a bare `0.0` would be a visible divergence. The very large
 * magnitudes where Python's shortest-repr algorithm switches to exponent notation
 * earlier than `Number#toString` are not reproduced -- no embedding component reaches
 * them, and reproducing the algorithm would be a lie dressed as fidelity.
 */
function floatRepr(value: number): string {
  if (Object.is(value, -0)) return '-0.0';
  const text = String(value);
  return /[.eEn]/.test(text) ? text : `${text}.0`;
}

/** pgvector's text input format, so its own package is not a dependency. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => floatRepr(value)).join(',')}]`;
}

/** Accept either a driver-returned sequence or pgvector's text form. */
export function parseVector(value: unknown): readonly number[] {
  if (typeof value === 'string') {
    const stripped = value.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (stripped.length === 0) return [];
    return stripped.split(',').map((part) => Number.parseFloat(part));
  }
  if (Array.isArray(value)) {
    return value.map((item) => Number(item));
  }
  throw new ConfigurationError('cannot read a vector: expected a sequence or its text form');
}

function metadataFrom(value: unknown): Readonly<Record<string, string>> {
  if (typeof value === 'string') {
    if (value.length === 0) return {};
    const parsed: unknown = JSON.parse(value);
    return (parsed ?? {}) as Record<string, string>;
  }
  return (value ?? {}) as Record<string, string>;
}

/** A single-table store: one row per chunk, keyed by content hash. */
export class PgVectorStore {
  private readonly _uri: string;
  private readonly _dimensions: number | null;
  private _connection: PgClient | null = null;
  private _closed = false;

  constructor(options: { readonly uri: string | null; readonly dimensions?: number | null }) {
    this._uri = resolveUri(options.uri);
    this._dimensions = options.dimensions ?? null;
  }

  get kind(): StoreKind {
    return 'pgvector';
  }

  async upsert(records: readonly StoreRecord[]): Promise<number> {
    if (this._dimensions !== null) {
      for (const record of records) {
        if (record.vector.length !== this._dimensions) {
          throw new ConfigurationError(
            `store is pinned to ${this._dimensions} dimensions but a record carries ` +
              `${record.vector.length}`,
          );
        }
      }
    }
    if (records.length === 0) return 0;
    const connection = await this.connect();
    for (const record of records) {
      await connection.query(UPSERT, this.params(record));
    }
    return records.length;
  }

  async search(
    vector: readonly number[],
    options: { readonly topK: number; readonly metric: 'cosine' | 'dot' | 'l2' },
  ): Promise<readonly SearchHit[]> {
    if (options.topK < 1) {
      throw new ConfigurationError('top_k must be at least 1');
    }
    const statement = SEARCH[options.metric];
    if (statement === undefined) {
      throw new ConfigurationError(`pgvector cannot rank by ${repr(options.metric)}`);
    }
    const connection = await this.connect();
    const { rows } = await connection.query(statement, [vectorLiteral(vector), options.topK]);
    return rows.map((row) => new SearchHit({ record: this.record(row), score: Number(row[9]) }));
  }

  async corpus(): Promise<readonly StoreRecord[]> {
    const connection = await this.connect();
    const { rows } = await connection.query(CORPUS);
    return rows.map((row) => this.record(row));
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    if (this._connection !== null) {
      await this._connection.end();
      this._connection = null;
    }
  }

  private async connect(): Promise<PgClient> {
    if (this._closed) {
      throw new ConfigurationError('this store has been closed');
    }
    if (this._connection === null) {
      const driver = loadDriver();
      try {
        this._connection = new driver.Client({ connectionString: this._uri });
      } catch (error) {
        throw new ProviderError(`cannot connect to the pgvector store: ${String(error)}`);
      }
      await this.ensureSchema(this._connection);
    }
    return this._connection;
  }

  private async ensureSchema(connection: PgClient): Promise<void> {
    await connection.query(CREATE_EXTENSION);
    await connection.query(CREATE_TABLE);
  }

  private params(record: StoreRecord): readonly unknown[] {
    const chunk = record.chunk;
    return [
      chunk.chunkId,
      chunk.docId,
      chunk.uri,
      chunk.index,
      chunk.start,
      chunk.end,
      chunk.text,
      dumpsSorted(chunk.metadata),
      vectorLiteral(record.vector),
    ];
  }

  private record(row: readonly unknown[]): StoreRecord {
    return new StoreRecord({
      chunk: new Chunk({
        chunkId: String(row[0]),
        docId: String(row[1]),
        uri: String(row[2]),
        index: Number(row[3]),
        start: Number(row[4]),
        end: Number(row[5]),
        text: String(row[6]),
        metadata: metadataFrom(row[7]),
      }),
      vector: parseVector(row[8]),
    });
  }
}
