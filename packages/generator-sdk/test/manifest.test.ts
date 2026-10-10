import { describe, expect, it } from 'vitest';

import {
  checkIRSupport,
  GENERATOR_DIAGNOSTIC_CODES,
  managedRoots,
  ORCHESTRATIONS,
  PY_FASTAPI_MANIFEST,
  parseManifest,
  parseManifestJson,
  supportsIR,
  targetCapabilityDeclarations,
  validateGeneratorSet,
  validateManifest,
} from '../src/index.js';
import { codes, hasCode, messages } from './helpers.js';

function validInput(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    name: '@aid/generator-test',
    target: 'test-target',
    version: '1.2.3',
    irRange: '^0.1.0',
    capabilities: ['http-trigger', 'otel'],
    emitsAgainst: { structuredOutput: 'pydantic' },
    output: { root: 'app' },
  };
}

describe('parseManifest', () => {
  it('accepts a complete manifest and fills in defaults', () => {
    const { manifest, diagnostics } = parseManifest(validInput());
    expect(diagnostics).toEqual([]);
    expect(manifest).toEqual({
      manifestVersion: 1,
      name: '@aid/generator-test',
      target: 'test-target',
      version: '1.2.3',
      irRange: '^0.1.0',
      capabilities: ['http-trigger', 'otel'],
      emitsAgainst: { structuredOutput: 'pydantic' },
      output: { root: 'app', generatedDir: 'generated', businessDir: 'business' },
    });
  });

  it('resolves capability aliases and canonicalizes order', () => {
    const { manifest } = parseManifest({
      ...validInput(),
      capabilities: ['tool-call-explicit', 'otel-genai', 'json-schema'],
    });
    expect(manifest?.capabilities).toEqual(['json-schema', 'otel', 'tool-calling']);
  });

  it('defaults emitsAgainst to an empty declaration', () => {
    const input = validInput();
    delete input.emitsAgainst;
    const { manifest, diagnostics } = parseManifest(input);
    expect(diagnostics).toEqual([]);
    expect(manifest?.emitsAgainst).toEqual({});
  });

  it('rejects a non-object', () => {
    expect(codes(validateManifest('nope'))).toEqual([
      GENERATOR_DIAGNOSTIC_CODES.manifestNotAMapping,
    ]);
  });

  it('reports every missing required field in one pass', () => {
    const diagnostics = validateManifest({ manifestVersion: 1 });
    expect(codes(diagnostics)).toEqual([
      GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
      GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
      GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
      GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
      GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
      GENERATOR_DIAGNOSTIC_CODES.manifestMissingField,
    ]);
    for (const key of ['name', 'target', 'version', 'irRange', 'capabilities', 'output']) {
      expect(messages(diagnostics).join(' ')).toContain(`"${key}"`);
    }
  });

  it('rejects an unknown top-level key', () => {
    const diagnostics = validateManifest({ ...validInput(), extra: 1 });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestUnknownKey)).toBe(true);
  });

  it('rejects an unsupported manifestVersion', () => {
    const diagnostics = validateManifest({ ...validInput(), manifestVersion: 2 });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestVersionUnsupported)).toBe(true);
  });

  it('rejects a non-semver version and a non-range irRange', () => {
    expect(
      hasCode(
        validateManifest({ ...validInput(), version: '1.2' }),
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
      ),
    ).toBe(true);
    expect(
      hasCode(
        validateManifest({ ...validInput(), irRange: 'anything' }),
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
      ),
    ).toBe(true);
  });

  it('rejects an unknown capability', () => {
    const diagnostics = validateManifest({ ...validInput(), capabilities: ['telepathy'] });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestCapabilityUnknown)).toBe(true);
  });

  it('rejects two spellings of one capability as a duplicate', () => {
    const diagnostics = validateManifest({
      ...validInput(),
      capabilities: ['otel', 'otel-genai'],
    });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestCapabilityDuplicate)).toBe(true);
  });

  it('rejects a non-array capabilities field', () => {
    const diagnostics = validateManifest({ ...validInput(), capabilities: 'otel' });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField)).toBe(true);
  });

  it('rejects a non-string capability entry', () => {
    const diagnostics = validateManifest({ ...validInput(), capabilities: [7] });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField)).toBe(true);
  });

  it('rejects an unknown emitsAgainst key and an out-of-vocabulary value', () => {
    expect(
      hasCode(
        validateManifest({ ...validInput(), emitsAgainst: { vectorStore: 'pgvector' } }),
        GENERATOR_DIAGNOSTIC_CODES.manifestUnknownKey,
      ),
    ).toBe(true);
    expect(
      hasCode(
        validateManifest({ ...validInput(), emitsAgainst: { orchestration: 'langgraph' } }),
        GENERATOR_DIAGNOSTIC_CODES.manifestEmitsAgainstUnknown,
      ),
    ).toBe(false);
    expect(
      hasCode(
        validateManifest({ ...validInput(), emitsAgainst: { orchestration: 'crewai' } }),
        GENERATOR_DIAGNOSTIC_CODES.manifestEmitsAgainstUnknown,
      ),
    ).toBe(true);
  });

  it('rejects a non-object emitsAgainst and output', () => {
    expect(
      hasCode(
        validateManifest({ ...validInput(), emitsAgainst: 'pydantic' }),
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
      ),
    ).toBe(true);
    expect(
      hasCode(
        validateManifest({ ...validInput(), output: 'app' }),
        GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField,
      ),
    ).toBe(true);
  });

  it('rejects an output root that escapes the repository', () => {
    const diagnostics = validateManifest({ ...validInput(), output: { root: '../outside' } });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestEscapingRoot)).toBe(true);
  });

  it('rejects an absolute output root', () => {
    const diagnostics = validateManifest({ ...validInput(), output: { root: '/app' } });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestNotRelative)).toBe(true);
  });

  it('rejects an empty output root', () => {
    const diagnostics = validateManifest({ ...validInput(), output: { root: '' } });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestInvalidField)).toBe(true);
  });

  it('accepts a nested generated directory relative to the root', () => {
    const { manifest, diagnostics } = parseManifest({
      ...validInput(),
      output: { root: 'app', generatedDir: 'src/generated' },
    });
    expect(diagnostics).toEqual([]);
    expect(managedRoots(manifest as NonNullable<typeof manifest>).generatedDir).toBe(
      'app/src/generated',
    );
  });

  it('rejects a generated directory that contains the business directory', () => {
    const diagnostics = validateManifest({
      ...validInput(),
      output: { root: 'app', generatedDir: 'owned', businessDir: 'owned/business' },
    });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestNotRelative)).toBe(true);
  });

  it('rejects the two tiers collapsing into one directory', () => {
    const diagnostics = validateManifest({
      ...validInput(),
      output: { root: 'app', generatedDir: 'shared', businessDir: 'shared' },
    });
    expect(messages(diagnostics).join(' ')).toContain('must be separate directories');
  });

  it('rejects an unknown output key', () => {
    const diagnostics = validateManifest({
      ...validInput(),
      output: { root: 'app', buildDir: 'dist' },
    });
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.manifestUnknownKey)).toBe(true);
  });

  it('keeps a non-default business directory when it is nested', () => {
    const { manifest } = parseManifest({
      ...validInput(),
      output: { root: 'app', businessDir: 'src/business' },
    });
    expect(manifest?.output.businessDir).toBe('src/business');
  });
});

