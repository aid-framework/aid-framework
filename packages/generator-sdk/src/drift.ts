/**
 * Regeneration and drift (§10). This is the algorithm the whole ownership model exists
 * to support, so it is stated once, here, in terms of a plan, the previous manifest, and
 * a byte-level view of the tree:
 *
 *   1. Plan the new file set (already done; see {@link Plan}).
 *   2. For each planned `generated/` file: if it exists on disk and its hash is not the
 *      one recorded in the manifest, a human edited generated code. Do not overwrite it.
 *      Write the new content to `<path>.aid-rej` and fail with guidance.
 *   3. For each planned `business/` file: create only if missing. Never overwrite.
 *   4. Write atomically; update the manifest.
 *   5. Report created / updated / unchanged / conflicts.
 *
 * The rule that makes this worth having is step 2. A generator that overwrites
 * `generated/` unconditionally destroys the one signal it has that a human disagreed
 * with it, and the loss is silent. Refusing, keeping the rejected bytes alongside the
 * file, and naming the two escapes (`aid eject <path>` to take ownership, `--force` to
 * discard the edits) turns a silent data loss into a decision.
 *
 * Two limits are deliberate. A planned file that is *newer* than the manifest but has no
 * record at all is treated as drift, not as a file to adopt — an unrecorded file under
 * `generated/` cannot be proven unmodified. And stale generated files (recorded, but no
 * longer planned) are reported but not deleted unless `prune` is requested explicitly,
 * because deletion is the one operation with no recovery.
 */

import { sortDiagnostics } from '@aid/spec';

import {
  AID_MANIFEST_VERSION,
  type AidManifest,
  type AidManifestFile,
  type AidManifestProvenance,
  manifestRecordFor,
} from './aid-manifest.js';
import { sha256Hex, sortByPath } from './determinism.js';
import {
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratorDiagnostic,
  generatorError,
  generatorWarning,
} from './diagnostics.js';
import { type FileOwner, rejectionPath } from './ownership.js';
import type { GeneratedFile, Plan } from './plan.js';

/** The byte-level view of the tree. Tests pass an in-memory map; real runs use the filesystem. */
export interface RegenerationSink {
  read(path: string): string | undefined;
  write(path: string, content: string): void;
  remove(path: string): void;
}

export interface DriftedFile {
  path: string;
  /** The hash the last generation recorded; absent when the file was never recorded. */
  recordedSha256?: string;
  actualSha256: string;
}

export type RegenerationAction =
  | { kind: 'create'; path: string; owner: FileOwner }
  | { kind: 'update'; path: string; owner: FileOwner }
  | { kind: 'unchanged'; path: string; owner: FileOwner }
  | { kind: 'keep-business'; path: string }
  | {
      kind: 'drift';
      path: string;
      recordedSha256?: string;
      actualSha256: string;
    };

export interface RegenerationReport {
  actions: readonly RegenerationAction[];
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Business files that already existed and were left exactly as they were. */
  kept: string[];
  drifted: DriftedFile[];
  /** Recorded generated files that are no longer planned. */
  stale: string[];
  /** Subset of {@link stale} that this run deleted, when `prune` was set. */
  pruned: string[];
  diagnostics: GeneratorDiagnostic[];
}

export interface RegenerationOptions {
  sink: RegenerationSink;
  manifest?: AidManifest;
  /** Discard hand edits to generated files instead of refusing. */
  force?: boolean;
  /** Delete stale generated files instead of only reporting them. */
  prune?: boolean;
}

