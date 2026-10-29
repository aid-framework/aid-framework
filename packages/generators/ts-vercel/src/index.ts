/**
 * `@aid/generator-ts-vercel`: the Phase 1 TypeScript target.
 *
 * The single input is the IR. Nothing here reads a spec file, a template directory or
 * the filesystem: `plan` is a pure function of the IR, and `@aid/runtime` holds the
 * behaviour. Generated code is declarative wiring -- zod schemas, model aliases, prompt
 * templates, tool adapters and their contracts, pipelines, routes, retriever bindings
 * with their ingest entry points -- and everything it calls into already exists in the
 * runtime.
 *
 * Two deliberate deviations from the plan's wording are documented in the README and
 * repeated here because a reader will otherwise assume a bug:
 *
 * 1. `emitsAgainst` carries `structuredOutput` and `tracing` only. The manifest
 *    vocabulary has no `vectorStore` key, so `vectorStore: 'pgvector'` reaches the
 *    runtime as the spec's `stores[].kind` instead of as a declaration.
 * 2. `app/api/<path>/route.ts` is hand-written in the example, not emitted. A path
 *    outside the managed roots has no owner, so emitting it would fail `validatePlan`
 *    and break the next `aid gen`. The generator emits the handler; the example's
 *    one-line Next shim delegates to it.
 */

import type { Generator, Plan } from '@aid/generator-sdk';

import {
  APP_ROOT,
  BUSINESS_ROOT,
  evalModulePath,
  GENERATED_ROOT,
  MANIFEST_PATH,
  paths,
  retrievalIngestModulePath,
} from './emit/file.js';
import { TS_VERCEL_MANIFEST } from './manifest.js';
import { planTsVercel } from './plan.js';

export { TsVercelPlanError } from './errors.js';
export {
  GENERATOR_NAME,
  GENERATOR_VERSION,
  supportsIrVersion,
  TS_VERCEL_CAPABILITIES,
  TS_VERCEL_MANIFEST,
  TS_VERCEL_MANIFEST_INPUT,
  TS_VERCEL_TARGET,
} from './manifest.js';
export { fileMap, filesFor, planTsVercel } from './plan.js';
export type { PlanProblem, PlanProblemCode } from './validate.js';
export {
  checkPlan,
  declaredCapabilities,
  RESERVED_BINDINGS,
} from './validate.js';
export {
  APP_ROOT,
  BUSINESS_ROOT,
  evalModulePath,
  GENERATED_ROOT,
  MANIFEST_PATH,
  paths,
  retrievalIngestModulePath,
};

/** The plan, unchanged. `plan` already holds the bytes; `emit` only hands them over. */
function emit(plan: Plan) {
  return plan.files;
}

/**
 * The generator a loader or the CLI drives. Every identity field comes off the
 * manifest, so a manifest a loader validated and the generator it then ran cannot
 * disagree about which target, version or IR range they describe.
 */
export const tsVercelGenerator: Generator = {
  name: TS_VERCEL_MANIFEST.name,
  target: TS_VERCEL_MANIFEST.target,
  version: TS_VERCEL_MANIFEST.version,
  irRange: TS_VERCEL_MANIFEST.irRange,
  plan: (ir) => planTsVercel(ir),
  emit,
};
