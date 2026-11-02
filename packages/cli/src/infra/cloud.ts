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
 * `edge` is absent from both: Cloud CDN serves static assets and cannot run the app, so
 * there is nothing to map it to. AWS now covers `batch` with a Fargate job queue; GCP's
 * `serverless` and `batch` are absent because they need a module this command does not
 * emit yet -- a functions-framework handler and a Google Cloud Batch job respectively --
 * even though the generators emit the entrypoints. Naming them here lets the command
 * refuse a plan instead of emitting nothing for a target the operator believes is
 * deployed.
 */
export const CLOUD_TARGETS: Readonly<Record<Cloud, readonly string[]>> = {
  aws: ['serverless', 'container', 'batch'],
  gcp: ['container'],
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
