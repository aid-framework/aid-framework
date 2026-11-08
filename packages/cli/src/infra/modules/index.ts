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

export { AGENT_RUNTIME_MODULE_DIR, emitAgentRuntimeModule } from './agent-runtime.js';
export { BATCH_MODULE_DIR, emitBatchModule } from './batch.js';
export {
  CDK_CONTAINER_MODULE,
  CDK_DIR,
  CDK_KNOWLEDGE_BASE_MODULE,
  CDK_SERVERLESS_MODULE,
  emitCdkModules,
} from './cdk.js';
export { CLOUDRUN_MODULE_DIR, emitCloudRunModule } from './cloudrun.js';
export { CLOUDRUNJOB_MODULE_DIR, emitCloudRunJobModule } from './cloudrunjob.js';
export { CONTAINER_MODULE_DIR, emitContainerModule } from './container.js';
export { EDGE_MODULE_DIR, emitEdgeModule } from './edge.js';
export { type EnvRootModules, envRoot } from './env-root.js';
export type { ModuleFile } from './hcl.js';
export { hcl } from './hcl.js';
export { emitKnowledgeBaseModule, KNOWLEDGE_BASE_MODULE_DIR } from './knowledge-base.js';
export { emitServerlessModule, SERVERLESS_MODULE_DIR } from './serverless.js';
export { emitVertexRagModule, VERTEX_RAG_MODULE_DIR } from './vertex-rag.js';

import { emitAgentRuntimeModule } from './agent-runtime.js';
import { emitBatchModule } from './batch.js';
import { emitCdkModules } from './cdk.js';
import { emitCloudRunModule } from './cloudrun.js';
import { emitCloudRunJobModule } from './cloudrunjob.js';
import { emitContainerModule } from './container.js';
import { emitEdgeModule } from './edge.js';
import { emitKnowledgeBaseModule } from './knowledge-base.js';
import { emitServerlessModule } from './serverless.js';
import { emitVertexRagModule } from './vertex-rag.js';

/**
 * Which platform modules a plan needs, in the shape `envRoot` reads.
 *
 * `container` is cloud-neutral: the same deployment is ECS on AWS and Cloud Run on GCP.
 * On GCP a `serverless` service joins it, because the function API takes only a source
 * zip while every service here deploys from an image -- Cloud Run is what gen2 builds on
 * and it runs the image directly. On AWS `serverless` is its own module: Lambda gets the
 * image, but the HTTP API in front of it is a different shape. `batch` means "some
 * deployment targets batch"; the cloud decides which module that is, AWS Batch on `aws`
 * and a Cloud Run job on `gcp`. `edge` is AWS-only: it is Lambda@Edge behind CloudFront,
 * and GCP has no counterpart (`CLOUD_TARGETS` refuses it there).
 */
export function modulesOf(
  plan: DeployPlan,
  cloud: Cloud = DEFAULT_CLOUD,
): {
  serverless: boolean;
  container: boolean;
  batch: boolean;
  edge: boolean;
  knowledgeBase: boolean;
  agentRuntime: boolean;
} {
  const managed = (service: DeployPlan['services'][number]) =>
    service.runtime !== undefined && service.runtime !== null;
  return {
    serverless:
      cloud === 'aws' &&
      plan.services.some((service) => service.target === 'serverless' && !managed(service)),
    container: plan.services.some(
      (service) =>
        !managed(service) &&
        (service.target === 'container' || (cloud === 'gcp' && service.target === 'serverless')),
    ),
    batch: plan.services.some((service) => service.target === 'batch' && !managed(service)),
    edge: cloud === 'aws' && plan.services.some((service) => service.target === 'edge'),
    knowledgeBase:
      (cloud === 'aws' && plan.knowledgeBases.some((base) => base.engine === 'aws-bedrock')) ||
      (cloud === 'gcp' && plan.knowledgeBases.some((base) => base.engine === 'vertex-rag')),
    // A runtime service is emitted by the agent-runtime module instead of the compute
    // module above, so the two call sites are mutually exclusive by construction.
    agentRuntime: plan.services.some(
      (service) => service.runtime !== undefined && service.runtime.cloud === cloud,
    ),
  };
}

/** Every provider module the plan needs on this cloud, or none. */
export function emitProviderModules(plan: DeployPlan, cloud: Cloud = DEFAULT_CLOUD): ModuleFile[] {
  return cloud === 'gcp'
    ? [
        ...emitCloudRunModule(plan),
        ...emitCloudRunJobModule(plan),
        ...emitVertexRagModule(plan),
        ...emitAgentRuntimeModule(plan, cloud),
      ]
    : [
        ...emitServerlessModule(plan),
        ...emitContainerModule(plan),
        ...emitBatchModule(plan),
        ...emitEdgeModule(plan),
        ...emitKnowledgeBaseModule(plan),
        ...emitAgentRuntimeModule(plan, cloud),
        ...emitCdkModules(plan, cloud),
      ];
}
