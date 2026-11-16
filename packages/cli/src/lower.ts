/**
 * The half of the compile pipeline that needs nothing but text: parse the spec, build the
 * IR, and run every gate.
 *
 * It lives apart from `pipeline.ts` for one reason, and it is not layering: `pipeline.ts`
 * reads files and asks the generators what each target supports, so it cannot be loaded in
 * a browser. The specification visualiser runs *here*, on a page with no filesystem and no
 * installed CLI, and a visualiser that re-implemented a gate would sooner or later draw a
 * picture of a spec the compiler refuses.
 *
 * The capability declarations are a parameter rather than a lookup because they are the
 * generators' own declarations and the generators are node-only. Passing them in keeps one
 * gate with one implementation: the caller supplies what the build would have supplied, and
 * a caller that supplies nothing gets a capability gate that passes everything -- which is
 * why this function demands them rather than defaulting to the IR package's placeholder.
 */

import type { IR, TargetCapabilityDeclarations } from '@aid-framework/ir';
import { buildIR, runGates } from '@aid-framework/ir';
import { checkSpecText, hasErrors, sortDiagnostics } from '@aid-framework/spec';

import type { CliDiagnostic } from './diagnostics.js';

/** A stage that judged the project and said no. */
export interface Failed {
  readonly ok: false;
  readonly diagnostics: readonly CliDiagnostic[];
}

/** A spec that reduced to an IR the gates accepted. `diagnostics` holds its warnings. */
export interface Lowered {
  readonly ok: true;
  readonly ir: IR;
  readonly diagnostics: readonly CliDiagnostic[];
}

export type LowerOutcome = Lowered | Failed;

/**
 * Parse, build, and gate a spec held in memory.
 *
 * Stages stop at the first error, and warnings produced before the stop are kept: lowering
 * a spec whose own schema did not validate would report a cascade of consequences of the
 * first mistake, which buries it.
 */
export function lowerSpecWithCapabilities(
  text: string,
  file: string,
  capabilities: TargetCapabilityDeclarations,
): LowerOutcome {
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
  const gates = runGates(built.ir, { targetCapabilities: capabilities, file });
  diagnostics.push(...gates.diagnostics);
  if (hasErrors(gates.diagnostics)) {
    return { ok: false, diagnostics: sortDiagnostics(diagnostics) };
  }

  return { ok: true, ir: built.ir, diagnostics: sortDiagnostics(diagnostics) };
}
