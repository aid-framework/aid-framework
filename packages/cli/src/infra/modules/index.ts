/**
 * The provider modules `aid infra gen` can emit, and the env root that calls them.
 *
 * One entry per deployment target that has a module. Adding `batch` or `edge` means a new
 * file here and one line in `emitProviderModules`; nothing in `emit.ts` changes, which is
 * the point of the seam.
 */

import type { DeployPlan } from '@aid-framework/ir';

import type { ModuleFile } from './hcl.js';

export { CONTAINER_MODULE_DIR, emitContainerModule } from './container.js';
export { type EnvRootModules, envRoot } from './env-root.js';
export type { ModuleFile } from './hcl.js';
export { hcl } from './hcl.js';
export { emitServerlessModule, SERVERLESS_MODULE_DIR } from './serverless.js';

import { emitContainerModule } from './container.js';
import { emitServerlessModule } from './serverless.js';

/** Which platform modules a plan needs, in the shape `envRoot` reads. */
export function modulesOf(plan: DeployPlan): {
  serverless: boolean;
  container: boolean;
} {
  return {
    serverless: plan.services.some((service) => service.target === 'serverless'),
    container: plan.services.some((service) => service.target === 'container'),
  };
}

/** Every provider module the plan needs, or none. */
export function emitProviderModules(plan: DeployPlan): ModuleFile[] {
  return [...emitServerlessModule(plan), ...emitContainerModule(plan)];
}
