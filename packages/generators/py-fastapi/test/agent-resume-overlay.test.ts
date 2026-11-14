import {
  applyOverlay,
  parseOverlay,
  parseOverlayBase,
  serializeResolved,
} from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { buildForSpecText, fileMap } from './helpers.js';

/**
 * Resume configuration is a per-customer decision, and an overlay is how one spec serves
 * many customers. Two things therefore need pinning that neither the overlay tests nor the
 * resume tests can see on their own:
 *
 * 1. A customer overlay that opens `state.kind`, `state.urlEnv` and `state.signingKeyEnv`
 *    reaches the generated app, so two customers share one spec and name their own secret
 *    and their own store.
 * 2. A base that never opened those paths refuses the overlay instead of being reconfigured
 *    silently: the allowlist in `overridable` is the whole contract, and resume config is
 *    the case where a silent move would point a customer at the wrong key.
 *
 * A third test records where the signing key is read, because the round's RFC claimed a
 * missing key fails at startup and the emitted app does not do that. See
 * `docs/rfcs/0009-round-9-generated-app-smoke.md` and the finding in the PR: the signer is
 * built inside `build_runtime`, which each handler calls per request, so an absent key is
 * an opaque 403 on the first resume rather than a boot failure. The test asserts what the
 * generator emits, not what the RFC said.
 */

/** The base resume configuration: one agent that pauses, on one store, behind one key. */
function baseSpec(options: { overridable?: boolean } = {}): string {
  const overridable =
    options.overridable === false
      ? ''
      : `
overridable:
  state.kind:
    from: [postgres]
  state.urlEnv:
    from: [ACME_STATE_URL]
  state.signingKeyEnv:
    from: [ACME_CHECKPOINT_KEY]`;

  return `specVersion: "0.33"

project:
  name: resumes
  namespace: aid.test.resumes
  description: One pausing agent, for exercising overlay-supplied resume configuration.
  targets: [py-fastapi]

types:
  Customer:
    kind: struct
    fields:
      id:
        type: string
        required: true

models:
  triage:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools]
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 400

prompts:
  agent_instructions:
    version: 1
    model: triage
    template: |
      Look the account up, then answer in one sentence.
    output:
      kind: text

tools:
  lookup_customer:
    description: Look up the account that filed a ticket.
    input: Customer
    output: Customer
    handler:
      kind: business
      symbol: lookup_customer
    sideEffects: read

guardrails:
  inspected:
    stages: [tool-call]
    policies: [secret-scan]
    action: block
    onFail:
      message: The call was refused.
      log: true

agents:
  helper:
    name: Helper
    instructions: agent_instructions
    model: triage
    tools: [lookup_customer]
    guardrails: [inspected]
    maxSteps: 4
    maxCostBudget: 0.05
    humanInTheLoop:
      when: "true"
      channel: reviews

state:
  kind: sqlite
  urlEnv: AID_STATE_DB
  signingKeyEnv: AID_CHECKPOINT_KEY${overridable}`;
}

/** One customer's overlay: every path here is opened by `baseSpec`'s `overridable` block. */
const OVERLAY = `base: base.spec.yaml
customer: acme-eu
overrides:
  state.kind: postgres
  state.urlEnv: ACME_STATE_URL
  state.signingKeyEnv: ACME_CHECKPOINT_KEY
`;

function parsedBase(text: string): unknown {
  const base = parseOverlayBase(text, { file: 'base.spec.yaml' });
  expect(base.diagnostics).toEqual([]);
  return base.value;
}

function parsedOverlay(text: string): Parameters<typeof applyOverlay>[1] {
  const parsed = parseOverlay(text, { file: 'acme.yaml' });
  expect(parsed.diagnostics).toEqual([]);
  if (parsed.overlay === undefined) throw new Error('the overlay did not parse');
  return parsed.overlay;
}

/** The `agents.py` a spec generates, so assertions read the emitted source rather than the IR. */
function agentsFrom(text: string): string {
  const source = fileMap(buildForSpecText(text).plan.files).get('app/generated/agents.py');
  if (source === undefined) throw new Error('the plan wrote no agents.py');
  return source;
}

/** A `NAME = "value"` constant, tolerating the `str | None` annotation the emitter adds. */
function constant(source: string, name: string): string | undefined {
  const match = new RegExp(`^${name}(?:: [^=\\n]+)? = "([^"]*)"$`, 'm').exec(source);
  return match?.[1];
}

describe('overlay-supplied resume configuration', () => {
  it('reaches the generated app, so two customers can name their own secret and store', () => {
    const applied = applyOverlay(parsedBase(baseSpec()), parsedOverlay(OVERLAY), {
      file: 'acme.yaml',
    });

    expect(applied.diagnostics).toEqual([]);
    expect([...applied.applied].sort()).toEqual([
      'state.kind',
      'state.signingKeyEnv',
      'state.urlEnv',
    ]);

    const source = agentsFrom(serializeResolved(applied.value));

    expect(constant(source, 'CHECKPOINT_SIGNING_KEY_ENV')).toBe('ACME_CHECKPOINT_KEY');
    expect(constant(source, 'CHECKPOINT_STATE_KIND')).toBe('postgres');
    expect(constant(source, 'CHECKPOINT_STATE_URL_ENV')).toBe('ACME_STATE_URL');
    // A fallback to the base's own names would be a customer signing with the wrong key.
    expect(source).not.toContain('AID_CHECKPOINT_KEY');
    expect(source).not.toContain('AID_STATE_DB');
  });

  it('is refused when the base never opened the path', () => {
    const applied = applyOverlay(
      parsedBase(baseSpec({ overridable: false })),
      parsedOverlay(OVERLAY),
      {
        file: 'acme.yaml',
      },
    );

    expect(applied.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'overlay/path-not-overridable',
    );
    // The refusal is per path, and all three paths are unopened, so all three are reported.
    expect(applied.diagnostics).toHaveLength(3);
    expect(applied.applied).toEqual([]);
  });
});

describe('a declared signing key that no environment provides', () => {
  it('is read per request, so a missing key refuses the first resume instead of blocking startup', () => {
    const source = agentsFrom(baseSpec());

    // One construction site, inside `_resume_protection` -- never at import time, which is
    // what makes an absent key a refusal on a request rather than a boot failure.
    expect(source.match(/signer_from_env\(/g) ?? []).toHaveLength(1);
    expect(source.match(/nonce_store_from_env\(/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/^(?:signer_from_env|nonce_store_from_env)\(/m);

    // `_resume_protection` is called once, from `build_runtime`...
    expect(source.match(/_resume_protection\(\)/g) ?? []).toHaveLength(2);
    expect(source).toContain('signer, nonces = _resume_protection()');

    // ...and `build_runtime` is what each handler calls, once per request.
    expect(source.match(/build_runtime\(/g) ?? []).toHaveLength(3);
    expect(source).toContain(
      'runtime = build_runtime(gateway=deps.gateway, tools=deps.agent_tools)',
    );
  });

  it('declares no signer at all when the spec names no key, rather than refusing to import', () => {
    const source = agentsFrom(baseSpec().replace('  signingKeyEnv: AID_CHECKPOINT_KEY', ''));

    expect(constant(source, 'CHECKPOINT_SIGNING_KEY_ENV')).toBeUndefined();
    expect(source).toContain('if CHECKPOINT_SIGNING_KEY_ENV is None:');
    expect(source).toContain('return None, None');
  });
});
