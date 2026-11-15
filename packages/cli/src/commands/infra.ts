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

import { existsSync, readFileSync } from 'node:fs';
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
import { buildDeployPlan, DEPLOY_PLAN_VERSION, type DeployPlan } from '@aid-framework/ir';
import { hasErrors, sortDiagnostics } from '@aid-framework/spec';

import type { CliContext, SpawnResult } from '../context.js';
import type { CliDiagnostic, CliDiagnosticCode } from '../diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, cliError, cliWarning } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import { cdkRoot, classifyCdk, runCdk } from '../infra/cdk.js';
import {
  BACKEND_CLOUDS,
  CLOUD_TARGETS,
  CLOUDS,
  type Cloud,
  HELM_TARGETS,
  IAC_BACKENDS,
  type IacBackend,
  isCloud,
  KNOWLEDGE_BASE_CLOUDS,
  pinnedCloud,
  resolveCloud,
  unsupportedGateways,
  unsupportedKnowledgeBases,
  unsupportedRuntimes,
  unsupportedTargets,
} from '../infra/cloud.js';
import type { InfraFile } from '../infra/emit.js';
import {
  emitInfra,
  INFRA_CDK_CONTEXT_PATH,
  INFRA_GENERATED_DIR,
  INFRA_MANIFEST_PATH,
  INFRA_PLAN_PATH,
} from '../infra/emit.js';
import type { InfraAction } from '../infra/tofu.js';
import {
  classifyTofu,
  destroyedKnowledgeBases,
  envRoot,
  removeTofuPlan,
  runTofu,
  TFVARS_PATH,
  tofuBinary,
  tofuPlanPath,
} from '../infra/tofu.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { DEFAULT_SPEC_PATH } from '../targets.js';

const SUBCOMMANDS = ['gen', 'plan', 'apply', 'drift'] as const;

/**
 * The cloud that evaluates each managed guardrail engine, and the wording a refusal uses.
 * `builtin` has no entry: the generated app evaluates it, so every cloud and every target
 * has it.
 */
const GUARDRAIL_HOMES: Record<
  'bedrock' | 'model-armor',
  { cloud: Cloud; product: string; names: string }
> = {
  bedrock: { cloud: 'aws', product: 'Bedrock', names: 'a Bedrock guardrail' },
  'model-armor': { cloud: 'gcp', product: 'Model Armor', names: 'a Model Armor template' },
};

export type { IacBackend };
/**
 * The backends `aid infra` can emit.
 *
 * Declared in `infra/cloud.ts` beside `BACKEND_CLOUDS`, so the list of backends and the
 * clouds each one serves cannot drift apart, and re-exported here because this is where the
 * dispatcher's refusals and the site's support page look for it.
 *
 * `tofu` stays the default, so nothing shipped moves. `helm` joined in 0.36: it renders a
 * chart from `target: kubernetes`, and unlike the other two it creates no managed resource
 * -- the cluster, namespace and secrets belong to the operator, so the chart only describes
 * what to run inside them. That is why the backend is separate from the cloud rather than
 * another entry in `CLOUD_TARGETS`.
 */
export { IAC_BACKENDS };

/**
 * Every served pair, spelled for a refusal to quote.
 *
 * Derived from {@link BACKEND_CLOUDS} rather than written out, so a pair that stops being
 * served stops being advertised in the same commit that removes it.
 */
