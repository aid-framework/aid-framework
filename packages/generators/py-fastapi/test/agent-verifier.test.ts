/**
 * The token verifier `identity.verifiedBy: aid` generates.
 *
 * Before 0.35 every `verifiedBy` value was a name: the generated `current_principal` was
 * an anonymous placeholder and a reviewer was asked to trust that the named component
 * existed. The reserved literal `aid` is the one value the build acts on instead of
 * recording, so what it emits is a security claim rather than a note, and these are the
 * bytes that back it.
 *
 * The pair pinned here is the same one `agent-principal.test.ts` pins for the anonymous
 * seam: for a document that asks for nothing, `current_principal` must still be overridable
 * and claim nothing; for a document that asks for the generated check, it must verify
 * before any route body runs and must never produce an unauthenticated principal.
 */

import { buildIR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { planPyFastApi } from '../src/index.js';
import { buildForSpecText, exampleSpecText, fileMap } from './helpers.js';

const AGENTS_PATH = 'app/generated/agents.py';

/** The spec version this feature is gated on, restated so the fixture cannot drift silently. */
const GENERATED_VERIFIER_VERSION = '0.35';

const IDENTITY = {
  kind: 'oidc',
  issuer: 'https://login.example.com',
  audience: 'aid-support',
  jwksUri: 'https://login.example.com/.well-known/jwks.json',
  verifiedBy: 'aid',
} as const;

/**
 * The committed example, at 0.35, with a second deployment that asks for the generated
 * verifier.
 *
 * A second deployment rather than an edit to `api`: appending is the only YAML change that
 * cannot be off by one indentation level, and the pair is also the shape the generator has
 * to handle -- one deployment is verified, the other declares no identity at all and still
 * gets the check, because one app has one `current_principal`.
 */
function verifyingSpecText(): string {
  const text = exampleSpecText().replace(
    /^specVersion: "[^"]*"$/m,
    `specVersion: "${GENERATED_VERIFIER_VERSION}"`,
  );
  if (!text.includes(`specVersion: "${GENERATED_VERIFIER_VERSION}"`)) {
    throw new Error('the example does not declare a replaceable specVersion');
  }
  return [
    text,
    '  verifying:',
    '    target: container',
    '    identity:',
    ...Object.entries(IDENTITY).map(([key, value]) => `      ${key}: ${value}`),
    '    secrets: [OPENAI_API_KEY]',
    '',
  ].join('\n');
}

function agentsFor(text: string): string {
  const file = fileMap(buildForSpecText(text).plan.files).get(AGENTS_PATH);
  if (file === undefined) throw new Error(`the plan does not emit ${AGENTS_PATH}`);
  return file;
}

/** `source` without its comment lines, since prose is allowed to name what code may not. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('a generated token verifier', () => {
  it('is compiled from the deployment that asked for it', () => {
    const module = agentsFor(verifyingSpecText());

    expect(module).toContain('from aid_runtime.identity import JwksVerifier, TokenRefusedError');
    expect(module).toContain('JWKS_VERIFIER = JwksVerifier(');
    expect(module).toContain('issuer="https://login.example.com",');
    expect(module).toContain('audience="aid-support",');
    expect(module).toContain('jwks_uri="https://login.example.com/.well-known/jwks.json",');
  });

  it('passes only the claim names the document states, so defaults stay in the runtime', () => {
    const module = agentsFor(verifyingSpecText());

    // Nothing was declared, so nothing is restated: a default written into generated code
    // is a second place to change it.
    expect(module).not.toContain('subject_claim=');
    expect(module).not.toContain('roles_claim=');
    expect(module).not.toContain('scopes_claim=');
  });

  it('takes the token from the Authorization header and fails closed', () => {
    const module = agentsFor(verifyingSpecText());

    expect(module).toContain('authorization: Annotated[str | None, Header()] = None,');
    expect(module).toContain('return JWKS_VERIFIER.principal_from_authorization(authorization)');
    expect(module).toContain('except TokenRefusedError as refusal:');
    expect(module).toContain('status_code=401,');
    expect(module).toContain('headers={"WWW-Authenticate": "Bearer"},');
  });

  it('never produces an unauthenticated principal, so an `auth` policy cannot fail open', () => {
    const module = agentsFor(verifyingSpecText());

    // The whole point of the mode: the anonymous seam is gone rather than kept as a branch,
    // because a branch is a path a future edit can take.
    expect(code(module)).not.toContain('Principal.unauthenticated()');
    expect(code(module)).not.toContain('ANONYMOUS_PRINCIPAL');
  });

  it('returns one opaque message while logging the reason', () => {
    const module = agentsFor(verifyingSpecText());

    // Three facts to the operator, one to the caller: "expired", "wrong audience" and
    // "signed by nobody we trust" are all "the header did not work" over the wire.
    expect(module).toContain('logger.warning("refused a bearer token: %s", refusal.reason)');
    expect(module).toContain('detail=TOKEN_REFUSED,');
    expect(module).toContain('"JWKS_VERIFIER",');
    expect(module).toContain('"TOKEN_REFUSED",');
  });

  it('leaves the anonymous seam untouched for a document that names its own verifier', () => {
    const module = agentsFor(
      verifyingSpecText().replace(
        '      verifiedBy: aid\n',
        '      verifiedBy: hospital-idp-gateway\n',
      ),
    );

    // The 0.33 behaviour, which has to survive: a named component is a declaration the
    // build records, so nothing verifies and the dependency stays overridable.
    expect(module).toContain('ANONYMOUS_PRINCIPAL = Principal.unauthenticated()');
    expect(module).toContain('def current_principal() -> Principal:');
    expect(module).not.toContain('from aid_runtime.identity import');
    expect(module).not.toContain('JWKS_VERIFIER');
  });

  it('does not treat `aid` as the reserved literal below the version that reserved it', () => {
    // Reached through `buildIR` rather than a spec document: the spec layer already refuses
    // `verifiedBy: aid` and `jwksUri` below 0.35 with their own diagnostics, so this is the
    // defence behind that one. An IR that says 0.34 and names a component called `aid`
    // describes a document where `aid` is an ordinary name, and emitting a verifier for it
    // would change the meaning of a spec that did not change.
    const ir = buildIR({
      specVersion: '0.34',
      project: { name: 'p' },
      profile: 'standard',
      types: { Claim: { kind: 'struct', fields: { id: { type: 'string', required: true } } } },
      models: {
        m: { provider: 'openai', modelId: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
      },
      prompts: {
        review: { version: 1, model: 'm', template: 'Review the claim.' },
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
          instructions: 'review',
          tools: ['lookup_claim'],
          maxSteps: 6,
          maxCostBudget: 1,
        },
      },
      deployments: {
        prod: { target: 'container', identity: IDENTITY, secrets: ['OPENAI_API_KEY'] },
      },
    });

    const module = fileMap(planPyFastApi(ir.ir).files).get(AGENTS_PATH);
    expect(module).toBeDefined();
    expect(module).toContain('ANONYMOUS_PRINCIPAL = Principal.unauthenticated()');
    expect(module).not.toContain('JWKS_VERIFIER');
  });
});
