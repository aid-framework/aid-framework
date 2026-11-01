/**
 * `aid migrate` is a pure tree transform: a spec in, one SQL file out. So the assertions
 * are about the file's bytes, the action that was reported, and the exit code.
 *
 * Two of these tests are load-bearing beyond the command. The first is the drift test:
 * the table DDL exists three times now -- twice in the runtimes, once here -- and a copy
 * nobody compares is a copy that silently rots, which would send an operator a schema the
 * runtime's own `INSERT` cannot satisfy. The second is the ownership test: `migrations/`
 * is a directory people keep real history in, so the command must refuse a file it did
 * not write rather than replace it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AID_CHUNKS_TABLE, MIGRATION_MARKER } from '../src/commands/migrate.js';
import type { Run } from './helpers.js';
import { aid, diagnosticsOf, EXAMPLE_SPEC, project, REPO_ROOT } from './helpers.js';

const FILE = 'migrations/aid-schema.sql';

/**
 * Replace one top-level section, keeping the rest of the committed spec.
 *
 * The example is the fixture, as it is for every other command's tests; rewriting a whole
 * spec per case would be a second thing that can drift out of schema.
 */
function replaceSection(spec: string, name: string, body: string): string {
  const lines = spec.split('\n');
  const start = lines.indexOf(`${name}:`);
  if (start < 0) throw new Error(`the example spec has no \`${name}\` section`);
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^[ \t]/.test(lines[end] ?? ''))) end += 1;
  return [...lines.slice(0, start + 1), ...body.split('\n'), '', ...lines.slice(end)].join('\n');
}

/** Add an entry to a section that already has the ones the example references. */
function appendToSection(spec: string, name: string, body: string): string {
  const lines = spec.split('\n');
  const start = lines.indexOf(`${name}:`);
  if (start < 0) throw new Error(`the example spec has no \`${name}\` section`);
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^[ \t]/.test(lines[end] ?? ''))) end += 1;
  while (end > start + 1 && lines[end - 1] === '') end -= 1;
  return [...lines.slice(0, end), ...body.split('\n'), '', ...lines.slice(end)].join('\n');
}

function pgvectorStore(id = 'handbook', dimension: number | undefined = 1536): string {
  return [
    `  ${id}:`,
    '    kind: pgvector',
    '    uri: env:PGVECTOR_URL',
    ...(dimension === undefined ? [] : [`    dimensions: ${dimension}`]),
  ].join('\n');
}

function retriever(id: string, metric: string, store = 'handbook', embedModel = 'embed'): string {
  return [
    `  ${id}:`,
    '    source:',
    '      kind: file',
    '      uri: ./docs',
    '      glob: "**/*.md"',
    '    chunking:',
    '      strategy: recursive',
    '      size: 800',
    '      overlap: 100',
    '      keepMetadata: [path]',
    `    embedModel: ${embedModel}`,
    `    store: ${store}`,
    '    index:',
    `      metric: ${metric}`,
    '      hybrid: false',
    '    topK: 5',
    '    refresh:',
    '      mode: full',
  ].join('\n');
}

interface SpecOptions {
  readonly stores?: string;
  readonly retrievers?: string;
}

/** The committed example, with its store and retriever sections swapped out. */
function spec(options: SpecOptions = {}): string {
  let text = EXAMPLE_SPEC;
  if (options.stores !== undefined) text = replaceSection(text, 'stores', options.stores);
  if (options.retrievers !== undefined) {
    text = replaceSection(text, 'retrievers', options.retrievers);
  }
  return text;
}

function json(run: Run): Record<string, unknown> {
  return run.json();
}

