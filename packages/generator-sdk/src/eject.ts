/**
 * `aid eject` (§10): taking ownership of a generated file.
 *
 * Ejection is the developer's answer to the drift rule. When a generated file needs
 * hand-editing, the choice is to keep discarding the edits with `--force`, or to own the
 * file. Owning it means two things, and both are required:
 *
 *   1. **The bytes move to the business tier.** Ownership is decided by *where a path
 *      lives* (`ownership.ts`), not by a flag, so flipping ownership is a move from
 *      `<generatedDir>/x` to `<businessDir>/x`. A manifest flag alone would contradict
 *      the location rule the planner enforces.
 *   2. **The generated path is excluded forever.** The manifest records it in `ejected`,
 *      and `planRegeneration` drops it from every plan. Without this the next `gen` would
 *      simply recreate the generated file and the edit would be lost again.
 *
 * The write order is deliberate: destination first, source second. An interrupted eject
 * leaves two copies, never zero.
 *
 * Two refusals are not negotiable. Ejecting onto a business file with different bytes
 * would destroy developer-owned content — the one thing the ownership model protects —
 * so it fails and names the file to move aside. Ejecting a path the manifest never
 * recorded has nothing to transfer and is refused rather than manufacturing a business
 * file from an accident.
 */

import { type AidManifest, type AidManifestFile, manifestRecordFor } from './aid-manifest.js';
import { sha256Hex, sortByPath } from './determinism.js';
import {
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratorDiagnostic,
  generatorError,
} from './diagnostics.js';
import type { RegenerationSink } from './drift.js';
import {
  DEFAULT_BUSINESS_DIR,
  DEFAULT_GENERATED_DIR,
  normalizeRelativePath,
  ownerForPath,
} from './ownership.js';

