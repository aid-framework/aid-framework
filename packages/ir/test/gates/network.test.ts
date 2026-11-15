import { describe, expect, it } from 'vitest';

import { IR_DIAGNOSTIC_CODES, runGates } from '../../src/index.js';
import {
  buildFixture,
  codesOf,
  first,
  gateFixture,
  mutateIR,
  onlyDiagnosticWith,
} from '../helpers.js';

const NETWORK = 'v37-network.yaml';

function gate(ir: ReturnType<typeof mutateIR>) {
  return runGates(ir).byGate.network;
}

describe('network', () => {
  it('accepts an internal ingress with the networks allowed to reach it', () => {
    expect(gateFixture(NETWORK).byGate.network.diagnostics).toEqual([]);
  });

  it('carries the resolved placement and the allowed networks onto the deployment', () => {
    const deployment = first(buildFixture(NETWORK).ir.deployments);
    expect(deployment.network).toEqual({
      ingress: 'internal',
      allowFrom: ['10.0.0.0/8', '172.16.0.0/12'],
      egress: 'declared-only',
    });
  });

  it('refuses `private-link`, because no module emits a private endpoint', () => {
    const ir = mutateIR(NETWORK);
    first(ir.deployments).network = { ingress: 'private-link' };

    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.networkIngressUnsupported,
    );
    expect(diagnostic.path).toEqual(['deployments', 'prod', 'network', 'ingress']);
    expect(diagnostic.message).toContain('no module emits a private endpoint');
    expect(diagnostic.hint).toContain('ingress: internal');
  });

  it('refuses a public ingress that also names allowed networks', () => {
    // The two lines ask for opposite things, so accepting both would let a reviewer
    // approve a document that contradicts itself.
    const ir = mutateIR(NETWORK);
    first(ir.deployments).network = { ingress: 'public', allowFrom: ['10.0.0.0/8'] };

    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.networkAllowFrom,
    );
    expect(diagnostic.path).toEqual(['deployments', 'prod', 'network', 'allowFrom']);
    expect(diagnostic.message).toContain('`ingress: public`');
    expect(diagnostic.message).toContain('`allowFrom`');
  });

  it('refuses an internal ingress on a target with no private placement', () => {
    const ir = mutateIR(NETWORK);
    const deployment = first(ir.deployments);
    deployment.target = 'serverless';

    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.networkTargetIncapable,
    );
    expect(diagnostic.path).toEqual(['deployments', 'prod', 'network', 'ingress']);
    expect(diagnostic.message).toContain('"serverless"');
    expect(diagnostic.hint).toContain('emits no VPC');
  });

  it('names the edge target as reachable from the internet by definition', () => {
    const ir = mutateIR(NETWORK);
    first(ir.deployments).target = 'edge';

    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.networkTargetIncapable,
    );
    expect(diagnostic.hint).toContain('CloudFront function');
  });

  it('refuses an internal ingress that contradicts a kubernetes Ingress object', () => {
    // The Ingress object *is* the public entry point: the chart cannot emit one and a
    // ClusterIP-only Service at once, so one of the two declarations has to go.
    const ir = mutateIR(NETWORK);
    const deployment = first(ir.deployments);
    deployment.target = 'kubernetes';
    deployment.kubernetes = {
      namespace: 'claims-prod',
      ingress: { host: 'claims.example.com', className: 'nginx' },
    };

    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.networkIngressConflict,
    );
    expect(diagnostic.path).toEqual(['deployments', 'prod', 'kubernetes', 'ingress']);
    expect(diagnostic.message).toContain('claims.example.com');
    expect(diagnostic.hint).toContain('drop the `kubernetes.ingress` block');
  });

  it('refuses an internal ingress with no allowed networks', () => {
    // The emitted security group opens exactly the listed CIDRs, so an empty list is a
    // load balancer nothing can reach.
    const ir = mutateIR(NETWORK);
    first(ir.deployments).network = { ingress: 'internal' };

    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.networkAllowFrom,
    );
    expect(diagnostic.path).toEqual(['deployments', 'prod', 'network', 'allowFrom']);
    expect(diagnostic.message).toContain('none are declared');
    expect(diagnostic.hint).toContain('allowFrom: [10.0.0.0/8]');
  });

  it('refuses a zero-length prefix, which admits everything the list exists to exclude', () => {
    for (const cidr of ['0.0.0.0/0', '::/0', '10.0.0.0/0']) {
      const ir = mutateIR(NETWORK);
      first(ir.deployments).network = { ingress: 'internal', allowFrom: [cidr] };

      const diagnostic = onlyDiagnosticWith(
        gate(ir).diagnostics,
        IR_DIAGNOSTIC_CODES.networkAllowFrom,
      );
      expect(diagnostic.message).toContain(`"${cidr}"`);
      expect(diagnostic.message).toContain('admits every address');
    }
  });

  it('refuses allowed networks on a target that emits no rule to narrow', () => {
    const ir = mutateIR(NETWORK);
    const deployment = first(ir.deployments);
    deployment.target = 'kubernetes';
    deployment.network = { ingress: 'internal', allowFrom: ['10.0.0.0/8'] };

    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.networkAllowFrom,
    );
    expect(diagnostic.message).toContain('emits no load balancer');
    expect(diagnostic.hint).toContain('NetworkPolicy you own');
  });

  it('refuses container deployments that disagree, because they share one load balancer', () => {
    // One environment root emits one `module "container"` over every service, so the
    // modes cannot differ. Reported once, naming both sides.
    const ir = mutateIR(NETWORK);
    ir.deployments = [
      first(ir.deployments),
      { ...first(ir.deployments), id: 'api', network: { ingress: 'public' } },
    ];

    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.networkIngressConflict,
    );
    expect(diagnostic.path).toEqual(['deployments', 'prod', 'network', 'ingress']);
    expect(diagnostic.message).toContain('one load balancer');
    expect(diagnostic.message).toContain('"prod"');
    expect(diagnostic.message).toContain('"api"');
    expect(diagnostic.hint).toContain('ask for internal');
  });

  it('says nothing about a deployment with no network block', () => {
    const ir = mutateIR(NETWORK);
    delete first(ir.deployments).network;

    expect(codesOf(gate(ir).diagnostics)).toEqual([]);
  });
});