const SERVED_PAIRS = Object.entries(BACKEND_CLOUDS)
  .flatMap(([backend, clouds]) => clouds.map((cloud) => `${cloud}+${backend}`))
  .join(', ');

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

  if (options.cloud !== undefined && !isCloud(options.cloud)) {
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

  // The cloud is a spec fact now, so it is resolved once here rather than in each
  // subcommand: `gen` writes `infra/envs/gcp-<env>` for a GCP pin, and `plan`/`apply`/
  // `drift` have to look for it in the same place. A spec that cannot be read or lowered
  // pins nothing, which leaves the flag and the `aws` default exactly as they were.
  const resolved = resolveCloud(pinnedFromSpec(context, options.spec).cloud, options.cloud);
  if (!resolved.ok) {
    return outcome({
      command: 'infra',
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraCloudConflict,
          message: resolved.message,
          hint: resolved.hint,
        }),
      ],
    });
  }
  const cloud = resolved.cloud;

  // A backend emits infrastructure for the clouds it has a module for. Asking for one it
  // does not is refused here rather than deeper down, because the alternative is an empty
  // root or an empty CDK app: it synths cleanly, deploys nothing, and reports success.
  // Azure reaches this point only when `--iac helm` was passed, since the chart is the only
  // Azure artifact and a chart is cloud-neutral.
  const iac = (options.iac ?? 'tofu') as IacBackend;
  const served = BACKEND_CLOUDS[iac];
  if (!served.includes(cloud)) {
    // A `kubernetes` target is the more specific fault when both are true: the backend has
    // no module for the cloud *and* the workload belongs in a chart. Naming the chart sends
    // the operator to the command that works; naming the cloud does not.
    if (iac !== 'helm' && pinnedFromSpec(context, options.spec).kubernetes) {
      return outcome({
        command: 'infra',
        exitCode: EXIT_USAGE,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.infraKubernetesBackendRequired,
            message: `The spec targets \`kubernetes\`, which the "${iac}" backend has no module for.`,
            hint: 'Run `aid infra gen --iac helm` to render the chart, or change the deployment target if it should run on a managed platform.',
          }),
        ],
      });
    }
    return outcome({
      command: 'infra',
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraCloudBackendUnsupported,
          message: `The "${iac}" backend emits no infrastructure for ${cloud}.`,
          hint:
            iac === 'helm'
              ? 'A Helm chart is a Kubernetes object graph; it renders for a plan whose deployments target `kubernetes`, whatever cloud they pin.'
              : cloud === 'azure'
                ? 'Azure is served through Kubernetes: target the deployment at `kubernetes` in the spec and run `aid infra gen --iac helm`.'
                : `Supported pairs are ${SERVED_PAIRS}.`,
        }),
      ],
    });
  }

  return options.subcommand === 'gen'
    ? generate(context, options, cloud)
    : action(context, options, options.subcommand as InfraAction, cloud);
}

/**
 * The cloud the spec pins, or `undefined` when it pins none or cannot be read.
 *
 * Reading is best-effort on purpose: `gen` reports why a spec does not lower, and
 * `plan`/`apply`/`drift` are routinely run in a generated tree with no spec at all. A
 * failure here therefore means "no pin", never a diagnostic -- otherwise `infra apply`
 * would start refusing documents it used to ignore.
 */
