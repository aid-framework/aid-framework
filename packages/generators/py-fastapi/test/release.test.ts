// biome-ignore-all lint/suspicious/noTemplateCurlyInString: assertions read the emitted GitHub Actions expressions literally.
/**
 * The image release: `.github/workflows/release.yml`.
 *
 * Presence is decided by the spec, not by the target: a project that never named a
 * registry repository has nothing to publish, and a workflow that pushed to a repository
 * the spec does not name would be an invented artifact. So the tests here are about the
 * two things a reader cannot see by eye:
 *
 *   1. The workflow appears only when a deployment declares `image`, and it names the
 *      image and the tag-triggered build the Dockerfile already documents.
 *   2. Deployments that name the same repository are one matrix entry, because two
 *      entries pushing the same tags in one run would race with each other, and entries
 *      are ordered by repository name so the matrix does not depend on declaration order.
 */

import { RELEASE_WORKFLOW_PATH } from '@aid-framework/generator-sdk';
import { describe, expect, it } from 'vitest';

import { buildForSpecText, examplePlan, exampleSpecText } from './helpers.js';

function plannedScaffoldPaths(specText: string): string[] {
  return buildForSpecText(specText, 'app.spec.yaml')
    .plan.files.filter((file) => file.owner === 'scaffold')
    .map((file) => file.path);
}

function releaseFor(specText: string): string {
  const file = buildForSpecText(specText, 'app.spec.yaml').plan.files.find(
    (candidate) => candidate.path === RELEASE_WORKFLOW_PATH,
  );
  if (file === undefined) throw new Error('the plan has no release workflow');
  return file.content;
}

/** The example, with its one deployment declaring the image it publishes. */
function specWithImage(registry = 'ghcr.io', name = 'acme/support-copilot'): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.4"')
    .replace(
      '    secrets: [OPENAI_API_KEY]',
      `    secrets: [OPENAI_API_KEY]\n    image:\n      registry: ${registry}\n      name: ${name}`,
    );
}

/** The example plus a second container deployment. */
function specWithWorker(registry: string, name: string): string {
  return `${specWithImage()}\n  worker:\n    target: container\n    secrets: [OPENAI_API_KEY]\n    image:\n      registry: ${registry}\n      name: ${name}\n`;
}

/** The example, publishing to Docker Hub with the two repository secrets its login reads. */
function specWithDockerHub(
  usernameSecret = 'DOCKERHUB_USERNAME',
  tokenSecret = 'DOCKERHUB_TOKEN',
): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.16"')
    .replace(
      '    secrets: [OPENAI_API_KEY]',
      `    secrets: [OPENAI_API_KEY]\n    image:\n      registry: docker.io\n      name: acme/support-copilot\n      usernameSecret: ${usernameSecret}\n      tokenSecret: ${tokenSecret}`,
    );
}

/** One image per credential path: a GITHUB_TOKEN login and a declared secret pair. */
function specWithBothRegistries(): string {
  return `${specWithImage().replace('specVersion: "0.4"', 'specVersion: "0.16"')}\n  worker:\n    target: container\n    secrets: [OPENAI_API_KEY]\n    image:\n      registry: docker.io\n      name: acme/worker\n      usernameSecret: DOCKERHUB_USERNAME\n      tokenSecret: DOCKERHUB_TOKEN\n`;
}

/** The example, publishing to ECR with the identity fields its OIDC login needs. */
function specWithEcr(
  accountId = '123456789012',
  region = 'eu-west-1',
  roleArn = 'arn:aws:iam::123456789012:role/publisher',
): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.17"')
    .replace(
      '    secrets: [OPENAI_API_KEY]',
      `    secrets: [OPENAI_API_KEY]\n    image:\n      registry: aws.ecr\n      name: acme/support-copilot\n      accountId: "${accountId}"\n      region: ${region}\n      roleArn: ${roleArn}`,
    );
}

/** The example, publishing to Artifact Registry through Workload Identity. */
function specWithArtifactRegistry(): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.18"')
    .replace(
      '    secrets: [OPENAI_API_KEY]',
      '    secrets: [OPENAI_API_KEY]\n    image:\n      registry: gcp.artifact-registry\n      name: acme/support-copilot\n      project: acme-prod\n      region: europe-west1\n      workloadIdentityProvider: projects/123456789/locations/global/workloadIdentityPools/gh/providers/main\n      serviceAccount: publisher@acme-prod.iam.gserviceaccount.com',
    );
}

function matrixRegistries(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => line.startsWith('          - registry: '))
    .map((line) => line.slice('          - registry: '.length));
}

function matrixImages(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => line.startsWith('            image: '))
    .map((line) => line.slice('            image: '.length));
}

describe('a spec that declares no image', () => {
  it('plans no release workflow, because there is nothing to publish', () => {
    expect(examplePlan().files.map((file) => file.path)).not.toContain(RELEASE_WORKFLOW_PATH);
    // The three workflows that do not depend on the spec's registry stay planned.
    expect(plannedScaffoldPaths(exampleSpecText())).toHaveLength(3);
  });
});

