/**
 * Which cloud the generated module set targets.
 *
 * A cloud is an environment fact, not a spec fact: one project may run in an AWS account
 * and a GCP project at the same time, and the spec has no business knowing which. So it is
 * a CLI choice (`--cloud`) rather than a YAML field, and `aws` is the default so every
 * existing invocation emits exactly the bytes it emitted before this existed.
 */

export const CLOUDS = ['aws', 'gcp'] as const;

export type Cloud = (typeof CLOUDS)[number];

export const DEFAULT_CLOUD: Cloud = 'aws';

export function isCloud(value: string): value is Cloud {
  return (CLOUDS as readonly string[]).includes(value);
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
