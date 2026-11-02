/**
 * `aid infra` — derive the deployment wiring from the spec, and drive a backend.
 *
 * The division of labour is the same one `aid gen` keeps, and for the same reason:
 * *what* the infrastructure says is derived by `@aid-framework/ir` (`buildDeployPlan`) and
 * spelled by `emitInfra`; *whether a file may be rewritten* is the generator SDK's drift
 * rule, reused as-is. This file decides five things and nothing else: which action, which
 * spec, which environment, which backend (`iac`), and what an exit status means. In
 * particular it does not re-hash files or re-implement drift — a second implementation of
 * that rule would eventually disagree, and the one that disagreed would be holding
 * someone's edits.
 *
 * `plan`, `apply` and `drift` shell out through `context.spawn`, so a missing `tofu` or
 * `cdk` is a diagnostic and not a crash, and a test can observe the argv without either
 * installed.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AidManifest, AidManifestProvenance, Plan } from '@aid-framework/generator-sdk';
import {
  createNodeSink,
  formatRegenerationSummary,
  parseAidManifestJson,
  planRegeneration,
  type RegenerationSink,
  regenerate,
  serializeAidManifest,
} from '@aid-framework/generator-sdk';
import type { IR } from '@aid-framework/ir';
import { buildDeployPlan, DEPLOY_PLAN_VERSION } from '@aid-framework/ir';
import { hasErrors, sortDiagnostics } from '@aid-framework/spec';

import type { CliContext, SpawnResult } from '../context.js';
import type { CliDiagnostic, CliDiagnosticCode } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import { cdkRoot, classifyCdk, runCdk } from '../infra/cdk.js';
import { CLOUDS, type Cloud, DEFAULT_CLOUD, isCloud, unsupportedTargets } from '../infra/cloud.js';
import type { InfraFile } from '../infra/emit.js';
import {
  emitInfra,
  INFRA_CDK_CONTEXT_PATH,
  INFRA_GENERATED_DIR,
  INFRA_MANIFEST_PATH,
} from '../infra/emit.js';
import type { InfraAction } from '../infra/tofu.js';
import { classifyTofu, envRoot, runTofu, TFVARS_PATH } from '../infra/tofu.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { DEFAULT_SPEC_PATH } from '../targets.js';

const SUBCOMMANDS = ['gen', 'plan', 'apply', 'drift'] as const;

/** The backends a bare action can drive. `tofu` stays the default, so nothing shipped moves. */
const IAC_BACKENDS = ['tofu', 'cdk'] as const;

type IacBackend = (typeof IAC_BACKENDS)[number];

/** The env root a bare action runs in. */
const DEFAULT_ENV = 'dev';

/**
 * What this emitter records about itself.
 *
 * `generatorVersion` is the deploy-plan format version, not a package version: it is the
 * shape of the emitted bytes, which is the only thing a later run has to agree with. The
 * manifest exists to answer "did a person edit this file", and a format bump is exactly
 * when that answer stops mattering.
 */
const INFRA_GENERATOR = 'aid-infra-tofu';

export interface InfraOptions {
  readonly subcommand: string | undefined;
  readonly spec: string | undefined;
  /** `gen` only: compute the report without writing. */
  readonly dryRun: boolean;
  /** `gen` only: fail when the tree is not what the spec would produce. */
  readonly check: boolean;
  readonly force: boolean;
  readonly env: string | undefined;
  readonly confirmProd: boolean;
  /** `plan`, `apply`, `drift`: which tool to drive. Defaults to `tofu`. */
  readonly iac: string | undefined;
  /** Which cloud the module set targets. An environment fact, so a flag; defaults to `aws`. */
  readonly cloud: string | undefined;
  /** Whether stdout must stay a single JSON document, which decides how a tool streams. */
  readonly json: boolean;
}

