import { describe, expect, it } from 'vitest';
import {
  checkSpecText,
  DEFERRED_SECTIONS,
  DEFERRED_STEP_KINDS,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  formatPath,
  MODEL_CACHE_MIN_VERSION,
  type PathSegment,
  SECTION_MIN_VERSION,
  SPEC_VERSION,
  SUPPORTED_SECTIONS,
  SUPPORTED_SPEC_VERSIONS,
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
  it('matches the versions the JSON Schema enforces', () => {
    expect(specJsonSchema()).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { specVersion: { enum: [...SUPPORTED_SPEC_VERSIONS] } },
    });
    // `aid init` writes SPEC_VERSION, so it has to be a version the schema accepts.
    expect([...SUPPORTED_SPEC_VERSIONS]).toContain(SPEC_VERSION);
  });

  it('lists the fourteen supported sections, four of which need spec 0.2', () => {
    expect([...SUPPORTED_SECTIONS].sort()).toEqual([
      'agents',
      'deployments',
      'evals',
      'guardrails',
      'memory',
      'models',
      'pipelines',
      'project',
      'prompts',
      'retrievers',
      'specVersion',
      'stores',
      'tools',
      'types',
    ]);
    // The version boundary, named explicitly: these four are supported, and only from
    // 0.2. A section that gains a minimum version without appearing here would be
    // enforced by the schema and quietly refused by the scope rule.
    expect(Object.keys(SECTION_MIN_VERSION).sort()).toEqual([
      'agents',
      'deployments',
      'guardrails',
      'memory',
    ]);
    expect(Object.values(SECTION_MIN_VERSION)).toEqual(['0.2', '0.2', '0.2', '0.2']);
  });

  it('keeps the supported and deferred step kinds disjoint', () => {
    const overlap = SUPPORTED_STEP_KINDS.filter((kind) =>
      (DEFERRED_STEP_KINDS as readonly string[]).includes(kind),
    );
    expect(overlap).toEqual([]);
    expect([...SUPPORTED_STEP_KINDS].sort()).toEqual([
      'branch',
      'emit',
      'generate',
      'map',
      'parallel',
      'reduce',
      'retrieve',
      'tool',
    ]);
    expect([...DEFERRED_STEP_KINDS].sort()).toEqual([
      'agent',
      'assert',
      'guard',
      'human',
      'rerank',
    ]);
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
    // No single fixture can carry all fourteen: four sections require spec 0.2 and the
    // v0.1 fixture is the byte-identical baseline this layer must leave alone. The union
    // is the assertion, so a supported section that no valid fixture carries fails here.
    const v01 = checkSpecText(readFixture('valid/full.spec.yaml')).value as Record<string, unknown>;
    const v02 = checkSpecText(readFixture('valid/v02-sections.spec.yaml')).value as Record<
      string,
      unknown
    >;
    const carried = new Set([...Object.keys(v01), ...Object.keys(v02)]);
    expect([...carried].sort()).toEqual([...SUPPORTED_SECTIONS].sort());

    // The split is exactly the version boundary, so nothing was silently promoted by
    // being added to SUPPORTED_SECTIONS without a minimum version.
    expect(Object.keys(v01).sort()).toEqual(
      [...SUPPORTED_SECTIONS].filter((section) => !(section in SECTION_MIN_VERSION)).sort(),
    );
    expect(Object.keys(v02).sort()).toEqual([...SUPPORTED_SECTIONS].sort());
  });
});

/**
 * One assertion per invalid fixture, each shaped to contain exactly one problem.
 * Iterating the directory means a new fixture with no expectation fails rather
 * than being skipped.
 */