describe('aid migrate', () => {
  it('is listed, and documents its flags', () => {
    const made = project();
    try {
      expect(aid(made, ['help']).stdout).toContain('migrate');
      const help = aid(made, ['migrate', '-h']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('--out');
      expect(help.stdout).toContain('--check');
      expect(help.stdout).toContain('--dry-run');
    } finally {
      made.close();
    }
  });

  it('needs nothing when no store asks for a schema', () => {
    const made = project();
    try {
      const run = aid(made, ['migrate', '--json']);
      expect(run.code).toBe(0);
      expect(json(run).action).toBe('none');
      expect(json(run).written).toBe(false);
      expect(made.exists(FILE)).toBe(false);
      expect(run.stdout).not.toContain('CREATE TABLE');
    } finally {
      made.close();
    }
  });

  it('creates the shared table and pins a declared dimension', () => {
    const made = project(spec({ stores: pgvectorStore() }));
    try {
      const run = aid(made, ['migrate', '--json']);
      expect(run.code).toBe(0);
      expect(json(run).action).toBe('created');
      expect(json(run).written).toBe(true);
      expect(json(run).dimension).toBe(1536);
      expect(made.read(FILE)).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
      expect(made.read(FILE)).toContain('embedding vector(1536) NOT NULL');
      expect(made.read(FILE).startsWith(MIGRATION_MARKER)).toBe(true);
    } finally {
      made.close();
    }
  });

  it('pins the width the embedder resolves, when the store declares none', () => {
    const made = project(spec({ stores: pgvectorStore('handbook', undefined) }));
    try {
      const run = aid(made, ['migrate', '--json']);
      expect(run.code).toBe(0);
      // The normalize gate resolves the width from the embedding model, so the column is
      // still pinned -- the one case where leaving it bare would have been a mistake.
      expect(json(run).dimension).toBe(1536);
      expect(made.read(FILE)).toContain('embedding vector(1536) NOT NULL');
    } finally {
      made.close();
    }
  });

  it('warns, and stays dimensionless, when two stores disagree', () => {
    // A second embedder the catalog does not know, which is the only way both widths get
    // past the normalize gate: with one side undeclared there is nothing to compare.
    const second = [
      '  embed_small:',
      '    provider: fake',
      '    modelId: fake-embed-small',
      '    capabilities: [embeddings]',
    ].join('\n');
    const stores = `${pgvectorStore('handbook', 1536)}\n${pgvectorStore('small', 768)}`;
    const made = project(
      appendToSection(
        spec({
          stores,
          retrievers: `${retriever('handbook', 'cosine', 'handbook')}\n\n${retriever('small', 'l2', 'small', 'embed_small')}`,
        }),
        'models',
        second,
      ),
    );
    try {
      const run = aid(made, ['migrate', '--json']);
      expect(run.code).toBe(0);
      expect(json(run).dimension).toBeNull();
      expect(made.read(FILE)).toContain('embedding vector NOT NULL');
      const diagnostics = diagnosticsOf(run);
      expect(diagnostics.map((entry) => entry.code)).toContain('cli/migrate-dimension-ambiguous');
      expect(diagnostics[0]?.severity).toBe('warning');
      expect(diagnostics[0]?.message).toContain('1536, 768');
    } finally {
      made.close();
    }
  });

  it('writes one index per metric a pgvector-backed retriever searches with', () => {
    const made = project(
      spec({
        stores: pgvectorStore(),
        retrievers: `${retriever('handbook', 'l2')}\n\n${retriever('extra_cosine', 'cosine')}\n\n${retriever('extra_l2', 'l2')}`,
      }),
    );
    try {
      const run = aid(made, ['migrate', '--json']);
      expect(run.code).toBe(0);
      expect(json(run).indexes).toEqual([
        { name: 'aid_chunks_embedding_cosine_idx', metric: 'cosine' },
        { name: 'aid_chunks_embedding_l2_idx', metric: 'l2' },
      ]);
      const sql = made.read(FILE);
      expect(sql).toContain('USING hnsw (embedding vector_cosine_ops)');
      expect(sql).toContain('USING hnsw (embedding vector_l2_ops)');
      expect(sql).not.toContain('vector_ip_ops');
      expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(2);
    } finally {
      made.close();
    }
  });

  it('writes no index for a retriever that does not read pgvector', () => {
    const made = project(
      spec({
        stores: `${pgvectorStore('archive')}\n  handbook:\n    kind: memory\n    dimensions: 1536`,
        retrievers: `${retriever('handbook', 'cosine', 'handbook')}\n\n${retriever('extra', 'l2', 'handbook')}`,
      }),
    );
    try {
      const run = aid(made, ['migrate', '--json']);
      expect(run.code).toBe(0);
      expect(json(run).indexes).toEqual([]);
      expect(made.read(FILE)).not.toContain('CREATE INDEX');
    } finally {
      made.close();
    }
  });

  it('honours --dry-run without touching the tree', () => {
    const made = project(spec({ stores: pgvectorStore() }));
    try {
      const run = aid(made, ['migrate', '--dry-run', '--json']);
      expect(run.code).toBe(0);
      expect(json(run).action).toBe('created');
      expect(json(run).written).toBe(false);
      expect(made.exists(FILE)).toBe(false);
      expect(aid(made, ['migrate', '--dry-run']).stdout).toContain('would be created');
    } finally {
      made.close();
    }
  });

  it('fails --check while the file is missing, and writes nothing', () => {
    const made = project(spec({ stores: pgvectorStore() }));
    try {
      const run = aid(made, ['migrate', '--check', '--json']);
      expect(run.code).toBe(1);
      expect(json(run).action).toBe('created');
      expect(json(run).written).toBe(false);
      expect(made.exists(FILE)).toBe(false);
    } finally {
      made.close();
    }
  });

  it('passes --check once the file matches, and is unchanged on a re-run', () => {
    const made = project(spec({ stores: pgvectorStore() }));
    try {
      expect(aid(made, ['migrate']).code).toBe(0);
      const again = aid(made, ['migrate', '--json']);
      expect(again.code).toBe(0);
      expect(json(again).action).toBe('unchanged');
      expect(json(again).written).toBe(false);

      const checked = aid(made, ['migrate', '--check', '--json']);
      expect(checked.code).toBe(0);
      expect(json(checked).action).toBe('unchanged');
    } finally {
      made.close();
    }
  });

  it('fails --check when the spec moved on', () => {
    const made = project(spec({ stores: pgvectorStore() }));
    try {
      expect(aid(made, ['migrate']).code).toBe(0);
      made.setSpec(
        spec({
          stores: pgvectorStore(),
          retrievers: `${retriever('handbook', 'l2')}`,
        }),
      );
      const run = aid(made, ['migrate', '--check', '--json']);
      expect(run.code).toBe(1);
      expect(json(run).action).toBe('updated');
      expect(made.read(FILE)).toContain('vector_cosine_ops');

      const applied = aid(made, ['migrate', '--json']);
      expect(applied.code).toBe(0);
      expect(json(applied).action).toBe('updated');
      expect(made.read(FILE)).toContain('vector_l2_ops');
      expect(made.read(FILE)).not.toContain('vector_cosine_ops');
    } finally {
      made.close();
    }
  });

  it('refuses a file it did not write', () => {
    const made = project(spec({ stores: pgvectorStore() }));
    try {
      const handWritten = '-- 0001_init.sql\nCREATE TABLE mine (id integer);\n';
      made.write(FILE, handWritten);
      const run = aid(made, ['migrate', '--json']);
      expect(run.code).toBe(1);
      expect(json(run).action).toBe('none');
      expect(diagnosticsOf(run).map((entry) => entry.code)).toContain('cli/refusing-to-overwrite');
      expect(made.read(FILE)).toBe(handWritten);
    } finally {
      made.close();
    }
  });

  it('removes its own file when the last pgvector store goes away', () => {
    const made = project(spec({ stores: pgvectorStore() }));
    try {
      expect(aid(made, ['migrate']).code).toBe(0);
      expect(made.exists(FILE)).toBe(true);

      made.setSpec(EXAMPLE_SPEC);
      const removed = aid(made, ['migrate', '--json']);
      expect(removed.code).toBe(0);
      expect(json(removed).action).toBe('removed');
      expect(made.exists(FILE)).toBe(false);

      expect(json(aid(made, ['migrate', '--json'])).action).toBe('none');
    } finally {
      made.close();
    }
  });

  it('accepts --out, and refuses one that leaves the project', () => {
    const made = project(spec({ stores: pgvectorStore() }));
    try {
      const run = aid(made, ['migrate', '--out', 'db', '--json']);
      expect(run.code).toBe(0);
      expect(json(run).path).toBe('db/aid-schema.sql');
      expect(made.exists('db/aid-schema.sql')).toBe(true);

      const outside = aid(made, ['migrate', '--out', '../aid-migrate-escaped', '--json']);
      expect(outside.code).toBe(2);
      expect(diagnosticsOf(outside).map((entry) => entry.code)).toContain(
        'cli/migrate-out-escapes',
      );
      expect(existsSync(join(made.root, '..', 'aid-migrate-escaped'))).toBe(false);
    } finally {
      made.close();
    }
  });
});

/**
 * The command restates the runtimes' DDL because neither publishes it as a value the CLI
 * can import. This is the comparison that keeps the third copy honest: both runtimes, read
 * from source, must agree with {@link AID_CHUNKS_TABLE} apart from the embedding type,
 * which `aid migrate` widens to pin a dimension and the runtimes leave bare.
 */
describe('the emitted table matches the runtimes', () => {
  function bodyOf(sql: string): string {
    const match = /CREATE TABLE IF NOT EXISTS aid_chunks \(([\s\S]*?)\n\)/.exec(sql);
    const body = match?.[1];
    if (body === undefined) throw new Error('no aid_chunks table in the source');
    return body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join('\n')
      .replace(
        /embedding (vector(?:\(\d+\))?|\{embedding\}) NOT NULL/,
        'embedding {embedding} NOT NULL',
      );
  }

  const sources = {
    python: readFileSync(
      join(REPO_ROOT, 'runtimes', 'python', 'src', 'aid_runtime', 'retrieval', 'pgvector.py'),
      'utf8',
    ),
    typescript: readFileSync(
      join(REPO_ROOT, 'runtimes', 'typescript', 'src', 'retrieval', 'pgvector.ts'),
      'utf8',
    ),
  };

  for (const [runtime, source] of Object.entries(sources)) {
    it(`agrees with the ${runtime} runtime`, () => {
      expect(bodyOf(sources.python)).toBe(bodyOf(sources.typescript));
      expect(bodyOf(source)).toBe(bodyOf(AID_CHUNKS_TABLE));
    });
  }
});
