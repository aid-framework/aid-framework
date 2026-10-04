import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import type { IR } from '../src/index.js';
import { buildFixture, FIXTURE_DIR } from './helpers.js';

const SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'schema',
  'ir.schema.json',
);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(SCHEMA);

/** Every fixture is a valid spec, so every IR the builder produces must validate. */
const FIXTURES = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.yaml'));

/**
 * The one fixture whose IR is left structurally unresolved, not merely gate-rejected. A
 * step whose tool names a prompt cannot be spelled as a resolved tool step, so the schema
 * is right to reject it. Every other fixture stays well-formed even when a gate rejects
 * it: this schema describes shape, never policy.
 */
const STRUCTURALLY_INVALID = new Set(['referential-unresolved.yaml']);

const base = buildFixture('full.yaml').ir;

function omit(ir: IR, key: string): Record<string, unknown> {
  const copy = { ...ir } as Record<string, unknown>;
  delete copy[key];
  return copy;
}

/** The first pipeline step, exposed loosely so a malformed case can be spelled out. */
function firstStep(ir: IR): { kind: string } {
  const step = ir.pipelines[0]?.steps[0];
  if (step === undefined) throw new Error('full.yaml has no first pipeline step');
  return step as { kind: string };
}

describe('ir.schema.json', () => {
  it('is a draft 2020-12 schema with a stable identity', () => {
    expect(SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(SCHEMA.$id).toBe('https://aid-framework.dev/schema/ir-0.1.json');
  });

  it('accepts every well-formed IR the builder produces', () => {
    expect(FIXTURES.length).toBeGreaterThan(6);
    for (const name of FIXTURES) {
      const expected = !STRUCTURALLY_INVALID.has(name);
      expect(validate(buildFixture(name).ir), `${name} schema validity`).toBe(expected);
    }
  });

  it('rejects an IR left structurally unresolved, and points at the offending step', () => {
    for (const name of STRUCTURALLY_INVALID) {
      expect(validate(buildFixture(name).ir), `${name} must be rejected`).toBe(false);
      expect(
        (validate.errors ?? []).some((error) =>
          error.instancePath.startsWith('/pipelines/0/steps/1'),
        ),
        `${name} must name the step`,
      ).toBe(true);
    }
  });

  it('requires every top-level key, so a reshape cannot silently drop one', () => {
    expect(validate(base)).toBe(true);
    for (const key of Object.keys(base)) {
      expect(validate(omit(base, key)), `${key} must be required`).toBe(false);
    }
  });

  it('rejects an IR with a deferred collection omitted', () => {
    for (const key of [
      'retrievers',
      'embeddings',
      'stores',
      'memory',
      'agents',
      'guardrails',
      'deployments',
    ]) {
      expect(validate(omit(base, key)), `${key} must be present`).toBe(false);
    }
  });

  it('rejects the wrong type in a required position', () => {
    expect(validate({ ...base, irVersion: 5 })).toBe(false);
    expect(validate({ ...base, specVersion: 1 })).toBe(false);
    expect(validate({ ...base, observability: 'on' })).toBe(false);
    expect(validate({ ...base, types: {} })).toBe(false);
    expect(validate({ ...base, pipelines: 'none' })).toBe(false);
  });

  it('rejects an unknown top-level key rather than ignoring it', () => {
    expect(validate({ ...base, bogusTopLevelKey: 1 })).toBe(false);
    expect(validate(null)).toBe(false);
    expect(validate([])).toBe(false);
    expect(validate('not an ir')).toBe(false);
  });

  it('rejects a capability outside the vocabulary', () => {
    const malformed = structuredClone(base);
    (malformed.requiredCapabilities as string[]).push('teleportation');
    expect(validate(malformed)).toBe(false);
  });

  it('rejects a step of an unknown kind', () => {
    const malformed = structuredClone(base);
    firstStep(malformed).kind = 'guard';
    expect(validate(malformed)).toBe(false);
  });

  it('rejects a misversioned IR', () => {
    expect(validate({ ...base, irVersion: '0.1' })).toBe(false);
  });
});
