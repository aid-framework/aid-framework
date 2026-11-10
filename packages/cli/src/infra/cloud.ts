/**
 * Which cloud the generated module set targets.
 *
 * A spec may pin it (`deployments[].cloud`), because a profile that promises data
 * residency or an audit sink cannot leave the provider to whoever happens to run
 * `aid infra` -- a region is only meaningful against a named cloud.
 *
 * The `--cloud` flag remains for documents that do not pin one, and `aws` remains the
 * default, so every invocation that worked before the pin existed emits exactly the bytes
 * it emitted before. When a document pins a cloud and the flag disagrees, the pin wins:
 * it is the reviewed, committed artifact, while the flag is a one-off at a terminal. The
 * disagreement is refused rather than resolved silently, because overriding either one
 * would deploy into an environment the caller or the reviewer did not ask for.
 */

export const CLOUDS = ['aws', 'gcp'] as const;

export type Cloud = (typeof CLOUDS)[number];

export const DEFAULT_CLOUD: Cloud = 'aws';

export function isCloud(value: string): value is Cloud {
  return (CLOUDS as readonly string[]).includes(value);
}

/**
 * The cloud a document pins, or `undefined` when it pins none.
 *
 * Deployments may pin different clouds, which the `profile` gate already refuses, so this
 * reads the first pinned deployment and leaves any disagreement to that gate rather than
 * inventing a second, conflicting answer here.
 */
export function pinnedCloud(deployments: readonly { cloud?: string }[]): Cloud | undefined {
  for (const deployment of deployments) {
    if (deployment.cloud !== undefined && isCloud(deployment.cloud)) return deployment.cloud;
  }
  return undefined;
}

/** Either the cloud to target, or the refusal explaining why there is not one. */
export type CloudResolution =
  | { readonly ok: true; readonly cloud: Cloud }
  | { readonly ok: false; readonly message: string; readonly hint: string };

/**
 * Reconcile a pinned cloud with `--cloud`.
 *
 * `flag` is not re-validated here: the `infra` dispatcher refuses an unknown `--cloud`
 * before any command runs, so a value reaching this function is one of {@link CLOUDS}.
 */
export function resolveCloud(pinned: Cloud | undefined, flag: string | undefined): CloudResolution {
  if (pinned === undefined) {
    return { ok: true, cloud: flag !== undefined && isCloud(flag) ? flag : DEFAULT_CLOUD };
  }
  if (flag === undefined || flag === pinned) return { ok: true, cloud: pinned };
  return {
    ok: false,
    message: `The spec pins cloud "${pinned}", but --cloud names "${flag}".`,
    hint: `Drop --cloud to deploy the cloud the spec pins, or change the spec's \`cloud:\` to "${flag}" if the pin is stale.`,
  };
}

/**
 * The deployment targets each cloud has a module for today.
 *
 * `edge` is AWS-only: on GCP, Cloud CDN serves static assets and cannot run the app, so
 * there is nothing to map it to. AWS covers every runnable target. GCP's `serverless`
 * maps to Cloud Run rather than Cloud Functions for a packaging reason -- the gen2
 * Functions API accepts only a source zip in GCS and then builds it, while every service
 * here is deployed from the image the generator already produces, which Cloud Run runs
 * directly. `batch` maps to a Cloud Run job rather than Google Cloud Batch because the
 * `hashicorp/google` provider has no resource for the latter, and a Cloud Run job is the
 * same run-to-completion model on the provider the rest of the GCP tree already uses.
 * Naming a target here lets the command refuse a plan instead of emitting nothing for a
 * target the operator believes is deployed.
 */
export const CLOUD_TARGETS: Readonly<Record<Cloud, readonly string[]>> = {
  aws: ['serverless', 'container', 'batch', 'edge'],
  gcp: ['serverless', 'container', 'batch'],
};

/** The targets in the plan this cloud has no module for, in plan order. */
export function unsupportedTargets(
  plan: { services: readonly { target: string }[] },
  cloud: Cloud,
): string[] {
  const known = CLOUD_TARGETS[cloud];
  return [...new Set(plan.services.map((service) => service.target))].filter(
    (target) => !known.includes(target),
  );
}

/**
 * The cloud each managed knowledge-base engine's resources exist on.
 *
 * An engine is a provider product, not a project preference: a Bedrock knowledge base is
 * an AWS resource and a Vertex RAG corpus is a GCP one, and neither has a counterpart on
 * the other cloud. Without this map a plan declaring a base for the other cloud emits no
 * resource for it and looks successful -- the service would then start and fail on its
 * first retrieval, which is the least debuggable outcome available.
 */
export const KNOWLEDGE_BASE_CLOUDS: Readonly<Record<string, Cloud>> = {
  'aws-bedrock': 'aws',
  'vertex-rag': 'gcp',
};

/** The managed bases in the plan this cloud has no resource for, in plan order. */
export function unsupportedKnowledgeBases(
  plan: { knowledgeBases: readonly { id: string; engine: string }[] },
  cloud: Cloud,
): { id: string; engine: string }[] {
  return plan.knowledgeBases.filter((base) => KNOWLEDGE_BASE_CLOUDS[base.engine] !== cloud);
}

/**
 * The services whose managed agent runtime does not run on this cloud.
 *
 * A platform is a vendor product, like a knowledge-base engine: the AgentCore runtime is
 * an AWS resource and the Agent Platform reasoning engine is a GCP one. The platform's
 * credentials are the deploy's credentials, so naming the other cloud's platform is
 * unreachable rather than slow -- and emitting nothing for the service would look like a
 * successful deploy until its first invocation.
 */
export function unsupportedRuntimes(
  plan: { services: readonly { id: string; runtime?: { platform: string; cloud: string } }[] },
  cloud: Cloud,
): { id: string; platform: string; cloud: string }[] {
  return plan.services
    .filter(
      (service): service is { id: string; runtime: { platform: string; cloud: string } } =>
        service.runtime !== undefined && service.runtime.cloud !== cloud,
    )
    .map((service) => ({
      id: service.id,
      platform: service.runtime.platform,
      cloud: service.runtime.cloud,
    }));
}

/**
 * The gateways in the plan this cloud has no resource for.
 *
 * An AgentCore Gateway is an AWS MCP endpoint, and the runtime that reaches it is the
 * AgentCore one, so there is no GCP counterpart at any layer. Declaring a gateway for a
 * GCP environment would emit no resource and still succeed, leaving the tool federation
 * the spec describes absent from the deployed project.
 */
export function unsupportedGateways(
  plan: { gateways: readonly { id: string }[] },
  cloud: Cloud,
): { id: string }[] {
  if (cloud === 'aws') return [];
  return plan.gateways.map((gateway) => ({ id: gateway.id }));
}
