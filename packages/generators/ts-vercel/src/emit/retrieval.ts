/**
 * `generated/retrieval/*`.
 *
 * The declared vector store is the target's `vectorStore: 'pgvector'` commitment, and it
 * reaches the runtime as `VectorStoreSpec.kind`, not as an `emitsAgainst` key: the
 * generator manifest vocabulary has no `vectorStore` field, so declaring one would be
 * rejected as an unknown key. The spec's store kind is what actually selects the
 * adapter, so it is carried here where it is load-bearing.
 *
 * Nothing here imports `Dataset`, which reads the filesystem: these modules are imported
 * by the route handlers and must stay usable in an edge runtime.
 */

import type { IR, LocalRetrieverShape } from '@aid-framework/ir';
import { isLocalRetriever } from '@aid-framework/ir';
import { literal, propertyKey } from '../names.js';
import { type EmittedFile, generated, paths, retrievalIngestModulePath } from './file.js';
import { exportStatement, type ImportName, importStatement, moduleText, tsValue } from './text.js';

function sourceExpression(retriever: LocalRetrieverShape): string {
  const fields = [
    `kind: ${literal(retriever.source.kind)}`,
    `uri: ${literal(retriever.source.uri)}`,
  ];
  if (retriever.source.glob !== undefined) fields.push(`glob: ${literal(retriever.source.glob)}`);
  return `new SourceSpec({ ${fields.join(', ')} })`;
}

function chunkingExpression(retriever: LocalRetrieverShape): string {
  const keep = retriever.chunking.keepMetadata;
  return [
    'new ChunkingSpec({',
    `      strategy: ${literal(retriever.chunking.strategy)},`,
    `      size: ${literal(retriever.chunking.size)},`,
    `      overlap: ${literal(retriever.chunking.overlap)},`,
    `      keepMetadata: [${keep.map((name) => literal(name)).join(', ')}],`,
    '    })',
  ].join('\n');
}

function indexExpression(retriever: LocalRetrieverShape): string {
  return [
    'new IndexSpec({',
    `      metric: ${literal(retriever.index.metric)},`,
    `      hybrid: ${literal(retriever.index.hybrid)},`,
    '    })',
  ].join('\n');
}

function retrieverExpression(retriever: LocalRetrieverShape): string {
  const lines = [
    `  ${propertyKey(retriever.id)}: new RetrieverSpec({`,
    `    id: ${literal(retriever.id)},`,
    `    source: ${sourceExpression(retriever)},`,
    `    chunking: ${chunkingExpression(retriever)},`,
    `    embedModel: ${literal(retriever.embedModel)},`,
    `    store: ${literal(retriever.store)},`,
    `    index: ${indexExpression(retriever)},`,
    `    topK: ${literal(retriever.topK)},`,
  ];
  if (retriever.rerank !== undefined) {
    lines.push(
      `    rerank: new RerankSpec({ model: ${literal(retriever.rerank.model)}, topN: ${literal(
        retriever.rerank.topN,
      )} }),`,
    );
  }
  lines.push(
    `    refresh: new RefreshSpec({ mode: ${literal(retriever.refresh.mode)} }),`,
    `    traits: ${tsValue(
      retriever.traits.map((trait) => trait.name),
      '    ',
    )},`,
    '  }),',
  );
  return lines.join('\n');
}

