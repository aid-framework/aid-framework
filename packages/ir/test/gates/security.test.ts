import { describe, expect, it } from 'vitest';

import {
  IR_DIAGNOSTIC_CODES,
  type PolicyNode,
  parsePolicyExpr,
  policyAuthenticates,
  runGates,
} from '../../src/index.js';
import { first, gateFixture, mutateIR, onlyDiagnosticWith } from '../helpers.js';

const UNAUTH_PATH = 'security-unauthenticated-path.yaml';

function astOf(source: string): PolicyNode {
  const parsed = parsePolicyExpr(source);
  if (parsed.ast === undefined) {
    throw new Error(`expected "${source}" to parse, got: ${JSON.stringify(parsed.diagnostics)}`);
  }
  return parsed.ast;
}

describe('security gate', () => {
  it('passes a spec whose mutations are authenticated and whose trace redacts', () => {
    const { byGate } = gateFixture('full.yaml');
    expect(byGate.security.diagnostics).toEqual([]);
  });

  it('suppresses the guardrail rule Phase 0 cannot enforce, with a reason', () => {
    const { suppressed } = gateFixture('full.yaml').byGate.security;
    expect(suppressed.map((entry) => entry.check)).toEqual(['security/input-output-guardrails']);
    expect(first(suppressed).reason).toContain('no guardrail runtime');
  });

  it('fails closed: a write tool with no auth is an error, not a warning', () => {
    const { diagnostics } = gateFixture('security-unauth-write.yaml').byGate.security;
    expect(diagnostics).toHaveLength(1);
    const missing = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.securityMissingAuth);
    expect(missing.severity).toBe('error');
    expect(missing.path).toEqual(['tools', 'log_note', 'auth']);
    expect(missing.message).toContain('is callable by anyone');
  });

  it('rejects a write tool reached over HTTP through a policy about something else', () => {
    const { diagnostics } = gateFixture(UNAUTH_PATH).byGate.security;
    expect(diagnostics).toHaveLength(1);
    const flagged = onlyDiagnosticWith(
      diagnostics,
      IR_DIAGNOSTIC_CODES.securityUnauthenticatedPath,
    );
    expect(flagged.severity).toBe('error');
    expect(flagged.path).toEqual(['pipelines', 'credit', 'steps', 0, 'tool']);
    expect(flagged.message).toContain('POST /credit');
    expect(flagged.message).toContain('does not authenticate the caller');
  });

  it('does not treat `not isAuthenticated()` as authenticating', () => {
    const ir = mutateIR(UNAUTH_PATH);
    first(ir.tools).auth = astOf('not isAuthenticated()');

    const flagged = onlyDiagnosticWith(
      runGates(ir).byGate.security.diagnostics,
      IR_DIAGNOSTIC_CODES.securityUnauthenticatedPath,
    );
    expect(flagged.message).toContain('apply_credit');
  });

  it('accepts a policy that does establish identity', () => {
    const ir = mutateIR(UNAUTH_PATH);
    first(ir.tools).auth = astOf('isAuthenticated() and hasScope("credit:write")');
    expect(runGates(ir).byGate.security.diagnostics).toEqual([]);
  });

  it('needs no auth on a tool that cannot mutate', () => {
    const ir = mutateIR('full.yaml');
    const tool = first(ir.tools.filter((entry) => entry.id === 'issue_refund'));
    tool.sideEffects = 'read';
    delete tool.auth;
    expect(runGates(ir).byGate.security.diagnostics).toEqual([]);
  });

  it('requires confirmation for a destructive tool', () => {
    const ir = mutateIR(UNAUTH_PATH);
    const tool = first(ir.tools);
    tool.sideEffects = 'destructive';
    tool.requiresConfirmation = false;
    tool.auth = astOf('hasRole("admin")');

    const { diagnostics } = runGates(ir).byGate.security;
    const missing = onlyDiagnosticWith(
      diagnostics,
      IR_DIAGNOSTIC_CODES.securityMissingConfirmation,
    );
    expect(missing.severity).toBe('error');
    expect(missing.path).toEqual(['tools', 'apply_credit', 'requiresConfirmation']);
  });

  it('accepts the redact set the builder derives from sensitive field names', () => {
    expect(gateFixture('sensitive-fields.yaml').byGate.security.diagnostics).toEqual([]);
  });

  it('rejects a top-level trace config that under-redacts', () => {
    const ir = mutateIR('sensitive-fields.yaml');
    ir.observability.redact = [];

    const incomplete = onlyDiagnosticWith(
      runGates(ir).byGate.security.diagnostics,
      IR_DIAGNOSTIC_CODES.securityRedactionIncomplete,
    );
    expect(incomplete.severity).toBe('error');
    expect(incomplete.path).toEqual(['observability', 'redact']);
    expect(incomplete.message).toContain('password');
  });

  it('rejects a pipeline trace config that under-redacts', () => {
    const ir = mutateIR('sensitive-fields.yaml');
    first(ir.pipelines).observability.redact = [];

    const incomplete = onlyDiagnosticWith(
      runGates(ir).byGate.security.diagnostics,
      IR_DIAGNOSTIC_CODES.securityRedactionIncomplete,
    );
    expect(incomplete.path).toEqual(['pipelines', 'greet_user', 'observability', 'redact']);
  });

  it('does not police redaction when tracing is off', () => {
    const ir = mutateIR('sensitive-fields.yaml');
    ir.observability.trace = false;
    ir.observability.redact = [];
    expect(runGates(ir).byGate.security.diagnostics).toEqual([]);
  });
});

describe('policyAuthenticates', () => {
  it('recognises the identity builtins', () => {
    expect(policyAuthenticates(astOf('isAuthenticated()'))).toBe(true);
    expect(policyAuthenticates(astOf('hasRole("admin")'))).toBe(true);
    expect(policyAuthenticates(astOf('hasScope("credit:write")'))).toBe(true);
  });

  it('propagates through conjunction, disjunction, and comparison', () => {
    expect(policyAuthenticates(astOf('isAuthenticated() and hasScope("x")'))).toBe(true);
    expect(policyAuthenticates(astOf('hasRole("a") or hasRole("b")'))).toBe(true);
    expect(policyAuthenticates(astOf('isAuthenticated() == true'))).toBe(true);
  });

  it('does not read a negation of identity as identity', () => {
    expect(policyAuthenticates(astOf('not isAuthenticated()'))).toBe(false);
    expect(policyAuthenticates(astOf('not hasRole("admin")'))).toBe(false);
  });

  it('reads a policy that never mentions identity as unauthenticated', () => {
    expect(policyAuthenticates(astOf('true'))).toBe(false);
    expect(policyAuthenticates(astOf('"a" == "b"'))).toBe(false);
    expect(policyAuthenticates(astOf('1 < 2'))).toBe(false);
  });
});