export function planRegeneration(plan: Plan, options: RegenerationOptions): RegenerationReport {
  const force = options.force ?? false;
  const manifest = options.manifest;
  const diagnostics: GeneratorDiagnostic[] = [];

  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const kept: string[] = [];
  const drifted: DriftedFile[] = [];
  const actions: RegenerationAction[] = [];

  for (const file of sortByPath(plan.files)) {
    const actual = options.sink.read(file.path);

    if (file.owner === 'business') {
      if (actual === undefined) {
        created.push(file.path);
        actions.push({ kind: 'create', path: file.path, owner: 'business' });
      } else {
        // Step 3: developer-owned content is created once and never overwritten. This is
        // not a conflict — it is the intended steady state.
        kept.push(file.path);
        actions.push({ kind: 'keep-business', path: file.path });
      }
      continue;
    }

    const recorded = manifestRecordFor(manifest, file.path);

    if (actual === undefined) {
      created.push(file.path);
      actions.push({ kind: 'create', path: file.path, owner: 'generated' });
      continue;
    }

    const actualSha256 = sha256Hex(actual);

    if (recorded === undefined || recorded.sha256 !== actualSha256) {
      const drift = {
        path: file.path,
        ...(recorded === undefined ? {} : { recordedSha256: recorded.sha256 }),
        actualSha256,
      };
      drifted.push(drift);
      actions.push({ kind: 'drift', ...drift });
      const init = {
        code: GENERATOR_DIAGNOSTIC_CODES.generatedDrift,
        message:
          recorded === undefined
            ? `"${file.path}" exists under the generated root but is not recorded in the manifest, so it cannot be safely regenerated.`
            : `"${file.path}" was modified after generation (recorded ${recorded.sha256}, found ${actualSha256}).`,
        path: file.path,
        hint: force
          ? `--force discards the local edits and rewrites "${file.path}" from the plan.`
          : `Run \`aid eject ${file.path}\` to own the file, or regenerate with --force to discard the edits. The new content is written to ${rejectionPath(file.path)}.`,
      };
      // Refusing is an error the caller must resolve; --force is the caller resolving it.
      diagnostics.push(force ? generatorWarning(init) : generatorError(init));
      continue;
    }

    if (actualSha256 === sha256Hex(file.content)) {
      unchanged.push(file.path);
      actions.push({ kind: 'unchanged', path: file.path, owner: 'generated' });
      continue;
    }

    updated.push(file.path);
    actions.push({ kind: 'update', path: file.path, owner: 'generated' });
  }

  const stale = staleGeneratedFiles(plan, manifest);
  for (const path of stale) {
    diagnostics.push(
      generatorWarning({
        code: GENERATOR_DIAGNOSTIC_CODES.generatedDrift,
        message: `"${path}" was generated by "${manifest?.generatedBy.generator ?? 'a previous generator'}" but is no longer planned.`,
        path,
        hint: force
          ? 'Pass --prune to delete stale generated files.'
          : 'Stale files under the generated root break the invariant that the manifest lists exactly what the generator owns.',
      }),
    );
  }

  return {
    actions,
    created,
    updated,
    unchanged,
    kept,
    drifted,
    stale,
    pruned: [],
    diagnostics: sortDiagnostics(diagnostics),
  };
}

/**
 * Generated files the manifest records that the plan no longer contains. Business files
 * are excluded: a generator is expected to stop planning one once a developer takes it
 * over, and flagging that would punish the intended path.
 */
export function staleGeneratedFiles(plan: Plan, manifest: AidManifest | undefined): string[] {
  if (manifest === undefined) return [];
  const planned = new Set(plan.files.map((file) => file.path));
  return sortByPath(
    manifest.files.filter((file) => file.owner === 'generated' && !planned.has(file.path)),
  ).map((file) => file.path);
}

export interface RegenerationResult {
  report: RegenerationReport;
  manifest: AidManifest;
}

/**
 * Plans, then applies. Drifted generated files are never written unless `force` is set;
 * their newly generated content goes to `<path>.aid-rej` instead, and an error-severity
 * diagnostic is returned so a caller cannot mistake the run for a success.
 */
