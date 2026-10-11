/**
 * The path a retrieval spec takes end to end: spec acceptance, the §7.2 shapes it
 * populates, and the gates that decide whether a target can serve it. Layer 1 owns
 * this contract; the runtime that executes it is layer 2's, so nothing here reaches
 * for a network, a key, or a database.
 */

import { checkSpecText } from '@aid/spec';
import { describe, expect, it } from 'vitest';

import { runGates } from '../src/index.js';
import { buildFixture, byId, first, fixtureText } from './helpers.js';

const SPEC = 'retrieval.yaml';

/** A target that genuinely serves retrieval: the baseline the refusal is measured against. */
const RETRIEVAL_TARGET = {
  'py-fastapi': ['http-trigger', 'json-schema', 'otel', 'tool-calling', 'embeddings', 'rerank'],
};

/** Phase 0's declaration, which implements neither embedding nor reranking. */
const PYTHON = { 'py-fastapi': ['http-trigger', 'json-schema', 'otel', 'tool-calling'] };

describe('retrieval surface, spec to IR to gates', () => {
  it('accepts the retrieval spec at the spec layer', () => {
    const checked = checkSpecText(fixtureText(SPEC), { file: SPEC });

    expect(checked.ok).toBe(true);
    expect(checked.diagnostics).toEqual([]);
  });

  it('builds memory as the default store and pgvector as a declarable one', () => {
    const { ir } = buildFixture(SPEC);

    expect(ir.stores.map((store) => store.id)).toEqual(['docs', 'docs_pg']);
    expect(byId(ir.stores, 'docs').kind).toBe('memory');
    expect(byId(ir.stores, 'docs').uri).toBeUndefined();
    expect(byId(ir.stores, 'docs_pg')).toMatchObject({
      kind: 'pgvector',
      uri: 'env:PGVECTOR_URL',
      dimensions: 1536,
    });
  });

  it('derives the embedding shape from the model that declares embeddings', () => {
    expect(buildFixture(SPEC).ir.embeddings).toEqual([
      {
        id: 'embed',
        modelId: 'text-embedding-3-small',
        provider: 'fake',
        dimensions: 1536,
        costProfile: { inputPerMTok: 0.02, outputPerMTok: 0 },
        traits: [],
      },
    ]);
  });

  it('resolves a retriever to its store, embedder, chunking and index plan', () => {
    const retriever = first(buildFixture(SPEC).ir.retrievers);

    expect(retriever.id).toBe('handbook');
    expect(retriever.source).toEqual({ kind: 'file', uri: './docs', glob: '**/*.md' });
    expect(retriever.chunking).toEqual({
      strategy: 'recursive',
      size: 800,
      overlap: 100,
      keepMetadata: ['path'],
    });
    expect(retriever.embedModel).toBe('embed');
    expect(retriever.store).toBe('docs');
    expect(retriever.index).toEqual({ metric: 'cosine', hybrid: true });
    expect(retriever.topK).toBe(5);
    expect(retriever.rerank).toEqual({ model: 'rerank', topN: 3 });
    expect(retriever.refresh).toEqual({ mode: 'full' });
    expect(retriever.traits).toEqual([{ name: 'citations' }]);
  });

  it('binds the retrieved context into the generating step', () => {
    const { steps } = first(buildFixture(SPEC).ir.pipelines);

    expect(steps[0]).toEqual({
      kind: 'retrieve',
      retriever: 'handbook',
      query: '{{event.question}}',
      as: 'context',
    });
    expect(steps[1]).toMatchObject({ kind: 'generate', context: 'context' });
  });

  it('carries the retrieval metric through to the eval that measures it', () => {
    const evaluation = byId(buildFixture(SPEC).ir.evals, 'retrieval_quality');

    expect(evaluation.metrics).toContainEqual({
      kind: 'retrieval',
      expectDocs: ['getting-started.md'],
      k: 3,
    });
    expect(evaluation.target).toMatchObject({ kind: 'pipeline', id: 'answer_question' });
  });

  it('requires exactly the capabilities the retrieval surface needs', () => {
    expect([...buildFixture(SPEC).ir.requiredCapabilities].sort()).toEqual([
      'embeddings',
      'http-trigger',
      'json-schema',
      'otel',
      'rerank',
    ]);
  });

  it('runs every gate clean for a target that serves retrieval', () => {
    const result = runGates(buildFixture(SPEC).ir, { targetCapabilities: RETRIEVAL_TARGET });

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails closed for a target that serves neither embedding nor reranking', () => {
    const result = runGates(buildFixture(SPEC).ir, { targetCapabilities: PYTHON });

    expect(result.ok).toBe(false);
    const text = result.diagnostics.map((diagnostic) => diagnostic.message).join('\n');
    expect(text).toContain('requires "embeddings", which this target does not declare');
    expect(text).toContain('requires "rerank", which this target does not declare');
  });
});
