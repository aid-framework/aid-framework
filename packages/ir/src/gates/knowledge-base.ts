/**
 * Managed knowledge bases — one gate.
 *
 * A base hands ingestion, chunking, embedding, the vector store and the index to the
 * engine, so the checks the rest of this layer makes about a local corpus do not apply:
 * there is no store width to reconcile and no connector to open. What is left is
 * everything the *engine* is asked to do on this app's behalf, because each of those
 * fails server-side — after the corpus has already been uploaded — rather than in the
 * plan. The spec layer has already refused the surface mistakes it can see alone (an
 * `aws-bedrock` base reading a `gcs` bucket, an `existing` store with no `arn`, a
 * managed retriever that redeclares `source` or `refresh`). This gate resolves what
 * needs the packed IR: the embedder alias, the retriever's base, the reranker and the
 * filter contract.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR, KnowledgeBaseEngine, Provider, RetrieverShape } from '../shapes.js';
import { isManagedRetriever } from '../shapes.js';
import { type GateOptions, type GateResult, NO_SUPPRESSIONS, reporter } from './contract.js';

/**
 * The embedder providers each managed engine can use.
 *
 * A knowledge base embeds its own corpus, with a model on its own cloud: Bedrock cannot
 * call a Vertex embedding model, and a Vertex corpus cannot be built with Titan. A
 * mismatch applies cleanly and then fails the first ingestion job, in the engine, after
 * the corpus has been uploaded.
 */
const ENGINE_EMBEDDER_PROVIDERS: Readonly<Record<KnowledgeBaseEngine, readonly Provider[]>> = {
  'aws-bedrock': ['bedrock'],
  'vertex-rag': ['google', 'gemini'],
};

export function knowledgeBaseGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const embeddings = new Map(ir.embeddings.map((embedding) => [embedding.id, embedding]));
  const bases = new Map(ir.knowledgeBases.map((base) => [base.id, base]));

  for (const base of ir.knowledgeBases) {
    const embedding = embeddings.get(base.embedModel);
    if (embedding === undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.knowledgeBaseEmbedder,
          message: `the knowledge-base gate rejected "${base.id}": embedModel names "${base.embedModel}", which is not a declared embedding alias`,
          path: ['knowledgeBases', base.id, 'embedModel'],
          hint: `declared embeddings: ${[...embeddings.keys()].sort().join(', ') || 'none — a model must declare the "embeddings" capability'}`,
        }),
      );
      continue;
    }
    const allowed = ENGINE_EMBEDDER_PROVIDERS[base.engine];
    if (!allowed.includes(embedding.provider)) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.knowledgeBaseEmbedder,
          message: `the knowledge-base gate rejected "${base.id}": engine "${base.engine}" can only embed with ${allowed.join(' or ')}, but "${embedding.id}" is a "${embedding.provider}" model`,
          path: ['knowledgeBases', base.id, 'embedModel'],
          hint: 'name an embedding model on the engine\u2019s own cloud; the mismatch would surface as a failed ingestion job after the corpus was already uploaded',
        }),
      );
    }
  }

  for (const retriever of ir.retrievers) {
    if (!isManagedRetriever(retriever)) continue;
    reportManagedRetriever(retriever, bases, diagnostics, report);
  }

  return { diagnostics, suppressed: NO_SUPPRESSIONS };
}

/**
 * One retriever bound to a managed base.
 *
 * Filters are refused outright rather than forwarded. The spec's filter surface is a
 * list of expression strings, and only one of the two engines takes that shape: Bedrock
 * wants a structured filter document, and Vertex's expression semantics could not be
 * verified against a current API reference. Forwarding the string to one engine and
 * dropping it for the other would silently widen a tenant-scoped query to the whole
 * corpus, so v1 refuses the declaration instead. `knowledgeBases.<id>.filterable` still
 * matters: it is what the Bedrock deployment copies into its metadata sidecar.
 */
function reportManagedRetriever(
  retriever: Extract<RetrieverShape, { kind: 'managed' }>,
  bases: ReadonlyMap<string, { engine: KnowledgeBaseEngine }>,
  diagnostics: IrDiagnostic[],
  report: ReturnType<typeof reporter>,
): void {
  const path = ['retrievers', retriever.id];
  const base = bases.get(retriever.knowledgeBase);
  if (base === undefined) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.knowledgeBaseRefUnresolved,
        message: `the knowledge-base gate rejected "${retriever.id}": knowledgeBase names "${retriever.knowledgeBase}", which is not a declared knowledge base`,
        path: [...path, 'knowledgeBase'],
        hint: `declared knowledge bases: ${[...bases.keys()].sort().join(', ') || 'none'}`,
      }),
    );
  }

  if ((retriever.filters ?? []).length > 0) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.knowledgeBaseFilter,
        message: `the knowledge-base gate rejected "${retriever.id}": it declares ${(retriever.filters ?? []).length} filter(s), and a managed retriever's filter is not forwarded in this version`,
        path: [...path, 'filters'],
        hint: 'remove the filters; Bedrock takes a structured filter document and the Vertex expression semantics are unverified, so forwarding one and dropping the other would retrieve the whole corpus',
      }),
    );
  }

  if (retriever.rerank !== undefined && !retriever.rerank.model.toLowerCase().includes('lexical')) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.knowledgeBaseRerank,
        message: `the knowledge-base gate rejected "${retriever.id}": it reranks with "${retriever.rerank.model}", and the runtime's only reranker is lexical`,
        path: [...path, 'rerank'],
        hint: 'name a reranker that says "lexical", or drop rerank; the engine returns chunks and this runtime reranks them itself',
      }),
    );
  }
}