export function infra(context: CliContext, options: InfraOptions): CommandOutcome {
  if (options.subcommand === undefined) {
    return outcome({
      command: 'infra',
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraSubcommandRequired,
          message: '`aid infra` needs a subcommand.',
          hint: `Use one of: ${SUBCOMMANDS.join(', ')}.`,
        }),
      ],
    });
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(options.subcommand)) {
    return outcome({
      command: 'infra',
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraUnknownSubcommand,
          message: `Unknown subcommand "${options.subcommand}".`,
          hint: `Use one of: ${SUBCOMMANDS.join(', ')}.`,
        }),
      ],
    });
  }

  if (options.iac !== undefined && !(IAC_BACKENDS as readonly string[]).includes(options.iac)) {
    return outcome({
      command: 'infra',
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraUnknownIac,
          message: `Unknown infrastructure backend "${options.iac}".`,
          hint: `Use one of: ${IAC_BACKENDS.join(', ')}.`,
        }),
      ],
    });
  }

  const cloud = options.cloud ?? DEFAULT_CLOUD;
  if (!isCloud(cloud)) {
    return outcome({
      command: 'infra',
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraUnknownCloud,
          message: `Unknown cloud "${options.cloud}".`,
          hint: `Use one of: ${CLOUDS.join(', ')}.`,
        }),
      ],
    });
  }

  // An empty CDK app is worse than a refusal: it would synth cleanly and deploy nothing.
  if (cloud === 'gcp' && options.iac === 'cdk') {
    return outcome({
      command: 'infra',
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraCloudBackendUnsupported,
          message: 'CDK constructs are emitted for AWS only.',
          hint: 'Use --iac tofu, which emits the Cloud Run module, or deploy this environment with --cloud aws.',
        }),
      ],
    });
  }

  return options.subcommand === 'gen'
    ? generate(context, options, cloud)
    : action(context, options, options.subcommand as InfraAction, cloud);
}

function generate(context: CliContext, options: InfraOptions, cloud: Cloud): CommandOutcome {
  const command = 'infra';
  const specPath = options.spec ?? DEFAULT_SPEC_PATH;
  const fields = { action: 'gen', spec: specPath, cloud };

  const read = readSpec(context, specPath);
  if (!read.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: read.diagnostics });
  }

  const lowered = lowerSpec(read.text, specPath);
  if (!lowered.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: lowered.diagnostics });
  }

  const deployPlan = buildDeployPlan(lowered.ir);

  // On GCP `edge` has no counterpart at all, and a plan that named it would otherwise
  // emit *no* module for it and look successful. Refuse instead of deploying part of a
  // project. `serverless` (Cloud Run), `container` (Cloud Run) and `batch` (a Cloud Run
  // job) are supported there, so they are not refused.
  // AWS has a module for every target, so this gate is deliberately GCP-only.
  if (cloud === 'gcp') {
    const missing = unsupportedTargets(deployPlan, cloud);
    if (missing.length > 0) {
      const services = deployPlan.services
        .filter((service) => missing.includes(service.target))
        .map((service) => `"${service.id}"`)
        .join(', ');
      return outcome({
        command,
        exitCode: EXIT_FAILURE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.infraCloudTargetUnsupported,
            message: `The plan targets ${missing.join(', ')}, which GCP has no module for: ${services}.`,
            hint: 'On GCP only `container` (Cloud Run) has a module. Retarget the service, or deploy this environment with --cloud aws.',
          }),
        ],
      });
    }
  }

  const files: InfraFile[] = emitInfra(deployPlan, { cloud });
  const plan: Plan = {
    files: files.map((file) => ({ path: file.path, content: file.contents, owner: 'generated' })),
  };

  const sink = createNodeSink(context.cwd);
  const manifest = readInfraManifest(sink);
  if (manifest.diagnostics.length > 0) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: manifest.diagnostics,
    });
  }

  const reconciliation = { sink, manifest: manifest.manifest, force: options.force };

  if (options.dryRun || options.check) {
    // Both branches take the SDK's planner, which has no writer. `--check` and `--dry-run`
    // therefore cannot write even by accident, and their difference is only what the exit
    // code means: a dry run describes, a check judges.
    const report = planRegeneration(plan, reconciliation);
    const outstanding = report.created.length + report.updated.length > 0;
    const failed = hasErrors(report.diagnostics) || (options.check && outstanding);
    // Creation is not drift, so the SDK reports no diagnostic for a tree that simply has
    // not been generated yet. A failing `--check` must still say why, or the exit code is
    // the only clue.
    const outdated: CliDiagnostic[] =
      options.check && outstanding
        ? [
            cliError({
              code: CLI_DIAGNOSTIC_CODES.infraGeneratedOutdated,
              message: `"${INFRA_GENERATED_DIR}" does not match the spec.`,
              hint: 'Run `aid infra gen` to rewrite it.',
            }),
          ]
        : [];

    return outcome({
      command,
      exitCode: failed ? EXIT_FAILURE : EXIT_OK,
      diagnostics: [...lowered.diagnostics, ...report.diagnostics, ...outdated],
      text: [
        options.check
          ? `${INFRA_GENERATED_DIR}: ${outstanding ? 'out of date' : 'up to date'} (${formatRegenerationSummary(report)})`
          : `${INFRA_GENERATED_DIR}: ${formatRegenerationSummary(report)}`,
        ...report.created.map((path) => `  would create  ${path}`),
        ...report.updated.map((path) => `  would update  ${path}`),
      ].join('\n'),
      fields: {
        ...fields,
        dryRun: options.dryRun,
        check: options.check,
        manifest: { path: INFRA_MANIFEST_PATH, written: false },
        changes: {
          created: report.created,
          updated: report.updated,
          unchanged: report.unchanged,
          conflicts: report.drifted.map((file) => file.path),
          stale: report.stale,
        },
      },
    });
  }

  const applied = regenerate(plan, {
    ...reconciliation,
    provenance: provenanceFor(lowered.ir),
  });
  sink.write(INFRA_MANIFEST_PATH, serializeAidManifest(applied.manifest));

  const { report } = applied;
  // Drift is an error the caller must answer, and `--force` is the answer. A run that did
  // what it was told exits 0; only an unforced run leaves something outstanding.
  const failed = hasErrors(report.diagnostics) || (!options.force && report.drifted.length > 0);

  return outcome({
    command,
    exitCode: failed ? EXIT_FAILURE : EXIT_OK,
    diagnostics: [...lowered.diagnostics, ...report.diagnostics],
    text: [
      `${INFRA_GENERATED_DIR}: ${formatRegenerationSummary(report)}`,
      ...report.created.map((path) => `  created  ${path}`),
      ...report.updated.map((path) => `  updated  ${path}`),
      ...report.drifted.map((file) => `  refused  ${file.path} (the new content is beside it)`),
    ].join('\n'),
    fields: {
      ...fields,
      dryRun: false,
      check: false,
      manifest: { path: INFRA_MANIFEST_PATH, written: true },
      changes: {
        created: report.created,
        updated: report.updated,
        unchanged: report.unchanged,
        conflicts: report.drifted.map((file) => file.path),
        stale: report.stale,
      },
    },
  });
}

