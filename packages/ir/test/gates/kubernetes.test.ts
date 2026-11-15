import { describe, expect, it } from 'vitest';

import { IR_DIAGNOSTIC_CODES, runGates } from '../../src/index.js';
import { buildFixture, first, gateFixture, mutateIR, onlyDiagnosticWith } from '../helpers.js';

const CLUSTER = 'v36-kubernetes.yaml';

function gate(ir: ReturnType<typeof mutateIR>) {
  return runGates(ir).byGate.kubernetes;
}

describe('kubernetes', () => {
  it('accepts a cluster placement that names its namespace, class and certificate', () => {
    expect(gateFixture(CLUSTER).byGate.kubernetes.diagnostics).toEqual([]);
  });

  it('carries the placement onto the deployment', () => {
    const deployment = first(buildFixture(CLUSTER).ir.deployments);
    expect(deployment.target).toBe('kubernetes');
    expect(deployment.kubernetes).toEqual({
      namespace: 'claims-prod',
      ingress: { host: 'claims.example.com', className: 'nginx', tlsSecret: 'claims-tls' },
    });
  });

  it('accepts a placement with no ingress, which is the private-by-default shape', () => {
    const ir = mutateIR(CLUSTER);
    delete first(ir.deployments).kubernetes?.ingress;
    expect(gate(ir).diagnostics).toEqual([]);
  });

  it('refuses a kubernetes block on a deployment that emits no chart', () => {
    const ir = mutateIR(CLUSTER);
    first(ir.deployments).target = 'container';
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.kubernetesBlockMisplaced,
    );

    expect(diagnostic.path).toEqual(['deployments', 'prod', 'kubernetes']);
    expect(diagnostic.message).toContain('emits no chart to place');
    expect(diagnostic.hint).toContain('set target: kubernetes to run this deployment on a cluster');
    expect(diagnostic.hint).toContain('a container deployment is placed by its own module');
  });

  it('refuses an ingress class that is not a DNS label', () => {
    const ir = mutateIR(CLUSTER);
    const ingress = first(ir.deployments).kubernetes?.ingress;
    if (ingress === undefined) throw new Error('fixture has no ingress');
    ingress.className = 'NGINX_Ingress';
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.kubernetesIngressClass,
    );

    expect(diagnostic.path).toEqual(['deployments', 'prod', 'kubernetes', 'ingress', 'className']);
    expect(diagnostic.message).toContain('"NGINX_Ingress" is not a DNS label');
    expect(diagnostic.hint).toContain('such as nginx or traefik');
  });

  it('refuses an enterprise ingress with no certificate name', () => {
    const ir = mutateIR(CLUSTER);
    const ingress = first(ir.deployments).kubernetes?.ingress;
    if (ingress === undefined) throw new Error('fixture has no ingress');
    delete ingress.tlsSecret;
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.kubernetesIngressTls,
    );

    expect(diagnostic.path).toEqual(['deployments', 'prod', 'kubernetes', 'ingress', 'tlsSecret']);
    expect(diagnostic.message).toContain('`profile: enterprise` exposes an ingress');
    expect(diagnostic.message).toContain('claims.example.com');
    expect(diagnostic.hint).toContain('kubernetes.io/tls');
  });

  it('permits a plaintext ingress on the standard profile', () => {
    // The control is the enterprise bundle's, not the framework's: a standard-profile
    // customer without cert-manager should not have to name a Secret they do not have.
    const ir = mutateIR(CLUSTER);
    ir.profile = 'standard';
    const ingress = first(ir.deployments).kubernetes?.ingress;
    if (ingress === undefined) throw new Error('fixture has no ingress');
    delete ingress.tlsSecret;
    expect(gate(ir).diagnostics).toEqual([]);
  });

  it('reports the class and the certificate separately, so each fix names one key', () => {
    const ir = mutateIR(CLUSTER);
    const ingress = first(ir.deployments).kubernetes?.ingress;
    if (ingress === undefined) throw new Error('fixture has no ingress');
    ingress.className = 'Not Valid';
    delete ingress.tlsSecret;

    expect(
      gate(ir)
        .diagnostics.map((diagnostic) => diagnostic.code)
        .sort(),
    ).toEqual([
      IR_DIAGNOSTIC_CODES.kubernetesIngressClass,
      IR_DIAGNOSTIC_CODES.kubernetesIngressTls,
    ]);
  });
});
