import { describe, expect, it } from 'vitest';
import {
  checkSpecText,
  DEFERRED_SECTIONS,
  DEFERRED_STEP_KINDS,
  DEPLOYMENT_IMAGE_MIN_VERSION,
  DIAGNOSTIC_CODES,
  type Diagnostic,
  formatPath,
  GEMINI_PROVIDER_MIN_VERSION,
  GOOGLE_PROVIDER_MIN_VERSION,
  MODEL_CACHE_MIN_VERSION,
  type PathSegment,
  RETIRED_STEP_KINDS,
  SECTION_MIN_VERSION,
  SPEC_VERSION,
  SPEC_VERSION_LATEST,
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

  it('names the newest supported version, so docs cannot claim an older language', () => {
    // The homepage and `/features` state this number. It was `0.6` while the build read
    // through `0.8`, which made the site describe a language two versions behind the one
    // `aid validate` accepts.
    expect(SPEC_VERSION_LATEST).toBe(SUPPORTED_SPEC_VERSIONS[SUPPORTED_SPEC_VERSIONS.length - 1]);
  });

  it('lists the fifteen supported sections, five of which need a later version', () => {
    expect([...SUPPORTED_SECTIONS].sort()).toEqual([
      'agents',
      'decisions',
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
    // The version boundary, named explicitly: four sections are supported from 0.2 and
    // `decisions` from 0.6. A section that gains a minimum version without appearing
    // here would be enforced by the schema and quietly refused by the scope rule.
    expect(Object.keys(SECTION_MIN_VERSION).sort()).toEqual([
      'agents',
      'decisions',
      'deployments',
      'guardrails',
      'memory',
    ]);
    expect(Object.values(SECTION_MIN_VERSION)).toEqual(['0.2', '0.2', '0.2', '0.2', '0.6']);
  });

  it('keeps the supported, deferred and retired step kinds pairwise disjoint', () => {
    const retired = Object.keys(RETIRED_STEP_KINDS);
    const overlap = SUPPORTED_STEP_KINDS.filter(
      (kind) => (DEFERRED_STEP_KINDS as readonly string[]).includes(kind) || retired.includes(kind),
    );
    expect(overlap).toEqual([]);
    expect([...SUPPORTED_STEP_KINDS].sort()).toEqual([
      'agent',
      'branch',
      'emit',
      'generate',
      'guard',
      'map',
      'parallel',
      'reduce',
      'rerank',
      'retrieve',
      'route',
      'tool',
    ]);
    // The phase-exit criterion itself: nothing is pending. L7b gave the last entry,
    // `assert`, real semantics in the eval layer, so re-adding any kind here -- and
    // `assert` specifically, which now has a metric arm -- is a regression, not a
    // no-op. A retired kind belongs in `RETIRED_STEP_KINDS` instead.
    expect([...DEFERRED_STEP_KINDS]).toEqual([]);
    expect(retired.sort()).toEqual(['human']);
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
    // No single fixture carries every section: four require spec 0.2, `decisions` needs
    // 0.6, and the v0.1 fixture is the byte-identical baseline this layer must leave
    // alone. The union is the assertion, so a supported section that no valid fixture
    // carries fails here.
    const fixtureNames = [
      'valid/full.spec.yaml',
      'valid/v02-sections.spec.yaml',
      'valid/v06-decisions.spec.yaml',
    ] as const;
    const documents = fixtureNames.map(
      (name) => checkSpecText(readFixture(name)).value as Record<string, unknown>,
    );
    const [v01, v02, v06] = documents as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const carried = new Set(documents.flatMap((document) => Object.keys(document)));
    expect([...carried].sort()).toEqual([...SUPPORTED_SECTIONS].sort());

    // The split is exactly the version boundary, so nothing was silently promoted by
    // being added to SUPPORTED_SECTIONS without a minimum version.
    expect(Object.keys(v01).sort()).toEqual(
      [...SUPPORTED_SECTIONS].filter((section) => !(section in SECTION_MIN_VERSION)).sort(),
    );
    expect(Object.keys(v02).sort()).toEqual(
      [...SUPPORTED_SECTIONS].filter((section) => section !== 'decisions').sort(),
    );
    expect(Object.keys(v06).sort()).toEqual(['decisions', 'project', 'specVersion']);
  });
});

/**
 * One assertion per invalid fixture, each shaped to contain exactly one problem.
 * Iterating the directory means a new fixture with no expectation fails rather
 * than being skipped.
 */
const EXPECTED: Record<string, { code: string; path: PathSegment[] }> = {
  'section-below-version.spec.yaml': { code: DIAGNOSTIC_CODES.notSupported, path: ['agents'] },
  'assert-metric-no-floor.spec.yaml': {
    code: DIAGNOSTIC_CODES.metricAssertNeedsFloor,
    path: ['evals', 'answer_shape', 'gate'],
  },
  'assert-metric-duplicate.spec.yaml': {
    code: DIAGNOSTIC_CODES.metricAssertDuplicate,
    path: ['evals', 'answer_shape', 'metrics', 1],
  },
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
  'guardrail-decision-below-version.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['guardrails', 'gate', 'decision'],
  },
  'guardrail-decision-undeclared.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['guardrails', 'gate', 'decision'],
  },
  'guardrail-decision-not-choice.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['guardrails', 'gate', 'decision'],
  },
  'guardrail-decision-noul-confidence.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['guardrails', 'gate', 'minConfidence'],
  },
  'guardrail-decision-missing-label.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['guardrails', 'gate', 'onDecision'],
  },
  'guardrail-decision-extra-label.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['guardrails', 'gate', 'onDecision', 'sale'],
  },
  'guardrail-decision-no-source.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['guardrails', 'gate'],
  },
  'guardrail-decision-stray-map.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['guardrails', 'gate', 'onDecision'],
  },
  'llm-judge-in-ci.spec.yaml': {
    code: DIAGNOSTIC_CODES.metricUnavailableInCi,
    path: ['evals', 'quality', 'metrics', 0],
  },
  'decision-metric-below-version.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['evals', 'quality', 'metrics', 1],
  },
  'decision-metric-unknown.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['evals', 'quality', 'metrics', 1],
  },
  'decision-metric-not-score.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['evals', 'quality', 'metrics', 1],
  },
  'decision-metric-moving-alias.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['decisions', 'helpfulness', 'model'],
  },
  'decision-metric-in-ci.spec.yaml': {
    code: DIAGNOSTIC_CODES.metricUnavailableInCi,
    path: ['evals', 'quality', 'metrics', 1],
  },
  'decision-metric-two.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['evals', 'quality', 'metrics', 2],
  },
  'malformed-template.spec.yaml': {
    code: DIAGNOSTIC_CODES.malformedTemplate,
    path: ['prompts', 'classify', 'template'],
  },
  'retired-step.spec.yaml': {
    code: DIAGNOSTIC_CODES.unsupportedStep,
    path: ['pipelines', 'probe', 'steps', 0],
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
  'route-below-version.spec.yaml': {
    code: DIAGNOSTIC_CODES.notSupported,
    path: ['pipelines', 'handle', 'steps', 0],
  },
  'route-dead-default.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['pipelines', 'handle', 'steps', 0, 'route', 'default'],
  },
  'route-decision-not-choice.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['pipelines', 'handle', 'steps', 0, 'route', 'decision'],
  },
  'route-decision-undeclared.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['pipelines', 'handle', 'steps', 0, 'route', 'decision'],
  },
  'route-on-unknown-label.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['pipelines', 'handle', 'steps', 0, 'route', 'on', 'refunds'],
  },
  'route-unmapped-label.spec.yaml': {
    code: DIAGNOSTIC_CODES.schemaViolation,
    path: ['pipelines', 'handle', 'steps', 0, 'route'],
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

describe('retired step kinds', () => {
  it('names the replacement spelling for a retired step', () => {
    const result = checkSpecText(readFixture('invalid/retired-step.spec.yaml'));
    expect(codes(result.diagnostics)).toEqual([DIAGNOSTIC_CODES.unsupportedStep]);
    // Falsifiable: delete the retired-kind branch and this falls through to the generic
    // "exactly one of ..." error, whose hint never names the replacement.
    expect(result.diagnostics[0]?.message).toContain('retired');
    expect(result.diagnostics[0]?.hint).toContain('agent.humanInTheLoop');
    expect(result.diagnostics[0]?.hint).toContain('agents[].humanInTheLoop');
  });

  it('does not confuse an eval-only kind with a retired one', () => {
    // `assert` is a metric kind, never a pipeline step. The document is still refused,
    // now by the generic "exactly one of ..." path, which is the branch that carries no
    // replacement hint -- so this pins the absence of a `hint` as well as the message.
    // Falsifiable: drop the step-level kind check and the schema's closed `oneOf` arm
    // rejects the same document, but with a hint-free schema error instead of this
    // message, so the message assertion is what keeps the two apart.
    const result = checkSpecText(readFixture('invalid/deferred-step.spec.yaml'));
    expect(codes(result.diagnostics)).toEqual([DIAGNOSTIC_CODES.unsupportedStep]);
    expect(result.diagnostics[0]?.message).toContain('step must contain exactly one of');
    expect(result.diagnostics[0]?.hint).toBeUndefined();
  });

  it('validates an agent that declares the replacement pause', () => {
    const diagnostics = validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      agents: {
        refund: {
          instructions: 'p',
          model: 'm',
          maxSteps: 1,
          humanInTheLoop: { when: 'true', channel: 'refunds' },
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });
});

describe('assert metric', () => {
  it('accepts an assert metric that declares the floor it needs', () => {
    const result = checkSpecText(readFixture('valid/assert-metric.spec.yaml'));
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses an assert metric without `gate.minMean: 1`', () => {
    const result = checkSpecText(readFixture('invalid/assert-metric-no-floor.spec.yaml'));
    expect(codes(result.diagnostics)).toEqual([DIAGNOSTIC_CODES.metricAssertNeedsFloor]);
    // The message says why, because the fix is not obvious: the regression allowance
    // is the reason the floor is mandatory for a 0/1 metric.
    expect(result.diagnostics[0]?.message).toContain('minMean: 1');
    expect(result.diagnostics[0]?.hint).toContain('maxRegression');
  });

  it('refuses a second assert metric in the same eval', () => {
    const result = checkSpecText(readFixture('invalid/assert-metric-duplicate.spec.yaml'));
    expect(codes(result.diagnostics)).toEqual([DIAGNOSTIC_CODES.metricAssertDuplicate]);
    expect(result.diagnostics[0]?.message).toContain('at most one');
  });

  it('does not require a floor for an eval without an assert metric', () => {
    // The rule is scoped to the metric, not to evals: a regression-based metric keeps
    // working with no floor at all, which is what every pre-L7b eval looks like.
    expect(
      validateSpec({
        specVersion: '0.1',
        project: { name: 'p' },
        evals: {
          q: {
            target: 'pipeline:p',
            dataset: { source: 'file', uri: 'e.jsonl' },
            metrics: [{ kind: 'exact', field: 'text' }],
            gate: { ci: true },
          },
        },
      }),
    ).toEqual([]);
  });

  it('rejects the step spelling as well as the metric spelling', () => {
    // One construct, one spelling: the metric arm exists, the step arm must not.
    const result = checkSpecText(readFixture('invalid/deferred-step.spec.yaml'));
    expect(codes(result.diagnostics)).toEqual([DIAGNOSTIC_CODES.unsupportedStep]);
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

describe('model capabilities', () => {
  // The IR narrows these strings to the model vocabulary, so this enum is the only
  // place an unknown capability is caught. It is closed to the four DSL spellings, and
  // all four survive the mapping into that vocabulary (`tools` becomes `tool-calling`),
  // so the IR's filter is unreachable from validated spec text.
  const SPELLINGS = ['json-schema', 'tools', 'streaming', 'embeddings'];

  function capabilitiesDiagnostics(capabilities: unknown[]): readonly Diagnostic[] {
    return validateSpec({
      specVersion: '0.2',
      project: { name: 'p' },
      models: { m: { provider: 'fake', modelId: 'fake-1', capabilities } },
    });
  }

  it.each(SPELLINGS)('admits the %s spelling', (capability) => {
    expect(capabilitiesDiagnostics([capability])).toEqual([]);
  });

  it('refuses a capability outside the enum, naming every spelling it admits', () => {
    const diagnostics = capabilitiesDiagnostics(['hologram']);

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['models.m.capabilities[0]']);
    expect(diagnostics[0]?.message).toContain('must be one of');
    for (const spelling of SPELLINGS) {
      expect(diagnostics[0]?.message).toContain(`"${spelling}"`);
    }
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

  it('refuses the google provider below spec 0.6 and names the version it needs', () => {
    const diagnostics = validateSpec({
      specVersion: '0.5',
      project: { name: 'p' },
      models: { gemini: { provider: 'google', modelId: 'gemini-2.5-flash' } },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.notSupported]);
    expect(paths(diagnostics)).toEqual(['models.gemini.provider']);
    expect(diagnostics[0]?.message).toContain(
      "'models.gemini.provider: google' requires specVersion 0.6",
    );
    expect(diagnostics[0]?.hint).toContain(`set specVersion: "${GOOGLE_PROVIDER_MIN_VERSION}"`);
  });

  it('accepts the google provider from spec 0.6', () => {
    const diagnostics = validateSpec({
      specVersion: '0.6',
      project: { name: 'p' },
      models: { gemini: { provider: 'google', modelId: 'gemini-2.5-flash' } },
    });
    expect(diagnostics).toEqual([]);
  });

  it('refuses the gemini provider below spec 0.10 and names the version it needs', () => {
    const diagnostics = validateSpec({
      specVersion: '0.9',
      project: { name: 'p' },
      models: {
        flash: { provider: 'gemini', modelId: 'gemini-2.5-flash', apiKeyEnv: 'GEMINI_API_KEY' },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.notSupported]);
    expect(paths(diagnostics)).toEqual(['models.flash.provider']);
    expect(diagnostics[0]?.message).toContain(
      "'models.flash.provider: gemini' requires specVersion 0.10",
    );
    expect(diagnostics[0]?.hint).toContain(`set specVersion: "${GEMINI_PROVIDER_MIN_VERSION}"`);
  });

  it('accepts the gemini provider from spec 0.10', () => {
    const diagnostics = validateSpec({
      specVersion: '0.10',
      project: { name: 'p' },
      models: {
        flash: { provider: 'gemini', modelId: 'gemini-2.5-flash', apiKeyEnv: 'GEMINI_API_KEY' },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it('requires an api key variable for gemini, which has no ambient credential', () => {
    const diagnostics = validateSpec({
      specVersion: '0.10',
      project: { name: 'p' },
      models: { flash: { provider: 'gemini', modelId: 'gemini-2.5-flash' } },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['models.flash.apiKeyEnv']);
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

  it('accepts a managed guardrail at 0.11, with its policy under heading bedrock', () => {
    const diagnostics = validateSpec({
      specVersion: '0.11',
      project: { name: 'p' },
      guardrails: {
        inbound: {
          engine: 'bedrock',
          stages: ['input', 'output'],
          action: 'block',
          bedrock: {
            content: { 'prompt-attack': 'high', hate: 'medium' },
            pii: ['email', 'credit-card'],
          },
          onFail: { message: 'nope', log: true },
        },
      },
    });
    expect(diagnostics).toEqual([]);
  });

  it('refuses a managed policy below 0.11 rather than silently ignoring it', () => {
    const diagnostics = validateSpec({
      specVersion: '0.10',
      project: { name: 'p' },
      guardrails: {
        inbound: {
          engine: 'bedrock',
          stages: ['input'],
          action: 'block',
          bedrock: { pii: ['email'] },
          onFail: { message: 'nope', log: true },
        },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.notSupported]);
    expect(paths(diagnostics)).toEqual(['guardrails.inbound.engine']);
  });

  it('refuses local policies on a guardrail the managed service evaluates', () => {
    const diagnostics = validateSpec({
      specVersion: '0.11',
      project: { name: 'p' },
      guardrails: {
        inbound: {
          engine: 'bedrock',
          stages: ['input'],
          policies: ['prompt-injection'],
          action: 'block',
          bedrock: { pii: ['email'] },
          onFail: { message: 'nope', log: true },
        },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['guardrails.inbound']);
  });

  it('refuses a managed policy block on a builtin guardrail', () => {
    const diagnostics = validateSpec({
      specVersion: '0.11',
      project: { name: 'p' },
      guardrails: {
        inbound: {
          stages: ['input'],
          policies: ['prompt-injection'],
          action: 'block',
          bedrock: { pii: ['email'] },
          onFail: { message: 'nope', log: true },
        },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['guardrails.inbound.engine']);
  });

  it('refuses redaction that also blocks a content category', () => {
    const diagnostics = validateSpec({
      specVersion: '0.11',
      project: { name: 'p' },
      guardrails: {
        inbound: {
          engine: 'bedrock',
          stages: ['input'],
          action: 'redact',
          bedrock: { content: { hate: 'low' }, pii: ['email'] },
          onFail: { message: 'nope', log: true },
        },
      },
    });
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['guardrails.inbound.action']);
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

describe('deployments', () => {
  /** A deployment the schema admits, so each test varies exactly one field. */
  const spec = (extra: Record<string, unknown> = {}) => ({
    specVersion: '0.2',
    project: { name: 'p' },
    deployments: { prod: { target: 'container', secrets: [], ...extra } },
  });

  /** A container deployment at a named version, so version-gated fields stay testable. */
  const at = (specVersion: string, extra: Record<string, unknown> = {}) => ({
    specVersion,
    project: { name: 'p' },
    deployments: { prod: { target: 'container', secrets: [], ...extra } },
  });

  it('accepts a scaling range whose floor sits at its ceiling', () => {
    const diagnostics = validateSpec(spec({ autoscale: { min: 2, max: 2, metric: 'cpu' } }));
    expect(diagnostics).toEqual([]);
  });

  it('refuses a scaling range whose floor sits above its ceiling', () => {
    const diagnostics = validateSpec(spec({ autoscale: { min: 10, max: 1, metric: 'cpu' } }));
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.deploymentAutoscaleRange]);
    expect(paths(diagnostics)).toEqual(['deployments.prod.autoscale']);
  });

  it('accepts one env entry per distinct name', () => {
    const diagnostics = validateSpec(
      spec({
        env: [
          { name: 'A', value: '1' },
          { name: 'B', value: '2' },
        ],
      }),
    );
    expect(diagnostics).toEqual([]);
  });

  it('refuses two env entries sharing a name, naming the second', () => {
    const diagnostics = validateSpec(
      spec({
        env: [
          { name: 'A', value: '1' },
          { name: 'A', value: '2' },
        ],
      }),
    );
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.deploymentEnvDuplicate]);
    expect(paths(diagnostics)).toEqual(['deployments.prod.env[1]']);
  });

  it('refuses an env entry that is both a literal and a secret reference', () => {
    const diagnostics = validateSpec(spec({ env: [{ name: 'TOKEN', value: 'x', secret: true }] }));
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.deploymentEnvValueAndSecret]);
    expect(paths(diagnostics)).toEqual(['deployments.prod.env[0]']);
  });

  it('accepts a secret entry that carries no literal value', () => {
    const diagnostics = validateSpec(spec({ env: [{ name: 'TOKEN', secret: true }] }));
    expect(diagnostics).toEqual([]);
  });

  it('accepts an image on a 0.4 container deployment', () => {
    const diagnostics = validateSpec(
      at('0.4', { image: { registry: 'ghcr.io', name: 'acme/support-copilot' } }),
    );
    expect(diagnostics).toEqual([]);
  });

  it('refuses an image below spec 0.4 and names the version it needs', () => {
    const diagnostics = validateSpec(at('0.3', { image: { registry: 'ghcr.io', name: 'acme/p' } }));
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.notSupported]);
    expect(paths(diagnostics)).toEqual(['deployments.prod.image']);
    expect(diagnostics[0]?.message).toContain("'deployments.prod.image' requires specVersion 0.4");
    expect(diagnostics[0]?.hint).toContain(`set specVersion: "${DEPLOYMENT_IMAGE_MIN_VERSION}"`);
  });

  it('refuses an image on a deployment whose target builds no image', () => {
    const diagnostics = validateSpec(
      at('0.4', { target: 'serverless', image: { registry: 'ghcr.io', name: 'acme/p' } }),
    );
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.deploymentImageWithoutContainer]);
    expect(paths(diagnostics)).toEqual(['deployments.prod.image']);
    expect(diagnostics[0]?.message).toContain("targets 'serverless'");
  });

  it('refuses an image name a registry would reject', () => {
    const diagnostics = validateSpec(at('0.4', { image: { registry: 'ghcr.io', name: 'Acme/P' } }));
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['deployments.prod.image.name']);
  });

  it('refuses a registry it cannot push to', () => {
    const diagnostics = validateSpec(
      at('0.4', { image: { registry: 'docker.io', name: 'acme/p' } }),
    );
    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['deployments.prod.image.registry']);
  });
});

/**
 * The batch surface: `trigger.manual` and `deployments[].pipeline`, which only make sense
 * together and only from spec 0.5.
 *
 * The two version cases are separate from the four shape cases because they are the
 * boundary the feature ships behind: a 0.4 document must hear "0.5" and not a
 * contradiction it has no way to fix. The schema cases pin the closure -- `manual` has one
 * legal value and a trigger names one kind -- because a trigger that meant both would have
 * two routes and one deployment.
 */
describe('the batch surface', () => {
  /** A document with one model and one prompt, so a pipeline can have a real step list. */
  function doc(
    specVersion: string,
    pipelines: Record<string, unknown>,
    deployments: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      specVersion,
      project: { name: 'jobs', namespace: 'aid.test.jobs', targets: ['py-fastapi'] },
      types: {
        Reply: { kind: 'struct', fields: { summary: { type: 'string', required: true } } },
      },
      models: {
        fast: { provider: 'fake', modelId: 'fake-deterministic-1', capabilities: ['json-schema'] },
      },
      prompts: {
        draft: {
          version: 1,
          model: 'fast',
          template: 'Summarise this ticket: {{ subject }}',
          variables: { subject: { type: 'string', required: true } },
          output: { kind: 'structured', schema: 'Reply' },
        },
      },
      pipelines,
      deployments,
    };
  }

  const STEPS = [
    { generate: { prompt: 'draft', input: { subject: '{{ event.subject }}' }, as: 'answer' } },
    { emit: { event: 'Reply' } },
  ];
  const MANUAL = { trigger: { manual: true }, steps: STEPS };
  const HTTP = { trigger: { http: { method: 'post', path: '/jobs/run' } }, steps: STEPS };
  const container = { target: 'container', secrets: [] };
  const batch = { target: 'batch', pipeline: 'brief', secrets: [] };

  it('accepts a manual pipeline run by a batch deployment', () => {
    expect(validateSpec(doc('0.5', { brief: MANUAL }, { nightly: batch }))).toEqual([]);
  });

  it('accepts an http pipeline and a route-serving deployment, unchanged', () => {
    expect(validateSpec(doc('0.5', { brief: HTTP }, { api: container }))).toEqual([]);
  });

  it('tells a 0.4 document to move to 0.5 before it uses the manual trigger', () => {
    const diagnostics = validateSpec(doc('0.4', { brief: MANUAL }, { api: container }));

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.notSupported]);
    expect(paths(diagnostics)).toEqual(['pipelines.brief.trigger.manual']);
    expect(diagnostics[0]?.message).toContain(
      "'pipelines.brief.trigger.manual' requires specVersion 0.5",
    );
    expect(diagnostics[0]?.hint).toContain('a document with no manual pipeline is unchanged');
  });

  it('tells a 0.4 document to move to 0.5 before it binds a job', () => {
    const diagnostics = validateSpec(doc('0.4', { brief: HTTP }, { nightly: batch }));

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.notSupported]);
    expect(paths(diagnostics)).toEqual(['deployments.nightly.pipeline']);
    expect(diagnostics[0]?.message).toContain(
      "'deployments.nightly.pipeline' requires specVersion 0.5",
    );
    expect(diagnostics[0]?.hint).toContain('a document that binds no job is unchanged');
  });

  it('refuses a pipeline on a deployment that serves routes', () => {
    const diagnostics = validateSpec(
      doc('0.5', { brief: MANUAL }, { api: { ...container, pipeline: 'brief' } }),
    );

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.deploymentPipelineWithoutBatch]);
    expect(paths(diagnostics)).toEqual(['deployments.api.pipeline']);
    expect(diagnostics[0]?.message).toContain("targets 'container'");
    expect(diagnostics[0]?.hint).toContain('a route is selected by the request');
  });

  it('refuses a batch deployment that names no pipeline', () => {
    const diagnostics = validateSpec(
      doc('0.5', { brief: MANUAL }, { nightly: { target: 'batch', secrets: [] } }),
    );

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.batchDeploymentWithoutPipeline]);
    expect(paths(diagnostics)).toEqual(['deployments.nightly']);
    expect(diagnostics[0]?.message).toContain('the job would run nothing');
  });

  it('refuses a batch deployment naming a pipeline the document lacks', () => {
    const diagnostics = validateSpec(
      doc('0.5', { brief: MANUAL }, { nightly: { ...batch, pipeline: 'digest' } }),
    );

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.batchPipelineUnknown]);
    expect(paths(diagnostics)).toEqual(['deployments.nightly.pipeline']);
    expect(diagnostics[0]?.hint).toContain('declare `pipelines.digest`');
    expect(diagnostics[0]?.hint).toContain('brief');
  });

  it('refuses to run a pipeline that also declares a route', () => {
    const diagnostics = validateSpec(doc('0.5', { brief: HTTP }, { nightly: batch }));

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.batchPipelineNotManual]);
    expect(paths(diagnostics)).toEqual(['deployments.nightly.pipeline']);
    expect(diagnostics[0]?.hint).toContain("set `trigger: { manual: true }` on 'brief'");
  });

  it('closes trigger.manual to the literal true', () => {
    const diagnostics = validateSpec(
      doc('0.5', { brief: { trigger: { manual: false }, steps: STEPS } }, { nightly: batch }),
    );

    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
    expect(paths(diagnostics)).toContain('pipelines.brief.trigger.manual');
  });

  it('refuses a trigger that is both http and manual', () => {
    const diagnostics = validateSpec(
      doc(
        '0.5',
        { brief: { trigger: { ...HTTP.trigger, manual: true }, steps: STEPS } },
        { nightly: batch },
      ),
    );

    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
    expect(paths(diagnostics)).toContain('pipelines.brief.trigger');
  });
});

