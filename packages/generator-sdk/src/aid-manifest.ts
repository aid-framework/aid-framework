/**
 * `aid.manifest.json` — the recorded state of the last generation (§8.3, §10).
 *
 * This file is what makes regeneration safe. Without it, a generator cannot tell
 * "the file on disk is exactly what I wrote" from "a human edited the generated
 * code", and the design's answer to those two states is completely different: the
 * first is a no-op, the second must never be overwritten. So every generation
 * records, per file, the owning generator and the SHA-256 of the bytes it wrote.
 *
 * Business file records are deliberately *not* refreshed on later runs. A developer
 * is expected to edit `business/`, and rewriting the recorded hash each run would
 * make the manifest churn on every generation while telling nobody anything new.
 * The record means "this generator created this file once and then let go of it".
 */

import { canonicalJson } from '@aid-framework/ir';
import { sortDiagnostics } from '@aid-framework/spec';
import { sha256Hex, sortByPath } from './determinism.js';
import {
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratorDiagnostic,
  generatorError,
} from './diagnostics.js';
import {
  DEFAULT_MANIFEST_FILENAME,
  type FileOwner,
  normalizeRelativePath,
  ownerForPath,
} from './ownership.js';
import type { GeneratedFile } from './plan.js';

export const AID_MANIFEST_VERSION = 1;

export { DEFAULT_MANIFEST_FILENAME };

/** SHA-256, lowercase hex. The same spelling the design's drift check compares. */
export type Sha256Hex = string;

export interface AidManifestFile {
  path: string;
  owner: FileOwner;
  sha256: Sha256Hex;
  generator: string;
  generatorVersion: string;
}

/** Provenance of the run that last wrote this manifest. */
export interface AidManifestProvenance {
  generator: string;
  generatorVersion: string;
  irVersion: string;
}

