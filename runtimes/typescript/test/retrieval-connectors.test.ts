import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteFetch, RemoteResponse } from '../src/index.js';
import {
  ConfigurationError,
  FeatureDeferredError,
  FileConnector,
  HttpConnector,
  openConnector,
  S3Connector,
  SourceDocument,
  SourceSpec,
} from '../src/index.js';
import { at } from './support.js';

const created: string[] = [];

/** Build a corpus on disk and hand back its root. */
function corpus(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'aid-connector-'));
  created.push(root);
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const root = created.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('SourceDocument', () => {
  it('defaults its metadata to empty', () => {
    const document = new SourceDocument({ docId: 'a.md', uri: 'file:///a.md', text: 'body' });

    expect(document.metadata).toEqual({});
  });

  it('copies its metadata', () => {
    const metadata = { lang: 'en' };

    const document = new SourceDocument({
      docId: 'a.md',
      uri: 'file:///a.md',
      text: 'body',
      metadata,
    });

    metadata.lang = 'fr';
    expect(document.metadata.lang).toBe('en');
  });

  it('refuses an empty docId', () => {
    expect(() => new SourceDocument({ docId: '', uri: 'file:///a.md', text: '' })).toThrow(
      'docId must not be empty',
    );
  });

  it('refuses an empty uri', () => {
    expect(() => new SourceDocument({ docId: 'a.md', uri: '', text: '' })).toThrow(
      'uri must not be empty',
    );
  });
});

describe('FileConnector construction', () => {
  it('is kind file', () => {
    expect(new FileConnector(corpus({})).kind).toBe('file');
  });

  it('refuses a path that does not exist', () => {
    const missing = join(tmpdir(), 'aid-connector-absent-directory-xyz');

    expect(() => new FileConnector(missing)).toThrow(ConfigurationError);
    expect(() => new FileConnector(missing)).toThrow(/does not exist/);
  });

  it('refuses a path that is a file, not a directory', () => {
    const root = corpus({ 'a.md': 'body' });
    const file = join(root, 'a.md');

    expect(() => new FileConnector(file)).toThrow(/is not a directory/);
  });
});

