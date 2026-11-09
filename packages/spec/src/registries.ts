/**
 * The container registries a deployment image may name, and how a generated release
 * workflow authenticates to each one.
 *
 * One table, not a constant per consumer: the schema enum, the field check in
 * `validate.ts`, the serialized IR and the emitted login step all read from here, so they
 * cannot disagree. A registry is admitted only with a credential path that stores nothing
 * long-lived in the repository.
 *
 * It lives in the spec package rather than the IR because the enum is part of the DSL a
 * document is validated against; the IR re-exports it for its own public surface.
 */

/**
 * How a generated release workflow authenticates to a registry.
 *
 * `github-token` is the `GITHUB_TOKEN` the run already holds and needs nothing in the
 * spec. `secret-pair` is two GitHub repository secrets whose *names* the spec declares,
 * so the workflow references them and their values never enter the repository.
 * `aws-oidc` and `gcp-wif` exchange the run's OIDC identity for a short-lived cloud
 * credential, so no key is stored anywhere; the spec declares the role or provider to
 * federate with, which is an identifier rather than a secret.
 */
export type RegistryAuthKind = 'github-token' | 'secret-pair' | 'aws-oidc' | 'gcp-wif';

/** The `image` fields that name a repository secret, rather than carry a value. */
export const IMAGE_CREDENTIAL_FIELDS = ['usernameSecret', 'tokenSecret'] as const;

export type ImageCredentialField = (typeof IMAGE_CREDENTIAL_FIELDS)[number];

/**
 * Every `image` field a registry may own. A field a registry does not declare is refused,
 * so a `ghcr.io` image carrying a Docker Hub token, or an ECR image carrying a project,
 * names something the emitted workflow would never read.
 */
export const IMAGE_REGISTRY_FIELDS = [
  ...IMAGE_CREDENTIAL_FIELDS,
  'accountId',
  'region',
  'roleArn',
  'project',
  'workloadIdentityProvider',
  'serviceAccount',
] as const;

export type ImageRegistryField = (typeof IMAGE_REGISTRY_FIELDS)[number];

/** The `image` fields as values, for the derivations below. */
export interface RegistryImageFields {
  usernameSecret?: string;
  tokenSecret?: string;
  accountId?: string;
  region?: string;
  roleArn?: string;
  project?: string;
  workloadIdentityProvider?: string;
  serviceAccount?: string;
}

/** One registry the release workflow can push to. */
export interface RegistryDescriptor {
  /**
   * The value of `deployments[].image.registry`. It is the registry's identity in the
   * DSL, which for a cloud registry is not its host: an ECR host carries the account and
   * the region, and both are separate fields so the spec can validate them.
   */
  readonly id: string;
  readonly authKind: RegistryAuthKind;
  /** The `image` fields a document must declare for this credential path, and only those. */
  readonly declares: readonly ImageRegistryField[];
  /** The spec version that first admitted this registry. */
  readonly minVersion: `0.${number}`;
  /** The fields to declare, as a sentence, for a diagnostic. */
  readonly credentialHint: string;
  /** The host `docker login` and `docker push` address, derived from the declared fields. */
  readonly loginServer: (fields: RegistryImageFields) => string;
  /**
   * The repository path inside the registry, when the spec's `name` is not the whole of
   * it. Absent means `name` is used as written.
   */
  readonly repository?: (fields: RegistryImageFields, name: string) => string;
  /**
   * The fields the login step reads from the matrix. A cloud login is per-account, not
   * per-workflow, so its identity travels with the matrix entry rather than with the job.
   */
  readonly loginFields?: readonly ImageRegistryField[];
}

/**
 * `github-token` stays first: the builder's diagnostic has always pointed at `ghcr.io` as
 * the registry to declare when none was given, and a document that declares no credential
 * keeps emitting the same workflow bytes.
 */
export const IMAGE_REGISTRY_DESCRIPTORS = [
  {
    id: 'ghcr.io',
    authKind: 'github-token',
    declares: [],
    minVersion: '0.4',
    credentialHint: 'nothing: the release workflow logs in with the GITHUB_TOKEN it already holds',
    loginServer: () => 'ghcr.io',
  },
  {
    id: 'docker.io',
    authKind: 'secret-pair',
    declares: ['usernameSecret', 'tokenSecret'],
    minVersion: '0.16',
    credentialHint:
      '`usernameSecret` and `tokenSecret`, naming the repository secrets that hold the account and its access token',
    loginServer: () => 'docker.io',
  },
  {
    id: 'aws.ecr',
    authKind: 'aws-oidc',
    declares: ['accountId', 'region', 'roleArn'],
    minVersion: '0.17',
    credentialHint:
      '`accountId`, `region` and `roleArn`: the workflow derives the registry host from the first two and assumes the role with OIDC, so no access key is stored',
    loginServer: (fields) => `${fields.accountId}.dkr.ecr.${fields.region}.amazonaws.com`,
    loginFields: ['region', 'roleArn'],
  },
  {
    id: 'gcp.artifact-registry',
    authKind: 'gcp-wif',
    declares: ['project', 'region', 'workloadIdentityProvider', 'serviceAccount'],
    minVersion: '0.18',
    credentialHint:
      '`project`, `region`, `workloadIdentityProvider` and `serviceAccount`: the workflow federates through Workload Identity with OIDC, and the repository path is prefixed with the project',
    loginServer: (fields) => `${fields.region}-docker.pkg.dev`,
    repository: (fields, name) => `${fields.project}/${name}`,
    loginFields: ['region', 'workloadIdentityProvider', 'serviceAccount'],
  },
] as const satisfies readonly RegistryDescriptor[];

/** A registry id from the table. */
export type ImageRegistry = (typeof IMAGE_REGISTRY_DESCRIPTORS)[number]['id'];

/** The registry ids, derived from the table so the two cannot disagree. */
export const IMAGE_REGISTRIES: readonly ImageRegistry[] = IMAGE_REGISTRY_DESCRIPTORS.map(
  (descriptor) => descriptor.id,
);

/** The descriptor for a registry id, or `undefined` when the id is not in the table. */
export function imageRegistry(id: string): RegistryDescriptor | undefined {
  return IMAGE_REGISTRY_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}