describe('a spec that declares an image', () => {
  it('plans the release workflow as a scaffold file', () => {
    const paths = plannedScaffoldPaths(specWithImage());
    expect(paths).toContain(RELEASE_WORKFLOW_PATH);
    expect(paths).toHaveLength(4);

    const release = buildForSpecText(specWithImage(), 'app.spec.yaml').plan.files.find(
      (file) => file.path === RELEASE_WORKFLOW_PATH,
    );
    expect(release?.owner).toBe('scaffold');
  });

  it('publishes the registry repository the deployment declared, and the spec it came from', () => {
    const content = releaseFor(specWithImage());

    expect(matrixRegistries(content)).toEqual(['ghcr.io']);
    expect(matrixImages(content)).toEqual(['acme/support-copilot']);
    expect(content).toContain('          # deployments.api');
    expect(content).toContain('-f app/generated/Dockerfile');
    expect(content).toContain('aid gen app/app.spec.yaml --check');
    expect(content).toMatch(/@aid-framework\/cli@0\.1/);
  });

  it('is byte-identical on a second plan', () => {
    expect(releaseFor(specWithImage())).toBe(releaseFor(specWithImage()));
  });

  it('collapses two deployments that name one repository into a single matrix entry', () => {
    const content = releaseFor(specWithWorker('ghcr.io', 'acme/support-copilot'));

    // Two entries pushing the same tags in one run would race with each other.
    expect(matrixImages(content)).toHaveLength(1);
    expect(content).toContain('          # deployments.api, deployments.worker');
  });

  it('logs in with the workflow token and asks only for packages: write', () => {
    const content = releaseFor(specWithImage());

    expect(content).toContain('permissions:\n  contents: read\n  packages: write\n');
    expect(content).toContain('          REGISTRY_TOKEN: ${{ github.token }}');
    expect(content).toContain('--username "$GITHUB_ACTOR"');
    // No secret is read, so none has to exist.
    expect(content).not.toContain('secrets.');
  });

  it('orders entries by repository name, so declaration order does not change the matrix', () => {
    const content = releaseFor(specWithWorker('ghcr.io', 'acme/aaa-worker'));

    const first = content.indexOf('            image: acme/aaa-worker');
    const second = content.indexOf('            image: acme/support-copilot');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
  });
});

describe('a Docker Hub image', () => {
  it('logs in with the repository secrets the image names', () => {
    const content = releaseFor(specWithDockerHub());

    expect(matrixRegistries(content)).toEqual(['docker.io']);
    expect(content).toContain('      - name: Log in to docker.io');
    expect(content).toContain('          REGISTRY_USERNAME: ${{ secrets.DOCKERHUB_USERNAME }}');
    expect(content).toContain('          REGISTRY_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}');
    expect(content).toContain('--username "$REGISTRY_USERNAME"');
  });

  it('asks for no packages scope and reads no workflow token', () => {
    const content = releaseFor(specWithDockerHub());

    expect(content).toContain('permissions:\n  contents: read\n');
    expect(content).not.toContain('packages: write');
    expect(content).not.toContain('github.token');
  });

  it('is byte-identical on a second plan', () => {
    expect(releaseFor(specWithDockerHub())).toBe(releaseFor(specWithDockerHub()));
  });

  it('carries the declared secret names through, not a conventional default', () => {
    const content = releaseFor(specWithDockerHub('HUB_ACCOUNT', 'HUB_PAT'));

    expect(content).toContain('          REGISTRY_USERNAME: ${{ secrets.HUB_ACCOUNT }}');
    expect(content).toContain('          REGISTRY_TOKEN: ${{ secrets.HUB_PAT }}');
    expect(content).not.toContain('DOCKERHUB_TOKEN');
  });
});

describe('two credential paths in one project', () => {
  it('guards each login with the matrix entry it serves', () => {
    const content = releaseFor(specWithBothRegistries());

    expect(content.match(/ {6}- name: Log in to /g)).toHaveLength(2);
    expect(content).toContain(
      "        if: matrix.registry == 'ghcr.io' && matrix.image == 'acme/support-copilot'",
    );
    expect(content).toContain(
      "        if: matrix.registry == 'docker.io' && matrix.image == 'acme/worker'",
    );
    // The GITHUB_TOKEN login still needs the scope, even though the other does not.
    expect(content).toContain('packages: write');
  });

  it('emits one login per account when two images share a registry', () => {
    const content = releaseFor(
      `${specWithDockerHub('HUB_A_USER', 'HUB_A_TOKEN')}\n  worker:\n    target: container\n    secrets: [OPENAI_API_KEY]\n    image:\n      registry: docker.io\n      name: acme/worker\n      usernameSecret: HUB_B_USER\n      tokenSecret: HUB_B_TOKEN\n`,
    );

    // A registry-only guard would run both logins for both images, so each names its own.
    expect(content.match(/ {6}- name: Log in to docker\.io/g)).toHaveLength(2);
    expect(content).toContain('          REGISTRY_TOKEN: ${{ secrets.HUB_A_TOKEN }}');
    expect(content).toContain('          REGISTRY_TOKEN: ${{ secrets.HUB_B_TOKEN }}');
    expect(content).toContain(
      "        if: matrix.registry == 'docker.io' && matrix.image == 'acme/support-copilot'",
    );
    expect(content).toContain(
      "        if: matrix.registry == 'docker.io' && matrix.image == 'acme/worker'",
    );
  });
});