describe('FileConnector documents', () => {
  it('reads files in sorted docId order, not directory order', async () => {
    const root = corpus({ 'b.md': 'bravo', 'a.md': 'alpha', 'c.md': 'charlie' });

    const documents = await new FileConnector(root).documents();

    expect(documents.map((document) => document.docId)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(at(documents, 0).text).toBe('alpha');
  });

  it('uses the POSIX path relative to the root as the docId', async () => {
    const root = corpus({ 'guide/getting-started.md': 'start here' });

    const documents = await new FileConnector(root).documents();

    // The IR's metric already speaks this vocabulary: `expectDocs` holds
    // `getting-started.md`, not `./guide/getting-started.md`.
    expect(at(documents, 0).docId).toBe('guide/getting-started.md');
  });

  it('records the absolute path as the uri, for a human reading a citation', async () => {
    const root = corpus({ 'a.md': 'body' });

    const documents = await new FileConnector(root).documents();

    expect(at(documents, 0).uri).toBe(join(root, 'a.md'));
  });

  it('carries the relative path and suffix as metadata', async () => {
    const root = corpus({ 'guide/intro.md': 'body' });

    const documents = await new FileConnector(root).documents();

    expect(at(documents, 0).metadata).toEqual({ path: 'guide/intro.md', suffix: '.md' });
  });

  it('records an empty suffix for a file with no extension', async () => {
    const root = corpus({ LICENSE: 'terms' });

    const documents = await new FileConnector(root).documents();

    expect(at(documents, 0).metadata.suffix).toBe('');
  });

  it('sorts nested ids by their full relative path', async () => {
    const root = corpus({ 'b/a.md': '', 'a/b.md': '', 'c.md': '' });

    const documents = await new FileConnector(root).documents();

    expect(documents.map((document) => document.docId)).toEqual(['a/b.md', 'b/a.md', 'c.md']);
  });

  it('skips dotfiles', async () => {
    const root = corpus({ 'a.md': 'kept', '.hidden.md': 'dropped' });

    const documents = await new FileConnector(root).documents();

    expect(documents.map((document) => document.docId)).toEqual(['a.md']);
  });

  it('returns nothing for an empty tree', async () => {
    const documents = await new FileConnector(corpus({})).documents();

    expect(documents).toEqual([]);
  });

  it('defaults the glob to everything', async () => {
    const root = corpus({ 'a.md': '', 'b.txt': '' });

    const documents = await new FileConnector(root).documents();

    expect(documents.map((document) => document.docId)).toEqual(['a.md', 'b.txt']);
  });

  it('filters by a single-star glob within one directory', async () => {
    const root = corpus({ 'a.md': 'kept', 'a.txt': 'dropped', 'deep/b.md': 'dropped' });

    const documents = await new FileConnector(root, { glob: '*.md' }).documents();

    expect(documents.map((document) => document.docId)).toEqual(['a.md']);
  });

  it('filters by a double-star glob across directories', async () => {
    const root = corpus({ 'a.md': '', 'deep/b.md': '', 'deep/more/c.md': '', 'deep/d.txt': '' });

    const documents = await new FileConnector(root, { glob: '**/*.md' }).documents();

    expect(documents.map((document) => document.docId)).toEqual([
      'a.md',
      'deep/b.md',
      'deep/more/c.md',
    ]);
  });

  it('matches a single character with ?', async () => {
    const root = corpus({ 'a1.md': '', 'a2.md': '', 'a12.md': '' });

    const documents = await new FileConnector(root, { glob: 'a?.md' }).documents();

    expect(documents.map((document) => document.docId)).toEqual(['a1.md', 'a2.md']);
  });

  it('treats regex metacharacters in the pattern literally', async () => {
    const root = corpus({ 'a.md': '', 'b.md': '' });

    // A '.' in the pattern is a literal dot, not "any character": otherwise `bmd`
    // would match and the corpus would silently differ from the one declared.
    const documents = await new FileConnector(root, { glob: 'a.md' }).documents();

    expect(documents.map((document) => document.docId)).toEqual(['a.md']);
  });

  it('answers a pathologically nested glob without backtracking', async () => {
    // A glob is configuration input, and `**/` repeated compiles to a nested quantifier,
    // which made a non-matching tree exponential to reject. The assertion is the value:
    // the deep path is found exactly when the pattern names it, and the missing file is
    // rejected quickly rather than eventually.
    const root = corpus({ 'a/b/c/d/deep.md': 'body', 'a/b/c/d/other.txt': 'body' });
    const pattern = `${'**/'.repeat(12)}deep.md`;

    const found = await new FileConnector(root, { glob: pattern }).documents();
    const missing = await new FileConnector(root, { glob: `${'**/'.repeat(12)}absent.md` });

    expect(found.map((document) => document.docId)).toEqual(['a/b/c/d/deep.md']);
    expect(await missing.documents()).toEqual([]);
  });

  it('is idempotent across two reads', async () => {
    const connector = new FileConnector(corpus({ 'a.md': 'body' }));

    const first = await connector.documents();
    const second = await connector.documents();

    expect(second.map((document) => document.docId)).toEqual(
      first.map((document) => document.docId),
    );
  });

  it('closes without complaint, twice', async () => {
    const connector = new FileConnector(corpus({ 'a.md': 'body' }));

    await expect(connector.close()).resolves.toBeUndefined();
    await expect(connector.close()).resolves.toBeUndefined();
  });
});

describe('openConnector', () => {
  it('opens a file source', async () => {
    const root = corpus({ 'a.md': 'body' });

    const connector = openConnector(new SourceSpec({ kind: 'file', uri: root }));

    expect(connector.kind).toBe('file');
    expect((await connector.documents()).map((document) => document.docId)).toEqual(['a.md']);
  });

  it('resolves a relative uri against the supplied base directory', async () => {
    const root = corpus({ 'docs/a.md': 'body' });
    const spec = new SourceSpec({ kind: 'file', uri: 'docs' });

    const connector = openConnector(spec, { baseDir: root });

    expect((await connector.documents()).map((document) => document.docId)).toEqual(['a.md']);
  });

  it('leaves an absolute uri alone even when a base directory is supplied', async () => {
    const root = corpus({ 'a.md': 'body' });
    const spec = new SourceSpec({ kind: 'file', uri: root });

    const connector = openConnector(spec, { baseDir: join(tmpdir(), 'somewhere-else') });

    expect((await connector.documents()).map((document) => document.docId)).toEqual(['a.md']);
  });

  it('passes the glob through to the connector', async () => {
    const root = corpus({ 'a.md': '', 'b.txt': '' });
    const spec = new SourceSpec({ kind: 'file', uri: root, glob: '*.txt' });

    const connector = openConnector(spec);

    expect((await connector.documents()).map((document) => document.docId)).toEqual(['b.txt']);
  });

  for (const kind of ['db', 'mcp'] as const) {
    it(`defers a ${kind} source rather than indexing an empty corpus`, () => {
      const spec = new SourceSpec({ kind, uri: 'ignored' });

      expect(() => openConnector(spec)).toThrow(FeatureDeferredError);
      expect(() => openConnector(spec)).toThrow(/is still reserved/);
      expect(() => openConnector(spec)).toThrow(/shipped in spec 0\.21/);
    });
  }

  it('opens an s3 source', async () => {
    const stub = s3Stub();
    const spec = new SourceSpec({ kind: 's3', uri: 's3://corpus/docs' });

    const connector = openConnector(spec, { fetchImpl: stub.fetchImpl, env: AWS_ENVIRONMENT });

    expect(connector.kind).toBe('s3');
    expect((await connector.documents()).map((document) => document.docId)).toEqual([
      'a&b.md',
      'b.md',
      'c.md',
      'nested/d.md',
    ]);
  });

  it('opens an http source', async () => {
    const spec = new SourceSpec({ kind: 'http', uri: 'https://example.com/guide/intro.md' });

    const connector = openConnector(spec, { fetchImpl: textFetch('body') });

    expect(connector.kind).toBe('http');
    expect((await connector.documents()).map((document) => document.docId)).toEqual(['intro.md']);
  });
});

/** A response carrying an XML body, as ListObjectsV2 answers. */
function xmlResponse(body: string, status = 200): RemoteResponse {
  const bytes = new TextEncoder().encode(body);
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-length' ? String(bytes.byteLength) : null),
    },
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  };
}

