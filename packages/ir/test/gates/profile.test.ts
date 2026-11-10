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

const ENTERPRISE = 'profile-enterprise.yaml';

function gate(ir: ReturnType<typeof mutateIR>) {
  return runGates(ir).byGate.profile;
}

describe('profile', () => {
  it('accepts an enterprise document that pins a region, an audit sink and an output guardrail', () => {
    expect(gateFixture(ENTERPRISE).byGate.profile.diagnostics).toEqual([]);
  });

  it('reads the declared profile into the IR', () => {
    expect(buildFixture(ENTERPRISE).ir.profile).toBe('enterprise');
  });

  it('carries the placement onto the deployment', () => {
    const deployment = first(buildFixture(ENTERPRISE).ir.deployments);
    expect(deployment.cloud).toBe('aws');
    expect(deployment.region).toBe('eu-central-1');
    expect(deployment.audit).toEqual({ sink: 'cloudwatch', retentionDays: 400 });
  });

  it('refuses an enterprise deployment with no region pin', () => {
    const ir = mutateIR(ENTERPRISE);
    delete first(ir.deployments).region;
    const diagnostic = onlyDiagnosticWith(gate(ir).diagnostics, IR_DIAGNOSTIC_CODES.profileRegion);
    expect(diagnostic.path).toEqual(['deployments', 'prod']);
    expect(diagnostic.message).toContain('requires every deployment to pin the region');
    expect(diagnostic.hint).toContain('region:');
  });

  it('refuses an enterprise deployment with no audit sink', () => {
    const ir = mutateIR(ENTERPRISE);
    delete first(ir.deployments).audit;
    const diagnostic = onlyDiagnosticWith(gate(ir).diagnostics, IR_DIAGNOSTIC_CODES.profileAudit);
    expect(diagnostic.path).toEqual(['deployments', 'prod']);
    expect(diagnostic.message).toContain('requires every deployment to pin an audit sink');
    expect(diagnostic.hint).toContain('audit:');
  });

  it('accepts an input-only guardrail on the standard profile', () => {
    const ir = mutateIR(ENTERPRISE);
    ir.profile = 'standard';
    first(ir.guardrails).stages = ['input'];
    expect(gate(ir).diagnostics).toEqual([]);
  });

  it('refuses the enterprise profile with only input-stage guardrails', () => {
    const ir = mutateIR(ENTERPRISE);
    first(ir.guardrails).stages = ['input'];
    const diagnostic = onlyDiagnosticWith(
      gate(ir).diagnostics,
      IR_DIAGNOSTIC_CODES.profileGuardrail,
    );
    expect(diagnostic.path).toEqual(['guardrails']);
    expect(diagnostic.message).toContain('at least one guardrail that inspects model output');
    expect(diagnostic.hint).toContain('stages: [output]');
  });

  it('refuses a region that the pinned cloud does not offer', () => {
    const ir = mutateIR(ENTERPRISE);
    first(ir.deployments).region = 'europe-west1';
    const diagnostic = onlyDiagnosticWith(gate(ir).diagnostics, IR_DIAGNOSTIC_CODES.regionTarget);
    expect(diagnostic.path).toEqual(['deployments', 'prod', 'region']);
    expect(diagnostic.message).toContain('"europe-west1" is not a aws region');
    expect(diagnostic.hint).toContain('aws');
  });

  it('refuses an audit sink the pinned cloud cannot create', () => {
    const ir = mutateIR(ENTERPRISE);
    first(ir.deployments).audit = { sink: 'gcs' };
    const diagnostic = onlyDiagnosticWith(gate(ir).diagnostics, IR_DIAGNOSTIC_CODES.auditTarget);
    expect(diagnostic.path).toEqual(['deployments', 'prod', 'audit', 'sink']);
    expect(diagnostic.message).toContain('"gcs" is not one aws can create');
    expect(diagnostic.hint).toContain('cloudwatch');
  });

  it('refuses two deployments on different clouds', () => {
    const ir = mutateIR(ENTERPRISE);
    ir.deployments = [
      { ...first(ir.deployments), id: 'prod' },
      { ...first(ir.deployments), id: 'eu', cloud: 'gcp', region: 'europe-west1' },
    ];
    const diagnostic = onlyDiagnosticWith(gate(ir).diagnostics, IR_DIAGNOSTIC_CODES.cloudConflict);
    expect(diagnostic.path).toEqual(['deployments']);
    expect(diagnostic.message).toContain('"prod" (aws), "eu" (gcp)');
    expect(diagnostic.hint).toContain('one spec per cloud');
  });

  it('accepts two deployments that pin the same cloud', () => {
    const ir = mutateIR(ENTERPRISE);
    ir.deployments = [
      { ...first(ir.deployments), id: 'prod' },
      { ...first(ir.deployments), id: 'eu' },
    ];
    expect(codesOf(gate(ir).diagnostics)).toEqual([]);
  });

  it('refuses two deployments that pin different audit destinations', () => {
    // One environment has one audit destination: a second sink means half the record
    // lands somewhere the first half's reader does not look.
    const ir = mutateIR(ENTERPRISE);
    ir.deployments = [
      { ...first(ir.deployments), id: 'prod' },
      { ...first(ir.deployments), id: 'archive', audit: { sink: 's3' } },
    ];
    const diagnostic = onlyDiagnosticWith(gate(ir).diagnostics, IR_DIAGNOSTIC_CODES.auditConflict);
    expect(diagnostic.path).toEqual(['deployments']);
    expect(diagnostic.message).toContain('cloudwatch');
    expect(diagnostic.message).toContain('s3');
  });

  it('refuses two deployments that agree on the sink but not its retention', () => {
    const ir = mutateIR(ENTERPRISE);
    ir.deployments = [
      { ...first(ir.deployments), id: 'prod' },
      { ...first(ir.deployments), id: 'archive', audit: { sink: 'cloudwatch', retentionDays: 30 } },
    ];
    const diagnostic = onlyDiagnosticWith(gate(ir).diagnostics, IR_DIAGNOSTIC_CODES.auditConflict);
    expect(diagnostic.path).toEqual(['deployments']);
    expect(diagnostic.message).toContain('retention');
  });

  it('leaves a document with no placement to the flag, and requires nothing of it', () => {
    const ir = mutateIR(ENTERPRISE);
    ir.profile = 'standard';
    delete first(ir.deployments).cloud;
    delete first(ir.deployments).region;
    delete first(ir.deployments).audit;
    expect(gate(ir).diagnostics).toEqual([]);
  });

  it('validates a placement even when the document declares no controls', () => {
    // Region and sink are wrong regardless of which profile asked for them, so the
    // standard profile does not get to skip the check by not promising anything.
    const ir = mutateIR(ENTERPRISE);
    ir.profile = 'standard';
    first(ir.deployments).region = 'europe-west1';
    expect(codesOf(gate(ir).diagnostics)).toEqual([IR_DIAGNOSTIC_CODES.regionTarget]);
  });
});