export function emitRetrievalBindings(ir: IR): EmittedFile {
  const localRetrievers = ir.retrievers.filter(isLocalRetriever);
  const imports: ImportName[] = [
    // The records are typed even when empty, so these three are unconditional.
    { name: 'EmbeddingSpec', type: false },
    { name: 'RetrieverSpec', type: false },
    { name: 'VectorStoreSpec', type: false },
  ];
  if (ir.embeddings.some((embedding) => embedding.costProfile !== undefined)) {
    imports.push({ name: 'EmbeddingCostProfile', type: false });
  }
  if (localRetrievers.length > 0) {
    imports.push(
      { name: 'ChunkingSpec', type: false },
      { name: 'IndexSpec', type: false },
      { name: 'RefreshSpec', type: false },
      { name: 'SourceSpec', type: false },
    );
  }
  if (localRetrievers.some((retriever) => retriever.rerank !== undefined)) {
    imports.push({ name: 'RerankSpec', type: false });
  }
  const header = importStatement('@aid-framework/runtime', imports);

  const embeddings = ir.embeddings
    .map((embedding) => {
      const fields = [
        `    id: ${literal(embedding.id)},`,
        `    provider: ${literal(embedding.provider)},`,
        `    modelId: ${literal(embedding.modelId)},`,
      ];
      if (embedding.dimensions !== undefined) {
        fields.push(`    dimensions: ${literal(embedding.dimensions)},`);
      }
      const profile = embedding.costProfile;
      if (profile !== undefined) {
        fields.push(
          `    costProfile: new EmbeddingCostProfile({ inputPerMTok: ${literal(profile.inputPerMTok)}, outputPerMTok: ${literal(profile.outputPerMTok)} }),`,
        );
      }
      return [`  ${propertyKey(embedding.id)}: new EmbeddingSpec({`, ...fields, '  }),'].join('\n');
    })
    .join('\n');

  const stores = ir.stores
    .map((store) => {
      const fields = [`    id: ${literal(store.id)},`, `    kind: ${literal(store.kind)},`];
      if (store.uri !== undefined) fields.push(`    uri: ${literal(store.uri)},`);
      if (store.dimensions !== undefined)
        fields.push(`    dimensions: ${literal(store.dimensions)},`);
      return [`  ${propertyKey(store.id)}: new VectorStoreSpec({`, ...fields, '  }),'].join('\n');
    })
    .join('\n');

  // `checkRetrievers` refuses a managed retriever before any byte is rendered, so the
  // filter here only narrows the type: a base has no local source, store or chunking to
  // spell, and letting one through would emit an unsearchable binding.
  const retrievers = ir.retrievers.filter(isLocalRetriever).map(retrieverExpression).join('\n');

  const body = [
    '/** The embedding models the IR pins, by alias. */',
    'export const EMBEDDINGS: Readonly<Record<string, EmbeddingSpec>> = {',
    embeddings,
    '};',
    '',
    '/** The vector stores the IR declares, by id. `kind` selects the adapter. */',
    'export const STORES: Readonly<Record<string, VectorStoreSpec>> = {',
    stores,
    '};',
    '',
    '/** The retrievers, by id. */',
    'export const RETRIEVERS: Readonly<Record<string, RetrieverSpec>> = {',
    retrievers,
    '};',
  ].join('\n');

  return generated(paths.retrievalBindings, moduleText(header, body));
}

export function emitRetrievalIndex(ir: IR): EmittedFile {
  void ir;
  const header = [
    importStatement('@aid-framework/runtime', [
      { name: 'ConfigurationError', type: false },
      { name: 'Retriever', type: false },
      { name: 'bindingFromSpec', type: false },
    ]),
    importStatement('./bindings.js', [
      { name: 'EMBEDDINGS', type: false },
      { name: 'RETRIEVERS', type: false },
      { name: 'STORES', type: false },
    ]),
  ].join('\n');
  const body = [
    'export interface BuildRetrieversOptions {',
    '  /**',
    '   * The directory a relative source uri resolves against. Defaults to the process',
    '   * cwd, which is right for a route handler in a deployment and wrong for a CLI step',
    '   * run from the project root -- those pass the `app/` directory instead.',
    '   */',
    '  readonly baseDir?: string | null;',
    '}',
    '',
    '/**',
    ' * Build every declared retriever.',
    ' *',
    ' * The binding is resolved and validated here rather than trusted: a mistyped',
    ' * `embedModel` or `store` id is a startup error naming both ids, not an empty corpus',
    ' * discovered much later.',
    ' */',
    'export function buildRetrievers(',
    '  options: BuildRetrieversOptions = {},',
    '): ReadonlyMap<string, Retriever> {',
    '  const built = new Map<string, Retriever>();',
    '  for (const spec of Object.values(RETRIEVERS)) {',
    '    const embedding = EMBEDDINGS[spec.embedModel];',
    '    if (embedding === undefined) {',
    '      throw new ConfigurationError(',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
    '        `retriever ${JSON.stringify(spec.id)} names embedding ${JSON.stringify(spec.embedModel)}, which is not declared`,',
    '      );',
    '    }',
    '    const store = STORES[spec.store];',
    '    if (store === undefined) {',
    '      throw new ConfigurationError(',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
    '        `retriever ${JSON.stringify(spec.id)} names store ${JSON.stringify(spec.store)}, which is not declared`,',
    '      );',
    '    }',
    '    built.set(',
    '      spec.id,',
    '      new Retriever(bindingFromSpec(spec, { embedding, store }), {',
    '        baseDir: options.baseDir ?? null,',
    '      }),',
    '    );',
    '  }',
    '  return built;',
    '}',
  ].join('\n');
  return generated(paths.retrievalIndex, moduleText(header, body));
}

