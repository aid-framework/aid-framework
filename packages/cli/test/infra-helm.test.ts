/**
 * `aid infra gen --iac helm`: the chart a Kubernetes target derives.
 *
 * The chart cannot be rendered here -- that needs a cluster's worth of Helm -- so the tests
 * assert the properties that a bad template actually breaks:
 *
 * 1. Only `target: kubernetes` deployments become workloads, and every object name is
 *    DNS-1123, because a spec id is snake_case and a Kubernetes name may not be.
 * 2. A Service selects pods, which means every label in its selector appears on the
 *    Deployment's pod template. Adding one to the selector alone is a Service that
 *    matches nothing and a release that looks installed.
 * 3. Two runs, same bytes -- the same promise `infra.test.ts` makes of the plan.
 * 4. Nothing that would put a secret value in git: a `secret: true` variable is a
 *    `secretKeyRef`, never a literal.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { CLI_DIAGNOSTIC_CODES } from '../src/diagnostics.js';

import { aid, project } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch(spec: string) {
  const made = project(spec);
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

const CHART = 'infra/generated/helm/aid-app';

/** Two Kubernetes deployments, one with an ingress, on a cloud that only serves Kubernetes. */
const KUBERNETES_SPEC = `specVersion: "0.36"

project:
  name: claims-desk
  targets:
    - py-fastapi

models:
  fast:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [tools]
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 256

prompts:
  answer:
    version: 1
    model: fast
    template: |
      You answer one question about a claim.
    output:
      kind: text

deployments:
  claims_prod:
    target: kubernetes
    cloud: azure
    region: uksouth
    secrets: [OPENAI_API_KEY]
    kubernetes:
      namespace: claims-prod
      ingress:
        host: claims.example.com
        className: nginx
        tlsSecret: claims-tls

  claims_staging:
    target: kubernetes
    cloud: azure
    region: uksouth
    secrets: [OPENAI_API_KEY]
`;

/** A deployment the chart does not describe, so `--iac helm` has nothing to render. */
const CONTAINER_SPEC = `specVersion: "0.36"

project:
  name: boxed
  targets:
    - py-fastapi

deployments:
  api:
    target: container
    cloud: aws
    region: us-east-1
    secrets: [OPENAI_API_KEY]
`;

/** The same, with no cloud pinned, so `--cloud` is what decides the backend pairing. */
const UNPINNED_SPEC = `specVersion: "0.36"

project:
  name: boxed
  targets:
    - py-fastapi

deployments:
  api:
    target: container
    region: us-east-1
    secrets: [OPENAI_API_KEY]
`;

describe('keeping only the workloads Kubernetes can run', () => {
  it('emits a chart for the kubernetes deployments and nothing for the others', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);

    const files = made.walk().filter((path) => path.startsWith(CHART));
    expect(files).toEqual([
      `${CHART}/Chart.yaml`,
      `${CHART}/README.md`,
      `${CHART}/templates/NOTES.txt`,
      `${CHART}/templates/_helpers.tpl`,
      `${CHART}/templates/claims-prod-deployment.yaml`,
      `${CHART}/templates/claims-prod-ingress.yaml`,
      `${CHART}/templates/claims-prod-service.yaml`,
      `${CHART}/templates/claims-staging-deployment.yaml`,
      `${CHART}/templates/claims-staging-service.yaml`,
      `${CHART}/values.yaml`,
    ]);
  });

  it('always emits the plan beside the chart, because it is the reviewable half', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);
    expect(made.exists('infra/generated/deploy.plan.json')).toBe(true);
  });

  it('names every object DNS-1123, from a spec id that is not', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);

    const deployment = made.read(`${CHART}/templates/claims-prod-deployment.yaml`);
    expect(deployment).toContain('name: {{ .Release.Name }}-claims-prod');
    // The raw id survives as a label value, which is where it is still useful.
    expect(deployment).toContain('aid-framework/deployment: "claims_prod"');
  });

  it('renders an ingress only for the deployment that declared a host', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);

    expect(made.walk()).toContain(`${CHART}/templates/claims-prod-ingress.yaml`);
    expect(made.walk()).not.toContain(`${CHART}/templates/claims-staging-ingress.yaml`);
  });

  it('derives the same bytes twice', () => {
    const first = scratch(KUBERNETES_SPEC);
    const second = scratch(KUBERNETES_SPEC);
    expect(aid(first, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);
    expect(aid(second, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);
    expect(first.snapshot()).toEqual(second.snapshot());
  });
});