/**
 * One backend's answer to "where does the plan live, what is its env root, and what does
 * an exit status mean". The command owns policy; the backend object is only the spelling
 * of the differences, so the two paths below cannot drift into different rules.
 */
interface Backend {
  readonly root: string;
  readonly planPath: string;
  readonly missingCode: CliDiagnosticCode;
  readonly failedCode: CliDiagnosticCode;
  readonly installHint: string;
  readonly rootHint: string;
  readonly run: (stdio: 'inherit' | 'pipe') => SpawnResult;
  readonly classify: (status: number | null) => 'ok' | 'drift' | 'failed';
}

function backendFor(
  context: CliContext,
  iac: IacBackend,
  action: InfraAction,
  env: string,
  cloud: Cloud,
): Backend {
  if (iac === 'cdk') {
    return {
      root: cdkRoot(env),
      planPath: INFRA_CDK_CONTEXT_PATH,
      missingCode: CLI_DIAGNOSTIC_CODES.infraCdkMissing,
      failedCode: CLI_DIAGNOSTIC_CODES.infraCdkFailed,
      installHint: 'Install the AWS CDK, or point AID_CDK at a cdk binary.',
      rootHint: `Create ${cdkRoot(env)} with your CDK app; the generated context is consumed there, not written to.`,
      run: (stdio) => runCdk(context, action, env, stdio),
      classify: (status) => classifyCdk(action, status),
    };
  }
  const root = envRoot(env, cloud);
  return {
    root,
    planPath: TFVARS_PATH,
    missingCode: CLI_DIAGNOSTIC_CODES.infraTofuMissing,
    failedCode: CLI_DIAGNOSTIC_CODES.infraTofuFailed,
    installHint: 'Install OpenTofu, or point AID_TOFU at a tofu binary.',
    rootHint: `Create ${root} with your module wiring; the generated tfvars is consumed there, not written to.`,
    run: (stdio) => runTofu(context, action, env, cloud, stdio),
    classify: (status) => classifyTofu(action, status),
  };
}

