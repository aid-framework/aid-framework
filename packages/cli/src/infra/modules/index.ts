/**
 * The provider modules `aid infra gen` can emit, and the env root that calls them.
 *
 * One entry per (cloud, deployment target) that has a module. Adding `batch` or `edge`
 * means a new file here and one line in `emitProviderModules`; nothing in `emit.ts`
 * changes, which is the point of the seam.
 */

import type { DeployPlan } from '@aid-framework/ir';

import { type Cloud, DEFAULT_CLOUD } from '../cloud.js';
import type { ModuleFile } from './hcl.js';

export { CLOUDRUN_MODULE_DIR, emitCloudRunModule } from './cloudrun.js';
export { CONTAINER_MODULE_DIR, emitContainerModule } from './container.js';
export { type EnvRootModules, envRoot } from './env-root.js';
export type { ModuleFile } from './hcl.js';
export { hcl } from './hcl.js';
export { emitServerlessModule, SERVERLESS_MODULE_DIR } from './serverless.js';

import { emitCloudRunModule } from './cloudrun.js';
import { emitContainerModule } from './container.js';
import { emitServerlessModule } from './serverless.js';

/**
 * Which platform modules a plan needs, in the shape `envRoot` reads.
 *
 * `container` is cloud-neutral: the same deployment is ECS on AWS and Cloud Run on GCP.
 * `serverless` is not, because GCP's counterpart runs on Cloud Functions and needs a
 * different entrypoint; the command refuses that plan before this is ever asked, so
 * reporting `false` here is the second half of the same answer, not a silent drop.
 */
export function modulesOf(
  plan: DeployPlan,
  cloud: Cloud = DEFAULT_CLOUD,
): {
  serverless: boolean;
  container: boolean;
} {
  return {
    serverless: cloud === 'aws' && plan.services.some((service) => service.target === 'serverless'),
    container: plan.services.some((service) => service.target === 'container'),
  };
}

/** Every provider module the plan needs on this cloud, or none. */
export function emitProviderModules(plan: DeployPlan, cloud: Cloud = DEFAULT_CLOUD): ModuleFile[] {
  return cloud === 'gcp'
    ? emitCloudRunModule(plan)
    : [...emitServerlessModule(plan), ...emitContainerModule(plan)];
}
