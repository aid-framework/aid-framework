/**
 * Reading an overlay off disk and resolving it into a concrete spec.
 *
 * `@aid-framework/spec` owns the rules -- what an overlay may say, which paths it may move,
 * what counts as a weakening. This module owns the part the spec package deliberately
 * refuses: the filesystem. It opens the overlay, opens the base the overlay names, feeds
 * the two through `applyOverlay`, and then asks the ordinary pipeline whether the result
 * is a specification the gates accept. That ordering is the whole design: the overlay is
 * judged by the same `buildIR` and the same 25 gates every other spec faces, so a
 * customer cannot buy a weaker specification by arriving through an overlay.
 *
 * `overlay/base-missing` is the one overlay diagnostic emitted here rather than in the
 * spec package, because only this layer can stat a file. It is still an `overlay/` code:
 * the diagnosis is "your overlay does not add up", not "the CLI is misconfigured".
 */

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { IR } from '@aid-framework/ir';
import {
  applyOverlay,
  type Diagnostic,
  errorDiagnostic,
  hasErrors,
  OVERLAY_DIAGNOSTIC_CODES,
  type OverlayDocument,
  parseOverlay,
  parseOverlayBase,
  serializeResolved,
  sortDiagnostics,
} from '@aid-framework/spec';

import type { CliContext } from './context.js';
import type { CliDiagnostic } from './diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from './diagnostics.js';
import { absolutePath, parentPath } from './paths.js';
import { lowerSpec } from './pipeline.js';

/**
 * The artifact path for an overlay's resolved spec: `customers/acme.yaml` resolves to
 * `customers/acme.spec.yaml`.
 *
 * It is derived, never configured, so that `aid fleet` and `aid resolve` agree about where
 * the artifact belongs without a second source of truth. The `.spec.yaml` suffix is the
 * one the rest of the repository already uses for a specification, which is what the
 * resolved document is.
 */
export function resolvedPathOf(overlayPath: string): string {
  const withoutExtension = overlayPath.replace(/\.(ya?ml)$/, '');
  return `${withoutExtension}.spec.yaml`;
}

/**
 * The path an overlay's `base` names, read relative to the overlay's own directory.
 *
 * Relative to the overlay rather than to the working directory, because an overlay is a
 * document about a base and both live in the repository: `customers/acme.yaml` naming
 * `../app.spec.yaml` means the same thing whether it was resolved from the repository
 * root or from inside `customers/`.
 */
export function basePathOf(overlayPath: string, base: string): string {
  if (posix.isAbsolute(base)) return base;
  const directory = parentPath(overlayPath);
  return posix.normalize(directory === '' ? base : posix.join(directory, base));
}

export interface ResolvedOverlay {
  /** The overlay file, repository-relative. */
  readonly overlayPath: string;
  /** Where the resolved spec belongs. Derived from {@link resolvedPathOf}. */
  readonly resolvedPath: string;
  /** The customer the overlay declares, when it parsed far enough to say. */
  readonly customer?: string;
  /** True when the overlay resolved into a spec every gate accepted. */
  readonly ok: boolean;
  /** The applied override paths, in declaration order. */
  readonly applied: readonly string[];
  /**
   * The resolved document, whenever resolution produced one -- even when a later gate
   * refused the result. `aid fleet` reads a customer's pinned models and ceilings off it
   * without asking the gates a second time.
   */
  readonly value?: unknown;
  /** The resolved specification as YAML; present whenever resolution produced a document. */
  readonly text?: string;
  /** The IR of the resolved specification, present when it passed every gate. */
  readonly ir?: IR;
  readonly diagnostics: readonly CliDiagnostic[];
}

function describeReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readText(context: CliContext, path: string): { text?: string; error?: string } {
  try {
    return { text: readFileSync(absolutePath(context.cwd, path), 'utf8') };
  } catch (error) {
    return { error: describeReadError(error) };
  }
}

/**
 * Resolves one overlay against its base and runs the full pipeline on the result.
 *
 * Stops at the first stage that produced an error, the way every other command does, so a
 * refused overlay reports the reason rather than the cascade behind it.
 */
export function resolveOverlay(context: CliContext, overlayPath: string): ResolvedOverlay {
  const resolvedPath = resolvedPathOf(overlayPath);
  const refuse = (
    diagnostics: readonly CliDiagnostic[],
    extra: { customer?: string; text?: string; applied?: readonly string[]; value?: unknown } = {},
  ): ResolvedOverlay => ({
    overlayPath,
    resolvedPath,
    ok: false,
    applied: extra.applied ?? [],
    diagnostics: sortDiagnostics([...diagnostics]),
    ...(extra.customer === undefined ? {} : { customer: extra.customer }),
    ...(extra.text === undefined ? {} : { text: extra.text }),
    ...(extra.value === undefined ? {} : { value: extra.value }),
  });

  const overlayFile = readText(context, overlayPath);
  if (overlayFile.text === undefined) {
    return refuse([
      cliError({
        code: CLI_DIAGNOSTIC_CODES.overlayUnreadable,
        message: `Cannot read the overlay at "${overlayPath}": ${overlayFile.error ?? 'unknown error'}`,
        path: [overlayPath],
        hint: 'Pass the path to an overlay file: `aid resolve customers/acme.yaml`.',
      }),
    ]);
  }

  const parsed = parseOverlay(overlayFile.text, { file: overlayPath });
  if (parsed.overlay === undefined || hasErrors(parsed.diagnostics)) {
    return refuse(parsed.diagnostics);
  }
  const overlay: OverlayDocument = parsed.overlay;

  const basePath = basePathOf(overlayPath, overlay.base);
  const baseFile = readText(context, basePath);
  if (baseFile.text === undefined) {
    return refuse(
      [
        errorDiagnostic({
          code: OVERLAY_DIAGNOSTIC_CODES.baseMissing,
          message: `the overlay gate rejected "${overlay.customer}": base "${overlay.base}" does not exist`,
          path: ['base'],
          hint: 'check the relative path from the overlay file',
          ...{ file: overlayPath },
        }),
      ],
      { customer: overlay.customer },
    );
  }

  const base = parseOverlayBase(baseFile.text, { file: basePath });
  if (base.diagnostics.length > 0) {
    return refuse(base.diagnostics, { customer: overlay.customer });
  }

  const applied = applyOverlay(base.value, overlay, { file: overlayPath });
  const text = serializeResolved(applied.value);
  const resolvedValue = applied.value;
  if (hasErrors(applied.diagnostics)) {
    return refuse(applied.diagnostics, {
      customer: overlay.customer,
      text,
      applied: applied.applied,
      value: resolvedValue,
    });
  }

  // The resolved document is judged under the name of the artifact it becomes, so a
  // refusal points at the file a reader will open next.
  const lowered = lowerSpec(text, resolvedPath);
  const diagnostics: Diagnostic<string>[] = [...applied.diagnostics, ...lowered.diagnostics];
  if (!lowered.ok) {
    return refuse(diagnostics, {
      customer: overlay.customer,
      text,
      applied: applied.applied,
      value: resolvedValue,
    });
  }

  return {
    overlayPath,
    resolvedPath,
    customer: overlay.customer,
    ok: true,
    applied: applied.applied,
    text,
    value: resolvedValue,
    ir: lowered.ir,
    diagnostics: sortDiagnostics(diagnostics),
  };
}
