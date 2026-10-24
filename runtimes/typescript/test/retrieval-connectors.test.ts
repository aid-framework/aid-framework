import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  FeatureDeferredError,
  FileConnector,
  openConnector,
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

  for (const kind of ['s3', 'http', 'db', 'mcp'] as const) {
    it(`defers a ${kind} source rather than indexing an empty corpus`, () => {
      const spec = new SourceSpec({ kind, uri: 'ignored' });

      expect(() => openConnector(spec)).toThrow(FeatureDeferredError);
      expect(() => openConnector(spec)).toThrow(new RegExp(`source kind '${kind}' is declared`));
    });
  }
});
