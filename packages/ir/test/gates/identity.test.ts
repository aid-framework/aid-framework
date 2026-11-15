import { describe, expect, it } from 'vitest';

import {
  buildIR,
  type IR,
  IR_DIAGNOSTIC_CODES,
  type IrDiagnosticCode,
  runGates,
} from '../../src/index.js';
import { codesOf } from '../helpers.js';

/**
 * `identity.verifiedBy: aid` is the one identity claim the build makes rather than reads:
 * every other value names a component and stops, while `aid` promises an emitted check.
 * These tests drive the gate directly, because each negative case is a document a human
 * would call complete -- an issuer, an audience, a provider -- and the gate is the only
 * place the missing half is noticed.
 */

const VERIFIER = {
  kind: 'oidc',
  issuer: 'https://login.example.com',
  audience: 'aid-claims',
  jwksUri: 'https://login.example.com/.well-known/jwks.json',
  verifiedBy: 'aid',
};

interface Options {
  specVersion?: string;
  identity?: Record<string, unknown>;
  /** Adds a second deployment carrying its own identity, for the agreement cases. */
  second?: Record<string, unknown>;
}

function document(options: Options = {}): unknown {
  const deployments: Record<string, unknown> = {
    prod: {
      target: 'container',
      cloud: 'aws',
      region: 'eu-central-1',
      identity: options.identity ?? VERIFIER,
    },
  };
  if (options.second !== undefined) {
    deployments.second = {
      target: 'container',
      cloud: 'aws',
      region: 'us-east-1',
      ...options.second,
    };
  }

  return {
    specVersion: options.specVersion ?? '0.35',
    project: { name: 'p' },
    profile: 'standard',
    types: {
      Claim: {
        kind: 'struct',
        fields: { id: { type: 'string', required: true } },
      },
    },
    models: {
      m: { provider: 'openai', modelId: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
    },
    tools: {
      lookup_claim: {
        description: 'Look up a claim.',
        input: 'Claim',
        output: 'Claim',
        handler: { kind: 'business', symbol: 'lookup_claim' },
        sideEffects: 'read',
      },
    },
    agents: {
      reviewer: {
        model: 'm',
        instructions: 'Review the claim.',
        tools: ['lookup_claim'],
        maxSteps: 6,
        maxCostBudget: 1,
      },
    },
    deployments,
  };
}

interface Outcome {
  ir: IR;
  codes: string[];
  diagnostics: { code: IrDiagnosticCode; severity: string; message: string }[];
}

function identity(options: Options = {}): Outcome {
  const built = buildIR(document(options));
  const diagnostics = runGates(built.ir).byGate.identity.diagnostics;
  return {
    ir: built.ir,
    codes: codesOf(diagnostics),
    diagnostics: diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
  };
}

/** The one diagnostic with `code`, or a failure naming what was actually emitted. */
function only(outcome: Outcome, code: IrDiagnosticCode) {
  const matches = outcome.diagnostics.filter((entry) => entry.code === code);
  const head = matches[0];
  if (head === undefined || matches.length !== 1) {
    throw new Error(
      `expected exactly one ${code}, found ${matches.length} in:\n${outcome.codes.join(', ')}`,
    );
  }
  return head;
}

describe('the identity gate', () => {
  it('accepts a complete oidc identity that asks for the generated verifier', () => {
    expect(identity().codes).toEqual([]);
  });

  it('says nothing about a document that names its own verifier', () => {
    const outcome = identity({
      identity: { ...VERIFIER, verifiedBy: 'api-gateway', jwksUri: undefined, audience: undefined },
    });
    expect(outcome.codes).toEqual([]);
  });

  it('says nothing about a document with no identity at all', () => {
    expect(identity({ identity: undefined }).codes).toEqual([]);
  });

  it('says nothing below 0.35, where `aid` is an ordinary component name', () => {
    const outcome = identity({ specVersion: '0.34', identity: { ...VERIFIER } });
    expect(outcome.codes).toEqual([]);
  });

  it('refuses a saml identity that asks for the generated verifier', () => {
    const outcome = identity({ identity: { ...VERIFIER, kind: 'saml' } });
    const refusal = only(outcome, IR_DIAGNOSTIC_CODES.identityKind);
    expect(refusal.severity).toBe('error');
    expect(refusal.message).toContain('saml');
    expect(outcome.codes).not.toContain(IR_DIAGNOSTIC_CODES.identityAudience);
  });

  it('refuses a generated verifier with no audience pinned', () => {
    const outcome = identity({ identity: { ...VERIFIER, audience: undefined } });
    const refusal = only(outcome, IR_DIAGNOSTIC_CODES.identityAudience);
    expect(refusal.severity).toBe('error');
    expect(refusal.message).toContain('would be accepted');
  });

  it('refuses a generated verifier with no key source', () => {
    const outcome = identity({ identity: { ...VERIFIER, jwksUri: undefined } });
    const refusal = only(outcome, IR_DIAGNOSTIC_CODES.identityKeys);
    expect(refusal.severity).toBe('error');
    expect(refusal.message).toContain('jwksUri');
  });

  it('refuses two deployments that disagree about the provider', () => {
    const outcome = identity({
      second: { identity: { ...VERIFIER, audience: 'other-service' } },
    });
    const refusal = only(outcome, IR_DIAGNOSTIC_CODES.identityConflict);
    expect(refusal.severity).toBe('error');
    expect(refusal.message).toContain('"prod"');
    expect(refusal.message).toContain('"second"');
  });

  it('accepts two deployments that agree about the provider', () => {
    const outcome = identity({ second: { identity: { ...VERIFIER } } });
    expect(outcome.codes).toEqual([]);
  });

  it('refuses a deployment that names its own verifier while another generates one', () => {
    // `current_principal` is one dependency, so the generated check would run on `second`
    // too -- a deployment whose document named a different component.
    const outcome = identity({
      second: { identity: { ...VERIFIER, verifiedBy: 'hospital-gateway' } },
    });
    const refusal = only(outcome, IR_DIAGNOSTIC_CODES.identityConflict);
    expect(refusal.message).toContain('"second"');
    expect(refusal.message).toContain('declares an identity that does not ask for it');
    expect(refusal.message).not.toContain('"prod" declares');
  });

  it('refuses a deployment that declares an identity but no verifier at all', () => {
    const outcome = identity({
      second: { identity: { kind: 'oidc', issuer: 'https://login.example.com' } },
    });
    const refusal = only(outcome, IR_DIAGNOSTIC_CODES.identityConflict);
    expect(refusal.message).toContain('"second"');
  });

  it('accepts a second deployment that declares no identity', () => {
    // No identity is anonymous, which is what the deployment asked for and not a
    // different verifier, so there is nothing to disagree with.
    const outcome = identity({ second: {} });
    expect(outcome.codes).toEqual([]);
  });

  it('treats a differing claim name as a disagreement, since it changes what is read', () => {
    const outcome = identity({
      second: { identity: { ...VERIFIER, subjectClaim: 'email' } },
    });
    expect(outcome.codes).toEqual([IR_DIAGNOSTIC_CODES.identityConflict]);
  });

  it('reports every missing key at once rather than one per run', () => {
    const outcome = identity({
      identity: { kind: 'oidc', issuer: 'https://login.example.com', verifiedBy: 'aid' },
    });
    expect(outcome.codes).toEqual([
      IR_DIAGNOSTIC_CODES.identityAudience,
      IR_DIAGNOSTIC_CODES.identityKeys,
    ]);
  });

  it('records the verifier configuration on the deployment', () => {
    const built = buildIR(
      document({ identity: { ...VERIFIER, subjectClaim: 'email', rolesClaim: 'groups' } }),
    );
    const deployment = built.ir.deployments.find((entry) => entry.id === 'prod');
    expect(deployment?.identity?.verifiedBy).toBe('aid');
    expect(deployment?.identity?.jwksUri).toBe(VERIFIER.jwksUri);
    expect(deployment?.identity?.subjectClaim).toBe('email');
    expect(deployment?.identity?.rolesClaim).toBe('groups');
  });
});
