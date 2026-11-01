/**
 * `aid infra` — derive the deployment wiring from the spec, and drive OpenTofu.
 *
 * The division of labour is the same one `aid gen` keeps, and for the same reason:
 * *what* the infrastructure says is derived by `@aid-framework/ir` (`buildDeployPlan`) and
 * spelled by `emitInfra`; *whether a file may be rewritten* is the generator SDK's drift
 * rule, reused as-is. This file decides four things and nothing else: which action, which
 * spec, which environment, and what an exit status means. In particular it does not
 * re-hash files or re-implement drift — a second implementation of that rule would
 * eventually disagree, and the one that disagreed would be holding someone's edits.
 *
 * `plan`, `apply` and `drift` shell out through `context.spawn`, so a missing `tofu` is a
 * diagnostic and not a crash, and a test can observe the argv without OpenTofu installed.
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

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { InfraFile } from '../infra/emit.js';
import { emitInfra, INFRA_GENERATED_DIR, INFRA_MANIFEST_PATH } from '../infra/emit.js';
import type { InfraAction } from '../infra/tofu.js';
import { envRoot, runTofu, TFVARS_PATH } from '../infra/tofu.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { DEFAULT_SPEC_PATH } from '../targets.js';

const SUBCOMMANDS = ['gen', 'plan', 'apply', 'drift'] as const;

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
  /** Whether stdout must stay a single JSON document, which decides how `tofu` streams. */
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

  return options.subcommand === 'gen'
    ? generate(context, options)
    : action(context, options, options.subcommand as InfraAction);
}

function generate(context: CliContext, options: InfraOptions): CommandOutcome {
  const command = 'infra';
  const specPath = options.spec ?? DEFAULT_SPEC_PATH;
  const fields = { action: 'gen', spec: specPath };

  const read = readSpec(context, specPath);
  if (!read.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: read.diagnostics });
  }

  const lowered = lowerSpec(read.text, specPath);
  if (!lowered.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: lowered.diagnostics });
  }

  const files: InfraFile[] = emitInfra(buildDeployPlan(lowered.ir));
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

function action(context: CliContext, options: InfraOptions, action: InfraAction): CommandOutcome {
  const command = 'infra';
  const env = options.env ?? DEFAULT_ENV;
  const fields = { action, env, tool: 'tofu' };

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

  if (!existsSync(join(context.cwd, ...TFVARS_PATH.split('/')))) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraNotGenerated,
          message: `"${TFVARS_PATH}" is missing, so there is nothing to ${action}.`,
          hint: 'Run `aid infra gen` first.',
        }),
      ],
    });
  }

  const root = envRoot(env);
  if (!existsSync(join(context.cwd, ...root.split('/')))) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraEnvRootMissing,
          message: `The environment root "${root}" does not exist.`,
          hint: `Create ${root} with your module wiring; the generated tfvars is consumed there, not written to.`,
        }),
      ],
    });
  }

  const result = runTofu(context, action, env, options.json ? 'pipe' : 'inherit');

  if (result.error !== undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraTofuMissing,
          message: `Could not run "${result.error.message}".`,
          hint: 'Install OpenTofu, or point AID_TOFU at a tofu binary.',
        }),
      ],
    });
  }

  // OpenTofu reserves exit 2 for "the plan is non-empty" under `-detailed-exitcode`, so
  // drift is a distinguishable status rather than a guess over human output. It is a
  // failure: a drift check that exited 0 would be a gate that never closes.
  const driftDetected = action === 'drift' && result.status === 2;
  const succeeded = result.status === 0;

  const diagnostics: CliDiagnostic[] = driftDetected
    ? [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraDriftDetected,
          message: `The "${env}" environment no longer matches the generated wiring.`,
          hint: 'Review the plan output, then apply to converge or fix the spec.',
        }),
      ]
    : succeeded
      ? []
      : [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.infraTofuFailed,
            message: `tofu ${action} exited ${result.status}.`,
            ...(result.stderr.trim() === '' ? {} : { hint: result.stderr.trim() }),
          }),
        ];

  const text = driftDetected
    ? `${env}: drift detected`
    : succeeded
      ? `${env}: tofu ${action} succeeded`
      : `${env}: tofu ${action} failed (exit ${result.status})`;

  return outcome({
    command,
    exitCode: succeeded ? EXIT_OK : EXIT_FAILURE,
    diagnostics,
    text,
    ...(succeeded ? {} : { stderr: result.stderr }),
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
