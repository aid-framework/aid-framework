/**
 * `aid eject` — take ownership of a generated file (§10).
 *
 * The CLI's whole job here is to decide *which managed tree* the path belongs to and to
 * write the manifest afterwards. The decision that matters — that ownership is a move to
 * the business tier plus a permanent exclusion, and that neither half is optional — is
 * `@aid-framework/generator-sdk`'s `eject`, so `aid gen`, `aid doctor` and this command cannot
 * disagree about what "ejected" means.
 *
 * Two trees own paths, so the path selects the tree rather than a flag: `app/...` is the
 * spec target's tree, `infra/...` is the infra emitter's (§12.2 spells `aid eject
 * infra/...`). `--target` only disambiguates which generator's manifest to read when a
 * tree could belong to more than one target; today both Phase 0 targets use `app/`, so it
 * changes nothing but the diagnostic wording. A path under neither root is a usage
 * mistake, not a missing file.
 */

import type { AidManifest, RegenerationSink } from '@aid-framework/generator-sdk';
import {
  createNodeSink,
  eject as ejectPath,
  normalizeRelativePath,
  parseAidManifestJson,
  serializeAidManifest,
} from '@aid-framework/generator-sdk';
import { hasErrors, sortDiagnostics } from '@aid-framework/spec';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import { INFRA_GENERATED_DIR, INFRA_MANIFEST_PATH } from '../infra/emit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { readManifest } from '../pipeline.js';
import type { Target } from '../targets.js';
import { resolveTarget, TARGETS, unknownTargetDiagnostic } from '../targets.js';

/** The infra emitter's business root, parallel to the app target's `app/business`. */
const INFRA_BUSINESS_DIR = 'infra/business';

export interface EjectOptions {
  /** The generated path to take ownership of. */
  readonly path: string | undefined;
  readonly target: string | undefined;
  /** Report the move without writing anything. */
  readonly dryRun: boolean;
}

type ManagedTree =
  | { readonly kind: 'target'; readonly target: Target }
  | { readonly kind: 'infra' };

function stripTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

function under(path: string, dir: string): boolean {
  return path.startsWith(`${stripTrailingSlash(dir)}/`);
}

/** Which managed tree `path` lives in, or `undefined` when it lives in neither. */
function managedTree(path: string, options: EjectOptions): ManagedTree | undefined {
  if (under(path, INFRA_GENERATED_DIR) || under(path, INFRA_BUSINESS_DIR)) {
    return { kind: 'infra' };
  }

  const target = resolveTarget(options.target);
  if (target === undefined) return undefined;
  if (under(path, target.generatedDir) || under(path, target.businessDir)) {
    return { kind: 'target', target };
  }
  return undefined;
}

/** Every generated and business root this CLI knows, for the unmanaged-path hint. */
function managedRootsHint(): string {
  const roots = new Set<string>();
  for (const target of TARGETS) {
    roots.add(target.generatedDir);
    roots.add(target.businessDir);
  }
  roots.add(INFRA_GENERATED_DIR);
  roots.add(INFRA_BUSINESS_DIR);
  return [...roots].sort().join(', ');
}

interface ReadTreeManifest {
  readonly ok: true;
  readonly manifest: AidManifest | undefined;
  readonly manifestPath: string;
}

interface UnreadableTreeManifest {
  readonly ok: false;
  readonly diagnostics: readonly CliDiagnostic[];
}

function readTreeManifest(
  sink: RegenerationSink,
  tree: ManagedTree,
): ReadTreeManifest | UnreadableTreeManifest {
  if (tree.kind === 'target') {
    const read = readManifest(sink, tree.target);
    return read.ok
      ? { ok: true, manifest: read.manifest, manifestPath: tree.target.manifestPath }
      : { ok: false, diagnostics: read.diagnostics };
  }

  const text = sink.read(INFRA_MANIFEST_PATH);
  if (text === undefined) {
    return { ok: true, manifest: undefined, manifestPath: INFRA_MANIFEST_PATH };
  }

  // The same parser and the same roots the infra emitter wrote with, so an infra path
  // satisfies the ownership rule exactly as `aid infra gen` wrote it.
  const parsed = parseAidManifestJson(text, {
    generatedDir: INFRA_GENERATED_DIR,
    businessDir: INFRA_BUSINESS_DIR,
  });
  if (parsed.manifest === undefined || hasErrors(parsed.diagnostics)) {
    return { ok: false, diagnostics: sortDiagnostics(parsed.diagnostics) };
  }
  return { ok: true, manifest: parsed.manifest, manifestPath: INFRA_MANIFEST_PATH };
}

export function eject(context: CliContext, options: EjectOptions): CommandOutcome {
  const command = 'eject';
  const raw = options.path?.trim() ?? '';
  const fields = { path: raw, dryRun: options.dryRun };

  if (raw === '') {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.ejectUnmanagedPath,
          message: 'eject needs the path of a generated file.',
          hint: 'For example: aid eject app/generated/prompts/triage.py',
        }),
      ],
    });
  }

  if (options.target !== undefined && resolveTarget(options.target) === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [unknownTargetDiagnostic(options.target)],
    });
  }

  const path = normalizeRelativePath(raw);
  if (path === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.ejectUnmanagedPath,
          message: `"${raw}" is not a path relative to the project root.`,
          path: [raw],
          hint: `Managed roots: ${managedRootsHint()}.`,
        }),
      ],
    });
  }

  const tree = managedTree(path, options);
  if (tree === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.ejectUnmanagedPath,
          message: `"${path}" is not under a generated or business root.`,
          path: [path],
          hint: `Managed roots: ${managedRootsHint()}.`,
        }),
      ],
    });
  }

  const sink = createNodeSink(context.cwd);
  const read = readTreeManifest(sink, tree);
  if (!read.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: read.diagnostics });
  }

  const result = ejectPath({
    path,
    sink,
    manifest: read.manifest,
    ...(tree.kind === 'target'
      ? { generatedDir: tree.target.generatedDir, businessDir: tree.target.businessDir }
      : { generatedDir: INFRA_GENERATED_DIR, businessDir: INFRA_BUSINESS_DIR }),
    ...(options.dryRun ? { dryRun: true } : {}),
  });

  if (!result.ok) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: sortDiagnostics(result.diagnostics),
    });
  }

  // Checked before the manifest, because an idempotent `already-owned` result carries no
  // new manifest and requiring one would turn success into a failure.
  if (result.status === 'already-owned') {
    return outcome({
      command,
      exitCode: EXIT_OK,
      diagnostics: [],
      text: `${result.from ?? path} is already developer-owned; nothing to do.`,
      fields: { ...fields, path, status: result.status },
    });
  }

  if (result.manifest === undefined) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: sortDiagnostics(result.diagnostics),
    });
  }

  const written = !options.dryRun;
  if (written) sink.write(read.manifestPath, serializeAidManifest(result.manifest));

  return outcome({
    command,
    exitCode: EXIT_OK,
    diagnostics: [],
    text: [
      options.dryRun
        ? `would eject ${result.from} -> ${result.to}`
        : `ejected ${result.from} -> ${result.to}`,
      written
        ? `${result.from} is now permanently excluded from generation.`
        : 'nothing was written (--dry-run).',
    ].join('\n'),
    fields: {
      ...fields,
      path,
      status: result.status,
      from: result.from,
      to: result.to,
      written: result.written,
      manifest: { path: read.manifestPath, written },
    },
  });
}
