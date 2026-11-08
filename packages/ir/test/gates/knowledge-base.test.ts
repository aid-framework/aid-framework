import { describe, expect, it } from 'vitest';

import { IR_DIAGNOSTIC_CODES, runGates } from '../../src/index.js';
import {
  buildFixture,
  byId,
  codesOf,
  first,
  gateFixture,
  mutateIR,
  onlyDiagnosticWith,
} from '../helpers.js';

const POSITIVE = 'knowledge-base.yaml';

function gate(ir: ReturnType<typeof mutateIR>) {
  return runGates(ir).byGate['retrievers/knowledge-bases'];
}

describe('retrievers/knowledge-bases', () => {
  it('accepts a retriever bound to a managed base on the engine\u2019s own cloud', () => {
    expect(gateFixture(POSITIVE).byGate['retrievers/knowledge-bases'].diagnostics).toEqual([]);
  });

  it('refuses an embedModel that is not a declared embedding alias', () => {
    const ir = mutateIR(POSITIVE);
    first(ir.knowledgeBases).embedModel = 'missing';
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.knowledgeBaseEmbedder,
    );
    expect(diagnostic.path).toEqual(['knowledgeBases', 'handbook', 'embedModel']);
    expect(diagnostic.message).toContain('not a declared embedding alias');
    expect(diagnostic.hint).toContain('titan_embed');
  });

  it('refuses an embedder from the other cloud, naming both the engine and the model', () => {
    const ir = mutateIR(POSITIVE);
    first(ir.embeddings).provider = 'google';
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.knowledgeBaseEmbedder,
    );
    expect(diagnostic.message).toContain('engine "aws-bedrock" can only embed with bedrock');
    expect(diagnostic.message).toContain('"titan_embed" is a "google" model');
    expect(diagnostic.hint).toContain('failed ingestion job');
  });

  it('refuses a bedrock embedder on the vertex engine, symmetrically', () => {
    const ir = mutateIR(POSITIVE);
    first(ir.knowledgeBases).engine = 'vertex-rag';
    expect(codesOf(gate(ir).diagnostics)).toEqual([IR_DIAGNOSTIC_CODES.knowledgeBaseEmbedder]);
  });

  it('accepts a google or gemini embedder on the vertex engine', () => {
    for (const provider of ['google', 'gemini'] as const) {
      const ir = mutateIR(POSITIVE);
      first(ir.knowledgeBases).engine = 'vertex-rag';
      first(ir.embeddings).provider = provider;
      expect(gate(ir).diagnostics).toEqual([]);
    }
  });

  it('refuses a retriever that names a knowledge base the IR does not carry', () => {
    const ir = mutateIR(POSITIVE);
    const retriever = first(ir.retrievers);
    if (retriever.kind !== 'managed') throw new Error('fixture retriever is not managed');
    retriever.knowledgeBase = 'missing';
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.knowledgeBaseRefUnresolved,
    );
    expect(diagnostic.path).toEqual(['retrievers', 'docs', 'knowledgeBase']);
    expect(diagnostic.hint).toContain('handbook');
  });

  it('refuses filters rather than silently retrieving the unfiltered corpus', () => {
    const ir = mutateIR(POSITIVE);
    const retriever = first(ir.retrievers);
    if (retriever.kind !== 'managed') throw new Error('fixture retriever is not managed');
    retriever.filters = ['tenant = "acme"'];
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.knowledgeBaseFilter,
    );
    expect(diagnostic.path).toEqual(['retrievers', 'docs', 'filters']);
    expect(diagnostic.message).toContain('not forwarded in this version');
    expect(diagnostic.hint).toContain('whole corpus');
  });

  it('refuses a reranker other than the runtime\u2019s lexical one', () => {
    const ir = mutateIR(POSITIVE);
    const retriever = first(ir.retrievers);
    if (retriever.kind !== 'managed') throw new Error('fixture retriever is not managed');
    retriever.rerank = { model: 'cohere-rerank', topN: 2 };
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.knowledgeBaseRerank,
    );
    expect(diagnostic.path).toEqual(['retrievers', 'docs', 'rerank']);
    expect(diagnostic.hint).toContain('lexical');
  });

  it('leaves a local retriever to the referential gate', () => {
    const built = buildFixture('retrieval.yaml');
    expect(runGates(built.ir).byGate['retrievers/knowledge-bases'].diagnostics).toEqual([]);
  });

  it('is registered under the plan\u2019s gate id', () => {
    const { byGate } = gateFixture(POSITIVE);
    expect(Object.keys(byGate)).toContain('retrievers/knowledge-bases');
  });

  it('names the base by id in every diagnostic', () => {
    const ir = mutateIR(POSITIVE);
    byId(ir.knowledgeBases, 'handbook').embedModel = 'missing';
    expect(gate(ir).diagnostics[0]?.message).toContain('"handbook"');
  });
});