/** A response that streams `chunks` and declares no length. */
function streamedResponse(chunks: readonly Uint8Array[]): RemoteResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

/** A `fetch` that answers every url with the same text body. */
function textFetch(body: string, status = 200): RemoteFetch {
  return () => Promise.resolve(xmlResponse(body, status));
}

const AWS_ENVIRONMENT = {
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_REGION: 'us-east-1',
} as const;

const FIXED_NOW = new Date('2026-11-02T05:17:11.000Z');

// Two pages, so pagination is exercised rather than assumed. `a&amp;b.md` is an XML
// escape a naive parser would keep literally, and its `&` is what proves the key is
// decoded before it becomes a docId.
const PAGE_ONE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>corpus</Name>
  <Prefix>docs/</Prefix>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>page-2</NextContinuationToken>
  <Contents>
    <Key>docs/b.md</Key>
    <ETag>&quot;etag-b&quot;</ETag>
    <LastModified>2026-01-02T00:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>docs/a&amp;b.md</Key>
    <ETag>&quot;etag-ab&quot;</ETag>
    <LastModified>2026-01-01T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

const PAGE_TWO = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>corpus</Name>
  <Prefix>docs/</Prefix>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>docs/c.md</Key>
    <ETag>&quot;etag-c&quot;</ETag>
    <LastModified>2026-01-03T00:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>docs/nested/d.md</Key>
    <ETag>&quot;etag-d&quot;</ETag>
    <LastModified>2026-01-04T00:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>docs/</Key>
    <ETag>&quot;etag-root&quot;</ETag>
    <LastModified>2026-01-05T00:00:00.000Z</LastModified>
  </Contents>
