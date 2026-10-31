/**
 * `app/generated/retrieval/**`: the retrievers a spec declares, as wiring.
 *
 * A retriever's source, chunking, embedModel, store, index and rerank travel as the
 * spec's own data -- three dict literals per retriever -- and the runtime's models
 * validate them when a binding is built. That is deliberate rather than lazy. A spec
 * payload has exactly one definition (the IR), so the generated module restates none of
 * it, and a declaration the runtime would refuse is refused at generation time by
 * `./validate.ts` instead of at the first request -- a class of failure no byte-level
 * test can see.
 *
 * Nothing here does work at import time. Importing the module to inspect it is free, no
 * store is constructed until `build_retriever` is called, and no vector-store driver is
 * imported at all until a store of that kind is actually built, so a bare install with
 * no extras can still import this. The ingest entry points beside it are what write a
 * corpus; this module only says where the pieces are.
 *
 * Everything here is wiring. What a corpus *means* -- which files are authoritative, how
 * passages should rank -- belongs to `app/business`, and the generator never writes it.
 */

import type { IR, RetrieverShape, Trait } from '@aid-framework/ir';

import { moduleName } from '../names.js';
import { INDENT, pythonNumber, pythonStatement, pythonString } from '../python.js';
import { assemble, dictBlock, HEADER, importBlock, importFrom } from '../template.js';
import { contractsPath } from './contracts.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { stageGuardrails, stageTable } from './guardrails.js';
import { orderedRetrievers } from './order.js';
import { require } from './require.js';
import { retrievalIngestFiles } from './retrievalIngest.js';
import { pythonDoc } from './text.js';

export const RETRIEVAL_INIT_PATH = `${GENERATED_ROOT}/retrieval/__init__.py`;
export const RETRIEVAL_BINDINGS_PATH = `${GENERATED_ROOT}/retrieval/bindings.py`;

/**
 * The citation contract, at the path the tool contracts already use.
 *
 * Derived through `contractsPath` rather than spelled out, so the two spellings of
 * `contracts/<module>.py` cannot drift apart.
 */
export const CITATIONS_CONTRACT_PATH = contractsPath('citations');

/** The module-level prefix one retriever's spec entries are emitted under. */
function constantName(retrieverId: string): string {
  return moduleName(retrieverId).toUpperCase();
}

/**
 * The app directory, as generated code reaches it.
 *
 * The same expression the generated eval modules reach their datasets with. A corpus
 * is resolved against the app this code belongs to, never against whatever directory
 * a process happened to start in: `open_connector` refuses to guess for exactly that
 * reason, so the generated code hands it an answer rather than a default.
 */
const APP_ROOT_LINE = 'APP_ROOT = str(Path(__file__).resolve().parents[2])';

const COMPREHENSION_BODY =
  'retriever_id: build_retriever(retriever_id, ledger=ledger) for retriever_id in _SPECS';

/**
 * Every retrieval artifact, or none.
 *
 * A spec that declares no retriever gets no `retrieval/` directory at all: an empty
 * bindings module and an empty ingest package would be files a reader has to open to
 * learn nothing, and the plan's file list is what `aid gen` reports and what the drift
 * check compares.
 */
export function emitRetrieval(ir: IR): EmittedFile[] {
  if (ir.retrievers.length === 0) return [];
  return [
    emitRetrievalInit(),
    emitRetrievalBindings(ir),
    emitCitationsContract(),
    ...retrievalIngestFiles(ir),
  ];
}

function emitRetrievalInit(): EmittedFile {
  return generated(
    RETRIEVAL_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The retrievers the spec declares, each bound to the embedding and store it ' +
          'names, and the ingest entry point that fills its index.',
      ),
      importFrom('.', ['bindings', 'ingest']),
      pythonStatement('__all__ = ', ['bindings', 'ingest']),
    ]),
  );
}

/**
 * The spec entries one retriever is bound from, as module constants.
 *
 * The retriever travels verbatim, `rerank.model` included: the runtime's
 * `reranker_for` matches its lexical marker against that name as the IR carries it --
 * the model *alias*, not the `modelId` behind it -- so rewriting it here would emit a
 * spec the runtime refuses at the first search. The validator reads the same string.
 *
 * The width is resolved here rather than in Python: the embedding declares it, or the
 * store does, and the validator has already refused a retriever where neither says. A
 * width that arrived from a lookup at run time would let a store accept vectors a later
 * run cannot compare against.
 */
