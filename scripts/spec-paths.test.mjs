/**
 * The spec-path and profile checks can only be trusted if they can be shown to fail.
 *
 * `resolveSpecPath` reads the JSON schema a different way from every other consumer
 * (it follows `$ref`s, `oneOf`s and map members), so its semantics are pinned here
 * against synthetic schemas small enough to read, plus the two real regressions it
 * was written to catch: a path one level short (`observability.feedback.redact`)
 * and the `[]` marker being ignored so `evals[].gate` was read as an eval *named*
 * `gate`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  looksLikeSpecPath,
  profileClaims,
  resolveSpecPath,
  specPathClaims,
} from './spec-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  readFileSync(join(root, 'packages/spec/src/schema/spec.schema.json'), 'utf8'),
);
const topLevel = new Set(Object.keys(schema.properties));

/**
 * @param {Record<string, any>} properties
 * @returns {any}
 */
const object = (properties) => ({ type: 'object', properties, additionalProperties: false });
/**
 * @param {string} ref
 * @returns {any}
 */
const map = (ref) => ({ type: 'object', additionalProperties: { $ref: ref } });

describe('what counts as a spec field path', () => {
  /** @param {string} name */
  const isTopLevel = (name) => topLevel.has(name);

  it('accepts a field path and its map and array forms', () => {
    for (const token of [
      'observability.redact',
      'deployments[].identity.verifiedBy',
      'deployments.api.region',
      'evals.*.target',
      'agents.<name>.state',
      'types.CoverageDecision',
    ]) {
      expect(looksLikeSpecPath(token, isTopLevel), token).toBe(true);
    }
  });

  it('rejects source paths, line citations and non-spec dotted names', () => {
    for (const token of [
      'app/business/tools.py',
      'agents.py',
      'observability.ts:213',
      'resume.token',
      'pnpm',
      'scripts/check-docs-claims.mjs',
    ]) {
      expect(looksLikeSpecPath(token, isTopLevel), token).toBe(false);
    }
  });

  it('finds backticked paths in a document and ignores prose', () => {
    const text = [
      'The set is `observability.redact`, not `agents.py`.',
      'A line cite like `observability.ts:213` is a place, not a field.',
    ].join('\n');
    expect(specPathClaims(text, isTopLevel)).toEqual([{ token: 'observability.redact', line: 1 }]);
  });
});

describe('resolving against the schema', () => {
  it('accepts a declared field and its nested fields', () => {
    expect(resolveSpecPath(schema, 'observability.redact').ok).toBe(true);
    expect(resolveSpecPath(schema, 'observability.feedback.pii.redact').ok).toBe(true);
    expect(resolveSpecPath(schema, 'state.signingKeyEnv').ok).toBe(true);
  });

  it('rejects a path one level short of the real field', () => {
    // The defect this rule caught: the docs dropped `pii`, and the reader edited a
    // spec the gate then refused for the wrong reason.
    const verdict = resolveSpecPath(schema, 'observability.feedback.redact');
    if (verdict.ok) throw new Error('expected the short path to be refused');
    expect(verdict.at).toBe('observability.feedback.redact');
    expect(verdict.available).toContain('pii');
  });

  it('reads the [] marker as a member, so a list field compares as a field', () => {
    // Regression: `evals[]` used to leave the map node in place, so `gate` resolved
    // through `additionalProperties` as an eval instance *named* `gate`.
    const synthetic = {
      type: 'object',
      properties: { evals: map('#/$defs/eval') },
      $defs: { eval: object({ gate: object({ ci: { type: 'boolean' } }) }) },
    };
    expect(resolveSpecPath(synthetic, 'evals[].gate.ci').ok).toBe(true);
    expect(resolveSpecPath(synthetic, 'evals[].gate.missing').ok).toBe(false);
  });

  it('resolves a node that carries both properties and a oneOf', () => {
    const synthetic = {
      type: 'object',
      properties: {
        pipelines: map('#/$defs/pipeline'),
      },
      $defs: {
        pipeline: object({
          trigger: {
            type: 'object',
            properties: { manual: object({}) },
            additionalProperties: false,
            oneOf: [{ properties: { manual: object({}) } }],
          },
        }),
      },
    };
    expect(resolveSpecPath(synthetic, 'pipelines[].trigger.manual').ok).toBe(true);
  });

  it('resolves a map instance name without demanding the schema list it', () => {
    const synthetic = {
      type: 'object',
      properties: { deployments: map('#/$defs/deployment') },
      $defs: { deployment: object({ region: { type: 'string' } }) },
    };
    for (const token of [
      'deployments.anyCustomer.region',
      'deployments[].region',
      'deployments.<id>.region',
      'deployments.*.region',
    ]) {
      expect(resolveSpecPath(synthetic, token).ok, token).toBe(true);
    }
  });

  it('names the offending segment and the fields that were available', () => {
    const synthetic = {
      type: 'object',
      properties: { state: object({ kind: { type: 'string' } }) },
    };
    const verdict = resolveSpecPath(synthetic, 'state.missing.kind');
    if (verdict.ok) throw new Error('expected the unknown field to be refused');
    expect(verdict.at).toBe('state.missing');
    expect(verdict.available).toEqual(['kind']);
  });
});

describe('operating-profile claims', () => {
  it('reads an assignment inside a fenced block', () => {
    const text = ['```yaml', 'profile: enterprise', '```'].join('\n');
    expect(profileClaims(text).map((claim) => claim.token)).toEqual(['enterprise']);
  });

  it('reads the unambiguous "profile `x`" orderings', () => {
    expect(profileClaims('Run it under profile `enterprise`.').map((c) => c.token)).toEqual([
      'enterprise',
    ]);
    expect(profileClaims('Set profile: `standard` first.').map((c) => c.token)).toEqual([
      'standard',
    ]);
  });

  it('does not read prose or a cost profile as an operating profile', () => {
    const text = [
      'A profile: a named bundle of defaults, not a mode.',
      'Delete the dead `azure-gpt-4o-mini` profile.',
    ].join('\n');
    expect(profileClaims(text)).toEqual([]);
  });

  it('produces a claim the check refuses when the name is not in the enum', () => {
    const claims = profileClaims(['```yaml', 'profile: sovereign', '```'].join('\n'));
    const admitted = new Set(schema.properties.profile.enum);
    expect(claims).toHaveLength(1);
    expect(admitted.has(claims[0]?.token ?? '')).toBe(false);
  });

  it('still finds claims in the real tree, so the detector cannot go vacuous', () => {
    let total = 0;
    for (const file of ['docs/usage.md', 'docs/walkthroughs/enterprise-profile.md']) {
      total += profileClaims(readFileSync(join(root, file), 'utf8')).length;
    }
    expect(total).toBeGreaterThan(0);
  });
});
