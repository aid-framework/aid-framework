/**
 * The generator's pure half: IR in, a file list out, nothing written.
 *
 * `planPyFastApi` is the only place that decides which files this target produces. It
 * validates before it emits, so a declaration the target cannot express stops
 * generation instead of being silently dropped or silently ignored (see `./validate.ts`
 * for the decision table and the reason each rejection exists).
 *
 * The result is a canonical value: files are sorted by path, so byte-identical output
 * is a property of the IR rather than of the order these emitters happen to be called
 * in. `emit` is the identity on the sorted plan -- the plan already holds the bytes,
 * which is what makes the golden test, the determinism test and the drift check all
 * measurable without a filesystem.
 */

import type { GeneratedFile, Plan } from '@aid-framework/generator-sdk';
import {
  ACTION_PINS,
  cliRangeFor,
  scaffoldCi,
  scaffoldEvals,
  scaffoldInfraPlan,
  scaffoldRelease,
} from '@aid-framework/generator-sdk';
import type { IR } from '@aid-framework/ir';

import { emitAgents, hasAgents } from './emit/agents.js';
import { emitBusinessToolSeed, emitContractsInit, emitToolContract } from './emit/contracts.js';
import { emitControl, hasComposite } from './emit/control.js';
import { emitDeps } from './emit/deps.js';
import { DOCKERFILE_PATH, emitDockerfile, hasContainerDeployment } from './emit/dockerfile.js';
import { emitEval, emitEvalsInit, evalModulePath } from './emit/evals.js';
import { emitGatewayInit, emitGatewayModels } from './emit/gateway.js';
import { emitGuardrails, hasGuardrails } from './emit/guardrails.js';
import { emitObservability } from './emit/observability.js';
import { orderedEvals, orderedPipelines, orderedPrompts, orderedTools } from './emit/order.js';
import { emitBusinessInit, emitGeneratedInit } from './emit/package.js';
import { emitPipelines } from './emit/pipelines.js';
import { emitBusinessPromptsInit, emitPromptModule, emitPromptsInit } from './emit/prompts.js';
import { emitRetrieval } from './emit/retrieval.js';
import { emitSchemas } from './emit/schemas.js';
import { emitSse } from './emit/sse.js';
import { emitBusinessToolsInit, emitToolAdapter, emitToolsInit } from './emit/tools.js';
import { PyFastApiPlanError } from './errors.js';
import { GENERATOR_VERSION, PY_FASTAPI_MANIFEST } from './manifest.js';
import { streams } from './streaming.js';
import { checkPlan } from './validate.js';

/** Code-unit order, so the plan does not depend on locale. */
function byPath(left: GeneratedFile, right: GeneratedFile): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/**
 * Every file this target emits for `ir`, in canonical order.
 *
 * The tree is laid out as design §8.3 describes: `generated/` is entirely this
 * generator's, `business/` holds only the seams a developer is meant to edit, and the
 * two `__init__.py` files that make the package importable belong to it as well.
 * Nothing above `generated/` or `business/` is planned except the scaffold files §6a
 * allows -- the CI workflow, and the eval workflow when the spec declares a `gate.ci`
 * eval -- so `app/main.py` and the app's packaging are the application's own files
 * rather than generation output.
 */
export function filesFor(ir: IR): GeneratedFile[] {
  const prompts = orderedPrompts(ir);
  const tools = orderedTools(ir);
  /* The negotiation module exists when a route reads it, and a guardrail module when a
   * declaration needs one -- a file nothing imports is a file a reader has to explain. */
  const servesStreams = orderedPipelines(ir).some((pipeline) => streams(ir, pipeline));
  return [
    emitGeneratedInit(ir),
    emitSchemas(ir),
    emitObservability(ir),
    emitDeps(ir),
    ...(hasComposite(ir.pipelines) ? [emitControl(ir)] : []),
    emitGatewayModels(ir),
    emitGatewayInit(),
    ...(hasAgents(ir) ? [emitAgents(ir)] : []),
    ...(hasGuardrails(ir) ? [emitGuardrails(ir)] : []),
    ...(servesStreams ? [emitSse()] : []),
    ...tools.map((tool) => emitToolAdapter(ir, tool)),
    emitToolsInit(ir),
    ...prompts.map((prompt) => emitPromptModule(prompt)),
    emitPromptsInit(ir),
    ...emitPipelines(ir),
    emitContractsInit(),
    ...tools.map((tool) => emitToolContract(tool)),
    emitEvalsInit(ir),
    ...orderedEvals(ir).map((evaluation) => emitEval(ir, evaluation)),
    ...emitRetrieval(ir),
    ...(hasContainerDeployment(ir) ? [emitDockerfile(ir)] : []),
    emitBusinessInit(ir),
    emitBusinessToolsInit(ir),
    ...tools.map((tool) => emitBusinessToolSeed(tool)),
    emitBusinessPromptsInit(),
    scaffoldCi(ciProfile(), cliRangeFor(GENERATOR_VERSION)),
    ...evalsScaffold(ir),
    ...releaseScaffold(ir),
    scaffoldInfraPlan({ target: PY_FASTAPI_MANIFEST.target }, cliRangeFor(GENERATOR_VERSION)),
  ].sort(byPath);
}