/**
 * A spec entry with its traits lowered to names.
 *
 * The IR carries traits as `{name, value}` records, because a trait may carry a value;
 * the runtime's specs declare `traits: tuple[str, ...]`, because nothing in Phase 1 reads
 * one. Serialising the IR record straight through passes every byte-level golden, drift
 * and determinism test and then raises a pydantic `ValidationError` at the first
 * `build_binding` -- a run-time failure only a run can see.
 */
function specNames<T extends { traits: readonly Trait[] }>(
  spec: T,
): Omit<T, 'traits'> & { traits: string[] } {
  const { traits, ...rest } = spec;
  return { ...rest, traits: traits.map((trait) => trait.name) };
}

function bindingConstants(ir: IR, retriever: RetrieverShape): string {
  const name = constantName(retriever.id);
  const embedding = require(ir.embeddings.find(
    (entry) => entry.id === retriever.embedModel,
  ), `the '${retriever.embedModel}' embedding model the '${retriever.id}' retriever names`);
  const store = require(ir.stores.find(
    (entry) => entry.id === retriever.store,
  ), `the '${retriever.store}' store the '${retriever.id}' retriever names`);
  const dimensions = require(embedding.dimensions ??
    store.dimensions, `a vector width for the '${retriever.id}' retriever`);
  return [
    pythonStatement(`${name}_EMBEDDING: dict[str, Any] = `, specNames(embedding)),
    pythonStatement(`${name}_STORE: dict[str, Any] = `, specNames(store)),
    pythonStatement(`${name}_RETRIEVER: dict[str, Any] = `, specNames(retriever)),
    `${name}_DIMENSIONS: int = ${pythonNumber(dimensions)}`,
  ].join('\n');
}

function specTable(ir: IR): string {
  const entries = orderedRetrievers(ir).map((retriever) => {
    const name = constantName(retriever.id);
    return [
      `${INDENT}${pythonString(retriever.id)}: {`,
      `${INDENT}${INDENT}"dimensions": ${name}_DIMENSIONS,`,
      `${INDENT}${INDENT}"embedding": ${name}_EMBEDDING,`,
      `${INDENT}${INDENT}"retriever": ${name}_RETRIEVER,`,
      `${INDENT}${INDENT}"store": ${name}_STORE,`,
      `${INDENT}},`,
    ].join('\n');
  });
  return dictBlock('_SPECS: dict[str, dict[str, Any]] =', entries);
}

function buildBinding(): string {
  return [
    'def build_binding(retriever_id: str) -> RetrieverBinding:',
    pythonDoc(
      'One declared retriever in the form the runtime searches with: every alias ' +
        'resolved and the vector width recorded. Nothing is connected here, so this is ' +
        'safe to call where a store must not be opened.',
      INDENT,
    ),
    `${INDENT}declared = _SPECS.get(retriever_id)`,
    `${INDENT}if declared is None:`,
    `${INDENT}${INDENT}` +
      'raise ConfigurationError(f"retriever {retriever_id!r} is not declared in the spec")',
    `${INDENT}return binding_from_spec(`,
    `${INDENT}${INDENT}RetrieverSpec.model_validate(declared["retriever"]),`,
    `${INDENT}${INDENT}embedding=EmbeddingSpec.model_validate(declared["embedding"]),`,
    `${INDENT}${INDENT}store=VectorStoreSpec.model_validate(declared["store"]),`,
    `${INDENT}${INDENT}dimensions=declared["dimensions"],`,
    `${INDENT})`,
  ].join('\n');
}