describe('the decisions section', () => {
  function doc(decisions: Record<string, unknown>, specVersion = '0.6'): Record<string, unknown> {
    return { specVersion, project: { name: 'gate' }, decisions };
  }

  const choice = {
    provider: 'typesafe',
    model: 'jev-1.14.0',
    type: 'choice',
    instructions: 'Which queue should handle this ticket',
    criteria: { billing: 'Money movement', technical: 'A bug report' },
  };
  const score = {
    provider: 'typesafe',
    model: 'jev-1.14.0',
    type: 'score',
    instructions: 'How urgent is this ticket',
    criteria: ['low', 'medium', 'high'],
  };
  const noul = {
    provider: 'typesafe',
    model: 'jev-1.14.0',
    type: 'noul',
    instructions: 'The message conveys urgency',
  };

  it('accepts all three question shapes', () => {
    expect(validateSpec(doc({ triage: choice, urgency: score, is_urgent: noul }))).toEqual([]);
  });

  it('accepts a declared failure posture and a description', () => {
    expect(
      validateSpec(doc({ is_urgent: { ...noul, onError: 'allow', description: 'Advisory only' } })),
    ).toEqual([]);
  });

  it('tells a 0.5 document to move to 0.6 before it declares a decision', () => {
    const diagnostics = validateSpec(doc({ triage: choice }, '0.5'));

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.notSupported]);
    expect(paths(diagnostics)).toEqual(['decisions']);
    expect(diagnostics[0]?.message).toContain("'decisions' requires specVersion 0.6");
  });

  it('closes the provider to typesafe, the only one the runtime serves', () => {
    const diagnostics = validateSpec(doc({ triage: { ...choice, provider: 'jev' } }));

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['decisions.triage.provider']);
  });

  it('refuses criteria on a noul question, which has nothing to choose between', () => {
    const diagnostics = validateSpec(doc({ is_urgent: { ...noul, criteria: ['urgent'] } }));

    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
    expect(paths(diagnostics)).toContain('decisions.is_urgent');
  });

  it('refuses a choice question without criteria', () => {
    const withoutCriteria: Record<string, unknown> = { ...choice };
    delete withoutCriteria.criteria;
    const diagnostics = validateSpec(doc({ triage: withoutCriteria }));

    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
    expect(paths(diagnostics)).toContain('decisions.triage.criteria');
  });

  it('refuses a choice whose criteria are an ordered list rather than a label map', () => {
    const diagnostics = validateSpec(
      doc({ triage: { ...choice, criteria: ['billing', 'technical'] } }),
    );

    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
    expect(paths(diagnostics)).toContain('decisions.triage.criteria');
  });

  it('refuses a score question with fewer than two levels', () => {
    const diagnostics = validateSpec(doc({ urgency: { ...score, criteria: ['high'] } }));

    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
    expect(paths(diagnostics)).toContain('decisions.urgency.criteria');
  });

  it('refuses a score question with more than ten levels', () => {
    const diagnostics = validateSpec(
      doc({ urgency: { ...score, criteria: Array.from({ length: 11 }, (_, i) => `level-${i}`) } }),
    );

    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
    expect(paths(diagnostics)).toContain('decisions.urgency.criteria');
  });

  it('refuses a blank instruction, which is not a question', () => {
    const diagnostics = validateSpec(doc({ is_urgent: { ...noul, instructions: '' } }));

    expect(codes(diagnostics)).toEqual([DIAGNOSTIC_CODES.schemaViolation]);
    expect(paths(diagnostics)).toEqual(['decisions.is_urgent.instructions']);
  });

  it('keeps a moving alias legal here; only an eval reference refuses one', () => {
    // The refusal belongs at the reference site (`evals[].scorer`), not in the
    // declaration: interactive routing may deliberately want the newest Jev.
    expect(validateSpec(doc({ triage: { ...choice, model: 'jev-latest' } }))).toEqual([]);
  });
});

/** Renders the message alone, so a failure diff stays readable. */
function formatDiagnosticLine(diagnostic: Diagnostic): string {
  return `${formatPath(diagnostic.path)}:${diagnostic.code}: ${diagnostic.message}`;
}