export function regenerate(
  plan: Plan,
  options: RegenerationOptions & { provenance: AidManifestProvenance },
): RegenerationResult {
  const force = options.force ?? false;
  const prune = options.prune ?? false;
  const report = planRegeneration(plan, options);

  const byPath = new Map(sortByPath(plan.files).map((file) => [file.path, file]));
  const driftedPaths = new Set(report.drifted.map((drift) => drift.path));

  for (const action of report.actions) {
    if (action.kind === 'create' || action.kind === 'update') {
      const file = byPath.get(action.path);
      if (file !== undefined) options.sink.write(file.path, file.content);
      continue;
    }

    if (action.kind === 'drift') {
      const file = byPath.get(action.path);
      if (file === undefined) continue;
      if (force) {
        options.sink.write(file.path, file.content);
        options.sink.remove(rejectionPath(file.path));
      } else {
        options.sink.write(rejectionPath(file.path), file.content);
      }
    }
  }

  const pruned: string[] = [];
  if (prune) {
    for (const path of report.stale) {
      options.sink.remove(path);
      pruned.push(path);
    }
  }

  const finalReport: RegenerationReport = {
    ...report,
    pruned: sortByPath(pruned.map((path) => ({ path }))).map((entry) => entry.path),
  };

  return {
    report: finalReport,
    manifest: nextManifest({
      plan,
      previous: options.manifest,
      provenance: options.provenance,
      driftedPaths,
      force,
      prunedPaths: new Set(finalReport.pruned),
      sink: options.sink,
    }),
  };
}

interface NextManifestInput {
  plan: Plan;
  previous: AidManifest | undefined;
  provenance: AidManifestProvenance;
  driftedPaths: ReadonlySet<string>;
  force: boolean;
  prunedPaths: ReadonlySet<string>;
  sink: RegenerationSink;
}

/**
 * The manifest after a run. Two deliberate asymmetries:
 *
 * - A drifted file keeps its previous record, because the bytes on disk are still the
 *   developer's edits and claiming the generated hash would erase the drift on the next
 *   run — silently, which is the exact failure this module exists to prevent.
 * - A business file's hash is read from disk rather than from the plan. The dev owns the
 *   content, so recording what is actually there is the only honest answer; recording the
 *   plan's hash would make the manifest disagree with the tree from the moment it is
 *   written.
 */
function nextManifest(input: NextManifestInput): AidManifest {
  const records: AidManifestFile[] = [];

  for (const file of sortByPath(input.plan.files)) {
    if (input.prunedPaths.has(file.path)) continue;

    const previous = manifestRecordFor(input.previous, file.path);

    if (file.owner === 'business') {
      const onDisk = input.sink.read(file.path);
      records.push(
        previous !== undefined
          ? previous
          : {
              path: file.path,
              owner: 'business',
              sha256: sha256Hex(onDisk ?? file.content),
              generator: input.provenance.generator,
              generatorVersion: input.provenance.generatorVersion,
            },
      );
      continue;
    }

    if (input.driftedPaths.has(file.path) && !input.force) {
      if (previous !== undefined) records.push(previous);
      continue;
    }

    records.push({
      path: file.path,
      owner: 'generated',
      sha256: sha256Hex(file.content),
      generator: input.provenance.generator,
      generatorVersion: input.provenance.generatorVersion,
    });
  }

  return {
    manifestVersion: AID_MANIFEST_VERSION,
    generatedBy: input.provenance,
    files: sortByPath(records),
  };
}

/**
 * Drift check without writing anything: the shape a CI gate or `aid gen --check` wants.
 * `regenerate` reports the same diagnostics; this exists so a caller cannot accidentally
 * write while only trying to verify.
 */
export function checkDrift(plan: Plan, options: RegenerationOptions): GeneratorDiagnostic[] {
  return planRegeneration(plan, options).diagnostics;
}

/** Human-readable one-line summary of what a run did, in reporting order. */
export function formatRegenerationSummary(report: RegenerationReport): string {
  const parts = [
    `${report.created.length} created`,
    `${report.updated.length} updated`,
    `${report.unchanged.length} unchanged`,
    `${report.kept.length} kept`,
  ];
  if (report.drifted.length > 0) parts.push(`${report.drifted.length} conflicts`);
  if (report.stale.length > 0) parts.push(`${report.stale.length} stale`);
  return parts.join(', ');
}

export function hasDrift(report: RegenerationReport): boolean {
  return report.drifted.length > 0;
}

export function generatedFiles(files: readonly GeneratedFile[]): GeneratedFile[] {
  return sortByPath(files.filter((file) => file.owner === 'generated'));
}
