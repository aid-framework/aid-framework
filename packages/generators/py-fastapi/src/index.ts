/**
 * `@aid/generator-py-fastapi`: the Phase 0 Python target.
 *
 * The single input is the IR. Nothing here reads a spec file, a template directory or
 * the filesystem at all: `plan` is a pure function of the IR, and the runtime library
 * (`aid-runtime-python`) holds the behaviour. Generated code is declarative wiring --
 * model aliases, prompt templates, request and response models, routes, tool adapters,
 * the eval definitions, retriever bindings with their ingest entry points -- and
 * everything it calls into already exists in the runtime.
 *
 * `pyFastApiGenerator` is the object a loader or the CLI drives; its identity fields
 * are read off {@link PY_FASTAPI_MANIFEST} so the manifest a loader validates and the
 * generator it then runs cannot disagree.
 */

import type { Generator, Plan } from '@aid/generator-sdk';

import { PY_FASTAPI_MANIFEST } from './manifest.js';
import { planPyFastApi } from './plan.js';

/** Where the generated tree puts each artifact, so tests and the drift check agree. */
export { businessToolPath, CONTRACTS_INIT_PATH, contractsPath } from './emit/contracts.js';
/**
 * The composite bounds module, and the walks over step shapes that decide what it holds.
 *
 * Exported rather than kept internal because the bound is emitted, not computed at run
 * time: `control.test.ts` compares what was written into `generated/control.py` against
 * the spec gate's own constant and against the runtime's, and that comparison is the only
 * mechanism that can hold a number steady across a language boundary.
 */
export {
  ANONYMOUS_PRINCIPAL,
  CONCURRENCY_LIMIT,
  CONTROL_PATH,
  childrenOf,
  concurrencyCap,
  DEPTH_KEY,
  everyStep,
  hasBranch,
  hasComposite,
  hasFanOut,
  INDEX_KEY,
  ITEM_KEY,
  LIMITER_KEY,
  PRINCIPAL_KEY,
  REDUCED_KEY,
  RESERVED_KEYS,
} from './emit/control.js';
export { DEPS_PATH } from './emit/deps.js';
export {
  baselineRelativePath,
  datasetRelativePath,
  EVALS_INIT_PATH,
  evalModulePath,
} from './emit/evals.js';

/** The roots the plan writes into, read from the manifest rather than restated. */
export { APP_ROOT, BUSINESS_ROOT, GENERATED_ROOT, MANIFEST_PATH } from './emit/file.js';
export { GATEWAY_INIT_PATH, GATEWAY_MODELS_PATH } from './emit/gateway.js';
export { OBSERVABILITY_PATH } from './emit/observability.js';
export { BUSINESS_INIT_PATH, GENERATED_INIT_PATH } from './emit/package.js';
export {
  PIPELINES_INIT_PATH,
  pipelinePath,
  REQUESTS_PATH,
  ROUTES_INIT_PATH,
  routePath,
} from './emit/pipelines.js';
export { BUSINESS_PROMPTS_INIT_PATH, PROMPTS_INIT_PATH, promptPath } from './emit/prompts.js';
export {
  CITATIONS_CONTRACT_PATH,
  RETRIEVAL_BINDINGS_PATH,
  RETRIEVAL_INIT_PATH,
} from './emit/retrieval.js';
export { RETRIEVAL_INGEST_INIT_PATH, retrievalIngestModulePath } from './emit/retrievalIngest.js';
export { SCHEMAS_PATH } from './emit/schemas.js';
export { TOOLS_INIT_PATH, toolAdapterPath } from './emit/tools.js';
export { PyFastApiPlanError } from './errors.js';
export {
  GENERATOR_NAME,
  GENERATOR_VERSION,
  PY_FASTAPI_MANIFEST,
  PY_FASTAPI_MANIFEST_INPUT,
  PY_FASTAPI_TARGET,
  supportsIrVersion,
} from './manifest.js';
/** The metric mapping, so the eval gate's metric names are assertable without emitting. */
export {
  deterministicMetrics,
  isRetrievalEval,
  jsonSchemaMetric,
  judgeAlias,
  metricBindings,
  usesJudge,
} from './metrics.js';
export { fileMap, filesFor, planPyFastApi } from './plan.js';
export type { PlanProblem, PlanProblemCode, RequestField, RequestPlan } from './validate.js';
/**
 * The validation half, for callers that want to report problems instead of catching an
 * exception -- the CLI generates diagnostics from these, and the tests assert on them.
 */
export {
  checkPlan,
  checkRetrievers,
  evalSubject,
  modelsUnderTest,
  renderNames,
  requestPlan,
  responsePlan,
} from './validate.js';

/** The plan, unchanged. `plan` already holds the bytes; `emit` only hands them over. */
function emit(plan: Plan) {
  return plan.files;
}

/**
 * The generator a loader or the CLI drives. Every identity field comes off the
 * manifest, so a manifest a loader validated and the generator it then ran cannot
 * disagree about which target, version or IR range they describe.
 */
export const pyFastApiGenerator: Generator = {
  name: PY_FASTAPI_MANIFEST.name,
  target: PY_FASTAPI_MANIFEST.target,
  version: PY_FASTAPI_MANIFEST.version,
  irRange: PY_FASTAPI_MANIFEST.irRange,
  plan: (ir) => planPyFastApi(ir),
  emit,
};