function pinnedFromSpec(
  context: CliContext,
  spec: string | undefined,
): { readonly cloud: Cloud | undefined; readonly kubernetes: boolean } {
  const specPath = spec ?? DEFAULT_SPEC_PATH;
  const read = readSpec(context, specPath);
  if (!read.ok) return { cloud: undefined, kubernetes: false };
  const lowered = lowerSpec(read.text, specPath);
  if (!lowered.ok) return { cloud: undefined, kubernetes: false };
  return {
    cloud: pinnedCloud(lowered.ir.deployments),
    kubernetes: lowered.ir.deployments.some((deployment) =>
      (HELM_TARGETS as readonly string[]).includes(deployment.target),
    ),
  };
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

  // The chart renders Deployments, Services and Ingresses, and nothing else. Both refusals
  // below exist because the alternative is a chart that installs cleanly while omitting
  // part of what the document declared: a knowledge base, a managed guardrail or a gateway
  // is a provider resource the cluster cannot describe, and a plan with no `kubernetes`
  // deployment would render a chart with no workload in it at all.
  if (options.iac === 'helm') {
    const rendered = deployPlan.services.filter((service) =>
      (HELM_TARGETS as readonly string[]).includes(service.target),
    );
    if (rendered.length === 0) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.infraHelmTargetRequired,
            message:
              'The plan has no deployment targeting `kubernetes`, so the chart would be empty.',
            hint: "Set the deployment's `target: kubernetes` if it should install on a cluster, or emit this environment with --iac tofu or --iac cdk.",
          }),
        ],
      });
    }
    const obstacles = helmObstacles(deployPlan);
    if (obstacles.length > 0) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.infraHelmSurfaceUnsupported,
            message: `The chart cannot render ${obstacles.map((obstacle) => obstacle.what).join(', ')}: it emits Deployments, Services and Ingresses only.`,
            hint: 'Drop the construct or retarget the service at `kubernetes`, and emit this environment with --iac tofu or --iac cdk if the plan genuinely needs a provider resource.',
          }),
        ],
      });
    }
  } else {
    // A `kubernetes` deployment has no OpenTofu or CDK module: a cluster is not something
    // these backends provision. Emitting the plan without it would deploy part of the
    // project and report success.
    const unrendered = deployPlan.services.filter(
      (service) => !(CLOUD_TARGETS[cloud] as readonly string[]).includes(service.target),
    );
    if (
      unrendered.some((service) => (HELM_TARGETS as readonly string[]).includes(service.target))
    ) {
      const ids = unrendered
        .filter((service) => (HELM_TARGETS as readonly string[]).includes(service.target))
        .map((service) => `"${service.id}"`)
        .join(', ');
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.infraKubernetesBackendRequired,
            message: `${ids} target${ids.includes(',') ? '' : 's'} \`kubernetes\`, which the "${options.iac ?? 'tofu'}" backend has no module for.`,
            hint: 'Run `aid infra gen --iac helm` to render the chart, or change the deployment target if it should run on a managed platform.',
          }),
        ],
      });
    }
  }

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
            hint: 'On GCP `serverless`, `container` and `batch` all have modules; only `edge` does not. Retarget the service, or deploy this environment with --cloud aws.',
          }),
        ],
      });
    }
  }

  // A managed guardrail is evaluated by a provider product, so a plan that asks for one
  // cannot run where that product does not exist: Bedrock is AWS-only and Model Armor is
  // GCP-only. An edge function is refused for a second reason: it has no environment
  // variables, so it could not be told which guardrail or template to call.
  const misplaced = deployPlan.services.flatMap((service) =>
    service.guardrailEngines.flatMap((engine) => {
      if (engine !== 'bedrock' && engine !== 'model-armor') return [];
      if (GUARDRAIL_HOMES[engine].cloud === cloud && service.target !== 'edge') return [];
      return [{ id: service.id, engine, edge: service.target === 'edge' }];
    }),
  );
  if (misplaced.length > 0) {
    const listed = misplaced
      .map(({ id, engine, edge }) =>
        edge
          ? `"${id}" targets edge, which has no environment to name ${GUARDRAIL_HOMES[engine].names}`
          : `"${id}" asks ${GUARDRAIL_HOMES[engine].product} to evaluate its guardrail, which ${cloud === 'gcp' ? 'GCP' : 'AWS'} cannot do`,
      )
      .join('; ');
    const hints: string[] = [];
    const engines = new Set(misplaced.filter((entry) => !entry.edge).map((entry) => entry.engine));
    if (engines.has('bedrock')) {
      hints.push(
        'Remove `engine: bedrock` from the guardrail, or deploy this environment with --cloud aws.',
      );
    }
    if (engines.has('model-armor')) {
      hints.push(
        'Remove `engine: model-armor` from the guardrail, or deploy this environment with --cloud gcp.',
      );
    }
    if (misplaced.some((entry) => entry.edge)) {
      hints.push(
        'Serve the service from `serverless` or `container`, or evaluate the guardrail in the edge handler itself.',
      );
    }
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraGuardrailUnsupported,
          message: `Service ${listed}.`,
          hint: hints.join(' '),
        }),
      ],
    });
  }

  // A managed base is a provider product: Bedrock's lives in AWS, a Vertex RAG corpus in
  // GCP, and neither has a counterpart on the other cloud. A plan that declares one for
  // the other cloud would emit no resource and still succeed, so the service would start
  // and fail on its first retrieval instead of at plan time.
  const misplacedBases = unsupportedKnowledgeBases(deployPlan, cloud);
  if (misplacedBases.length > 0) {
    const bases = misplacedBases.map((base) => `"${base.id}" (${base.engine})`).join(', ');
    const wanted = [...new Set(misplacedBases.map((base) => KNOWLEDGE_BASE_CLOUDS[base.engine]))];
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraKnowledgeBaseUnsupported,
          message: `Knowledge base ${bases} needs ${wanted.join(' and ')}, which --cloud ${cloud} does not create.`,
          hint: `Generate this environment with --cloud ${wanted[0]}, or move the base to an engine this cloud runs (${cloud === 'gcp' ? 'vertex-rag' : 'aws-bedrock'}).`,
        }),
      ],
    });
  }

  // A managed agent runtime is a vendor product too: the AgentCore runtime lives in AWS
  // and the Agent Platform reasoning engine in GCP. The platform's credentials are the
  // deploy's credentials, so the other cloud's platform cannot be reached, and a plan that
  // silently kept its compute module would be deploying a service the spec did not name.
  const misplacedRuntimes = unsupportedRuntimes(deployPlan, cloud);
  if (misplacedRuntimes.length > 0) {
    const services = misplacedRuntimes
      .map((runtime) => `"${runtime.id}" (${runtime.platform})`)
      .join(', ');
    const wanted = [...new Set(misplacedRuntimes.map((runtime) => runtime.cloud))];
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraRuntimeUnsupported,
          message: `Service ${services} names a runtime that runs on ${wanted.join(' and ')}, which --cloud ${cloud} does not create.`,
          hint: `Generate this environment with --cloud ${wanted[0]}, or choose the platform this cloud runs (${cloud === 'gcp' ? 'gcp-agent-platform' : 'aws-agentcore'}).`,
        }),
      ],
    });
  }

  // A gateway is a managed MCP endpoint, and only AgentCore hosts one: there is no GCP
  // counterpart at any layer, and the runtime that reaches it is the AWS one. A GCP
  // environment would emit no gateway and still succeed, so the federation the spec
  // describes would be missing from the deployed project.
  const misplacedGateways = unsupportedGateways(deployPlan, cloud);
  if (misplacedGateways.length > 0) {
    const gateways = misplacedGateways.map((gateway) => `"${gateway.id}"`).join(', ');
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraGatewayUnsupported,
          message: `Gateway ${gateways} needs AWS, which --cloud ${cloud} does not create.`,
          hint: 'Generate this environment with --cloud aws, or remove the gateway and reach each tool from the application itself.',
        }),
      ],
    });
  }

  // CDK constructs exist for `serverless`, `container` and managed knowledge bases only.
  // A plan naming anything else would synth a clean app that deploys part of the project,
  // so it is refused for the same reason a GCP CDK app is: an empty app is worse than a
  // refusal. A scheduled refresh is the same kind of gap -- no construct creates one, so
  // the app would deploy a retriever that never refreshes. `action()` repeats this check
  // against the emitted plan, because `plan` and `apply` read that file rather than the
  // spec and would otherwise accept a plan written by a `gen` that had no `--iac cdk` to
  // warn it.
  const obstacles = cdkObstacles(deployPlan.services, deployPlan.tasks);
  if (options.iac === 'cdk' && obstacles.length > 0) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields,
      diagnostics: [cdkObstacleDiagnostic(obstacles)],
    });
  }

  const files: InfraFile[] = emitInfra(deployPlan, {
    cloud,
    iac: options.iac as IacBackend | undefined,
  });
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

