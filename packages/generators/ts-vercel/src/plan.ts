/**
 * The plan: IR in, bytes out.
 *
 * `planTsVercel` is a pure function of the IR. It does not read the spec, the
 * filesystem, the clock or the environment, which is what makes "generate twice and
 * diff" a meaningful test rather than a smoke test. Anything the IR cannot express is
 * reported as a `PlanProblem` and refused, never approximated: a generated app that
 * silently drops a declared capability is worse than one that will not generate.
 */

import type { GeneratedFile, Plan } from '@aid-framework/generator-sdk';
import {
  ACTION_PINS,
  ambientCredentialNote,
  cliRangeFor,
  scaffoldCi,
  scaffoldEvals,
  sortByPath,
} from '@aid-framework/generator-sdk';
import type { IR } from '@aid-framework/ir';
import { emitAgents } from './emit/agents.js';
import {
  emitBusinessIndex,
  emitBusinessPromptsIndex,
  emitBusinessToolSeeds,
  emitBusinessToolsIndex,
  emitEvalModules,
  emitEvalsIndex,
  emitGeneratedIndex,
} from './emit/business.js';
import { emitControl } from './emit/control.js';
import { emitEvalDriver } from './emit/eval-driver.js';
import type { EmittedFile } from './emit/file.js';
import { paths } from './emit/file.js';
import { emitGuardrails } from './emit/guardrails.js';
import {
  emitDeps,
  emitGatewayIndex,
  emitGatewayModels,
  emitObservability,
} from './emit/infrastructure.js';
import {
  emitPipelineModule,
  emitPipelinesIndex,
  emitRouteModule,
  emitRoutesIndex,
} from './emit/pipelines.js';
import { emitPromptModules, emitPromptsIndex } from './emit/prompts.js';
import {
  emitRetrievalBindings,
  emitRetrievalIndex,
  emitRetrievalIngestIndex,
  emitRetrievalIngestModules,
} from './emit/retrieval.js';
import { emitRequests, emitSchemas } from './emit/schemas.js';
import {
  emitContractModule,
  emitContractsIndex,
  emitToolAdapter,
  emitToolsIndex,
} from './emit/tools.js';
import { TsVercelPlanError } from './errors.js';
import { GENERATOR_VERSION, TS_VERCEL_MANIFEST } from './manifest.js';
import { checkPlan } from './validate.js';

/**
 * The scaffold profile for this target. The spec path is derived from the manifest's
 * output root rather than hardcoded, so the workflow points at the same file the CLI
 * reads; both targets use `<root>/app.spec.yaml` today.
 */
function ciProfile() {
  const root = TS_VERCEL_MANIFEST.output.root;
  return {
    target: TS_VERCEL_MANIFEST.target,
    specPath: `${root}/app.spec.yaml`,
    dependencyManifest: 'package.json',
    toolchain: [`- uses: ${ACTION_PINS.setupNode}`, '  with:', "    node-version: '22'"],
    install: ['if [ -f package-lock.json ]; then npm ci; else npm install; fi'],
    lint: ['npx --no-install tsc --noEmit -p tsconfig.json'],
    build: 'npm run build --if-present',
    test: 'npm test --if-present',
  } as const;
}

/**
 * The env vars the generated gateway reads a model key from. A fake model has no key, and
 * `apiKeyEnv` is absent for it, so a fake-only project's gate runs unguarded.
 */
function declaredSecrets(ir: IR): readonly string[] {
  const names = new Set<string>();
  for (const model of ir.models) {
    if (model.provider !== 'fake' && model.apiKeyEnv !== undefined) names.add(model.apiKeyEnv);
  }
  return [...names].sort();
}

/**
 * The driver, when the spec declares any eval at all.
 *
 * Every eval suite runs it, CI-gated or not, because it is the only way a retrieval eval
 * can be measured in a project whose store is `kind: memory`. Emitting it only alongside
 * the workflow would leave the developer without a runnable command.
 */
function evalDriverFiles(ir: IR): readonly EmittedFile[] {
  return ir.evals.length === 0 ? [] : [emitEvalDriver()];
}

