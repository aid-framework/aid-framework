/**
 * Where emitted files live.
 *
 * The three roots come from the manifest through `managedRoots`, never from a literal
 * here, so the plan and `aid gen`'s ownership check cannot disagree about a path. The
 * per-file paths are derived from those roots for the same reason.
 *
 * The one thing this target deliberately does *not* emit is `app/api/<path>/route.ts`.
 * A7 asks for that shim "that Next actually serves", but `validatePlan` rejects any
 * path outside the managed roots, and `parseAidManifest` would reject the resulting
 * manifest on the next run: `ownerForPath` classifies by the first path segment, so
 * `app/api/...` has no owner. Emitting it would be a hard CLI break, not a cosmetic
 * deviation. The example therefore hand-writes a one-line re-export under `app/api/`
 * and the generator emits the handler it delegates to, mirroring how the Python
 * example hand-writes `app/main.py`. See the README.
 */

import { managedRoots } from '@aid/generator-sdk';
import { TS_VERCEL_MANIFEST } from '../manifest.js';

export const MANIFEST_PATH = managedRoots(TS_VERCEL_MANIFEST).manifestFilename;
export const GENERATED_ROOT = managedRoots(TS_VERCEL_MANIFEST).generatedDir;
export const BUSINESS_ROOT = managedRoots(TS_VERCEL_MANIFEST).businessDir;

/** The manifest's `output.root`: the Next.js App Router directory. */
export const APP_ROOT = TS_VERCEL_MANIFEST.output.root;

export type FileOwner = 'generated' | 'business';

export interface EmittedFile {
  readonly path: string;
  readonly content: string;
  readonly owner: FileOwner;
}

/** The per-file paths, as one table so a test can assert the layout once. */
export const paths = {
  generatedIndex: `${GENERATED_ROOT}/index.ts`,
  schemas: `${GENERATED_ROOT}/schemas.ts`,
  requests: `${GENERATED_ROOT}/requests.ts`,
  deps: `${GENERATED_ROOT}/deps.ts`,
  control: `${GENERATED_ROOT}/control.ts`,
  guardrails: `${GENERATED_ROOT}/guardrails.ts`,
  agents: `${GENERATED_ROOT}/agents.ts`,
  observability: `${GENERATED_ROOT}/observability.ts`,
  gatewayModels: `${GENERATED_ROOT}/gateway/models.ts`,
  gatewayIndex: `${GENERATED_ROOT}/gateway/index.ts`,
  toolsIndex: `${GENERATED_ROOT}/tools/index.ts`,
  contractsIndex: `${GENERATED_ROOT}/contracts/index.ts`,
  contractsCitations: `${GENERATED_ROOT}/contracts/citations.ts`,
  promptsIndex: `${GENERATED_ROOT}/prompts/index.ts`,
  pipelinesIndex: `${GENERATED_ROOT}/pipelines/index.ts`,
  routesIndex: `${GENERATED_ROOT}/routes/index.ts`,
  retrievalBindings: `${GENERATED_ROOT}/retrieval/bindings.ts`,
  retrievalIndex: `${GENERATED_ROOT}/retrieval/index.ts`,
  retrievalIngestIndex: `${GENERATED_ROOT}/retrieval/ingest/index.ts`,
  evalsIndex: `${GENERATED_ROOT}/evals/index.ts`,
  businessIndex: `${BUSINESS_ROOT}/index.ts`,
  businessToolsIndex: `${BUSINESS_ROOT}/tools/index.ts`,
  businessPromptsIndex: `${BUSINESS_ROOT}/prompts/index.ts`,
} as const;

export function toolAdapterPath(tool: string): string {
  return `${GENERATED_ROOT}/tools/${tool}.ts`;
}

export function toolContractPath(tool: string): string {
  return `${GENERATED_ROOT}/contracts/${tool}.ts`;
}

export function promptPath(prompt: string): string {
  return `${GENERATED_ROOT}/prompts/${prompt}.ts`;
}

export function pipelinePath(pipeline: string): string {
  return `${GENERATED_ROOT}/pipelines/${pipeline}.ts`;
}

export function routePath(pipeline: string): string {
  return `${GENERATED_ROOT}/routes/${pipeline}.ts`;
}

export function retrievalIngestModulePath(retriever: string): string {
  return `${GENERATED_ROOT}/retrieval/ingest/${retriever}.ts`;
}

export function evalModulePath(evalId: string): string {
  return `${GENERATED_ROOT}/evals/${evalId}.ts`;
}

export function businessToolPath(tool: string): string {
  return `${BUSINESS_ROOT}/tools/${tool}.ts`;
}

export function generated(path: string, content: string): EmittedFile {
  return { path, content, owner: 'generated' };
}

export function business(path: string, content: string): EmittedFile {
  return { path, content, owner: 'business' };
}
