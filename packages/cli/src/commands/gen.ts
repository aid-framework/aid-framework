/**
 * `aid gen` — compile the spec and reconcile the tree with it.
 *
 * Every decision about *what* changes belongs to `@aid-framework/generator-sdk`: `planRegeneration`
 * decides the actions, `regenerate` applies them, and the drift rule that refuses to
 * overwrite an edited generated file is the SDK's. The CLI decides four things and
 * nothing else: which target, which spec, whether to write, and what the run's exit code
 * means. In particular it does not re-derive ownership, re-hash a file, or re-implement
 * drift -- two implementations of that rule would eventually disagree, and the one that
 * disagreed would be the one holding a developer's edits.
 *
 * One deliberate divergence from `generate-example.mjs`, noted because it is a choice: the
 * manifest is written even when the run reports drift. `regenerate` records the *previous*
 * hash for a file it refused to overwrite, so a run that refuses an edit and a run that
 * discards one cannot disagree about what is on the tree; skipping the manifest write
 * instead leaves files that this run did create unrecorded, and the next run then reports
 * those as drift even though the generator was the one that wrote them.
 */

import type { RegenerationReport } from '@aid-framework/generator-sdk';
import {
  createNodeSink,
  formatRegenerationSummary,
  hasDrift,
  planRegeneration,
  regenerate,
  rejectionPath,
  serializeAidManifest,
} from '@aid-framework/generator-sdk';
import { hasErrors, sortDiagnostics } from '@aid-framework/spec';

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { compile, provenanceFor, readManifest, readSpec } from '../pipeline.js';
import type { Target } from '../targets.js';
import { resolveTarget, unknownTargetDiagnostic } from '../targets.js';

export interface GenerateOptions {
  readonly spec: string | undefined;
  readonly target: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
}

/** A spec that compiled and a plan that was reconciled, or the reason it was not. */
export interface GenerateSuccess {
  readonly target: Target;
  readonly specPath: string;
  readonly report: RegenerationReport;
  readonly warnings: readonly CliDiagnostic[];
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly manifestWritten: boolean;
}

function lines(label: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  return [label, ...paths.map((path) => `  ${path}`)];
}

function render(context: CliContext, options: GenerateOptions): CommandOutcome {
  const command = 'gen';
  const target = resolveTarget(options.target);
  if (target === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [unknownTargetDiagnostic(options.target ?? '')],
    });
  }

  const specPath = options.spec ?? target.specPath;
  const fields = { target: target.name, spec: specPath };

  const read = readSpec(context, specPath);
  if (!read.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: read.diagnostics });
  }

  const compiled = compile(read.text, specPath, target);
  if (!compiled.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: compiled.diagnostics });
  }

  const sink = createNodeSink(context.cwd);
  const manifest = readManifest(sink, target);
  if (!manifest.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: manifest.diagnostics });
  }

  const reconciliation = { sink, manifest: manifest.manifest, force: options.force };

  if (options.dryRun) {
    // A dry run takes the branch in which no write call exists at all, rather than the
    // branch that writes and is then trusted not to. `planRegeneration` is the SDK's
    // planner without its writer, so "writes nothing" is a property of the code path
    // and not a promise in a comment.
    return summarize({
      target,
      specPath,
      report: planRegeneration(compiled.plan, reconciliation),
      warnings: compiled.diagnostics,
      dryRun: true,
      force: options.force,
      manifestWritten: false,
    });
  }

  const applied = regenerate(compiled.plan, {
    ...reconciliation,
    provenance: provenanceFor(target, compiled.ir),
  });
  sink.write(target.manifestPath, serializeAidManifest(applied.manifest));

  return summarize({
    target,
    specPath,
    report: applied.report,
    warnings: compiled.diagnostics,
    dryRun: false,
    force: options.force,
    manifestWritten: true,
  });
}

/** The public entry point, and the one `aid init --gen` folds into its own report. */
export function generate(context: CliContext, options: GenerateOptions): CommandOutcome {
  return render(context, options);
}

function summarize(success: GenerateSuccess): CommandOutcome {
  const { report, target, specPath, warnings, dryRun, force, manifestWritten } = success;
  const diagnostics = sortDiagnostics([...warnings, ...report.diagnostics]);
  // Two ways to fail, and neither is redundant. `hasErrors` is the SDK's verdict on the
  // run; `hasDrift` is checked alongside it rather than instead of it because drift is
  // reported as an error today, and a gate that would stop failing if that changed is not
  // a gate -- and drift is the one failure that silently destroys a developer's edits.
  // `--force` is the caller answering it, so a run that discarded the edits did what it
  // was told and exits 0; only an unforced run leaves drift outstanding.
  const failed = hasErrors(diagnostics) || (!force && hasDrift(report));

  const text: string[] = [
    `${target.name}: ${dryRun ? 'dry run, ' : ''}${formatRegenerationSummary(report)}`,
  ];
  text.push(...lines('created:', report.created));
  text.push(...lines('updated:', report.updated));
  if (report.drifted.length > 0) {
    text.push(
      dryRun ? 'would refuse to overwrite:' : 'refused to overwrite, the new content is beside it:',
    );
    for (const drift of report.drifted) {
      text.push(`  ${drift.path}  ->  ${rejectionPath(drift.path)}`);
    }
  }
  text.push(...lines('no longer generated:', report.stale));

  return outcome({
    command: 'gen',
    exitCode: failed ? EXIT_FAILURE : EXIT_OK,
    diagnostics,
    text: text.join('\n'),
    fields: {
      target: target.name,
      spec: specPath,
      dryRun,
      manifest: { path: target.manifestPath, written: manifestWritten },
      changes: {
        created: report.created,
        updated: report.updated,
        unchanged: report.unchanged,
        kept: report.kept,
        // Paths, like every sibling here: the report answers "which files", and the
        // rejected content is on disk at the deterministic `rejectionPath` the human
        // summary prints. Mixing record objects into one entry and strings into the rest
        // makes the one shape a consumer has to special-case the one about conflicts.
        conflicts: report.drifted.map((file) => file.path),
        stale: report.stale,
        pruned: report.pruned,
      },
    },
  });
}
