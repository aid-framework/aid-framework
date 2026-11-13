/**
 * The shipped surface, parsed once from the declarations the compiler enforces.
 *
 * `docs/reference/support.md` and `docs/features.md` are two renderings of one set
 * of facts. A fact written down twice is the copy that goes stale, so both pages
 * are generated from this module: adding a provider to `SERVED_PROVIDERS` puts a
 * row on both pages in the same commit, or on neither.
 *
 * The parsers read source, not `dist`, so a page can be generated in a clean
 * checkout without a build. Every parse throws rather than returning an empty
 * list: a page that describes nothing because a regex stopped matching is worse
 * than a failed build.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));

/** The repository root, resolved once so every parser reads the same tree. */
export const repoRoot = join(siteRoot, '..');

/**
 * @param {string} repositoryPath
 * @returns {string}
 */
function readText(repositoryPath) {
  try {
    return readFileSync(join(repoRoot, repositoryPath), 'utf8');
  } catch (cause) {
    throw new Error(`cannot read ${repositoryPath}: ${String(cause)}`);
  }
}

/**
 * @param {string} repositoryPath
 * @returns {any}
 */
function readJsonFile(repositoryPath) {
  const text = readText(repositoryPath);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`cannot parse ${repositoryPath}: ${String(cause)}`);
  }
}

/**
 * `SERVED_PROVIDERS` — the set the normalize gate accepts as a model provider.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseServedProviders(source) {
  const block = source.match(/export const SERVED_PROVIDERS = \[([\s\S]*?)\] as const;/);
  const providers = [...(block?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
  if (providers.length === 0) {
    throw new Error('cannot parse `SERVED_PROVIDERS` from packages/ir/src/shapes.ts');
  }
  return providers;
}

/**
 * `CLOUD_TARGETS` — the deployment targets each cloud has a module for.
 *
 * @param {string} source
 * @returns {{ cloud: string, targets: string[] }[]}
 */
export function parseCloudTargets(source) {
  const block = source.match(/CLOUD_TARGETS[^=]*=\s*\{([\s\S]*?)\n\};/);
  /** @type {{ cloud: string, targets: string[] }[]} */
  const clouds = [];
  for (const match of (block?.[1] ?? '').matchAll(/^\s*([a-z][a-z0-9]*):\s*\[([^\]]*)\],/gm)) {
    clouds.push({
      cloud: match[1] ?? '',
      targets: [...(match[2] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1] ?? ''),
    });
  }
  if (clouds.length === 0) {
    throw new Error('cannot parse `CLOUD_TARGETS` from packages/cli/src/infra/cloud.ts');
  }
  return clouds;
}

/**
 * The spec version enum, in declaration order; the last entry is the current one.
 *
 * @param {any} schema
 * @returns {string[]}
 */
export function parseSpecVersions(schema) {
  const versions = /** @type {string[]} */ (schema?.properties?.specVersion?.enum ?? []);
  if (versions.length === 0) {
    throw new Error('cannot parse the spec version enum from the spec JSON Schema');
  }
  return versions;
}

/**
 * `*_MIN_VERSION` — the spec version each gate demands. The support page renders
 * these as the "Since" column, so a page cannot promise a version the compiler
 * does not enforce, or lag behind one it does.
 *
 * @param {string} source
 * @returns {Record<string, string>}
 */
export function parseVersionFloors(source) {
  /** @type {Record<string, string>} */
  const floors = {};
  for (const match of source.matchAll(
    /export const ([A-Z0-9_]+_MIN_VERSION): SpecVersion = '([0-9]+(?:\.[0-9]+)*)';/g,
  )) {
    floors[match[1] ?? ''] = match[2] ?? '';
  }
  if (Object.keys(floors).length === 0) {
    throw new Error('cannot parse any spec version floor from the spec validator');
  }
  return floors;
}

