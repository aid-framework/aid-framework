/**
 * Diagnostics, the one currency every layer already speaks.
 *
 * `@aid-framework/spec` defines the shape and the renderer, and `@aid-framework/ir` and
 * `@aid-framework/generator-sdk` re-declare the same shape nominally with their own closed code
 * unions. The CLI reads all of them through the widened `Diagnostic<string>` view and
 * renders them with the spec package's renderer: it renames no code, re-ranks no
 * severity, and re-checks nothing a gate already decided.
 *
 * The codes below are the ones *this* layer originates -- a file that could not be
 * read, a target that does not exist, a Python interpreter that is not there. They
 * follow the same `<layer>/<slug>` convention so that a reader cannot tell which layer
 * produced a code from its shape, which is the point.
 */

import type { Diagnostic } from '@aid-framework/spec';
import { errorDiagnostic, warningDiagnostic } from '@aid-framework/spec';

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
  runnerUnsupported: 'cli/runner-unsupported',
  runnerFailed: 'cli/runner-failed',
  runnerWarned: 'cli/runner-warned',
  // `aid doctor` originates these. The tree checks it reports through the SDK's own
  // codes (drift, stale) rather than these, so a reader sees one code per fact.
  manifestMissing: 'cli/manifest-missing',
  provenanceMismatch: 'cli/provenance-mismatch',
  versionMismatch: 'cli/version-mismatch',
  filesMissing: 'cli/files-missing',
  businessMissing: 'cli/business-missing',
  filesOutdated: 'cli/files-outdated',
  // `aid infra` originates these. A missing binary and a failed plan are separate codes
  // because they need different fixes; reporting both as "infra failed" would hide which.
  infraSubcommandRequired: 'cli/infra-subcommand-required',
  infraUnknownSubcommand: 'cli/infra-unknown-subcommand',
  infraUnknownIac: 'cli/infra-unknown-iac',
  infraUnknownCloud: 'cli/infra-unknown-cloud',
  infraCloudBackendUnsupported: 'cli/infra-cloud-backend-unsupported',
  infraCloudTargetUnsupported: 'cli/infra-cloud-target-unsupported',
  infraGuardrailUnsupported: 'cli/infra-guardrail-unsupported',
  infraKnowledgeBaseUnsupported: 'cli/infra-knowledge-base-unsupported',
  infraGeneratedOutdated: 'cli/infra-generated-outdated',
  infraNotGenerated: 'cli/infra-not-generated',
  infraEnvRootMissing: 'cli/infra-env-root-missing',
  infraTofuMissing: 'cli/infra-tofu-missing',
  infraTofuFailed: 'cli/infra-tofu-failed',
  infraCdkMissing: 'cli/infra-cdk-missing',
  infraCdkFailed: 'cli/infra-cdk-failed',
  infraDriftDetected: 'cli/infra-drift-detected',
  infraConfirmProdRequired: 'cli/infra-confirm-prod-required',
  // `aid eject` answers a path it cannot place. Every other refusal comes from the SDK
  // with a `generator/` code, so a reader can tell "you named the wrong tree" from
  // "this file cannot be ejected".
  ejectUnmanagedPath: 'cli/eject-unmanaged-path',
  // `aid cost` reads the runtime's local trace sink. The first two mean there is
  // nothing to read (exit 2); the last three describe a report that is incomplete or
  // empty, which is a fact about the traces rather than about the invocation.
  traceDirMissing: 'cli/trace-dir-missing',
  traceDirNotFound: 'cli/trace-dir-not-found',
  traceSinceInvalid: 'cli/trace-since-invalid',
  traceUnreadable: 'cli/trace-unreadable',
  traceMalformed: 'cli/trace-malformed',
  traceEmpty: 'cli/trace-empty',
  // `--budget` turns the report into a ceiling: a value that is not a non-negative
  // number is a wrong invocation (`2`), and measured spend above it is a verdict on the
  // traces (`1`) rather than on the project.
  costBudgetInvalid: 'cli/cost-budget-invalid',
  costOverBudget: 'cli/cost-over-budget',
  // `aid trace` selects one run out of those files. A selector that matches nothing, or
  // more than one, is a wrong invocation (`2`), not a verdict on the project.
  traceRunNotFound: 'cli/trace-run-not-found',
  traceRunAmbiguous: 'cli/trace-run-ambiguous',
  traceNoRuns: 'cli/trace-no-runs',
  traceFlagsConflict: 'cli/trace-flags-conflict',
  // `aid dev` starts the application's own server, so every failure here is about the
  // environment it needs or the address it was given -- not about the spec, which `gen`
  // has already validated by the time any of these can fire.
  devPortInvalid: 'cli/dev-port-invalid',
  devEntryMissing: 'cli/dev-entry-missing',
  devUvicornMissing: 'cli/dev-uvicorn-missing',
  // `aid guard` measures detection, so these separate a corpus the command could not
  // read or judge (`redTeam*`, `guardModuleMissing` -- exit 2 territory) from a measured
  // result that failed the gate (`guardRecall`, `guardFalsePositives`, exit 1).
  redTeamMissing: 'cli/red-team-missing',
  redTeamMalformed: 'cli/red-team-malformed',
  redTeamTooSmall: 'cli/red-team-too-small',
  guardNotDeclared: 'cli/guard-not-declared',
  guardModuleMissing: 'cli/guard-module-missing',
  guardCredentialsMissing: 'cli/guard-credentials-missing',
  guardPolicyUndeclared: 'cli/guard-policy-undeclared',
  guardRecall: 'cli/guard-recall',
  guardFalsePositives: 'cli/guard-false-positives',
  guardFixtureError: 'cli/guard-fixture-error',
  // `aid migrate` emits one shared table for every `pgvector` store, so two stores pinning
  // different dimensions cannot both be honoured; the warning names the conflict rather
  // than letting the file quietly pick one.
  migrateDimensionAmbiguous: 'cli/migrate-dimension-ambiguous',
  // `--out` is the only path the CLI lets a caller choose, so naming one outside the
  // project is an invocation error (exit 2) rather than something the tree can express.
  migrateOutEscapes: 'cli/migrate-out-escapes',
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