/**
 * The knowledge bases a saved plan would delete, or nothing when the tool wrote no plan.
 *
 * The plan directory belongs to this process, so a missing file means the plan failed
 * before it produced one — there is nothing to report, and the caller's own failure
 * diagnostic already says why.
 */
function destroyingKnowledgeBases(context: CliContext, env: string, cloud: Cloud): string[] {
  const planFile = tofuPlanPath(env, cloud);
  if (!existsSync(planFile)) return [];
  const shown = context.spawn(tofuBinary(context), ['show', '-json', planFile], {
    cwd: join(context.cwd, ...envRoot(env, cloud).split('/')),
    stdio: 'pipe',
    env: context.env,
  });
  // One command's artifact: leaving it behind would make the next run's cleanup the only
  // thing standing between the operator and a stray binary file.
  try {
    removeTofuPlan();
  } catch {
    // A file that cannot be removed is not a reason to fail a plan that succeeded.
  }
  if (shown.error !== undefined || shown.status !== 0) return [];
  return destroyedKnowledgeBases(shown.stdout);
}

/** A service the CDK backend cannot represent, and why. */
interface CdkObstacle {
  /**
   * `runtime`: a managed agent runtime; `target`: a target with no construct;
   * `schedule`: a refresh schedule, which no construct in this backend emits.
   */
  readonly reason: 'runtime' | 'target' | 'schedule';
  readonly id: string;
  /** The target name, when that is the obstacle. */
  readonly detail?: string;
}

/** The part of a saved plan this check needs, so a hand-edited file cannot lie about more. */
interface SavedPlanService {
  readonly id: string;
  readonly target: string;
  readonly runtime?: unknown;
}

