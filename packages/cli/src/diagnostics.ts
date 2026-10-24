/**
 * Diagnostics, the one currency every layer already speaks.
 *
 * `@aid/spec` defines the shape and the renderer, and `@aid/ir` and
 * `@aid/generator-sdk` re-declare the same shape nominally with their own closed code
 * unions. The CLI reads all of them through the widened `Diagnostic<string>` view and
 * renders them with the spec package's renderer: it renames no code, re-ranks no
 * severity, and re-checks nothing a gate already decided.
 *
 * The codes below are the ones *this* layer originates -- a file that could not be
 * read, a target that does not exist, a Python interpreter that is not there. They
 * follow the same `<layer>/<slug>` convention so that a reader cannot tell which layer
 * produced a code from its shape, which is the point.
 */

import type { Diagnostic } from '@aid/spec';
import { errorDiagnostic, warningDiagnostic } from '@aid/spec';

/** The shared diagnostic shape, widened over the code union. */
export type CliDiagnostic = Diagnostic<string>;

export const CLI_DIAGNOSTIC_CODES = {
  specUnreadable: 'cli/spec-unreadable',
  unknownTarget: 'cli/unknown-target',
  refusingToOverwrite: 'cli/refusing-to-overwrite',
  pythonMissing: 'cli/python-missing',
  suiteNotFound: 'cli/suite-not-found',
  evalModulesMissing: 'cli/eval-modules-missing',
  retrieverRequired: 'cli/retriever-required',
  retrieverConflict: 'cli/retriever-conflict',
  retrieverNotFound: 'cli/retriever-not-found',
  ingestModulesMissing: 'cli/ingest-modules-missing',
  runnerFailed: 'cli/runner-failed',
  runnerWarned: 'cli/runner-warned',
} as const;

export type CliDiagnosticCode = (typeof CLI_DIAGNOSTIC_CODES)[keyof typeof CLI_DIAGNOSTIC_CODES];

export interface CliDiagnosticInit {
  readonly code: CliDiagnosticCode;
  readonly message: string;
  readonly path?: readonly string[];
  readonly hint?: string;
}

export function cliError(init: CliDiagnosticInit): CliDiagnostic {
  return errorDiagnostic({
    code: init.code,
    message: init.message,
    path: init.path ?? [],
    ...(init.hint === undefined ? {} : { hint: init.hint }),
  });
}

export function cliWarning(init: CliDiagnosticInit): CliDiagnostic {
  return warningDiagnostic({
    code: init.code,
    message: init.message,
    path: init.path ?? [],
    ...(init.hint === undefined ? {} : { hint: init.hint }),
  });
}