describe('the labels a Service selects on', () => {
  /** The `key: value` pairs under a `selector:` or `labels:` block, by line. */
  function pairsIn(text: string, after: string): string[] {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.trim() === `${after}:`);
    if (start === -1) throw new Error(`no ${after}: block`);
    const found: string[] = [];
    const header = lines[start] ?? '';
    const blockIndent = header.length - header.trimStart().length;
    for (const line of lines.slice(start + 1)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      // A pair at the block's own indentation ends the block.
      if (line.length - line.trimStart().length <= blockIndent) {
        break;
      }
      if (trimmed.includes('{{')) continue;
      if (!trimmed.includes(':')) break;
      found.push(trimmed);
    }
    return found;
  }

  it('puts every selector label on the pod template too', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);

    const service = made.read(`${CHART}/templates/claims-prod-service.yaml`);
    const deployment = made.read(`${CHART}/templates/claims-prod-deployment.yaml`);
    const selector = pairsIn(service, 'selector');
    const podLabels = deployment
      .slice(deployment.indexOf('      labels:'))
      .split('\n')
      .map((line) => line.trim());

    expect(selector).not.toHaveLength(0);
    for (const pair of selector) expect(podLabels).toContain(pair);
  });

  it('keeps the two deployments apart, so one Service cannot select the other', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);

    for (const [id, file] of [
      ['claims_prod', 'claims-prod'],
      ['claims_staging', 'claims-staging'],
    ] as const) {
      expect(made.read(`${CHART}/templates/${file}-service.yaml`)).toContain(
        `aid-framework/deployment: "${id}"`,
      );
      expect(made.read(`${CHART}/templates/${file}-deployment.yaml`)).toContain(
        `aid-framework/deployment: "${id}"`,
      );
    }
  });
});

describe('what the chart refuses to hold', () => {
  it('references a secret instead of templating one', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);

    const deployment = made.read(`${CHART}/templates/claims-prod-deployment.yaml`);
    expect(deployment).toContain('secretKeyRef:');
    expect(deployment).toContain('key: OPENAI_API_KEY');
    expect(deployment).not.toContain('kind: Secret');
  });

  it('creates no namespace, so the platform keeps owning it', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);
    for (const path of made.walk().filter((file) => file.startsWith(CHART))) {
      expect(made.read(path)).not.toContain('kind: Namespace');
    }
  });

  it('turns the read-only root filesystem off by default, rather than assuming it', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);
    expect(made.read(`${CHART}/values.yaml`)).toContain('readOnlyRootFilesystem: false');
  });

  it('renders no probe, because the generated app serves no health route', () => {
    const made = scratch(KUBERNETES_SPEC);
    expect(aid(made, ['infra', 'gen', '--iac', 'helm']).code).toBe(0);
    // The template holds the block, guarded; the default values file leaves it empty.
    expect(made.read(`${CHART}/values.yaml`)).toContain('path: ""');
  });
});

describe('refusing the pairs the chart cannot serve', () => {
  it('refuses helm when nothing targets kubernetes', () => {
    const made = scratch(CONTAINER_SPEC);
    const run = aid(made, ['infra', 'gen', '--iac', 'helm']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(CLI_DIAGNOSTIC_CODES.infraHelmTargetRequired);
    expect(made.exists('infra/generated')).toBe(false);
  });

  it('refuses OpenTofu for a kubernetes target, rather than emitting a stub', () => {
    const made = scratch(KUBERNETES_SPEC);
    const run = aid(made, ['infra', 'gen']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(CLI_DIAGNOSTIC_CODES.infraKubernetesBackendRequired);
  });

  it('refuses azure on OpenTofu, which has no Azure module set', () => {
    const made = scratch(UNPINNED_SPEC);
    const run = aid(made, ['infra', 'gen', '--cloud', 'azure']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(CLI_DIAGNOSTIC_CODES.infraCloudBackendUnsupported);
  });

  it('refuses to drive helm, which no binary on this machine can apply', () => {
    const made = scratch(KUBERNETES_SPEC);
    const run = aid(made, ['infra', 'plan', '--iac', 'helm']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(CLI_DIAGNOSTIC_CODES.infraHelmNotDriven);
  });

  it('refuses an unknown backend by name', () => {
    const made = scratch(KUBERNETES_SPEC);
    const run = aid(made, ['infra', 'gen', '--iac', 'pulumi']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(CLI_DIAGNOSTIC_CODES.infraUnknownIac);
  });
});