</ListBucketResult>`;

const OBJECT_BODIES: Readonly<Record<string, string>> = {
  'docs/a&b.md': 'ampersand',
  'docs/b.md': 'bravo',
  'docs/c.md': 'charlie',
  'docs/nested/d.md': 'delta',
};

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A stubbed S3 endpoint: answers the listing pages, then each object by key.
 *
 * The recorded requests are what let a test assert the connector actually listed with
 * the prefix, paginated, and signed its objects.
 */
function s3Stub(): { fetchImpl: RemoteFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: RemoteFetch = (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers });
    const parsed = new URL(url);
    if (parsed.searchParams.get('list-type') === '2') {
      const token = parsed.searchParams.get('continuation-token');
      return Promise.resolve(xmlResponse(token === 'page-2' ? PAGE_TWO : PAGE_ONE));
    }
    // Path-style addressing puts the bucket in the path; virtual-host addressing does
    // not, so both spellings of the same key have to land on the same entry.
    const key = decodeURIComponent(parsed.pathname)
      .replace(/^\/corpus\//, '/')
      .replace(/^\/+/, '');
    const body = OBJECT_BODIES[key];
    return Promise.resolve(body === undefined ? xmlResponse('missing', 404) : xmlResponse(body));
  };
  return { fetchImpl, requests };
}

function s3Connector(options: { glob?: string | null } = {}): {
  connector: S3Connector;
  requests: RecordedRequest[];
} {
  const stub = s3Stub();
  const connector = new S3Connector('s3://corpus/docs', {
    ...options,
    fetchImpl: stub.fetchImpl,
    env: AWS_ENVIRONMENT,
    now: () => FIXED_NOW,
  });
  return { connector, requests: stub.requests };
}

describe('S3Connector documents', () => {
  it('pages through the listing and sorts by docId', async () => {
    const { connector, requests } = s3Connector();

    const documents = await connector.documents();

    expect(documents.map((document) => document.docId)).toEqual([
      'a&b.md',
      'b.md',
      'c.md',
      'nested/d.md',
    ]);
    // Two list calls: the first page is truncated, the second is not.
    expect(requests.filter((request) => request.url.includes('list-type=2'))).toHaveLength(2);
  });

  it('names every object with its own s3 uri and the bucket key', async () => {
    const { connector } = s3Connector();

    const documents = await connector.documents();

    expect(at(documents, 0).uri).toBe('s3://corpus/docs/a&b.md');
    expect(at(documents, 0).text).toBe('ampersand');
  });

  it('carries path, suffix, etag and lastModified as metadata', async () => {
    const { connector } = s3Connector();

    const documents = await connector.documents();
    const nested = documents.find((document) => document.docId === 'nested/d.md');

    expect(at(documents, 0).metadata).toEqual({
      path: 'a&b.md',
      suffix: '.md',
      etag: 'etag-ab',
      lastModified: '2026-01-01T00:00:00.000Z',
    });
    expect(nested?.metadata.suffix).toBe('.md');
  });

  it('skips the prefix placeholder key', async () => {
    const { connector } = s3Connector();

    const documents = await connector.documents();

    expect(documents.map((document) => document.docId)).not.toContain('');
  });

  it('lists under the source prefix, not the bucket root', async () => {
    const { connector, requests } = s3Connector();

    await connector.documents();

    const listing = requests.find((request) => request.url.includes('list-type=2'));
    expect(new URL(listing?.url ?? '').searchParams.get('prefix')).toBe('docs/');
  });

  it('signs every request as s3 with the configured region', async () => {
    const { connector, requests } = s3Connector();

    await connector.documents();

    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(request.headers.authorization).toContain('/us-east-1/s3/aws4_request');
      expect(request.headers['x-amz-date']).toBe('20261102T051711Z');
    }
  });

  it('filters keys by the glob, relative to the prefix', async () => {
    const { connector } = s3Connector({ glob: '**/*.md' });

    const documents = await connector.documents();

    expect(documents.map((document) => document.docId)).toEqual([
      'a&b.md',
      'b.md',
      'c.md',
      'nested/d.md',
    ]);
  });

  it('matches a single-star glob within one segment of the key', async () => {
    const { connector } = s3Connector({ glob: '*.md' });

    const documents = await connector.documents();

    expect(documents.map((document) => document.docId)).toEqual(['a&b.md', 'b.md', 'c.md']);
  });

  it('returns nothing when no key matches', async () => {
    const { connector } = s3Connector({ glob: '*.rst' });

    expect(await connector.documents()).toEqual([]);
  });

  it('is idempotent across two reads', async () => {
    const { connector } = s3Connector();

    const first = await connector.documents();
    const second = await connector.documents();

    expect(second.map((document) => document.docId)).toEqual(
      first.map((document) => document.docId),
    );
  });

  it('closes without complaint, twice', async () => {
    const { connector } = s3Connector();

    await expect(connector.close()).resolves.toBeUndefined();
    await expect(connector.close()).resolves.toBeUndefined();
  });
});

describe('S3Connector configuration', () => {
  it('refuses a uri that is not an s3 uri', () => {
    expect(() => new S3Connector('https://example.com/corpus', { env: AWS_ENVIRONMENT })).toThrow(
      /must be an absolute 's3:\/\/<bucket>\[\/<prefix>\]' uri/,
    );
  });

  it('refuses a uri with no bucket', () => {
    expect(() => new S3Connector('s3:///prefix', { env: AWS_ENVIRONMENT })).toThrow(
      ConfigurationError,
    );
  });

  it('requires a region', () => {
    const env = {
      AWS_ACCESS_KEY_ID: AWS_ENVIRONMENT.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: AWS_ENVIRONMENT.AWS_SECRET_ACCESS_KEY,
    };

    expect(() => new S3Connector('s3://corpus', { env })).toThrow(/AWS_REGION/);
    expect(() => new S3Connector('s3://corpus', { env })).toThrow(/AWS_DEFAULT_REGION/);
  });

  it('accepts AWS_DEFAULT_REGION when AWS_REGION is absent', async () => {
    const stub = s3Stub();
    const connector = new S3Connector('s3://corpus/docs', {
      fetchImpl: stub.fetchImpl,
      env: {
        AWS_ACCESS_KEY_ID: AWS_ENVIRONMENT.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: AWS_ENVIRONMENT.AWS_SECRET_ACCESS_KEY,
        AWS_DEFAULT_REGION: 'eu-west-1',
      },
    });

    await connector.documents();

    const listing = stub.requests[0];
    expect(listing?.headers.authorization).toContain('/eu-west-1/s3/aws4_request');
  });

  it('requires credentials', () => {
    expect(() => new S3Connector('s3://corpus', { env: { AWS_REGION: 'us-east-1' } })).toThrow(
      /AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/,
    );
  });

  it('signs a session token when one is present', async () => {
    const stub = s3Stub();
    const connector = new S3Connector('s3://corpus/docs', {
      fetchImpl: stub.fetchImpl,
      env: { ...AWS_ENVIRONMENT, AWS_SESSION_TOKEN: 'session-token' },
    });

    await connector.documents();

    expect(stub.requests[0]?.headers['x-amz-security-token']).toBe('session-token');
  });

  it('uses path-style addressing when a custom endpoint is set', async () => {
    const stub = s3Stub();
    const connector = new S3Connector('s3://corpus/docs', {
      fetchImpl: stub.fetchImpl,
      env: { ...AWS_ENVIRONMENT, AWS_ENDPOINT_URL_S3: 'http://localhost:9000' },
    });

    await connector.documents();

    expect(new URL(stub.requests[0]?.url ?? '').pathname).toBe('/corpus/');
  });

  it('strips trailing slashes from a custom endpoint', async () => {
    const stub = s3Stub();
    const connector = new S3Connector('s3://corpus/docs', {
      fetchImpl: stub.fetchImpl,
      env: { ...AWS_ENVIRONMENT, AWS_ENDPOINT_URL_S3: 'http://localhost:9000//' },
    });

    await connector.documents();

    expect(new URL(stub.requests[0]?.url ?? '').pathname).toBe('/corpus/');
  });

  it('refuses a document over the size limit', async () => {
    const oversize: RemoteResponse = {
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name.toLowerCase() === 'content-length' ? String(11 * 1024 * 1024) : null),
      },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
    const connector = new S3Connector('s3://corpus/docs', {
      fetchImpl: () => Promise.resolve(oversize),
      env: AWS_ENVIRONMENT,
    });

    await expect(connector.documents()).rejects.toThrow(/over the 10485760-byte limit/);
  });

  it('refuses a streamed body that grows past the size limit', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const connector = new S3Connector('s3://corpus/docs', {
      fetchImpl: () => Promise.resolve(streamedResponse(new Array<Uint8Array>(11).fill(chunk))),
      env: AWS_ENVIRONMENT,
    });

    await expect(connector.documents()).rejects.toThrow(/10485760-byte document limit/);
  });

  it('refuses a non-2xx response', async () => {
    const connector = new S3Connector('s3://corpus/docs', {
      fetchImpl: () => Promise.resolve(xmlResponse('denied', 403)),
      env: AWS_ENVIRONMENT,
    });

    await expect(connector.documents()).rejects.toThrow(/returned HTTP 403: denied/);
  });
});

describe('HttpConnector', () => {
  it('yields exactly one document', async () => {
    const connector = new HttpConnector('https://example.com/guide/intro.md', {
      fetchImpl: textFetch('# Intro'),
    });

    const documents = await connector.documents();

    expect(documents).toHaveLength(1);
    expect(at(documents, 0).docId).toBe('intro.md');
    expect(at(documents, 0).uri).toBe('https://example.com/guide/intro.md');
    expect(at(documents, 0).text).toBe('# Intro');
    expect(at(documents, 0).metadata).toEqual({ path: 'intro.md', suffix: '.md' });
  });

  it('is kind http', () => {
    expect(
      new HttpConnector('https://example.com/a.md', { fetchImpl: textFetch('body') }).kind,
    ).toBe('http');
  });

  it('falls back to index for a url with no path segment', async () => {
    const connector = new HttpConnector('https://example.com/', { fetchImpl: textFetch('home') });

    const documents = await connector.documents();

    expect(at(documents, 0).docId).toBe('index');
    expect(at(documents, 0).metadata.suffix).toBe('');
  });

  it('ignores a trailing slash when naming the document', async () => {
    const connector = new HttpConnector('https://example.com/guide/', {
      fetchImpl: textFetch('body'),
    });

    expect(at(await connector.documents(), 0).docId).toBe('guide');
  });

  it('refuses a glob, because an http source is one document', () => {
    expect(() => new HttpConnector('https://example.com/a.md', { glob: '*.md' })).toThrow(
      /takes no 'glob': an http source is exactly one document/,
    );
  });

  it('refuses a uri that is not http(s)', () => {
    expect(() => new HttpConnector('file:///tmp/a.md')).toThrow(
      /must be an absolute 'http:\/\/' or 'https:\/\/' url/,
    );
  });

  it('refuses a non-2xx response', async () => {
    const connector = new HttpConnector('https://example.com/a.md', {
      fetchImpl: textFetch('gone', 404),
    });

    await expect(connector.documents()).rejects.toThrow(/returned HTTP 404: gone/);
  });

  it('refuses a body that is not UTF-8', async () => {
    const invalid: RemoteResponse = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(Uint8Array.from([0xff, 0xfe]).buffer as ArrayBuffer),
    };
    const connector = new HttpConnector('https://example.com/a.md', {
      fetchImpl: () => Promise.resolve(invalid),
    });

    await expect(connector.documents()).rejects.toThrow(/is not valid UTF-8/);
  });

  it('refuses a document over the size limit', async () => {
    const oversize: RemoteResponse = {
      ok: true,
      status: 200,
      headers: {
        get: (name) => (name.toLowerCase() === 'content-length' ? String(11 * 1024 * 1024) : null),
      },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    };
    const connector = new HttpConnector('https://example.com/a.md', {
      fetchImpl: () => Promise.resolve(oversize),
    });

    await expect(connector.documents()).rejects.toThrow(/over the 10485760-byte limit/);
  });
});