export interface ManagedPathOptions {
  generatedDir?: string;
  businessDir?: string;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/**
 * The business-tier home of a generated path: `<generatedDir>/a/b.py` becomes
 * `<businessDir>/a/b.py`. Returns `undefined` for anything that is not a file directly
 * beneath the generated root, so a caller cannot "eject" a directory or a foreign path.
 */
export function businessPathFor(
  path: string,
  options: ManagedPathOptions = {},
): string | undefined {
  const normalized = normalizeRelativePath(path);
  if (normalized === undefined) return undefined;

  const generatedDir = stripTrailingSlashes(options.generatedDir ?? DEFAULT_GENERATED_DIR);
  const businessDir = stripTrailingSlashes(options.businessDir ?? DEFAULT_BUSINESS_DIR);

  if (!normalized.startsWith(`${generatedDir}/`)) return undefined;
  const rest = normalized.slice(generatedDir.length + 1);
  if (rest === '') return undefined;

  return `${businessDir}/${rest}`;
}

export type EjectStatus = 'ejected' | 'already-owned';

export interface EjectResult {
  readonly ok: boolean;
  /** `ejected` when ownership moved; `already-owned` when there was nothing to do. */
  readonly status?: EjectStatus;
  readonly from?: string;
  readonly to?: string;
  /** True when the destination did not exist and was written. False when it already held
   *  identical bytes (the transfer still removes the generated copy). */
  readonly written?: boolean;
  readonly dryRun?: boolean;
  /** The manifest to write. Absent when the request was refused. */
  readonly manifest?: AidManifest;
  readonly diagnostics: readonly GeneratorDiagnostic[];
}

export interface EjectRequest extends ManagedPathOptions {
  /** The generated path to take ownership of, repo-relative. */
  readonly path: string;
  readonly sink: RegenerationSink;
  readonly manifest: AidManifest | undefined;
  /** Report the move without writing anything. */
  readonly dryRun?: boolean;
}

function refuse(diagnostic: GeneratorDiagnostic): EjectResult {
  return { ok: false, diagnostics: [diagnostic] };
}

/**
 * Moves one generated file to the business tier and records a permanent exclusion.
 *
 * Idempotent by design: ejecting a path that is already developer-owned succeeds with
 * `status: 'already-owned'`, so a script can call it without first asking whether the
 * file was ejected.
 */
export function eject(request: EjectRequest): EjectResult {
  const dryRun = request.dryRun ?? false;

  const path = normalizeRelativePath(request.path);
  if (path === undefined) {
    return refuse(
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.ejectInvalidPath,
        message: `"${request.path}" is not a repo-relative path, so it cannot name a generated file.`,
        path: request.path,
        hint: 'Pass the path `aid gen` prints, for example `app/generated/prompts/triage.py`.',
      }),
    );
  }

  // Scaffold content is authored once and owned by the developer from then on, so there
  // is nothing to transfer and nothing to look up. Checked before the manifest guard: the
  // answer does not depend on the tree ever having been generated.
  if (ownerForPath(path, request) === 'scaffold') {
    return { ok: true, status: 'already-owned', from: path, dryRun, diagnostics: [] };
  }

  const manifest = request.manifest;
  if (manifest === undefined) {
    return refuse(
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.ejectNotGenerated,
        message:
          'There is no manifest, so this tree has never been generated and has nothing to eject.',
        hint: 'Run `aid gen` first; ejection transfers a file the generator wrote.',
      }),
    );
  }

  const record = manifestRecordFor(manifest, path);

  if (record === undefined) {
    // A business path the generator never planned is already owned by the developer;
    // asking to eject it is a no-op, not a mistake. The same is true of a generated path
    // already in the ledger: the file has moved, so there is no record left, and the
    // ledger is the only proof the transfer happened. Without this lookup a second eject
    // would report "not generated" for a file this command ejected itself. Scaffold paths
    // are handled above, before the manifest guard.
    if (ownerForPath(path, request) === 'business' || manifest.ejected.includes(path)) {
      return { ok: true, status: 'already-owned', from: path, dryRun, diagnostics: [] };
    }
    return refuse(
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.ejectNotGenerated,
        message: `"${path}" is not recorded in the manifest, so there is no generated artifact to take ownership of.`,
        path,
        hint: 'Eject a path the manifest lists as generated; `aid doctor` prints them.',
      }),
    );
  }

  if (record.owner === 'business') {
    return { ok: true, status: 'already-owned', from: record.path, dryRun, diagnostics: [] };
  }

  const to = businessPathFor(record.path, request);
  if (to === undefined) {
    return refuse(
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.ejectInvalidPath,
        message: `"${record.path}" has no business-tier counterpart under the configured roots.`,
        path: record.path,
      }),
    );
  }

  const content = request.sink.read(record.path);
  if (content === undefined) {
    return refuse(
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.ejectMissingFile,
        message: `"${record.path}" is recorded as generated but is missing from the tree.`,
        path: record.path,
        hint: 'Run `aid gen` to restore it, then eject.',
      }),
    );
  }

  const existing = request.sink.read(to);
  if (existing !== undefined && existing !== content) {
    return refuse(
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.ejectDestinationExists,
        message: `"${to}" already exists and differs from "${record.path}"; ejecting would overwrite developer-owned content.`,
        path: to,
        hint: 'Move or delete that file yourself, then run eject again.',
      }),
    );
  }

  const written = existing === undefined;
  if (!dryRun) {
    if (written) request.sink.write(to, content);
    request.sink.remove(record.path);
  }

  const businessRecord: AidManifestFile = {
    path: to,
    owner: 'business',
    sha256: sha256Hex(content),
    generator: record.generator,
    generatorVersion: record.generatorVersion,
  };

  return {
    ok: true,
    status: 'ejected',
    from: record.path,
    to,
    written,
    dryRun,
    manifest: {
      manifestVersion: manifest.manifestVersion,
      generatedBy: manifest.generatedBy,
      files: sortByPath([
        ...manifest.files.filter((file) => file.path !== record.path && file.path !== to),
        businessRecord,
      ]),
      // Sorted and de-duplicated: two routes to the same exclusion must not produce two
      // entries, and a stable order is what makes the manifest byte-comparable.
      ejected: [...new Set([...manifest.ejected, record.path])].sort(),
    },
    diagnostics: [],
  };
}
