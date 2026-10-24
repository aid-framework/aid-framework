/**
 * `app/generated/retrieval/ingest/**`: one entry point per declared retriever.
 *
 * Indexing is a batch job, not a request, so it is not a route: each module is run
 * as `python -m app.generated.retrieval.ingest.<id>`, which is the interface `aid
 * ingest` shells out to. The layout is the one `routes/` already uses -- an
 * `__init__.py` beside one module per declared id -- so a caller that has learned
 * where a route lives knows where an ingest module lives, and the CLI never has to
 * restate either path.
 *
 * Two rules make the entry points usable from a caller that cannot see inside them.
 * `--dry-run` is answered here rather than by the caller, because only this module
 * knows how the spec's chunking turns documents into chunks -- and under it no store
 * is constructed, so a dry run needs neither a database nor the store's driver. And
 * nothing happens at import time, so `aid` can import the module to describe it, or
 * to run it under a bare install with no extras, without side effects.
 */

import type { IR, RetrieverShape } from '@aid/ir';

import { moduleName } from '../names.js';
import { INDENT, pythonStatement, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { orderedRetrievers } from './order.js';
import { pythonDoc } from './text.js';

export const RETRIEVAL_INGEST_INIT_PATH = `${GENERATED_ROOT}/retrieval/ingest/__init__.py`;

/** The ingest module for one declared retriever, by the id the spec used. */
export function retrievalIngestModulePath(retrieverId: string): string {
  return `${GENERATED_ROOT}/retrieval/ingest/${moduleName(retrieverId)}.py`;
}

/** One ingest entry point per declared retriever, in declared-identity order. */
export function retrievalIngestFiles(ir: IR): EmittedFile[] {
  const retrievers = orderedRetrievers(ir);
  if (retrievers.length === 0) return [];
  return [emitIngestInit(), ...retrievers.map((retriever) => emitIngest(retriever))];
}

function emitIngestInit(): EmittedFile {
  return generated(
    RETRIEVAL_INGEST_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The ingest entry points, one module each, named after the retriever id the ' +
          'spec declares. Each is runnable on its own as ``python -m ' +
          'app.generated.retrieval.ingest.`` plus its id. They are deliberately not ' +
          'imported here: the caller already loads the one module it names, and ' +
          'importing it here as well would load it twice.',
      ),
    ]),
  );
}