/** A piece of a plan the Helm chart has no object to describe. */
interface HelmObstacle {
  /** Spelled for the refusal: names the id and what it is. */
  readonly what: string;
}

/**
 * Everything in the plan the chart would silently omit.
 *
 * A chart describes Kubernetes objects. A managed knowledge base, a managed guardrail and
 * an agent gateway are provider resources -- a Bedrock knowledge base is not a Deployment,
 * and a Model Armor template is not a ConfigMap -- so a chart that rendered the workload
 * and skipped them would install cleanly and then fail on first use, which is the least
 * debuggable outcome available. A service on any other target is the same omission one
 * layer up: the chart would carry no workload for it.
 *
 * Every field is read from the plan rather than the spec, so a plan saved by an earlier
 * `gen` cannot slip past this by describing a spec shape that has since changed.
 */
function helmObstacles(plan: DeployPlan): HelmObstacle[] {
  const obstacles: HelmObstacle[] = [];
  for (const service of plan.services) {
    if (!(HELM_TARGETS as readonly string[]).includes(service.target)) {
      obstacles.push({ what: `"${service.id}" (a ${service.target} deployment)` });
    }
    for (const engine of service.guardrailEngines) {
      obstacles.push({ what: `"${service.id}"'s ${engine} guardrail` });
    }
    if (service.runtime !== undefined) {
      obstacles.push({ what: `"${service.id}"'s ${service.runtime.platform} runtime` });
    }
  }
  for (const base of plan.knowledgeBases) {
    obstacles.push({ what: `"${base.id}" (a ${base.engine} knowledge base)` });
  }
  for (const gateway of plan.gateways) {
    obstacles.push({ what: `"${gateway.id}" (an agent gateway)` });
  }
  for (const task of plan.tasks) {
    obstacles.push({ what: `"${task.id}" (a task, which the chart renders no job for)` });
  }
  return obstacles;
}

/** The part of a saved task this check needs: whether it asks to be scheduled. */
interface SavedPlanTask {
  readonly id: string;
  readonly schedule?: unknown;
}

/**
 * The services and tasks a CDK app would silently drop.
 *
 * `target` rather than a fixed list so a target added later fails closed instead of
 * deploying a partial project. The list names every target a construct exists for;
 * `batch` and `edge` were the case this guard existed for, and now have one.
 *
 * A scheduled refresh is the second kind of drop: the constructs that exist cover
 * compute, and none of them creates an EventBridge schedule, so a plan carrying a
 * `refresh.schedule` would deploy an environment where the refresh never runs. The spec
 * already refuses a schedule no batch deployment ingests, so this only has to refuse the
 * backend that cannot express one.
 */
function cdkObstacles(
  services: readonly SavedPlanService[],
  tasks: readonly SavedPlanTask[] = [],
): CdkObstacle[] {
  const represented = new Set(['serverless', 'container', 'batch', 'edge']);
  const obstacles: CdkObstacle[] = [];
  for (const service of services) {
    if (service.runtime !== undefined) {
      obstacles.push({ reason: 'runtime', id: service.id });
    } else if (!represented.has(service.target)) {
      obstacles.push({ reason: 'target', id: service.id, detail: service.target });
    }
  }
  for (const task of tasks) {
    if (typeof task.schedule === 'string' && task.schedule !== '') {
      obstacles.push({ reason: 'schedule', id: task.id });
    }
  }
  return obstacles;
}

function cdkObstacleDiagnostic(obstacles: readonly CdkObstacle[]): CliDiagnostic {
  const quote = (list: readonly CdkObstacle[]): string =>
    list.map((obstacle) => `"${obstacle.id}"`).join(', ');
  const managed = obstacles.filter((obstacle) => obstacle.reason === 'runtime');
  const targets = obstacles.filter((obstacle) => obstacle.reason === 'target');
  const scheduled = obstacles.filter((obstacle) => obstacle.reason === 'schedule');

  const sentences: string[] = [];
  if (managed.length > 0) {
    sentences.push(
      `Service ${quote(managed)} runs on a managed agent runtime, which the CDK backend does not emit.`,
    );
  }
  if (targets.length > 0) {
    const named = [...new Set(targets.map((obstacle) => obstacle.detail ?? ''))]
      .map((target) => `\`${target}\``)
      .join(', ');
    sentences.push(
      `Service ${quote(targets)} targets ${named}, which the CDK backend does not emit a construct for.`,
    );
  }
  if (scheduled.length > 0) {
    sentences.push(
      `Retriever ${quote(scheduled)} declares refresh.schedule, and the CDK backend emits no scheduler, so the refresh would never run.`,
    );
  }

  return cliError({
    code: CLI_DIAGNOSTIC_CODES.infraCloudBackendUnsupported,
    message: sentences.join(' '),
    hint: 'Use --iac tofu, which emits a module for every target, the managed runtime and a scheduler for a refresh, or retarget the service to a target with a construct (`serverless`, `container`, `batch` or `edge`).',
  });
}

