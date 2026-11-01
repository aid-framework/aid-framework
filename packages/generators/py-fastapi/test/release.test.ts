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

  it('orders entries by repository name, so declaration order does not change the matrix', () => {
    const content = releaseFor(specWithWorker('ghcr.io', 'acme/aaa-worker'));

    const first = content.indexOf('            image: acme/aaa-worker');
    const second = content.indexOf('            image: acme/support-copilot');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
  });
});