export interface AidManifest {
  manifestVersion: number;
  generatedBy: AidManifestProvenance;
  files: readonly AidManifestFile[];
  /**
   * Generated paths a developer took ownership of with `aid eject`. The exclusion is
   * permanent: the planner drops these paths from every plan, and a regeneration that
   * would otherwise forget them carries them forward. Absent in older manifests, which
   * read as an empty list.
   */
  ejected: readonly string[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TOP_LEVEL_KEYS = new Set(['manifestVersion', 'generatedBy', 'files', 'ejected']);
const FILE_KEYS = new Set(['path', 'owner', 'sha256', 'generator', 'generatorVersion']);
const PROVENANCE_KEYS = new Set(['generator', 'generatorVersion', 'irVersion']);

function invalid(message: string, path: string, hint?: string): GeneratorDiagnostic {
  return generatorError({
    code: GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
    message,
    path,
    ...(hint === undefined ? {} : { hint }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyAidManifest(provenance: AidManifestProvenance): AidManifest {
  return {
    manifestVersion: AID_MANIFEST_VERSION,
    generatedBy: provenance,
    files: [],
    ejected: [],
  };
}

/**
 * The manifest describing a freshly emitted plan: one record per file, hashed from
 * the exact bytes in the plan.
 */
export function manifestFor(
  files: readonly GeneratedFile[],
  provenance: AidManifestProvenance,
): AidManifest {
  return {
    manifestVersion: AID_MANIFEST_VERSION,
    generatedBy: provenance,
    files: sortByPath(files).map((file) => ({
      path: file.path,
      owner: file.owner,
      sha256: sha256Hex(file.content),
      generator: provenance.generator,
      generatorVersion: provenance.generatorVersion,
    })),
    ejected: [],
  };
}

export function manifestRecordFor(
  manifest: AidManifest | undefined,
  path: string,
): AidManifestFile | undefined {
  return manifest?.files.find((file) => file.path === path);
}

export interface AidManifestParseResult {
  manifest?: AidManifest;
  diagnostics: GeneratorDiagnostic[];
}

/**
 * Where the two managed tiers live, repo-relative. A generator whose app root is `app`
 * records paths like `app/generated/main.py`, so the location check has to be told the
 * layout rather than assuming the directories sit at the repository root — otherwise a
 * manifest this package wrote could not be read back.
 */
export interface AidManifestPathOptions {
  generatedDir?: string;
  businessDir?: string;
}

/**
 * Parses a manifest value. A missing or unreadable manifest is an error, not an
 * empty one: without records, every generated file on disk becomes indistinguishable
 * from hand-edited code, and the safe behaviour is to refuse rather than clobber.
 * Callers that genuinely want a first generation pass {@link emptyAidManifest}.
 */
export function parseAidManifest(
  value: unknown,
  options: AidManifestPathOptions = {},
): AidManifestParseResult {
  if (!isRecord(value)) {
    return { diagnostics: [invalid('aid.manifest.json must be an object.', 'manifest')] };
  }

  const diagnostics: GeneratorDiagnostic[] = [];
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push(invalid(`Unknown aid.manifest.json key "${key}".`, key));
    }
  }

  if (value.manifestVersion !== AID_MANIFEST_VERSION) {
    diagnostics.push(
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.manifestVersionUnsupported,
        message: `aid.manifest.json declares manifestVersion ${JSON.stringify(value.manifestVersion)}; this build writes and reads version ${AID_MANIFEST_VERSION}.`,
        path: 'manifestVersion',
      }),
    );
  }

  const generatedBy = parseProvenance(value.generatedBy, diagnostics);
  const files = parseFiles(value.files, diagnostics, options);
  const ejected = parseEjected(value.ejected, diagnostics, options);

  if (files !== undefined && ejected !== undefined) {
    // A path cannot be both generator-owned and permanently excluded. Reading such a
    // manifest would have to pick a winner, and the two readers that pick differently is
    // exactly the class of bug this file exists to prevent.
    const generated = new Set(
      files.filter((file) => file.owner === 'generated').map((file) => file.path),
    );
    for (const path of ejected) {
      if (generated.has(path)) {
        diagnostics.push(
          invalid(
            `"${path}" is recorded as a generated file and also listed in "ejected"; a path cannot be both.`,
            'ejected',
          ),
        );
      }
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { diagnostics: sortDiagnostics(diagnostics) };
  }

  return {
    manifest: {
      manifestVersion: AID_MANIFEST_VERSION,
      generatedBy: generatedBy as AidManifestProvenance,
      files: files as readonly AidManifestFile[],
      ejected: ejected as readonly string[],
    },
    diagnostics: sortDiagnostics(diagnostics),
  };
}

export function parseAidManifestJson(
  text: string,
  options: AidManifestPathOptions = {},
): AidManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      diagnostics: [
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.manifestParseFailed,
          message: `aid.manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          path: 'manifest',
        }),
      ],
    };
  }
  return parseAidManifest(parsed, options);
}

function parseProvenance(
  value: unknown,
  diagnostics: GeneratorDiagnostic[],
): AidManifestProvenance | undefined {
  if (!isRecord(value)) {
    diagnostics.push(invalid('aid.manifest.json needs a `generatedBy` object.', 'generatedBy'));
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!PROVENANCE_KEYS.has(key)) {
      diagnostics.push(invalid(`Unknown generatedBy key "${key}".`, `generatedBy.${key}`));
    }
  }

  const generator = value.generator;
  const generatorVersion = value.generatorVersion;
  const irVersion = value.irVersion;
  if (
    typeof generator !== 'string' ||
    typeof generatorVersion !== 'string' ||
    typeof irVersion !== 'string'
  ) {
    diagnostics.push(
      invalid(
        'generatedBy.generator, generatedBy.generatorVersion, and generatedBy.irVersion must all be strings.',
        'generatedBy',
      ),
    );
    return undefined;
  }
  return { generator, generatorVersion, irVersion };
}

function parseFiles(
  value: unknown,
  diagnostics: GeneratorDiagnostic[],
  options: AidManifestPathOptions,
): readonly AidManifestFile[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(invalid('aid.manifest.json needs a `files` array.', 'files'));
    return undefined;
  }

  const records: AidManifestFile[] = [];
  const seen = new Map<string, number>();
  let failed = false;

  for (const [index, entry] of value.entries()) {
    const at = `files[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(invalid(`${at} must be an object.`, at));
      failed = true;
      continue;
    }

    // Every problem in the record is reported, not just the first: a manifest is
    // hand-editable, and fixing one field per run is a poor way to learn the shape.
    const before = diagnostics.length;

    for (const key of Object.keys(entry)) {
      if (!FILE_KEYS.has(key)) {
        diagnostics.push(invalid(`Unknown ${at} key "${key}".`, `${at}.${key}`));
      }
    }

    const rawPath = entry.path;
    const path = typeof rawPath === 'string' ? normalizeRelativePath(rawPath) : undefined;
    if (path === undefined) {
      diagnostics.push(invalid(`${at}.path must be a relative path.`, `${at}.path`));
    }

    const rawOwner = entry.owner;
    const owner = rawOwner === 'generated' || rawOwner === 'business' ? rawOwner : undefined;
    if (owner === undefined) {
      diagnostics.push(invalid(`${at}.owner must be "generated" or "business".`, `${at}.owner`));
    }

    // A record whose owner contradicts its location would make drift decisions
    // depend on which field the reader happened to trust.
    if (path !== undefined && owner !== undefined) {
      const locationOwner = ownerForPath(path, options);
      if (locationOwner !== owner) {
        diagnostics.push(
          invalid(
            `${at}.owner is "${owner}" but "${path}" is a ${locationOwner ?? 'unmanaged'} path.`,
            `${at}.owner`,
          ),
        );
      }
    }

    const sha256 = entry.sha256;
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      diagnostics.push(
        invalid(`${at}.sha256 must be a lowercase 64-character hex digest.`, `${at}.sha256`),
      );
    }

    const generator = entry.generator;
    const generatorVersion = entry.generatorVersion;
    if (typeof generator !== 'string' || typeof generatorVersion !== 'string') {
      diagnostics.push(
        invalid(`${at}.generator and ${at}.generatorVersion must be strings.`, `${at}.generator`),
      );
    }

    // Tracked independently of the other fields, so a manifest that records one path
    // twice says so even when those records are also malformed.
    if (path !== undefined) {
      const previous = seen.get(path);
      if (previous === undefined) {
        seen.set(path, index);
      } else {
        diagnostics.push(
          invalid(`"${path}" is recorded twice (also at files[${previous}]).`, `${at}.path`),
        );
      }
    }

    if (diagnostics.length > before) {
      failed = true;
      continue;
    }

    if (
      path === undefined ||
      owner === undefined ||
      typeof sha256 !== 'string' ||
      typeof generator !== 'string' ||
      typeof generatorVersion !== 'string'
    ) {
      failed = true;
      continue;
    }

    records.push({ path, owner, sha256, generator, generatorVersion });
  }

  if (failed) return undefined;
  return sortByPath(records);
}

/**
 * The ejection ledger: generated paths a developer took ownership of. Only a path under
 * the generated root can be ejected — the entry exists to *stop* generation, and a
 * business path is already unmanaged.
 */
function parseEjected(
  value: unknown,
  diagnostics: GeneratorDiagnostic[],
  options: AidManifestPathOptions,
): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(invalid('aid.manifest.json "ejected" must be an array of paths.', 'ejected'));
    return undefined;
  }

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of value.entries()) {
    const at = `ejected[${index}]`;
    if (typeof entry !== 'string') {
      diagnostics.push(invalid(`${at} must be a repo-relative path string.`, at));
      continue;
    }

    const path = normalizeRelativePath(entry);
    if (path === undefined) {
      diagnostics.push(invalid(`${at} "${entry}" is not a usable relative path.`, at));
      continue;
    }

    if (ownerForPath(path, options) !== 'generated') {
      diagnostics.push(
        invalid(
          `${at} "${path}" is not under the generated root; only a generated path can be ejected.`,
          at,
        ),
      );
      continue;
    }

    if (seen.has(path)) {
      diagnostics.push(invalid(`${at} "${path}" is listed twice.`, at));
      continue;
    }

    seen.add(path);
    paths.push(path);
  }

  return paths;
}

/** Canonical serialization: sorted keys, sorted records, LF, exactly one trailing newline. */
export function serializeAidManifest(manifest: AidManifest): string {
  return `${canonicalJson({
    manifestVersion: manifest.manifestVersion,
    generatedBy: {
      generator: manifest.generatedBy.generator,
      generatorVersion: manifest.generatedBy.generatorVersion,
      irVersion: manifest.generatedBy.irVersion,
    },
    files: sortByPath(manifest.files).map((file) => ({
      path: file.path,
      owner: file.owner,
      sha256: file.sha256,
      generator: file.generator,
      generatorVersion: file.generatorVersion,
    })),
    // Omitted when empty so a manifest written before ejections existed keeps its exact
    // bytes on the next regeneration.
    ...(manifest.ejected.length === 0 ? {} : { ejected: [...manifest.ejected].sort() }),
  })}\n`;
}