describe('parseManifestJson', () => {
  it('reports invalid JSON as a parse failure', () => {
    const { manifest, diagnostics } = parseManifestJson('{ not json');
    expect(manifest).toBeUndefined();
    expect(codes(diagnostics)).toEqual([GENERATOR_DIAGNOSTIC_CODES.manifestParseFailed]);
  });

  it('parses valid JSON', () => {
    const { manifest } = parseManifestJson(JSON.stringify(validInput()));
    expect(manifest?.name).toBe('@aid/generator-test');
  });
});

describe('managedRoots', () => {
  it('derives repo-relative managed prefixes from the output layout', () => {
    const { manifest } = parseManifest(validInput());
    expect(manifest).toBeDefined();
    expect(managedRoots(manifest as NonNullable<typeof manifest>)).toEqual({
      generatedDir: 'app/generated',
      businessDir: 'app/business',
      manifestFilename: 'app/aid.manifest.json',
    });
  });
});

describe('checkIRSupport', () => {
  it('accepts an IR version inside the declared range', () => {
    const { manifest } = parseManifest(validInput());
    expect(checkIRSupport(manifest as NonNullable<typeof manifest>, '0.1.0')).toEqual([]);
  });

  it('reports an IR version outside the declared range', () => {
    const { manifest } = parseManifest(validInput());
    const diagnostics = checkIRSupport(manifest as NonNullable<typeof manifest>, '0.2.0');
    expect(codes(diagnostics)).toEqual([GENERATOR_DIAGNOSTIC_CODES.manifestUnsupportedIr]);
  });

  it('exposes a boolean form', () => {
    expect(supportsIR(PY_FASTAPI_MANIFEST, '0.1.0')).toBe(true);
    expect(supportsIR(PY_FASTAPI_MANIFEST, '1.0.0')).toBe(false);
  });
});

describe('validateGeneratorSet', () => {
  const a = parseManifest({ ...validInput(), name: '@aid/a', target: 't' }).manifest;
  const b = parseManifest({ ...validInput(), name: '@aid/a', target: 'u' }).manifest;
  const c = parseManifest({ ...validInput(), name: '@aid/c', target: 't' }).manifest;

  it('accepts a set with unique names and targets', () => {
    expect(
      validateGeneratorSet([
        a as NonNullable<typeof a>,
        parseManifest({ ...validInput(), name: '@aid/b', target: 'u' }).manifest as NonNullable<
          typeof a
        >,
      ]),
    ).toEqual([]);
  });

  it('rejects a duplicated generator name', () => {
    expect(
      codes(validateGeneratorSet([a as NonNullable<typeof a>, b as NonNullable<typeof b>])),
    ).toContain(GENERATOR_DIAGNOSTIC_CODES.manifestDuplicateGenerator);
  });

  it('rejects a target claimed by two generators', () => {
    const diagnostics = validateGeneratorSet([
      a as NonNullable<typeof a>,
      c as NonNullable<typeof c>,
    ]);
    expect(messages(diagnostics).join(' ')).toContain('claimed by two generators');
  });
});

describe('targetCapabilityDeclarations', () => {
  it('renders declarations in the IR gate shape, ordered by target', () => {
    const declarations = targetCapabilityDeclarations([
      parseManifest({ ...validInput(), name: '@aid/z', target: 'z-target' })
        .manifest as NonNullable<ReturnType<typeof parseManifest>['manifest']>,
      parseManifest({ ...validInput(), name: '@aid/a', target: 'a-target' })
        .manifest as NonNullable<ReturnType<typeof parseManifest>['manifest']>,
    ]);
    expect(Object.keys(declarations)).toEqual(['a-target', 'z-target']);
    expect(declarations['a-target']).toEqual(['http-trigger', 'otel']);
  });
});

describe('ORCHESTRATIONS', () => {
  it('is the closed §8.1 vocabulary', () => {
    expect([...ORCHESTRATIONS]).toEqual([
      'langgraph',
      'llamaindex',
      'dspy',
      'vercel-ai',
      'semantic-kernel',
    ]);
  });
});
