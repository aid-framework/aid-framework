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

  it('no longer suppresses the guardrail rule Phase 2 L1 can enforce', () => {
    const { suppressed } = gateFixture('full.yaml').byGate.security;
    expect(suppressed).toEqual([]);
    // `security/input-output-guardrails` used to sit in this gate's suppression list.
    // Its absence is the assertion that it was not quietly re-deferred when the four
    // sections were promoted.
    expect(suppressed.map((entry) => entry.check)).not.toContain(
      'security/input-output-guardrails',
    );
  });

  it('rejects caller text that reaches a prompt with no input-stage guardrail', () => {
    const { diagnostics } = gateFixture('guardrails-no-input-stage.yaml').byGate.security;
    const flagged = onlyDiagnosticWith(diagnostics, IR_DIAGNOSTIC_CODES.securityInputGuardrail);
    expect(flagged.severity).toBe('error');
    expect(flagged.path).toEqual(['pipelines', 'handle_ticket', 'steps', 0]);
    expect(flagged.message).toContain('POST /tickets');
    expect(flagged.message).toContain('no guardrail with an "input" stage');
  });

  it('accepts the same pipeline once an input-stage guardrail is declared', () => {
    const { diagnostics } = gateFixture('agents.yaml').byGate.security;
    expect(
      diagnostics.filter((entry) => entry.code === IR_DIAGNOSTIC_CODES.securityInputGuardrail),
    ).toEqual([]);
  });

  it('does not impose the guardrail rule on a spec that cannot declare one', () => {
    // Additive-only: `full.yaml` is a 0.1 spec with no `guardrails` section, so the
    // rule has nothing to inspect and must stay silent rather than fail retroactively.
    const { ir, byGate } = gateFixture('full.yaml');
    expect(ir.guardrails).toEqual([]);
    const flagged = byGate.security.diagnostics.filter(
      (entry) => entry.code === IR_DIAGNOSTIC_CODES.securityInputGuardrail,
    );
    expect(flagged).toEqual([]);
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

  it('accepts a store that reaches its service through the environment', () => {
    expect(gateFixture('retrieval.yaml').byGate.security.diagnostics).toEqual([]);
  });

  it('rejects a store carrying a literal connection string, fail-closed', () => {
    const ir = mutateIR('retrieval.yaml');
    first(ir.stores).uri = 'postgres://aid:hunter2@db.internal:5432/aid';

    const secret = onlyDiagnosticWith(
      runGates(ir).byGate.security.diagnostics,
      IR_DIAGNOSTIC_CODES.securityStoreSecret,
    );
    expect(secret.severity).toBe('error');
    expect(secret.path).toEqual(['stores', 'docs', 'uri']);
    expect(secret.message).toContain('a literal connection string');
    expect(secret.hint).toContain('env:<NAME>');
  });

  it('rejects a source uri that carries an inline credential', () => {
    const ir = mutateIR('retrieval.yaml');
    first(ir.retrievers).source.uri = 'https://aid:hunter2@docs.internal/handbook';

    const secret = onlyDiagnosticWith(
      runGates(ir).byGate.security.diagnostics,
      IR_DIAGNOSTIC_CODES.securityStoreSecret,
    );
    expect(secret.severity).toBe('error');
    expect(secret.path).toEqual(['retrievers', 'handbook', 'source', 'uri']);
    expect(secret.message).toContain('inline credential');
  });
});