/**
 * The `retrievers[].chunking.strategy` enum, in declaration order.
 *
 * The support page renders a row per strategy, so a strategy cannot ship in the
 * schema without appearing in the matrix, and the matrix cannot name one the
 * compiler rejects.
 *
 * @param {any} schema
 * @returns {string[]}
 */
export function parseChunkingStrategies(schema) {
  const strategies = /** @type {string[]} */ (
    schema?.$defs?.retriever?.properties?.chunking?.properties?.strategy?.enum ?? []
  );
  if (strategies.length === 0) {
    throw new Error('cannot parse the chunking strategy enum from the spec JSON Schema');
  }
  return strategies;
}

/**
 * `ADAPTER_CAPABILITIES` — what each provider adapter can do at all, as
 * `Capability` member names (`TOOL_CALLING`, not `tool-calling`).
 *
 * @param {string} source
 * @returns {Record<string, string[]>}
 */
export function parseAdapterCapabilities(source) {
  const block = source.match(/ADAPTER_CAPABILITIES[^=]*=\s*\{([\s\S]*?)\n\};/);
  /** @type {Record<string, string[]>} */
  const adapters = {};
  for (const match of (block?.[1] ?? '').matchAll(/^\s{2}(\w+):\s*\[([\s\S]*?)\],/gm)) {
    const members = [...(match[2] ?? '').matchAll(/Capability\.([A-Z_]+)/g)].map(
      (entry) => entry[1] ?? '',
    );
    if (members.length === 0) {
      throw new Error(`parsed an empty capability list for adapter \`${match[1]}\``);
    }
    adapters[match[1] ?? ''] = members;
  }
  if (Object.keys(adapters).length === 0) {
    throw new Error('cannot parse `ADAPTER_CAPABILITIES` from the py-fastapi generator');
  }
  return adapters;
}

/**
 * `providerAdapter()` — the adapter each served provider is routed to.
 *
 * Read from the function body rather than from a comment, because the mapping is
 * what decides which capability row a provider gets.
 *
 * @param {string} source
 * @returns {Record<string, string>}
 */
export function parseProviderAdapters(source) {
  const start = source.indexOf('export function providerAdapter');
  if (start === -1) {
    throw new Error('cannot find `providerAdapter` in packages/generators/py-fastapi/src/names.ts');
  }
  const flat = source.slice(start).replace(/\s+/g, ' ');
  /** @type {Record<string, string>} */
  const adapters = {};
  for (const match of flat.matchAll(
    /provider === '([^']+)'(?: \|\| provider === '([^']+)')?\) ?\{? ?return '(\w+)';/g,
  )) {
    const adapter = match[3] ?? '';
    if (match[1] !== undefined) adapters[match[1]] = adapter;
    if (match[2] !== undefined) adapters[match[2]] = adapter;
  }
  if (Object.keys(adapters).length === 0) {
    throw new Error('cannot parse the provider-to-adapter mapping in `providerAdapter`');
  }
  return adapters;
}

/**
 * The spec DSL's closed `capabilities` enum, as `[spec spelling, canonical name]`.
 *
 * The features page renders one column per entry, so a capability the spec cannot
 * declare never becomes a column that is a dash on every row.
 *
 * @param {string} source `packages/ir/src/capabilities.ts`
 * @returns {{ spec: string, canonical: string }[]}
 */
export function parseSpecCapabilityEnum(source) {
  const block = source.match(/SPEC_MODEL_CAPABILITY_MAP = \{([\s\S]*?)\} as const;/);
  /** @type {{ spec: string, canonical: string }[]} */
  const entries = [];
  for (const match of (block?.[1] ?? '').matchAll(/^\s*'?([a-z-]+)'?:\s*'([a-z-]+)',/gm)) {
    entries.push({ spec: match[1] ?? '', canonical: match[2] ?? '' });
  }
  if (entries.length === 0) {
    throw new Error(
      'cannot parse `SPEC_MODEL_CAPABILITY_MAP` from packages/ir/src/capabilities.ts',
    );
  }
  return entries;
}

