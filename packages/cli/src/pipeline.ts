/**
 * The compile pipeline: read the spec, lower it to the IR, run every build-time gate,
 * then ask the target to compile it.
 *
 * This is the sequence `packages/generators/py-fastapi/scripts/generate-example.mjs`
 * already performs for the example app, and it is deliberately the *same* sequence
 * rather than a parallel one: every step is a call into `@aid/spec`, `@aid/ir`,
 * `@aid/generator-sdk` or `@aid/generator-py-fastapi`. The CLI introduces no gate, no
 * hash, no drift rule and no manifest reader of its own -- a second implementation of a
 * gate is a defect, because the two can disagree and only one of them will be right.
 *
 * Two behaviours worth stating because they are choices, not accidents:
 *
 * - Stages stop at the first error. Lowering a spec whose own schema did not validate
 *   would report a cascade of consequences of the first mistake, which buries it.
 *   Warnings produced before the stop are kept, because the design emits some
 *   deliberately -- the eval-coverage gate warns rather than fails.
 * - The target's compiler runs *before* its planner. `checkPlan` reports every problem
 *   at once; `plan` throws. Asking first is what lets `aid gen` print the target's own
 *   codes and paths instead of a stack trace with an exception dressed up as a
 *   diagnostic.
 */

import { readFileSync } from 'node:fs';
import {
  type AidManifest,
  type AidManifestProvenance,
  type Plan,
  parseAidManifestJson,
  type RegenerationSink,
} from '@aid/generator-sdk';
import type { IR } from '@aid/ir';
import { buildIR, runGates } from '@aid/ir';
import { checkSpecText, hasErrors, sortDiagnostics } from '@aid/spec';

import type { CliContext } from './context.js';
import type { CliDiagnostic } from './diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from './diagnostics.js';
import { absolutePath } from './paths.js';
import type { Target } from './targets.js';
import { targetCapabilities } from './targets.js';

/** A stage that judged the project and said no. */
export interface Failed {
  readonly ok: false;
  readonly diagnostics: readonly CliDiagnostic[];
}

export interface ReadSpec {
  readonly ok: true;
  readonly text: string;
}

/** A spec that reduced to an IR the gates accepted. `diagnostics` holds its warnings. */
export interface Lowered {
  readonly ok: true;
  readonly ir: IR;
  readonly diagnostics: readonly CliDiagnostic[];
}

export type LowerOutcome = Lowered | Failed;

/** A spec the target accepted, with the plan it produced. */
export interface Compiled {
  readonly ok: true;
  readonly ir: IR;
  readonly plan: Plan;
  readonly diagnostics: readonly CliDiagnostic[];
}

export type CompileOutcome = Compiled | Failed;

/** A manifest read back from the tree, or the diagnostics explaining why it was not. */
export interface ReadManifest {
  readonly ok: true;
  readonly manifest: AidManifest | undefined;
}

export type ManifestOutcome = ReadManifest | Failed;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readSpec(context: CliContext, specPath: string): ReadSpec | Failed {
  try {
    return { ok: true, text: readFileSync(absolutePath(context.cwd, specPath), 'utf8') };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.specUnreadable,
          message: `Cannot read the spec at "${specPath}": ${describeError(error)}`,
          path: [specPath],
          hint: 'Run `aid init` to scaffold a project, or pass the path to an existing spec.',
        }),
      ],
    };
  }
}

export function lowerSpec(text: string, file: string): LowerOutcome {
  const diagnostics: CliDiagnostic[] = [];

  const parsed = checkSpecText(text, { file });
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.ok || parsed.value === undefined) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  const built = buildIR(parsed.value, { file });
  diagnostics.push(...built.diagnostics);
  if (hasErrors(built.diagnostics)) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  // The gates take the *generators'* capability declarations, not the IR package's
  // placeholder: a gate run against a placeholder passes every spec and is not a gate.
  const gates = runGates(built.ir, { targetCapabilities: targetCapabilities(), file });
  diagnostics.push(...gates.diagnostics);
  if (hasErrors(gates.diagnostics)) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  return { ok: true, ir: built.ir, diagnostics: sortDiagnostics(diagnostics) };
}

export function compile(text: string, file: string, target: Target): CompileOutcome {
  const lowered = lowerSpec(text, file);
  if (!lowered.ok) return lowered;

  const problems = target.check(lowered.ir);
  const diagnostics = sortDiagnostics([...lowered.diagnostics, ...problems]);
  if (hasErrors(problems)) return { ok: false, diagnostics };

  return { ok: true, ir: lowered.ir, plan: target.plan(lowered.ir), diagnostics };
}

/**
 * The manifest the tree currently holds, read through the sink so that the path-escape
 * guard and the "missing file is `undefined`" contract are the SDK's rather than this
 * layer's. A manifest with an error in it is a failure, not a warning: generation
 * cannot tell a hand edit from its own output without it.
 */
export function readManifest(sink: RegenerationSink, target: Target): ManifestOutcome {
  const text = sink.read(target.manifestPath);
  if (text === undefined) return { ok: true, manifest: undefined };

  const parsed = parseAidManifestJson(text, {
    generatedDir: target.generatedDir,
    businessDir: target.businessDir,
  });
  if (parsed.manifest === undefined || hasErrors(parsed.diagnostics)) {
    return { ok: false, diagnostics: sortDiagnostics(parsed.diagnostics) };
  }
  return { ok: true, manifest: parsed.manifest };
}

/**
 * What the next manifest records about the run that wrote it, read off the target's own
 * manifest so that the generator identity in the manifest and the generator that ran
 * cannot disagree.
 */
export function provenanceFor(target: Target, ir: IR): AidManifestProvenance {
  return {
    generator: target.manifest.name,
    generatorVersion: target.manifest.version,
    irVersion: ir.irVersion,
  };
}
