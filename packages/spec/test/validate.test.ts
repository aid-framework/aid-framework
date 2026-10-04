import { describe, expect, it } from 'vitest';
import {
  checkSpecText,
  DEFERRED_SECTIONS,
  DEFERRED_STEP_KINDS,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  formatPath,
  type PathSegment,
  SPEC_VERSION,
  SUPPORTED_SECTIONS,
  SUPPORTED_STEP_KINDS,
  specJsonSchema,
  validateSpec,
} from '../src/index.js';
import { readFixture, readFixtureDir } from './fixtures.js';

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

function paths(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => formatPath(diagnostic.path));
}

describe('spec version', () => {
  it('matches the version the JSON Schema enforces', () => {
    expect(SPEC_VERSION).toBe('0.1');
    expect(specJsonSchema()).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { specVersion: { const: SPEC_VERSION } },
    });
  });

  it('lists only the Phase 0 sections as supported', () => {
    expect([...SUPPORTED_SECTIONS].sort()).toEqual([
      'evals',
      'models',
      'pipelines',
      'project',
      'prompts',
      'specVersion',
      'tools',
      'types',
    ]);
  });

  it('keeps the supported and deferred step kinds disjoint', () => {
    const overlap = SUPPORTED_STEP_KINDS.filter((kind) =>
      (DEFERRED_STEP_KINDS as readonly string[]).includes(kind),
    );
    expect(overlap).toEqual([]);
    expect([...SUPPORTED_STEP_KINDS].sort()).toEqual(['emit', 'generate', 'tool']);
  });
});

describe('valid fixtures', () => {
  const fixtures = readFixtureDir('valid');

  it.each(fixtures.map((fixture) => [fixture.name, fixture.text] as const))(
    '%s produces no diagnostics',
    (name, text) => {
      const result = checkSpecText(text, { file: name });
      expect(result.diagnostics.map((diagnostic) => formatDiagnosticLine(diagnostic))).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it('accepts every section declared as supported', () => {
    const value = checkSpecText(readFixture('valid/full.spec.yaml')).value as Record<
      string,
      unknown
    >;
    expect(Object.keys(value).sort()).toEqual([...SUPPORTED_SECTIONS].sort());
  });
});

/**
 * One assertion per invalid fixture, each shaped to contain exactly one problem.
 * Iterating the directory means a new fixture with no expectation fails rather
 * than being skipped.
 */
const EXPECTED: Record<string, { code: string; path: PathSegment[] }> = {
  'deferred-section.spec.yaml': { code: DIAGNOSTIC_CODES.notSupported, path: ['agents'] },
  'deferred-step.spec.yaml': {
    code: DIAGNOSTIC_CODES.unsupportedStep,
    path: ['pipelines', 'probe', 'steps', 0],
  },
  'duplicate-binding.spec.yaml': {
    code: DIAGNOSTIC_CODES.duplicateBinding,
    path: ['pipelines', 'probe', 'steps', 1, 'generate', 'as'],
  },
  'fake-with-api-key.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['models', 'offline'],
  },
  'llm-judge-in-ci.spec.yaml': {
    code: DIAGNOSTIC_CODES.metricUnavailableInCi,
    path: ['evals', 'quality', 'metrics', 0],
  },
  'malformed-template.spec.yaml': {
    code: DIAGNOSTIC_CODES.malformedTemplate,
    path: ['prompts', 'classify', 'template'],
  },
  'step-with-two-kinds.spec.yaml': {
    code: DIAGNOSTIC_CODES.unsupportedStep,
    path: ['pipelines', 'probe', 'steps', 0],
  },
  'structured-without-schema.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['prompts', 'classify', 'output', 'schema'],
  },
  'syntax-error.spec.yaml': { code: DIAGNOSTIC_CODES.yamlSyntax, path: [] },
  'unknown-key.spec.yaml': { code: DIAGNOSTIC_CODES.unknownKey, path: ['modles'] },
  'wrong-spec-version.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['specVersion'],
  },
};