/**
 * A `*_DIAGNOSTIC_CODES` table, as the code strings it maps to. The features page
 * cites these to show *what* refuses a capability boundary, so a code named there
 * must still exist somewhere the compiler can emit.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function parseDiagnosticCodes(source) {
  const block = source.match(/(?:[A-Z]+_)?DIAGNOSTIC_CODES = \{([\s\S]*?)\} as const;/);
  const codes = [...(block?.[1] ?? '').matchAll(/'((?:ir|spec|cli|overlay)\/[a-z0-9-]+)'/g)].map(
    (match) => match[1] ?? '',
  );
  if (codes.length === 0) {
    throw new Error('cannot parse a diagnostic code table');
  }
  return codes;
}

/** Registered generator package directories, sorted, so both target parsers walk one list. */
export function generatorDirectories() {
  const root = 'packages/generators';
  try {
    // Membership is decided by the manifest, not by being a directory: tooling drops
    // `node_modules` and cache directories here (vitest writes `.vite`), and reading one
    // as a target fails the page instead of being skipped.
    return readdirSync(join(repoRoot, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(repoRoot, root, entry.name, 'src', 'manifest.ts')))
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    throw new Error(`cannot list ${root}: ${String(cause)}`);
  }
}

/**
 * The `capabilities` each registered generator declares, keyed by target id.
 *
 * The support page names the targets that publish the alert series, and a list
 * written down in prose is the copy that goes stale: a target that gains the
 * capability would leave the page refusing a document the compiler accepts. So
 * the list is read here, from the same declarations the gates are run against.
 * A manifest that spreads a named constant is followed to that constant, because
 * reading the spread as an empty list would claim the target supports nothing.
 *
 * @returns {Record<string, string[]>}
 */
export function targetCapabilities() {
  /** @type {Record<string, string[]>} */
  const byTarget = {};
  for (const name of generatorDirectories()) {
    const path = `packages/generators/${name}/src/manifest.ts`;
    const source = readText(path);
    const id = source.match(/export const [A-Z0-9_]+_TARGET = '([^']+)'/)?.[1] ?? '';
    if (id === '') {
      throw new Error(`cannot parse the target id from ${path}`);
    }
    const block = source.match(/\n\s*capabilities:\s*\[([\s\S]*?)\]/)?.[1] ?? '';
    const spread = block.match(/\.\.\.([A-Z0-9_]+)/)?.[1];
    const listed =
      spread === undefined
        ? block
        : (source.match(new RegExp(`export const ${spread} = \\[([\\s\\S]*?)\\] as const;`))?.[1] ??
          '');
    // Only quoted entries count: the block's comments name capabilities in backticks.
    const declared = [...listed.matchAll(/'([a-z-]+)'/g)].map((match) => match[1] ?? '');
    if (declared.length === 0) {
      throw new Error(`parsed no capabilities for \`${id}\` from ${path}`);
    }
    byTarget[id] = declared;
  }
  if (Object.keys(byTarget).length === 0) {
    throw new Error('cannot parse any generator capability declaration');
  }
  return byTarget;
}

/**
 * Registered target ids, discovered the same way the CLI discovers them.
 *
 * @returns {string[]}
 */
export function targetIds() {
  const names = generatorDirectories();
  /** @type {string[]} */
  const ids = [];
  for (const name of names) {
    const path = `packages/generators/${name}/src/manifest.ts`;
    const manifest = readText(path);
    const found = [...manifest.matchAll(/export const [A-Z0-9_]+_TARGET = '([^']+)'/g)].map(
      (match) => match[1] ?? '',
    );
    if (found.length === 0) {
      throw new Error(`cannot parse the target id from ${path}`);
    }
    ids.push(...found);
  }
  return ids;
}