function action(
  context: CliContext,
  options: InfraOptions,
  action: InfraAction,
  cloud: Cloud,
): CommandOutcome {
  const command = 'infra';
  const iac: IacBackend = options.iac === 'cdk' ? 'cdk' : 'tofu';
  const env = options.env ?? DEFAULT_ENV;
  const fields = { action, env, tool: iac, cloud };
  const backend = backendFor(context, iac, action, env, cloud);

  if (action === 'apply' && env === 'prod' && !options.confirmProd) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraConfirmProdRequired,
          message: 'Applying to prod requires an explicit confirmation.',
          hint: 'Re-run with --confirm-prod once the plan has been reviewed.',
        }),
      ],
    });
  }

  if (!existsSync(join(context.cwd, ...backend.planPath.split('/')))) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraNotGenerated,
          message: `"${backend.planPath}" is missing, so there is nothing to ${action}.`,
          hint: 'Run `aid infra gen` first.',
        }),
      ],
    });
  }

  if (!existsSync(join(context.cwd, ...backend.root.split('/')))) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraEnvRootMissing,
          message: `The environment root "${backend.root}" does not exist.`,
          hint: backend.rootHint,
        }),
      ],
    });
  }

  const result = backend.run(options.json ? 'pipe' : 'inherit');

  if (result.error !== undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: backend.missingCode,
          message: `Could not run "${result.error.message}".`,
          hint: backend.installHint,
        }),
      ],
    });
  }

  const verdict = backend.classify(result.status);

  // Drift is a failure: a drift check that exited 0 would be a gate that never closes.
  const diagnostics: CliDiagnostic[] =
    verdict === 'drift'
      ? [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.infraDriftDetected,
            message: `The "${env}" environment no longer matches the generated wiring.`,
            hint: 'Review the plan output, then apply to converge or fix the spec.',
          }),
        ]
      : verdict === 'ok'
        ? []
        : [
            cliError({
              code: backend.failedCode,
              message: `${iac} ${action} exited ${result.status}.`,
              ...(result.stderr.trim() === '' ? {} : { hint: result.stderr.trim() }),
            }),
          ];

  const text =
    verdict === 'drift'
      ? `${env}: drift detected`
      : verdict === 'ok'
        ? `${env}: ${iac} ${action} succeeded`
        : `${env}: ${iac} ${action} failed (exit ${result.status})`;

  return outcome({
    command,
    exitCode: verdict === 'ok' ? EXIT_OK : EXIT_FAILURE,
    diagnostics,
    text,
    ...(verdict === 'ok' ? {} : { stderr: result.stderr }),
    fields: {
      ...fields,
      status: result.status,
      ...(options.json ? { output: result.stdout } : {}),
    },
  });
}

interface InfraManifestOutcome {
  readonly manifest?: AidManifest;
  readonly diagnostics: readonly CliDiagnostic[];
}

function readInfraManifest(sink: RegenerationSink): InfraManifestOutcome {
  const text = sink.read(INFRA_MANIFEST_PATH);
  if (text === undefined) return { diagnostics: [] };

  const parsed = parseAidManifestJson(text, {
    generatedDir: INFRA_GENERATED_DIR,
    businessDir: 'infra/business',
  });
  if (hasErrors(parsed.diagnostics)) {
    return { diagnostics: sortDiagnostics(parsed.diagnostics) };
  }
  return parsed.manifest === undefined
    ? { diagnostics: [] }
    : { manifest: parsed.manifest, diagnostics: [] };
}

function provenanceFor(ir: IR): AidManifestProvenance {
  return {
    generator: INFRA_GENERATOR,
    generatorVersion: DEPLOY_PLAN_VERSION,
    irVersion: ir.irVersion,
  };
}