describe('an ECR image', () => {
  it('derives the host and role from the spec and carries them in the matrix', () => {
    const content = releaseFor(specWithEcr());

    expect(matrixRegistries(content)).toEqual(['aws.ecr']);
    // The account is part of the host, so the spec does not restate it.
    expect(content).toContain('            login: 123456789012.dkr.ecr.eu-west-1.amazonaws.com');
    expect(content).toContain('            region: eu-west-1');
    expect(content).toContain('            roleArn: arn:aws:iam::123456789012:role/publisher');
    expect(content).toContain('      REGISTRY: ${{ matrix.login }}');
    expect(content).toContain('${REGISTRY}/${IMAGE}:${tag}');
  });

  it('assumes the role with OIDC instead of reading an access key', () => {
    const content = releaseFor(specWithEcr());

    expect(content).toContain('      - name: Assume the publish role');
    expect(content).toContain('          role-to-assume: ${{ matrix.roleArn }}');
    expect(content).toContain('          aws-region: ${{ matrix.region }}');
    expect(content).toContain('aws ecr get-login-password');
    expect(content).toContain('--username AWS');
    // No long-lived credential is invented, and the workflow token pushes nothing.
    expect(content).not.toContain('secrets.');
    expect(content).not.toContain('github.token');
    expect(content).not.toContain('packages: write');
  });

  it('asks for the OIDC scope and nothing else', () => {
    const content = releaseFor(specWithEcr());
    expect(content).toContain('permissions:\n  contents: read\n  id-token: write\n');
  });

  it('is byte-identical on a second plan', () => {
    expect(releaseFor(specWithEcr())).toBe(releaseFor(specWithEcr()));
  });

  it('emits one guarded login per account when two images share a registry', () => {
    const content = releaseFor(
      `${specWithEcr()}\n  worker:\n    target: container\n    secrets: [OPENAI_API_KEY]\n    image:\n      registry: aws.ecr\n      name: acme/worker\n      accountId: "210987654321"\n      region: us-east-1\n      roleArn: arn:aws:iam::210987654321:role/publisher\n`,
    );

    expect(content.match(/ {6}- name: Assume the publish role/g)).toHaveLength(2);
    expect(content).toContain(
      "        if: matrix.registry == 'aws.ecr' && matrix.image == 'acme/support-copilot' && matrix.login == '123456789012.dkr.ecr.eu-west-1.amazonaws.com'",
    );
    expect(content).toContain(
      "        if: matrix.registry == 'aws.ecr' && matrix.image == 'acme/worker' && matrix.login == '210987654321.dkr.ecr.us-east-1.amazonaws.com'",
    );
  });
});

describe('an Artifact Registry image', () => {
  it('prefixes the repository with the project the host names', () => {
    const content = releaseFor(specWithArtifactRegistry());

    expect(matrixRegistries(content)).toEqual(['gcp.artifact-registry']);
    // Artifact Registry paths start with the project, so the spec's `name` is a suffix.
    expect(matrixImages(content)).toEqual(['acme-prod/acme/support-copilot']);
    expect(content).toContain('            login: europe-west1-docker.pkg.dev');
    expect(content).toContain('      REGISTRY: ${{ matrix.login }}');
  });

  it('federates through Workload Identity instead of a service-account key', () => {
    const content = releaseFor(specWithArtifactRegistry());

    expect(content).toContain(
      '          workload_identity_provider: ${{ matrix.workloadIdentityProvider }}',
    );
    expect(content).toContain('          service_account: ${{ matrix.serviceAccount }}');
    expect(content).toContain('gcloud auth print-access-token');
    expect(content).toContain('--username oauth2accesstoken');
    expect(content).not.toContain('secrets.');
    expect(content).not.toContain('packages: write');
    expect(content).toContain('  id-token: write');
  });

  it('is byte-identical on a second plan', () => {
    expect(releaseFor(specWithArtifactRegistry())).toBe(releaseFor(specWithArtifactRegistry()));
  });
});

describe('a workflow that publishes to two credential paths', () => {
  it('asks for both scopes and guards each login', () => {
    const content = releaseFor(
      `${specWithEcr()}\n  worker:\n    target: container\n    secrets: [OPENAI_API_KEY]\n    image:\n      registry: ghcr.io\n      name: acme/worker\n`,
    );

    expect(content).toContain('  packages: write');
    expect(content).toContain('  id-token: write');
    // A ghcr entry takes part in the derived-host matrix, so it names its own host.
    expect(content).toContain('            login: ghcr.io');
    expect(content).toContain(
      "        if: matrix.registry == 'ghcr.io' && matrix.image == 'acme/worker'",
    );
    expect(content).toContain(
      "        if: matrix.registry == 'aws.ecr' && matrix.image == 'acme/support-copilot' && matrix.login == '123456789012.dkr.ecr.eu-west-1.amazonaws.com'",
    );
  });
});
