/**
 * The two-phase generator contract (§8.1): `plan` is a pure function of the IR, and
 * `emit` turns a plan into committed bytes.
 *
 * The split is what makes the safety properties checkable before anything touches
 * disk. A plan is data — a set of repo-relative paths with owners — so ownership,
 * path escapes, and duplicates are all decided by `validatePlan` with no filesystem
 * involved. Drift detection then only has to answer one question per file: does the
 * content on disk still match the hash recorded from the last generation?
 */

import type { IR } from '@aid/ir';
import { sortDiagnostics } from '@aid/spec';

import {
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratorDiagnostic,
  generatorError,
} from './diagnostics.js';
import {
  DEFAULT_MANIFEST_FILENAME,
  escapesRoot,
  type FileOwner,
  isAbsolutePath,
  isReservedPath,
  normalizeRelativePath,
  ownerForPath,
} from './ownership.js';

export interface GeneratedFile {
  /** Repo-relative POSIX path. */
  path: string;
  content: string;
  owner: FileOwner;
  /** Replaced with `content`; absent means create-only-if-missing. */
  previousHash?: string;
}

export interface Plan {
  files: readonly GeneratedFile[];
}

export interface GeneratorContext {
  /** Version of the generator producing the output, recorded per file in the manifest. */
  generatorVersion: string;
  /** Repository root the plan's paths are relative to. */
  root: string;
}

export interface Generator {
  readonly name: string;
  readonly target: string;
  readonly version: string;
  readonly irRange: string;
  plan(ir: IR, context: GeneratorContext): Plan;
  emit(plan: Plan, context: GeneratorContext): readonly GeneratedFile[];
}

export interface PlanValidationOptions {
  generatedDir?: string;
  businessDir?: string;
  /** The manifest is generator bookkeeping, never a planned artifact. */
  manifestFilename?: string;
}

/**
 * Checks a plan before any of it is written. Every failure is reported at once —
 * a generator author fixing one path at a time per run is how drift bugs survive.
 */
export function validatePlan(
  plan: unknown,
  options: PlanValidationOptions = {},
): GeneratorDiagnostic[] {
  const manifestFilename = options.manifestFilename ?? DEFAULT_MANIFEST_FILENAME;
  const diagnostics: GeneratorDiagnostic[] = [];

  if (!isRecord(plan) || !Array.isArray(plan.files)) {
    return [
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.planNotAMapping,
        message: 'A plan must be an object with a `files` array.',
        path: 'plan.files',
      }),
    ];
  }

  if (plan.files.length === 0) {
    diagnostics.push(
      generatorError({
        code: GENERATOR_DIAGNOSTIC_CODES.planEmpty,
        message: 'A plan must contain at least one file; an empty plan hides a broken generator.',
        path: 'plan.files',
      }),
    );
  }

  const seen = new Map<string, number>();

  for (const [index, entry] of plan.files.entries()) {
    const at = `plan.files[${index}]`;
    if (!isRecord(entry)) {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planInvalidPath,
          message: `${at} must be an object with \`path\`, \`content\`, and \`owner\`.`,
          path: at,
        }),
      );
      continue;
    }

    if (typeof entry.path !== 'string') {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planInvalidPath,
          message: `${at}.path must be a string.`,
          path: `${at}.path`,
        }),
      );
      continue;
    }

    const raw = entry.path;
    if (isAbsolutePath(raw)) {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planInvalidPath,
          message: `${at}.path "${raw}" is absolute; plan paths are repo-relative.`,
          path: `${at}.path`,
        }),
      );
      continue;
    }

    if (escapesRoot(raw)) {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planInvalidPath,
          message: `${at}.path "${raw}" escapes the repository root.`,
          path: `${at}.path`,
        }),
      );
      continue;
    }

    const normalized = normalizeRelativePath(raw);
    if (normalized === undefined) {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planInvalidPath,
          message: `${at}.path "${raw}" is not a usable relative path.`,
          path: `${at}.path`,
        }),
      );
      continue;
    }

    if (isReservedPath(normalized, manifestFilename)) {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planInvalidPath,
          message: `${at}.path "${normalized}" is reserved by the generator; it is never planned.`,
          path: `${at}.path`,
        }),
      );
      continue;
    }

    const expectedOwner = ownerForPath(normalized, options);
    if (expectedOwner === undefined) {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planOwnerMismatch,
          message: `${at}.path "${normalized}" is outside the managed roots, so it has no owner.`,
          path: `${at}.path`,
          hint: 'Generated files belong under the generated root and business files under the business root.',
        }),
      );
      continue;
    }

    if (entry.owner !== expectedOwner) {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planOwnerMismatch,
          message: `${at}.owner is "${String(entry.owner)}" but "${normalized}" is a ${expectedOwner} path.`,
          path: `${at}.owner`,
        }),
      );
      continue;
    }

    if (typeof entry.content !== 'string') {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planInvalidPath,
          message: `${at}.content must be a string.`,
          path: `${at}.content`,
        }),
      );
      continue;
    }

    const first = seen.get(normalized);
    if (first !== undefined) {
      diagnostics.push(
        generatorError({
          code: GENERATOR_DIAGNOSTIC_CODES.planDuplicatePath,
          message: `"${normalized}" is planned twice (at plan.files[${first}]).`,
          path: `${at}.path`,
        }),
      );
      continue;
    }
    seen.set(normalized, index);
  }

  return sortDiagnostics(diagnostics);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