const EXPECTED: Record<string, { code: string; path: PathSegment[] }> = {
  'section-below-version.spec.yaml': { code: DIAGNOSTIC_CODES.notSupported, path: ['agents'] },
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
  'model-cache-below-version.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['models', 'cached', 'cache'],
  },
  'retriever-filters.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['retrievers', 'knowledge', 'filters'],
  },
  'retriever-incremental-refresh.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['retrievers', 'knowledge', 'refresh', 'mode'],
  },
  'retriever-refresh-schedule.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['retrievers', 'knowledge', 'refresh', 'schedule'],
  },
  'retriever-semantic-chunking.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['retrievers', 'knowledge', 'chunking', 'strategy'],
  },
  'retriever-source-remote.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['retrievers', 'knowledge', 'source', 'kind'],
  },
  'retriever-without-store.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['retrievers', 'knowledge', 'store'],
  },
  'step-with-two-kinds.spec.yaml': {
    code: DIAGNOSTIC_CODES.unsupportedStep,
    path: ['pipelines', 'probe', 'steps', 0],
  },
  'store-literal-dsn.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['stores', 'docs', 'uri'],
  },
  'store-memory-with-uri.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['stores', 'docs'],
  },
  'store-pgvector-without-uri.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['stores', 'docs', 'uri'],
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

  it('never reports both a version rule and a schema error for the same path', () => {
    // The fixture's `agents` content is schema-valid at 0.2; only the declared version
    // is wrong. The scope rule claims the path and the schema pass is suppressed
    // underneath it, so the reader gets one diagnostic rather than a pile of noise.
    const result = checkSpecText(readFixture('invalid/section-below-version.spec.yaml'));
    expect(result.diagnostics).toHaveLength(1);
    // The message names the section and the version it needs.
    expect(result.diagnostics[0]?.message).toContain("'agents'");
    expect(result.diagnostics[0]?.message).toContain('requires specVersion 0.2');
    expect(result.diagnostics[0]?.hint).toContain('set specVersion: "0.2"');
  });

  it('points a section below its version at its own line', () => {
    const text = readFixture('invalid/section-below-version.spec.yaml');
    const result = checkSpecText(text, { file: 'section-below-version.spec.yaml' });
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

  it('tells the reader which version a section needs', () => {
    const [diagnostic] = validateSpec({
      specVersion: '0.1',
      project: { name: 'p' },
      memory: {},
    });
    expect(diagnostic?.message).toContain("'memory' requires specVersion 0.2");
    expect(diagnostic?.hint).toContain('set specVersion: "0.2"');
  });

  it('refuses a model cache below spec 0.3 and names the version it needs', () => {
    const diagnostics = validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      models: {
        cached: { provider: 'fake', modelId: 'fake-deterministic-1', cache: { prompt: true } },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.notSupported]);
    expect(paths(diagnostics)).toEqual(['models.cached.cache']);
    expect(diagnostics[0]?.message).toContain("'models.cached.cache' requires specVersion 0.3");
    expect(diagnostics[0]?.hint).toContain(`set specVersion: "${MODEL_CACHE_MIN_VERSION}"`);
  });

  it('accepts a model cache from spec 0.3, with a semantic threshold and TTL', () => {
    const diagnostics = validateSpec({
      specVersion: '0.3',
      project: { name: 'p' },
      models: {
        cached: {
          provider: 'fake',
          modelId: 'fake-deterministic-1',
          cache: { prompt: true, semantic: { threshold: 0.9, ttlSeconds: 3600 } },
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it('refuses a semantic cache that omits its explicit threshold or TTL', () => {
    const diagnostics = validateSpec({
      specVersion: '0.3',
      project: { name: 'p' },
      models: {
        cached: {
          provider: 'fake',
          modelId: 'fake-deterministic-1',
          cache: { semantic: { threshold: 0.9 } },
        },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['models.cached.cache.semantic.ttlSeconds']);
  });

  it('leaves a v0.1 document that declares no cache byte-identical in its verdict', () => {
    const diagnostics = validateSpec({
      specVersion: '0.1',
      project: { name: 'p' },
      models: { m: { provider: 'fake', modelId: 'fake-deterministic-1' } },
    });
    expect(diagnostics).toEqual([]);
  });

  it('lists the supported vocabulary when the key is simply misspelled', () => {
    // The counterpart to the version rule: a key the DSL does not know at any version
    // still gets the full list of what it does know, so the two failures read
    // differently instead of both saying "no".
    const [diagnostic] = validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      memroy: {},
    });
    expect(diagnostic?.message).toContain("'memroy'");
    expect(diagnostic?.hint).toContain(SUPPORTED_SECTIONS.join(', '));
  });

  it('refuses a key inside a promoted section instead of passing it through', () => {
    // Closed vocabulary is the whole point of promoting these sections: an unknown
    // agent key is a spec the generator would have to ignore, so it is rejected here.
    const diagnostics = validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      agents: {
        support: { instructions: 'p', model: 'm', maxSteps: 1, persona: 'unbounded' },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['agents.support.persona']);
  });

  it('refuses a guardrail policy outside the closed vocabulary', () => {
    const diagnostics = validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      guardrails: {
        inbound: {
          stages: ['input'],
          policies: ['vibes'],
          action: 'block',
          onFail: { message: 'nope', log: true },
        },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['guardrails.inbound.policies[0]']);
  });

  it('refuses a memory scope outside the three the runtime can honour', () => {
    const diagnostics = validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      memory: { conversation: { kind: 'window', scope: 'organisation', tokenBudget: 512 } },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['memory.conversation.scope']);
  });

  it('accepts deployment streaming here, leaving the gate to refuse the build', () => {
    // The staging in one assertion: the spec layer recognizes the intent, and
    // `deploy/streaming` is the gate that fails closed because no runtime streams yet.
    const diagnostics = validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      deployments: { prod: { target: 'container', streaming: true, secrets: [] } },
    });
    expect(diagnostics).toEqual([]);
  });

  it('accepts a deepagents engine here, leaving the orchestration gate to refuse it', () => {
    const diagnostics = validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      agents: {
        support: {
          instructions: 'p',
          model: 'm',
          maxSteps: 1,
          engine: 'deepagents',
          engineVersion: '0.0.1',
        },
      },
    });
    expect(diagnostics).toEqual([]);
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