/** The dotted module a caller spawns, derived from the file path it was given. */
function dottedModule(retrieverId: string): string {
  return retrievalIngestModulePath(retrieverId)
    .replace(/\.py$/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('.');
}

function parserBlock(retriever: RetrieverShape): string {
  return [
    'def _parser() -> argparse.ArgumentParser:',
    pythonDoc('The command line this module is run with.', INDENT),
    `${INDENT}parser = argparse.ArgumentParser(`,
    `${INDENT}${INDENT}prog=${pythonString(dottedModule(retriever.id))},`,
    `${INDENT}${INDENT}description=${pythonString(`Ingest the corpus of the '${retriever.id}' retriever.`)},`,
    `${INDENT})`,
    `${INDENT}parser.add_argument(`,
    `${INDENT}${INDENT}"--dry-run",`,
    `${INDENT}${INDENT}action="store_true",`,
    `${INDENT}${INDENT}help="Report what a run would write, and write nothing.",`,
    `${INDENT})`,
    `${INDENT}return parser`,
  ].join('\n');
}

/**
 * The dry run answers with the counts a real run would report.
 *
 * It reads the corpus and chunks it, because only the chunker knows how many chunks a
 * document becomes -- but it builds no store and calls no embedder, so it needs neither
 * a database nor the store's driver. It cannot go through `Retriever` to do this: a
 * retriever constructs its store as it is built, which is exactly the cost a dry run
 * exists to avoid.
 */
function planBlock(): string {
  return [
    'async def _plan(retriever_id: str) -> tuple[int, int]:',
    pythonDoc(
      'The document and chunk counts a run would write, without building a store. ' +
        'That is what makes a dry run cheap and offline: the chunking is applied, so ' +
        'the counts are the ones a real run would report, but no embedder is called ' +
        'and no store is opened.',
      INDENT,
    ),
    `${INDENT}binding = build_binding(retriever_id)`,
    `${INDENT}connector = open_connector(binding.source, base_dir=APP_ROOT)`,
    `${INDENT}try:`,
    `${INDENT}${INDENT}documents = await connector.documents()`,
    `${INDENT}finally:`,
    `${INDENT}${INDENT}await connector.aclose()`,
    `${INDENT}chunker = chunker_for(binding.chunking)`,
    `${INDENT}return len(documents), sum(len(chunker.chunk(document)) for document in documents)`,
  ].join('\n');
}

function runBlock(): string {
  return [
    'async def _run(retriever_id: str) -> IngestReport:',
    pythonDoc(
      'Ingest one retriever and report what was written. The store is built here ' +
        'rather than imported, so a store whose driver is not installed raises its ' +
        'configuration error at this call.',
      INDENT,
    ),
    `${INDENT}retriever = build_retriever(retriever_id, ledger=CostLedger())`,
    `${INDENT}try:`,
    `${INDENT}${INDENT}return await retriever.ingest()`,
    `${INDENT}finally:`,
    `${INDENT}${INDENT}await retriever.aclose()`,
  ].join('\n');
}

function mainBlock(): string {
  return [
    'def main() -> int:',
    pythonDoc(
      'Ingest the corpus, or report what a run would write under --dry-run. The ' +
        'exit status is the verdict: zero when the corpus was written or a dry run ' +
        'reported it, non-zero when the spec names something this run could not use.',
      INDENT,
    ),
    `${INDENT}arguments = _parser().parse_args()`,
    `${INDENT}try:`,
    `${INDENT}${INDENT}if arguments.dry_run:`,
    `${INDENT}${INDENT}${INDENT}documents, chunks = asyncio.run(_plan(RETRIEVER_ID))`,
    `${INDENT}${INDENT}${INDENT}print(f"would write {documents} documents as {chunks} chunks")`,
    `${INDENT}${INDENT}${INDENT}return 0`,
    `${INDENT}${INDENT}report = asyncio.run(_run(RETRIEVER_ID))`,
    `${INDENT}except (ConfigurationError, FeatureDeferredError) as error:`,
    `${INDENT}${INDENT}print(f"error: {error}", file=sys.stderr)`,
    `${INDENT}${INDENT}return 1`,
    `${INDENT}print(f"wrote {report.written} of {report.chunks} chunks from {report.documents} documents")`,
    `${INDENT}print(f"embedding cost: usd {report.cost_usd:.4f} over {report.tokens} tokens")`,
    `${INDENT}return 0`,
  ].join('\n');
}

function emitIngest(retriever: RetrieverShape): EmittedFile {
  return generated(
    retrievalIngestModulePath(retriever.id),
    assemble([
      HEADER,
      pythonDoc(
        `The corpus behind the ${retriever.id} retriever: read the source the spec ` +
          'declares, chunk it, embed each chunk, and write it to the store the spec ' +
          'declares, so the retriever has something to search. Re-running replaces ' +
          'rather than appends, because a chunk id is a content hash rather than a ' +
          'position. Indexing is a batch job rather than a request, which is why it ' +
          'is a command instead of a route.',
      ),
      importBlock([
        ['import argparse', 'import asyncio', 'import sys'],
        [
          importFrom('aid_runtime', [
            'ConfigurationError',
            'CostLedger',
            'FeatureDeferredError',
            'IngestReport',
            'chunker_for',
            'open_connector',
          ]),
        ],
        [importFrom('..bindings', ['APP_ROOT', 'build_binding', 'build_retriever'])],
      ]),
      pythonStatement('RETRIEVER_ID = ', retriever.id),
      parserBlock(retriever),
      planBlock(),
      runBlock(),
      mainBlock(),
      ['if __name__ == "__main__":', `${INDENT}raise SystemExit(main())`].join('\n'),
    ]),
  );
}
