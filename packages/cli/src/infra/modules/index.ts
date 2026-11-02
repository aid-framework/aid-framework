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

export { BATCH_MODULE_DIR, emitBatchModule } from './batch.js';
export { CLOUDRUN_MODULE_DIR, emitCloudRunModule } from './cloudrun.js';
export { CLOUDRUNJOB_MODULE_DIR, emitCloudRunJobModule } from './cloudrunjob.js';
export { CONTAINER_MODULE_DIR, emitContainerModule } from './container.js';
export { type EnvRootModules, envRoot } from './env-root.js';
export type { ModuleFile } from './hcl.js';
export { hcl } from './hcl.js';
export { emitServerlessModule, SERVERLESS_MODULE_DIR } from './serverless.js';

import { emitBatchModule } from './batch.js';
import { emitCloudRunModule } from './cloudrun.js';
import { emitCloudRunJobModule } from './cloudrunjob.js';
import { emitContainerModule } from './container.js';
import { emitServerlessModule } from './serverless.js';

/**
 * Which platform modules a plan needs, in the shape `envRoot` reads.
 *
 * `container` is cloud-neutral: the same deployment is ECS on AWS and Cloud Run on GCP.
 * On GCP a `serverless` service joins it, because the function API takes only a source
 * zip while every service here deploys from an image -- Cloud Run is what gen2 builds on
 * and it runs the image directly. On AWS `serverless` is its own module: Lambda gets the
 * image, but the HTTP API in front of it is a different shape. `batch` means "some
 * deployment targets batch"; the cloud decides which module that is, AWS Batch on `aws`
 * and a Cloud Run job on `gcp`.
 */
export function modulesOf(
  plan: DeployPlan,
  cloud: Cloud = DEFAULT_CLOUD,
): {
  serverless: boolean;
  container: boolean;
  batch: boolean;
} {
  return {
    serverless: cloud === 'aws' && plan.services.some((service) => service.target === 'serverless'),
    container: plan.services.some(
      (service) =>
        service.target === 'container' || (cloud === 'gcp' && service.target === 'serverless'),
    ),
    batch: plan.services.some((service) => service.target === 'batch'),
  };
}

/** Every provider module the plan needs on this cloud, or none. */
export function emitProviderModules(plan: DeployPlan, cloud: Cloud = DEFAULT_CLOUD): ModuleFile[] {
  return cloud === 'gcp'
    ? [...emitCloudRunModule(plan), ...emitCloudRunJobModule(plan)]
    : [...emitServerlessModule(plan), ...emitContainerModule(plan), ...emitBatchModule(plan)];
}