/** The scaffold profile for this target; the spec path follows the manifest's root. */
function ciProfile() {
  const root = PY_FASTAPI_MANIFEST.output.root;
  return {
    target: PY_FASTAPI_MANIFEST.target,
    specPath: `${root}/app.spec.yaml`,
    dependencyManifest: 'pyproject.toml',
    toolchain: [`- uses: ${ACTION_PINS.setupPython}`, '  with:', "    python-version: '3.11'"],
    install: ['pip install --upgrade pip', 'pip install -e ".[dev]"'],
    lint: ['ruff check .', 'ruff format --check .', 'mypy'],
    build: 'python -m compileall -q app',
    test: 'pytest -q',
  } as const;
}

/**
 * The env vars the generated gateway reads a model key from. A fake model has no key, and
 * `apiKeyEnv` is absent for it, so the gate runs unguarded in a fake-only project.
 */
function declaredSecrets(ir: IR): readonly string[] {
  const names = new Set<string>();
  for (const model of ir.models) {
    if (model.provider !== 'fake' && model.apiKeyEnv !== undefined) names.add(model.apiKeyEnv);
  }
  return [...names].sort();
}

/**
 * The eval gate, for specs that declare a `gate.ci` eval.
 *
 * The command is the generated module itself -- the same one `aid eval` shells out to --
 * so the workflow does not depend on a published CLI version, and the gate that runs in
 * CI is byte-for-byte the gate a developer runs by hand.
 */
function evalsScaffold(ir: IR): readonly GeneratedFile[] {
  const suites = orderedEvals(ir).filter((evaluation) => evaluation.gate.ci);
  if (suites.length === 0) return [];
  const profile = ciProfile();
  return [
    scaffoldEvals(
      {
        target: profile.target,
        specPath: profile.specPath,
        toolchain: profile.toolchain,
        install: profile.install,
        suites: suites.map((evaluation) => ({
          id: evaluation.id,
          command: `python -m ${evalModulePath(evaluation.id)
            .replace(/\.py$/, '')
            .replace(/\//g, '.')}`,
        })),
        secrets: declaredSecrets(ir),
      },
      cliRangeFor(GENERATOR_VERSION),
    ),
  ];
}

/**
 * The release workflow, for specs that name a registry for at least one image.
 *
 * The workflow is planned only when a deployment declares `image`: a project that never
 * declared one has nothing to publish, and a workflow that pushed to a repository the
 * spec does not name would be an invented artifact. Deployments that name the same
 * repository collapse into one matrix entry -- publishing the same tags twice in one run
 * would race with itself.
 */
function releaseScaffold(ir: IR): readonly GeneratedFile[] {
  const byRepository = new Map<string, { registry: string; ids: string[] }>();
  for (const deployment of ir.deployments) {
    const image = deployment.image;
    if (image === undefined) continue;
    const entry = byRepository.get(image.name) ?? { registry: image.registry, ids: [] };
    entry.ids.push(deployment.id);
    byRepository.set(image.name, entry);
  }
  if (byRepository.size === 0) return [];
  const images = [...byRepository.entries()]
    .map(([name, entry]) => ({
      registry: entry.registry,
      name,
      deploymentIds: [...entry.ids].sort(),
    }))
    .sort((left, right) => compareCodeUnits(left.name, right.name));
  const profile = ciProfile();
  return [
    scaffoldRelease(
      {
        target: profile.target,
        specPath: profile.specPath,
        dockerfile: DOCKERFILE_PATH,
        images,
      },
      cliRangeFor(GENERATOR_VERSION),
    ),
  ];
}

/** Code-unit order, so the matrix is byte-identical regardless of locale. */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The plan for `ir`.
 *
 * Every problem this target found is reported at once -- `PyFastApiPlanError.codes` is
 * the sorted, deduplicated set -- because a generator that reveals one unsupported
 * declaration per run is how a half-generated application reaches a review.
 */
export function planPyFastApi(ir: IR): Plan {
  const problems = checkPlan(ir);
  if (problems.length > 0) {
    throw new PyFastApiPlanError(problems);
  }
  return { files: filesFor(ir) };
}

/** A plan's files as a `path -> content` map, for golden comparison and drift checks. */
export function fileMap(plan: Plan): Map<string, string> {
  return new Map(plan.files.map((file) => [file.path, file.content]));
}
