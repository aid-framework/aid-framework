/**
 * The container registries a deployment image may name, and how a generated release
 * workflow authenticates to each one.
 *
 * One table, not a constant per consumer: the schema enum, the credential check in
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
 */
export type RegistryAuthKind = 'github-token' | 'secret-pair';

/** The `image` fields that name a repository secret, rather than carry a value. */
export const IMAGE_CREDENTIAL_FIELDS = ['usernameSecret', 'tokenSecret'] as const;

export type ImageCredentialField = (typeof IMAGE_CREDENTIAL_FIELDS)[number];

/** One registry the release workflow can push to. */
export interface RegistryDescriptor {
  /** The registry host, exactly as it appears in `deployments[].image.registry`. */
  readonly host: string;
  readonly authKind: RegistryAuthKind;
  /** The `image` fields a document must declare for this credential path, and only those. */
  readonly declares: readonly ImageCredentialField[];
  /** The spec version that first admitted this registry. */
  readonly minVersion: `0.${number}`;
  /** One clause for a diagnostic, completing "declare ...". */
  readonly credentialHint: string;
}

/**
 * `github-token` stays first: the builder's diagnostic has always pointed at `ghcr.io` as
 * the registry to declare when none was given, and a document that declares no credential
 * keeps emitting the same workflow bytes.
 */
export const IMAGE_REGISTRY_DESCRIPTORS = [
  {
    host: 'ghcr.io',
    authKind: 'github-token',
    declares: [],
    minVersion: '0.4',
    credentialHint: 'nothing: the release workflow logs in with the GITHUB_TOKEN it already holds',
  },
  {
    host: 'docker.io',
    authKind: 'secret-pair',
    declares: ['usernameSecret', 'tokenSecret'],
    minVersion: '0.16',
    credentialHint:
      '`usernameSecret` and `tokenSecret`, naming the repository secrets that hold the account and its access token',
  },
] as const satisfies readonly RegistryDescriptor[];

/** A registry host from the table. */
export type ImageRegistry = (typeof IMAGE_REGISTRY_DESCRIPTORS)[number]['host'];

/** The registry hosts, derived from the table so the two cannot disagree. */
export const IMAGE_REGISTRIES: readonly ImageRegistry[] = IMAGE_REGISTRY_DESCRIPTORS.map(
  (descriptor) => descriptor.host,
);

/** The descriptor for a host, or `undefined` when the host is not in the table. */
export function imageRegistry(host: string): RegistryDescriptor | undefined {
  return IMAGE_REGISTRY_DESCRIPTORS.find((descriptor) => descriptor.host === host);
}