/**
 * Which catalog models and cost profiles exist per provider.
 *
 * A provider absent here is not unsupported — it is one whose model ids are
 * declared by hand and therefore unpriced, and the cost gate treats an unknown
 * cost as unknown rather than as free.
 *
 * @param {any} models `packages/ir/src/catalog/models.json`
 * @returns {Record<string, { models: number, priced: number }>}
 */
export function parseProviderCatalog(models) {
  /** @type {Record<string, { models: number, priced: number }>} */
  const byProvider = {};
  for (const entry of Object.values(models?.models ?? {})) {
    const provider = /** @type {any} */ (entry)?.provider;
    if (typeof provider !== 'string') continue;
    const bucket = byProvider[provider] ?? { models: 0, priced: 0 };
    byProvider[provider] = bucket;
    bucket.models += 1;
    if (Array.isArray(/** @type {any} */ (entry).costProfiles)) {
      if (/** @type {any} */ (entry).costProfiles.length > 0) bucket.priced += 1;
    }
  }
  return byProvider;
}

/**
 * The whole shipped surface, read from the tree.
 *
 * @returns {{
 *   providers: string[],
 *   providerAdapters: Record<string, string>,
 *   adapterCapabilities: Record<string, string[]>,
 *   providerCatalog: Record<string, { models: number, priced: number }>,
 *   specCapabilities: { spec: string, canonical: string }[],
 *   clouds: { cloud: string, targets: string[] }[],
 *   targets: string[],
 *   targetCapabilities: Record<string, string[]>,
 *   specVersions: string[],
 *   latestSpecVersion: string,
 *   chunkingStrategies: string[],
 *   versionFloors: Record<string, string>,
 *   diagnostics: string[],
 *   corpus: { cases: number, operations: number },
 * }}
 */
export function loadSupportData() {
  const shapes = readText('packages/ir/src/shapes.ts');
  const capabilities = readText('packages/ir/src/capabilities.ts');
  const cloud = readText('packages/cli/src/infra/cloud.ts');
  const names = readText('packages/generators/py-fastapi/src/names.ts');
  const diagnostics = readText('packages/ir/src/diagnostics.ts');
  const cliDiagnostics = readText('packages/cli/src/diagnostics.ts');
  const specDiagnostics = readText('packages/spec/src/diagnostics.ts');
  const overlayDiagnostics = readText('packages/spec/src/overlay.ts');
  const specValidator = readText('packages/spec/src/validate.ts');
  const schema = readJsonFile('packages/spec/src/schema/spec.schema.json');
  const corpus = readJsonFile('conformance/corpus.json');
  const models = readJsonFile('packages/ir/src/catalog/models.json');

  const specVersions = parseSpecVersions(schema);

  /** @type {{ op?: string }[]} */
  const cases = Array.isArray(corpus?.cases) ? corpus.cases : [];
  if (cases.length === 0) {
    throw new Error('parsed `conformance/corpus.json` as an empty case list');
  }

  return {
    providers: parseServedProviders(shapes),
    providerAdapters: parseProviderAdapters(names),
    adapterCapabilities: parseAdapterCapabilities(names),
    providerCatalog: parseProviderCatalog(models),
    specCapabilities: parseSpecCapabilityEnum(capabilities),
    clouds: parseCloudTargets(cloud),
    targets: targetIds(),
    targetCapabilities: targetCapabilities(),
    specVersions,
    latestSpecVersion: specVersions[specVersions.length - 1] ?? '',
    chunkingStrategies: parseChunkingStrategies(schema),
    versionFloors: parseVersionFloors(specValidator),
    diagnostics: [
      ...new Set([
        ...parseDiagnosticCodes(diagnostics),
        ...parseDiagnosticCodes(cliDiagnostics),
        ...parseDiagnosticCodes(specDiagnostics),
        ...parseDiagnosticCodes(overlayDiagnostics),
      ]),
    ],
    corpus: {
      cases: cases.length,
      operations: new Set(cases.map((entry) => entry.op)).size,
    },
  };
}
