/**
 * `app/generated/retrieval/sync/**`: one entry point per managed retriever.
 *
 * Sync is the operation a managed retriever has *instead of* ingest. Its corpus is
 * filled inside the engine, by an ingestion job the corpus owns, so there is nothing
 * for this process to index -- but there is something for it to *ask for*, and that
 * request is what these modules make. Each is run as
 * `python -m app.generated.retrieval.sync.<id>`, which is the interface `aid kb sync`
 * shells out to.
 *
 * The layout mirrors `ingest/` -- an `__init__.py` beside one module per declared id --
 * so a caller that knows where an ingest module lives knows where a sync module lives,
 * and the CLI restates neither path.
 */

import type { IR, ManagedRetrieverShape } from '@aid-framework/ir';
import { isManagedRetriever } from '@aid-framework/ir';

import { moduleName } from '../names.js';
import { INDENT, pythonStatement, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { orderedRetrievers } from './order.js';
import { pythonDoc } from './text.js';

export const RETRIEVAL_SYNC_INIT_PATH = `${GENERATED_ROOT}/retrieval/sync/__init__.py`;

/** The sync module for one managed retriever, by the id the spec used. */
export function retrievalSyncModulePath(retrieverId: string): string {
  return `${GENERATED_ROOT}/retrieval/sync/${moduleName(retrieverId)}.py`;
}

/** One sync entry point per managed retriever, in declared-identity order. */
export function retrievalSyncFiles(ir: IR): EmittedFile[] {
  // The mirror image of the rule that gives a managed retriever no ingest module. A
  // local retriever's corpus is written by this process, so there is no engine-side job
  // to start: its sync is `aid ingest`, which it already has. Emitting a sync module
  // here would be an entry point whose only possible answer is a refusal.
  const retrievers = orderedRetrievers(ir).filter(isManagedRetriever);
  if (retrievers.length === 0) return [];
  return [emitSyncInit(), ...retrievers.map((retriever) => emitSync(retriever))];
}

function emitSyncInit(): EmittedFile {
  return generated(
    RETRIEVAL_SYNC_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The sync entry points, one module each, named after the managed retriever id ' +
          'the spec declares. Each is runnable on its own as ``python -m ' +
          'app.generated.retrieval.sync.`` plus its id. They are deliberately not ' +
          'imported here: the caller already loads the one module it names, and ' +
          'importing it here as well would load it twice.',
      ),
    ]),
  );
}

/** The dotted module a caller spawns, derived from the file path it was given. */
function dottedModule(retrieverId: string): string {
  return retrievalSyncModulePath(retrieverId)
    .replace(/\.py$/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .join('.');
}

function parserBlock(retriever: ManagedRetrieverShape): string {
  return [
    'def _parser() -> argparse.ArgumentParser:',
    pythonDoc('The command line this module is run with.', INDENT),
    `${INDENT}parser = argparse.ArgumentParser(`,
    `${INDENT}${INDENT}prog=${pythonString(dottedModule(retriever.id))},`,
    `${INDENT}${INDENT}description=${pythonString(
      `Start the ingestion job behind the '${retriever.id}' retriever.`,
    )},`,
    `${INDENT})`,
    `${INDENT}parser.add_argument(`,
    `${INDENT}${INDENT}"--wait",`,
    `${INDENT}${INDENT}action="store_true",`,
    `${INDENT}${INDENT}help="Wait for the job to finish, and report how it ended.",`,
    `${INDENT})`,
    `${INDENT}return parser`,
  ].join('\n');
}

/**
 * Sync one managed retriever through the client its knowledge base names.
 *
 * The guard is the inverse of the ingest module's: a local retriever reaching this
 * module is a spec and a plan that disagree, and it is refused here rather than by
 * starting a job that belongs to no corpus of its own.
 */
function runBlock(): string {
  return [
    'async def _sync(wait: bool) -> SyncResult:',
    pythonDoc(
      'Start the ingestion job behind one managed retriever, and under ``wait`` return ' +
        'the job once the engine has finished with it. The client is built here rather ' +
        'than at import time, so importing this module -- which the caller does in ' +
        'order to describe it -- needs no credentials and reaches no network.',
      INDENT,
    ),
    `${INDENT}binding = build_binding(RETRIEVER_ID)`,
    `${INDENT}if not isinstance(binding, ManagedRetrieverBinding):`,
    `${INDENT}${INDENT}raise ConfigurationError(`,
    `${INDENT}${INDENT}${INDENT}f"retriever {RETRIEVER_ID!r} is indexed here, not in a knowledge base, "`,
    `${INDENT}${INDENT}${INDENT}"so it has no ingestion job to start"`,
    `${INDENT}${INDENT})`,
    `${INDENT}client = knowledge_base_client_for(binding.knowledge_base)`,
    `${INDENT}try:`,
    `${INDENT}${INDENT}return await client.sync(binding.knowledge_base, wait=wait)`,
    `${INDENT}finally:`,
    `${INDENT}${INDENT}await client.aclose()`,
  ].join('\n');
}

function mainBlock(): string {
  return [
    'def main() -> int:',
    pythonDoc(
      'Start the job, or under --wait report how it ended. The exit status is the ' +
        "verdict, and it is the engine's: zero when a job was started or completed, " +
        'non-zero when the job failed or this run could not ask for one. A failed job ' +
        'is never reported as a success, because a caller that read the success and ' +
        'searched anyway would be searching a corpus the engine could not rebuild.',
      INDENT,
    ),
    `${INDENT}arguments = _parser().parse_args()`,
    `${INDENT}try:`,
    `${INDENT}${INDENT}result = asyncio.run(_sync(arguments.wait))`,
    `${INDENT}except (ConfigurationError, ProviderError) as error:`,
    `${INDENT}${INDENT}print(f"error: {error}", file=sys.stderr)`,
    `${INDENT}${INDENT}return 1`,
    `${INDENT}print(f"knowledge base {result.knowledge_base_id} job {result.job_id}: {result.status}")`,
    `${INDENT}if result.failure_reason:`,
    `${INDENT}${INDENT}print(f"failure: {result.failure_reason}", file=sys.stderr)`,
    `${INDENT}return 0 if result.ok else 1`,
  ].join('\n');
}

function emitSync(retriever: ManagedRetrieverShape): EmittedFile {
  return generated(
    retrievalSyncModulePath(retriever.id),
    assemble([
      HEADER,
      pythonDoc(
        `The corpus behind the ${retriever.id} retriever, rebuilt by the engine that ` +
          'owns it. A managed knowledge base ingests inside the engine, driven by its ' +
          'data source, so this module starts that ingestion and -- under --wait -- ' +
          'follows it to the job the engine reports, rather than importing anything ' +
          'itself. The job belongs to the corpus and outlives this process, which is ' +
          'why a run without --wait returns as soon as the work is queued.',
      ),
      importBlock([
        ['import argparse', 'import asyncio', 'import sys'],
        [
          importFrom('aid_runtime', [
            'ConfigurationError',
            'ManagedRetrieverBinding',
            'ProviderError',
            'SyncResult',
            'knowledge_base_client_for',
          ]),
        ],
        [importFrom('..bindings', ['build_binding'])],
      ]),
      pythonStatement('RETRIEVER_ID = ', retriever.id),
      parserBlock(retriever),
      runBlock(),
      mainBlock(),
      ['if __name__ == "__main__":', `${INDENT}raise SystemExit(main())`].join('\n'),
    ]),
  );
}
