/**
 * Where infrastructure files live.
 *
 * Separate from `emit.ts` so the module emitter can name its directory without importing
 * the file that imports it -- a cycle would evaluate `INFRA_GENERATED_DIR` before its
 * declaration, and an emitter that throws on import is not a scaffolding problem.
 */

/** Where every derived infrastructure file lives, relative to the project root. */
export const INFRA_GENERATED_DIR = 'infra/generated';

/** The plan both backends read. */
export const INFRA_PLAN_PATH = `${INFRA_GENERATED_DIR}/deploy.plan.json`;

/** The same plan spelled for a CDK app, which is TypeScript and therefore camelCase. */
export const INFRA_CDK_CONTEXT_PATH = `${INFRA_GENERATED_DIR}/deploy.cdk-context.json`;

/** The manifest recording what this emitter wrote, so a hand edit is never overwritten. */
export const INFRA_MANIFEST_PATH = 'infra/aid.infra.manifest.json';
