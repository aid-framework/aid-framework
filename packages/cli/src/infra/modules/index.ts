/**
 * The provider modules `aid infra gen` can emit, and the env root that calls them.
 *
 * One entry per (cloud, deployment target) that has a module. Adding a target to the
 * contract means a new file here and one line in `emitProviderModules`; nothing in
 * `emit.ts` changes, which is the point of the seam.
 */

import type { DeployPlan } from '@aid-framework/ir';

import { type Cloud, DEFAULT_CLOUD } from '../cloud.js';
import type { ModuleFile } from './hcl.js';

export { AGENT_RUNTIME_MODULE_DIR, emitAgentRuntimeModule } from './agent-runtime.js';
export { AUDIT_MODULE_DIR, emitAuditModule } from './audit.js';
export { BATCH_MODULE_DIR, emitBatchModule } from './batch.js';
export {
  CDK_BATCH_MODULE,
  CDK_CONTAINER_MODULE,
  CDK_DIR,
  CDK_EDGE_MODULE,
  CDK_GATEWAY_MODULE,
  CDK_KNOWLEDGE_BASE_MODULE,
  CDK_SERVERLESS_MODULE,
  emitCdkModules,
} from './cdk.js';
export { CLOUDRUN_MODULE_DIR, emitCloudRunModule } from './cloudrun.js';
export { CLOUDRUNJOB_MODULE_DIR, emitCloudRunJobModule } from './cloudrunjob.js';
export { CONTAINER_MODULE_DIR, emitContainerModule } from './container.js';
export { EDGE_MODULE_DIR, emitEdgeModule } from './edge.js';
export { type EnvRootModules, envRoot } from './env-root.js';
export { emitGatewayModule, GATEWAY_MODULE_DIR } from './gateway.js';
export type { ModuleFile } from './hcl.js';
export { hcl } from './hcl.js';
export { emitKnowledgeBaseModule, KNOWLEDGE_BASE_MODULE_DIR } from './knowledge-base.js';
export {
  emitModelArmorModule,
  MODEL_ARMOR_MODULE_DIR,
  MODEL_ARMOR_VARIABLES,
  modelArmorLocals,
} from './model-armor.js';
export { emitServerlessModule, SERVERLESS_MODULE_DIR } from './serverless.js';
export { emitVertexRagModule, VERTEX_RAG_MODULE_DIR } from './vertex-rag.js';

import { emitAgentRuntimeModule } from './agent-runtime.js';
import { emitAuditModule } from './audit.js';
import { emitBatchModule } from './batch.js';
import { emitCdkModules } from './cdk.js';
import { emitCloudRunModule } from './cloudrun.js';
import { emitCloudRunJobModule } from './cloudrunjob.js';
import { emitContainerModule } from './container.js';
import { emitEdgeModule } from './edge.js';
import { emitGatewayModule } from './gateway.js';
import { emitKnowledgeBaseModule } from './knowledge-base.js';
import { emitModelArmorModule } from './model-armor.js';
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
  /** A managed MCP gateway this plan owns, which only an AWS plan can. */
  gateway: boolean;
  agentRuntime: boolean;
  /** A Model Armor template this plan owns, which only a GCP plan can. */
  modelArmor: boolean;
  /** An audit destination the document pinned, which both clouds can create. */
  audit: boolean;
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
    // AgentCore Gateway is an AWS product: `infra gen` refuses a gateway on a GCP plan,
    // so the cloud check restates that refusal rather than adding a second rule.
    gateway: cloud === 'aws' && plan.gateways.length > 0,
    // A runtime service is emitted by the agent-runtime module instead of the compute
    // module above, so the two call sites are mutually exclusive by construction.
    agentRuntime: plan.services.some(
      (service) => service.runtime !== undefined && service.runtime.cloud === cloud,
    ),
    // Model Armor is a Google product: `infra gen` refuses the engine on AWS, so the
    // cloud check is a restatement of that refusal rather than a second rule.
    modelArmor:
      cloud === 'gcp' &&
      plan.services.some((service) => service.managedGuardrail?.engine === 'model-armor'),
    // Not cloud-gated: `profileGate` has already refused a sink the pinned cloud cannot
    // create, so by here the plan's destination is one this cloud has a module for.
    audit: plan.audit !== undefined,
  };
}

/** Every provider module the plan needs on this cloud, or none. */
export function emitProviderModules(plan: DeployPlan, cloud: Cloud = DEFAULT_CLOUD): ModuleFile[] {
  return cloud === 'gcp'
    ? [
        ...emitCloudRunModule(plan),
        ...emitCloudRunJobModule(plan),
        ...emitVertexRagModule(plan),
        ...emitModelArmorModule(plan),
        ...emitAgentRuntimeModule(plan, cloud),
        ...emitAuditModule(plan, cloud),
      ]
    : [
        ...emitServerlessModule(plan),
        ...emitContainerModule(plan),
        ...emitBatchModule(plan),
        ...emitEdgeModule(plan),
        ...emitKnowledgeBaseModule(plan),
        ...emitGatewayModule(plan),
        ...emitAgentRuntimeModule(plan, cloud),
        ...emitCdkModules(plan, cloud),
        ...emitAuditModule(plan, cloud),
      ];
}