/**
 * The same obstacles, read from the plan `gen` wrote.
 *
 * A file that is missing or unreadable yields no obstacles on purpose: the caller has
 * already refused a missing context, and inventing a second diagnostic here would hide
 * the real one.
 */
function savedPlanObstacles(context: CliContext): CdkObstacle[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(context.cwd, ...INFRA_PLAN_PATH.split('/')), 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const services = (parsed as { services?: unknown }).services;
  if (!Array.isArray(services)) return [];
  const tasks = (parsed as { tasks?: unknown }).tasks;

  const known = services.filter(
    (service): service is SavedPlanService =>
      typeof service === 'object' &&
      service !== null &&
      typeof (service as { id?: unknown }).id === 'string' &&
      typeof (service as { target?: unknown }).target === 'string',
  );
  const knownTasks = Array.isArray(tasks)
    ? tasks.filter(
        (task): task is SavedPlanTask =>
          typeof task === 'object' &&
          task !== null &&
          typeof (task as { id?: unknown }).id === 'string',
      )
    : [];
  return cdkObstacles(known, knownTasks);
}

function action(
  context: CliContext,
  options: InfraOptions,
  action: InfraAction,
  cloud: Cloud,
): CommandOutcome {
  const command = 'infra';
  const iac: IacBackend = options.iac === 'cdk' || options.iac === 'helm' ? options.iac : 'tofu';

  // A chart is not a state file: there is no plan to review, no apply to confirm and no
  // drift to compare. Refusing here keeps the three commands from reporting on a backend
  // they cannot drive, rather than shelling out to a binary that will not understand the
  // tree.
  if (iac === 'helm') {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      fields: { action, env: options.env ?? DEFAULT_ENV, tool: iac, cloud },
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.infraHelmNotDriven,
          message: `\`aid infra ${action}\` does not drive Helm, which has no plan file to review.`,
          hint: 'Run `aid infra gen --iac helm` to render the chart, review the rendered templates with `helm template`, and install it with `helm upgrade --install`.',
        }),
      ],
    });
  }

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

  // `plan`, `apply` and `drift` never read the spec, so the plan they are about to use is
  // the only thing that can refuse a partial CDK app here.
  if (iac === 'cdk') {
    const obstacles = savedPlanObstacles(context);
    if (obstacles.length > 0) {
      return outcome({
        command,
        exitCode: EXIT_USAGE,
        fields,
        diagnostics: [cdkObstacleDiagnostic(obstacles)],
      });
    }
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

  // A managed knowledge base is the one resource whose destroy loses data the deployment
  // cannot rebuild for free: a corpus is paid for per document and takes minutes to
  // ingest. This is a warning rather than a refusal because a legitimate teardown must
  // still be possible, and it is read from the saved plan so it does not depend on the
  // wording of human output.
  const doomedBases =
    iac === 'tofu' && action === 'plan' && verdict === 'ok'
      ? destroyingKnowledgeBases(context, env, cloud)
      : [];
  const destroyWarnings: CliDiagnostic[] =
    doomedBases.length === 0
      ? []
      : [
          cliWarning({
            code: CLI_DIAGNOSTIC_CODES.infraKnowledgeBaseDestroy,
            message: `The "${env}" plan destroys ${doomedBases.join(', ')}, and a corpus costs real money and time to rebuild.`,
            hint: 'Review the plan before applying. A teardown is still allowed, but the data does not come back on its own.',
          }),
        ];

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
        ? destroyWarnings
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
      ...(doomedBases.length === 0 ? {} : { destroyingKnowledgeBases: doomedBases }),
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