function ingestModule(retriever: LocalRetrieverShape): string {
  const header = [
    importStatement('node:fs', [{ name: 'existsSync', type: false }]),
    importStatement('node:path', [
      { name: 'dirname', type: false },
      { name: 'join', type: false },
    ]),
    importStatement('node:url', [{ name: 'fileURLToPath', type: false }]),
    importStatement('@aid-framework/runtime', [{ name: 'IngestReport', type: true }]),
    importStatement('../index.js', [{ name: 'buildRetrievers', type: false }]),
  ].join('\n');
  return [
    header,
    '',
    '/**',
    " * The `app/` directory: the base the spec's relative source uris resolve against.",
    ' *',
    ' * Ingest is a step an operator runs from the project root, and it also runs from',
    ' * build output, so the base is found rather than assumed: the nearest ancestor',
    ' * `package.json` is the root above both `app/` and `dist/`.',
    ' */',
    'function appDir(): string {',
    '  let directory = dirname(fileURLToPath(import.meta.url));',
    "  while (!existsSync(join(directory, 'package.json'))) {",
    '    const parent = dirname(directory);',
    '    if (parent === directory) break;',
    '    directory = parent;',
    '  }',
    "  return join(directory, 'app');",
    '}',
    '',
    '/**',
    ` * Ingest the corpus the \`${retriever.id}\` retriever declares.`,
    ' *',
    ' * Idempotent because chunk ids are content-addressed: re-running writes the same ids',
    ' * rather than appending duplicates.',
    ' */',
    'export async function ingest(): Promise<IngestReport> {',
    `  const retriever = buildRetrievers({ baseDir: appDir() }).get(${literal(retriever.id)});`,
    '  if (retriever === undefined) {',
    `    throw new Error(${literal(`no retriever ${retriever.id}`)});`,
    '  }',
    '  try {',
    '    return await retriever.ingest();',
    '  } finally {',
    '    await retriever.close();',
    '  }',
    '}',
  ].join('\n');
}

export function emitRetrievalIngestModules(ir: IR): EmittedFile[] {
  return ir.retrievers
    .filter(isLocalRetriever)
    .map((retriever) =>
      generated(retrievalIngestModulePath(retriever.id), moduleText(ingestModule(retriever))),
    );
}

export function emitRetrievalIngestIndex(ir: IR): EmittedFile {
  const locals = ir.retrievers.filter(isLocalRetriever);
  const lines =
    locals.length === 0
      ? ['// This project declares no local retrievers, so there is nothing to ingest.']
      : locals.map((retriever) =>
          exportStatement(`./${retriever.id}.js`, [
            [
              'ingest',
              `ingest${retriever.id.replace(/(?:^|_)(\w)/g, (_, c: string) => c.toUpperCase())}`,
            ],
          ]),
        );
  return generated(paths.retrievalIngestIndex, moduleText(...lines));
}