/**
 * The eval workflow, for specs that declare a `gate.ci` eval.
 *
 * The suites run the emitted driver rather than a published CLI command, so the gate in
 * CI is the gate a developer runs by hand: same module, same driver, same index. A spec
 * with no CI gate gets no workflow -- an empty one would be a green check that measures
 * nothing.
 */
function evalsScaffold(ir: IR): readonly GeneratedFile[] {
  const suites = ir.evals.filter((evaluation) => evaluation.gate.ci);
  if (suites.length === 0) return [];
  const profile = ciProfile();
  return [
    scaffoldEvals(
      {
        target: profile.target,
        specPath: profile.specPath,
        /*
         * The workflow already installs Node to run the CLI, and `npm i -g` needs it
         * before any step here could; a second setup-node step would only be a cache
         * reset. Python passes its setup-python step because Node alone cannot run its
         * eval modules.
         */
        toolchain: [],
        install: profile.install,
        /* The driver loads compiled modules, so the workflow builds before it measures. */
        prepare: [profile.build],
        suites: suites.map((evaluation) => ({
          id: evaluation.id,
          command: `node ${paths.evalsDriver} ${evaluation.id}`,
        })),
        secrets: declaredSecrets(ir),
        credentialNote: ambientCredentialNote(ir.models.map((model) => model.provider)),
      },
      cliRangeFor(GENERATOR_VERSION),
    ),
  ];
}

/** Every file the IR implies, in a fixed order, unsorted. */
function collect(ir: IR): EmittedFile[] {
  const files: EmittedFile[] = [];

  files.push(emitSchemas(ir));
  const requests = emitRequests(ir);
  if (requests !== undefined) files.push(requests);

  files.push(emitObservability(ir));
  files.push(emitDeps(ir));
  files.push(emitControl(ir));
  files.push(emitGuardrails(ir));
  const agents = emitAgents(ir);
  if (agents !== undefined) files.push(agents);
  files.push(emitGatewayModels(ir));
  files.push(emitGatewayIndex(ir));

  files.push(emitContractsIndex(ir));
  for (const tool of ir.tools) {
    files.push(emitContractModule(ir, tool));
    files.push(emitToolAdapter(ir, tool));
  }
  files.push(emitToolsIndex(ir));

  files.push(...emitPromptModules(ir));
  files.push(emitPromptsIndex(ir));

  for (const pipeline of ir.pipelines) {
    files.push(emitPipelineModule(ir, pipeline));
    files.push(emitRouteModule(ir, pipeline));
  }
  files.push(emitPipelinesIndex(ir));
  files.push(emitRoutesIndex(ir));

  files.push(emitRetrievalBindings(ir));
  files.push(emitRetrievalIndex(ir));
  files.push(...emitRetrievalIngestModules(ir));
  files.push(emitRetrievalIngestIndex(ir));

  files.push(...emitEvalModules(ir));
  files.push(emitEvalsIndex(ir));
  files.push(...evalDriverFiles(ir));

  files.push(...emitBusinessToolSeeds(ir));
  files.push(emitBusinessToolsIndex(ir));
  files.push(emitBusinessPromptsIndex(ir));
  files.push(emitBusinessIndex(ir));

  files.push(emitGeneratedIndex(ir));
  files.push(scaffoldCi(ciProfile(), cliRangeFor(GENERATOR_VERSION)));
  files.push(...evalsScaffold(ir));

  return files;
}

/** The plan's files, sorted by path so two runs cannot differ by traversal order. */
export function filesFor(ir: IR): GeneratedFile[] {
  return sortByPath(collect(ir));
}

/** The plan, or a `TsVercelPlanError` naming every reason it cannot be emitted. */
export function planTsVercel(ir: IR): Plan {
  const problems = checkPlan(ir);
  if (problems.length > 0) throw new TsVercelPlanError(problems);
  return { files: filesFor(ir) };
}

/** The plan as a path-to-bytes map, for callers that only want the tree. */
export function fileMap(plan: Plan): Map<string, string> {
  return new Map(plan.files.map((file) => [file.path, file.content]));
}