function buildRetriever(ir: IR): string {
  // `guardrails` is a constructor seam the runtime already offers, so the retrieval stage
  // is enforced by the retriever itself rather than by every caller remembering to check.
  const guarded = stageGuardrails(ir, 'retrieval').length > 0;
  return [
    'def build_retriever(',
    `${INDENT}retriever_id: str,`,
    `${INDENT}*,`,
    `${INDENT}embedder: Embedder | None = None,`,
    `${INDENT}store: VectorStore | None = None,`,
    `${INDENT}reranker: Reranker | None = None,`,
    `${INDENT}ledger: CostLedger | None = None,`,
    ') -> Retriever:',
    pythonDoc(
      'One retriever, with its embedder, store and reranker built from the spec. A ' +
        'seam can be supplied instead of built, which is how a test runs a retriever ' +
        'against the fake embedder and an in-memory store, or how a caller shares the ' +
        'process cost ledger. The store is constructed here, so a store whose driver is ' +
        'not installed raises its configuration error at this call rather than at the ' +
        'first search. The corpus resolves against the app directory, so exactly which ' +
        'files are indexed does not depend on where the process was started.' +
        (guarded
          ? ' Every passage that comes back is checked against the `retrieval` guardrails ' +
            'before the caller sees it, so a redacted passage is redacted for the prompt too.'
          : ''),
      INDENT,
    ),
    `${INDENT}return Retriever(`,
    `${INDENT}${INDENT}build_binding(retriever_id),`,
    `${INDENT}${INDENT}embedder=embedder,`,
    `${INDENT}${INDENT}store=store,`,
    `${INDENT}${INDENT}reranker=reranker,`,
    `${INDENT}${INDENT}ledger=ledger,`,
    `${INDENT}${INDENT}base_dir=APP_ROOT,`,
    ...(guarded ? [`${INDENT}${INDENT}guardrails=${stageTable('retrieval')},`] : []),
    `${INDENT})`,
  ].join('\n');
}

function buildRetrievers(): string {
  return [
    'def build_retrievers(*, ledger: CostLedger | None = None) -> dict[str, Retriever]:',
    pythonDoc(
      'Every retriever the spec declares, keyed by the id the spec used, sharing one ' +
        'cost ledger so retrieval spend lands in the same accounting as model calls.',
      INDENT,
    ),
    // ruff collapses this to one line whenever it fits, and at this width it does: keep the
    // emission in the form the formatter would produce rather than the form it would rewrite.
    `${INDENT}return {${COMPREHENSION_BODY}}`,
  ].join('\n');
}

function emitRetrievalBindings(ir: IR): EmittedFile {
  return generated(
    RETRIEVAL_BINDINGS_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The retrievers this app searches, and where each one is indexed. Every entry ' +
          'below is the spec declaration, unsummarised, so the runtime validates exactly ' +
          'what the spec said and the generated code makes no judgement of its own.',
      ),
      importBlock([
        [importFrom('pathlib', ['Path']), importFrom('typing', ['Any'])],
        [
          importFrom('aid_runtime', [
            'ConfigurationError',
            'CostLedger',
            'Embedder',
            'EmbeddingSpec',
            'Reranker',
            'Retriever',
            'RetrieverBinding',
            'RetrieverSpec',
            'VectorStore',
            'VectorStoreSpec',
            'binding_from_spec',
          ]),
        ],
        ...(stageGuardrails(ir, 'retrieval').length > 0
          ? [[importFrom('..guardrails', [stageTable('retrieval')])]]
          : []),
      ]),
      APP_ROOT_LINE,
      orderedRetrievers(ir)
        .map((retriever) => bindingConstants(ir, retriever))
        .join('\n\n'),
      specTable(ir),
      buildBinding(),
      buildRetriever(ir),
      buildRetrievers(),
    ]),
  );
}

/**
 * `app/generated/contracts/citations.py`: how a retrieval step's result is read.
 *
 * The runtime already is the implementation -- `RetrievalResult.context` renders the
 * excerpt block, `.citations` and `.doc_ids` list the sources, and `cite` and
 * `chunk_id_for` are the id scheme a hand-written chunker has to match -- so this module
 * re-exports that vocabulary rather than restating any of it. Business code then imports
 * citations from the generated tree, and the runtime stays free to move its own modules.
 */
function emitCitationsContract(): EmittedFile {
  const names = [
    'Citation',
    'RetrievalResult',
    'RetrievedItem',
    'assemble_context',
    'chunk_id_for',
    'cite',
  ];
  return generated(
    CITATIONS_CONTRACT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The citation vocabulary a retrieval step is read through: the ranked items, ' +
          'the citation each passage is cited by, and the excerpt block a prompt ' +
          'interpolates. Nothing here re-implements the runtime, and an empty result is ' +
          'a result -- its context is empty rather than a bare header, because a header ' +
          'with no sources under it reads to a model as though sources were found.',
      ),
      importFrom('aid_runtime', names),
      pythonStatement('__all__ = ', names),
    ]),
  );
}