describe('invalid fixtures', () => {
  const fixtures = readFixtureDir('invalid');

  it('covers every fixture on disk', () => {
    expect(fixtures.map((fixture) => fixture.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(fixtures.map((fixture) => [fixture.name, fixture.text] as const))(
    '%s reports exactly one error at the expected path',
    (name, text) => {
      const expected = EXPECTED[name];
      if (!expected) throw new Error(`no expectation for fixture ${name}`);

      const result = checkSpecText(text, { file: name });

      expect(codes(result.diagnostics)).toEqual([expected.code]);
      expect(paths(result.diagnostics)).toEqual([formatPath(expected.path)]);
      expect(result.ok).toBe(false);
      expect(result.diagnostics[0]?.file).toBe(name);
    },
  );

  it('never reports both a deferral and a schema error for the same path', () => {
    // The schema also rejects `agents`; the scope rule claims the path and the
    // schema pass is suppressed underneath it.
    const result = checkSpecText(readFixture('invalid/deferred-section.spec.yaml'));
    expect(result.diagnostics).toHaveLength(1);
    // The message names the section; the hint names the phase.
    expect(result.diagnostics[0]?.message).toContain("'agents'");
    expect(result.diagnostics[0]?.hint).toContain('Phase 0');
  });

  it('points a deferred section at its own line', () => {
    const text = readFixture('invalid/deferred-section.spec.yaml');
    const result = checkSpecText(text, { file: 'deferred-section.spec.yaml' });
    const [diagnostic] = result.diagnostics;
    if (!diagnostic?.line) throw new Error('expected a diagnostic carrying a line number');

    expect(text.split('\n')[diagnostic.line - 1]).toContain('agents:');
  });
});

describe('document-level shape', () => {
  it('rejects an empty document', () => {
    const result = checkSpecText('');
    expect(codes(result.diagnostics)).toEqual([DIAGNOSTIC_CODES.emptyDocument]);
  });

  it('rejects a document whose top level is a sequence', () => {
    const result = checkSpecText('- specVersion: "0.1"\n');
    expect(codes(result.diagnostics)).toEqual([DIAGNOSTIC_CODES.documentNotAMapping]);
  });

  it('rejects a document whose top level is a scalar', () => {
    const result = checkSpecText('"specVersion"\n');
    expect(codes(result.diagnostics)).toEqual([DIAGNOSTIC_CODES.documentNotAMapping]);
  });

  it('reports a missing required top-level key', () => {
    const diagnostics = validateSpec({ specVersion: '0.1' });
    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
    expect(paths(diagnostics)).toContain('project');
  });
});

describe('rule-level unit tests', () => {
  it('distinguishes a deferred section from a misspelled one', () => {
    const deferred = validateSpec({ specVersion: '0.1', project: { name: 'p' }, agents: {} });
    expect(codes(deferred)).toEqual([DIAGNOSTIC_CODES.notSupported]);

    const typo = validateSpec({ specVersion: '0.1', project: { name: 'p' }, agants: {} });
    expect(codes(typo)).toEqual([DIAGNOSTIC_CODES.unknownKey]);
  });

  it('tells the reader what Phase 0 does cover', () => {
    const [diagnostic] = validateSpec({
      specVersion: '0.1',
      project: { name: 'p' },
      retrievers: {},
    });
    expect(diagnostic?.message).toContain('retrievers');
    expect(diagnostic?.hint).toContain(SUPPORTED_SECTIONS.join(', '));
  });

  it('never claims a deferred section is supported', () => {
    for (const section of DEFERRED_SECTIONS) {
      expect(SUPPORTED_SECTIONS).not.toContain(section);
    }
  });

  it('rejects a step that names no supported kind', () => {
    const diagnostics = validateSpec({
      specVersion: '0.1',
      project: { name: 'p' },
      pipelines: {
        p: { trigger: { http: { method: 'post', path: '/p' } }, steps: [{ emit_if: {} }] },
      },
    });
    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.unsupportedStep);
  });

  it('accepts a step that names exactly one supported kind', () => {
    const diagnostics = validateSpec({
      specVersion: '0.1',
      project: { name: 'p' },
      pipelines: {
        p: {
          trigger: { http: { method: 'post', path: '/p' } },
          steps: [{ emit: { event: 'Answer' } }],
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it('allows an llm-judge metric on an eval that is not gated in CI', () => {
    const diagnostics = validateSpec({
      specVersion: '0.1',
      project: { name: 'p' },
      evals: {
        quality: {
          target: 'pipeline:p',
          dataset: { source: 'file', uri: 'evals/q.jsonl' },
          metrics: [{ kind: 'llm-judge', rubric: 'Is it good?' }],
          gate: { ci: false, maxRegression: 0.1, samples: 3 },
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it('attaches positions only when a document is supplied', () => {
    const parsed = checkSpecText(readFixture('invalid/unknown-key.spec.yaml'), {
      file: 'unknown-key.spec.yaml',
    });
    expect(parsed.diagnostics[0]?.line).toBe(6);

    const bare = validateSpec({ specVersion: '0.1', project: { name: 'p' }, modles: {} });
    expect(bare[0]?.line).toBeUndefined();
  });
});

/** Renders the message alone, so a failure diff stays readable. */
function formatDiagnosticLine(diagnostic: Diagnostic): string {
  return `${formatPath(diagnostic.path)}:${diagnostic.code}: ${diagnostic.message}`;
}
