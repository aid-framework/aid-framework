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

import type { DiagnosticMetadata } from '@aid-framework/ir';
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
  // `aid eval --record` asks a generated eval module to keep its model calls. Only an
  // agent eval can: it is the only kind that calls a model through a provider mapping it
  // builds itself. Asking a prompt eval to record would print nothing and write nothing,
  // which reads as success, so the request is refused instead.
  evalRecordUnsupported: 'cli/eval-record-unsupported',
  // `aid eval --compare` originates these. The split is the usual one: a comparison with
  // no policy, with two possible verdicts, with a baseline that cannot be read, or across
  // two datasets judged nothing and exits 2; a candidate that regressed, or a required
  // approval that is not in the tree, is a refusal and exits 1.
  compareNoPolicy: 'cli/eval-compare-no-policy',
  compareSuiteRequired: 'cli/eval-compare-suite-required',
  comparePairRequired: 'cli/eval-compare-pair-required',
  compareUnreadable: 'cli/eval-compare-unreadable',
  compareMismatch: 'cli/eval-compare-mismatch',
  compareRegressed: 'cli/eval-compare-regressed',
  compareCostRegressed: 'cli/eval-compare-cost-regressed',
  compareApprovalMissing: 'cli/eval-compare-approval-missing',
  compareCostUnjudged: 'cli/eval-compare-cost-unjudged',
  retrieverRequired: 'cli/retriever-required',
  retrieverConflict: 'cli/retriever-conflict',
  retrieverNotFound: 'cli/retriever-not-found',
  ingestModulesMissing: 'cli/ingest-modules-missing',
  runnerUnsupported: 'cli/runner-unsupported',
  runnerFailed: 'cli/runner-failed',
  runnerWarned: 'cli/runner-warned',
  // `aid kb` originates these. The split is the same one `aid ingest` draws: a
  // subcommand that is missing or unknown, a retriever that is not managed, and an
  // engine with no ingestion job are all "nothing was judged" -- the command had no
  // work it could do -- so they exit 2. A missing generated module is a project that
  // has not been generated, which is a well-formed request that cannot do its job, so
  // it exits 1 and points at `aid gen`.
  kbSubcommandRequired: 'cli/kb-subcommand-required',
  kbUnknownSubcommand: 'cli/kb-unknown-subcommand',
  kbRetrieverNotManaged: 'cli/kb-retriever-not-managed',
  kbSyncModulesMissing: 'cli/kb-sync-modules-missing',
  kbEngineUnsupported: 'cli/kb-engine-unsupported',
  // `aid doctor` originates these. The tree checks it reports through the SDK's own
  // codes (drift, stale) rather than these, so a reader sees one code per fact.
  manifestMissing: 'cli/manifest-missing',
  provenanceMismatch: 'cli/provenance-mismatch',
  versionMismatch: 'cli/version-mismatch',
  filesMissing: 'cli/files-missing',
  businessMissing: 'cli/business-missing',
  filesOutdated: 'cli/files-outdated',
  // The one fact about observability that no gate can see: the meters are installed from
  // the entrypoint, which belongs to the developer. A document may declare an alert whose
  // series nothing publishes, and that reports *no data*, which reads as healthy.
  metricsUninstalled: 'cli/metrics-uninstalled',
  // `aid infra` originates these. A missing binary and a failed plan are separate codes
  // because they need different fixes; reporting both as "infra failed" would hide which.
  infraSubcommandRequired: 'cli/infra-subcommand-required',
  infraUnknownSubcommand: 'cli/infra-unknown-subcommand',
  infraUnknownIac: 'cli/infra-unknown-iac',
  infraUnknownCloud: 'cli/infra-unknown-cloud',
  infraCloudConflict: 'cli/infra-cloud-conflict',
  infraCloudBackendUnsupported: 'cli/infra-cloud-backend-unsupported',
  infraCloudTargetUnsupported: 'cli/infra-cloud-target-unsupported',
  infraGuardrailUnsupported: 'cli/infra-guardrail-unsupported',
  infraKnowledgeBaseUnsupported: 'cli/infra-knowledge-base-unsupported',
  infraRuntimeUnsupported: 'cli/infra-runtime-unsupported',
  infraGatewayUnsupported: 'cli/infra-gateway-unsupported',
  infraKnowledgeBaseDestroy: 'cli/infra-knowledge-base-destroy',
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
  // `aid trace export` writes a dataset from the same files. A run that recorded no
  // payloads is the ordinary case, because the sink keeps text only when
  // `AID_TRACE_CONTENT` asks for it, so that refusal names the variable rather than
  // leaving a reader to wonder why an expensive run produced no cases.
  traceExportDatasetRequired: 'cli/trace-export-dataset-required',
  // A document that runs an agent records a transcript, so what it withholds from that
  // transcript is `observability.redact` alone: `feedback.redact` governs feedback payloads
  // and has no bearing on model-call text. Accepting the second as proof would let an
  // enterprise agent document export captured content while nothing removed a value.
  traceExportAgentUnredacted: 'cli/trace-export-agent-unredacted',
  traceExportEnterpriseCapture: 'cli/trace-export-enterprise-capture',
  traceExportFilterInvalid: 'cli/trace-export-filter-invalid',
  traceExportFilterNoMatch: 'cli/trace-export-filter-no-match',
  traceExportNoCases: 'cli/trace-export-no-cases',
  traceExportPartial: 'cli/trace-export-partial',
  traceExportSpecInvalid: 'cli/trace-export-spec-invalid',
  traceExportSpecRequired: 'cli/trace-export-spec-required',
  traceExportWouldOverwrite: 'cli/trace-export-would-overwrite',
  traceExportUnwritable: 'cli/trace-export-unwritable',
  traceUnknownSubcommand: 'cli/trace-unknown-subcommand',
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
  // `aid package` builds the archive a deployment hands to the cloud. Its refusals fall
  // into three groups, and they need different fixes: a wrong invocation (the first two),
  // a spec that has nothing to package, and an environment that cannot build. The last
  // group is split further because "no uv", "this dependency has no wheel" and "the
  // manifest has no dependency list" are three different edits.
  packageSubcommandRequired: 'cli/package-subcommand-required',
  packageUnknownSubcommand: 'cli/package-unknown-subcommand',
  packageNoEdgeDeployment: 'cli/package-no-edge-deployment',
  packageStageMissing: 'cli/package-stage-missing',
  packageNoInterpreter: 'cli/package-no-interpreter',
  packageDependenciesMissing: 'cli/package-dependencies-missing',
  packageDependenciesInvalid: 'cli/package-dependencies-invalid',
  packageHelperFailed: 'cli/package-helper-failed',
  packageUvMissing: 'cli/package-uv-missing',
  packageWheelsUnavailable: 'cli/package-wheels-unavailable',
  // `aid resolve` and `aid fleet` read overlay documents. They originate these; every
  // refusal *inside* an overlay comes from `@aid-framework/spec` with an `overlay/` code, so a
  // reader can tell "the CLI could not open it" from "the overlay is not allowed".
  // An unreadable overlay exits 1: the request was well formed and names a real file
  // that is not there. `--check` needs no `--out`, because the resolved artifact's path
  // is derived from the overlay's, so nothing here judges an invocation.
  overlayUnreadable: 'cli/overlay-unreadable',
  resolveOverlayRequired: 'cli/resolve-overlay-required',
  resolveOutdated: 'cli/resolve-outdated',
  // `aid fleet` derives its table from the repository alone. A directory holding no
  // overlay, or one that is not a directory, leaves the command with nothing to report
  // — that is "nothing was judged" (`2`), not a verdict on a customer.
  fleetNoOverlays: 'cli/fleet-no-overlays',
  fleetDirUnreadable: 'cli/fleet-dir-unreadable',
  initTemplateUnknown: 'cli/init-template-unknown',
  initTemplateConflict: 'cli/init-template-conflict',
  // `aid report` compares many deployments from files. A wrong invocation (`2`) is a
  // missing or non-directory root; an empty root is a true answer and only warns. A
  // `*.baseline.json` that is not a recorded baseline is a warning because the traces in
  // the same directory are still worth reporting -- one bad file must not hide them.
  reportDirUnreadable: 'cli/report-dir-unreadable',
  reportNoDeployments: 'cli/report-no-deployments',
  reportBaselineInvalid: 'cli/report-baseline-invalid',
} as const;

/**
 * The one-line condition a published `cli/*` refusal covers.
 *
 * The same shape the IR keeps for its codes, and partial for the same reason: only codes a
 * page publishes need a condition. The boundary page cites exactly one.
 */
export const CLI_DIAGNOSTIC_METADATA = {
  'cli/infra-cloud-conflict': {
    condition: 'a `--cloud` flag that disagrees with the spec the modules were generated from',
  },
} as const satisfies Readonly<Partial<Record<CliDiagnosticCode, DiagnosticMetadata>>>;

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
