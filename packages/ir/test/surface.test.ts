import { SPEC_VERSION, SUPPORTED_SECTIONS } from '@aid/spec';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_VERSION,
  catalogCostProfile,
  catalogCostProfiles,
  catalogModel,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_OBSERVABILITY,
  DEFAULT_RUNTIME,
  DEFAULT_TARGET,
  deriveRequiredCapabilities,
  EVAL_TARGET_KINDS,
  GATES,
  IR_COLLECTIONS,
  IR_DIAGNOSTIC_CODES,
  IR_ONLY_COLLECTIONS,
  IR_VERSION,
  irError,
  irWarning,
  isModelCapability,
  isProvider,
  isRequiredCapability,
  MODEL_CAPABILITIES,
  modelIdentity,
  NON_COLLECTION_SECTIONS,
  offsetPosition,
  PHASE_0_PROVIDERS,
  PHASE_0_TARGET_CAPABILITIES,
  POPULATED_COLLECTION_BY_SECTION,
  PRIMITIVE_TYPES,
  PROVIDERS,
  phase0TargetCapabilities,
  pipelineIdentity,
  promptIdentity,
  REQUIRED_CAPABILITIES,
  reporter,
  resolveRequiredCapability,
  runGates,
  SPEC_MODEL_CAPABILITY_MAP,
  TARGET_CAPABILITY_ALIASES,
  toolIdentity,
  withPosition,
} from '../src/index.js';
import { buildFixture, codesOf, gateFixture } from './helpers.js';

const ir = buildFixture('full.yaml').ir;

describe('ir/* diagnostics', () => {
  it('names every code ir/<slug>, distinct from the spec namespace', () => {
    const codes = Object.values(IR_DIAGNOSTIC_CODES);
    expect(codes.length).toBe(37);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^ir\/[a-z0-9-]+$/);
      expect(code.startsWith('spec/')).toBe(false);
    }
  });

  it('builds the shared diagnostic shape at both severities', () => {
    const error = irError({ code: IR_DIAGNOSTIC_CODES.gateFailed, message: 'x', path: ['a'] });
    expect(error.severity).toBe('error');
    expect(error.code).toBe('ir/gate-failed');
    expect(error.path).toEqual(['a']);
    expect(irWarning({ code: IR_DIAGNOSTIC_CODES.evalUncovered, message: 'y' }).severity).toBe(
      'warning',
    );
  });

  it('attaches a position to a copy, leaving the original untouched', () => {
    const base = irError({ code: IR_DIAGNOSTIC_CODES.policySyntax, message: 'x' });
    const located = withPosition(base, { file: 'f.yaml', line: 2, column: 3 });
    expect(located).not.toBe(base);
    expect(base.line).toBeUndefined();
    expect(located).toMatchObject({ file: 'f.yaml', line: 2, column: 3 });
  });

  it('counts 1-based line and column from a 0-based offset', () => {
    expect(offsetPosition('abc', 0)).toEqual({ line: 1, column: 1 });
    expect(offsetPosition('ab\ncd', 3)).toEqual({ line: 2, column: 1 });
    expect(offsetPosition('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
    expect(offsetPosition('ab\ncd', 5)).toEqual({ line: 2, column: 3 });
  });
});

describe('the capability vocabulary', () => {
  it('is one normative list carrying the §8.1 names', () => {
    expect(new Set(REQUIRED_CAPABILITIES).size).toBe(REQUIRED_CAPABILITIES.length);
    for (const name of ['streaming', 'tool-calling', 'cursor-memory', 'otel']) {
      expect(REQUIRED_CAPABILITIES as readonly string[]).toContain(name);
    }
    for (const entry of REQUIRED_CAPABILITIES) expect(isRequiredCapability(entry)).toBe(true);
    expect(isRequiredCapability('teleportation')).toBe(false);
  });

  it('resolves the design-doc spellings through its alias table', () => {
    expect(TARGET_CAPABILITY_ALIASES['otel-genai']).toBe('otel');
    expect(TARGET_CAPABILITY_ALIASES['tool-call-explicit']).toBe('tool-calling');
    expect(resolveRequiredCapability('otel-genai')).toBe('otel');
    expect(resolveRequiredCapability('streaming')).toBe('streaming');
    expect(resolveRequiredCapability('teleportation')).toBeUndefined();
  });

  it('maps the DSL model capability spelling onto the vocabulary', () => {
    expect(SPEC_MODEL_CAPABILITY_MAP.tools).toBe('tool-calling');
    for (const name of MODEL_CAPABILITIES) expect(isModelCapability(name)).toBe(true);
    expect(isModelCapability('teleportation')).toBe(false);
  });

  it('declares the Phase 0 target using only vocabulary members', () => {
    expect(phase0TargetCapabilities()).toBe(PHASE_0_TARGET_CAPABILITIES);
    const declared = PHASE_0_TARGET_CAPABILITIES[DEFAULT_TARGET];
    expect(declared).toEqual(['http-trigger', 'json-schema', 'otel', 'tool-calling']);
    for (const entry of declared ?? []) expect(isRequiredCapability(entry)).toBe(true);
  });

  it('derives requirements from the IR that are all vocabulary members', () => {
    const derived = deriveRequiredCapabilities(ir);
    expect(derived).toEqual(['http-trigger', 'json-schema', 'tool-calling', 'otel']);
    expect(new Set(derived).size).toBe(derived.length);
    for (const name of derived) expect(isRequiredCapability(name)).toBe(true);
    expect(derived).toEqual([...ir.requiredCapabilities]);
  });
});

describe('the offline catalog', () => {
  it('versions itself and ships priced profiles', () => {
    expect(typeof CATALOG_VERSION).toBe('string');
    expect(CATALOG_VERSION.length).toBeGreaterThan(0);
    const ids = Object.keys(catalogCostProfiles());
    expect(ids.length).toBeGreaterThan(0);
  });

  it('resolves a declared cost-profile key and rejects an unknown model or profile', () => {
    const first = Object.keys(catalogCostProfiles())[0] as string;
    expect(catalogCostProfile('no-such-model', first)?.id).toBe(first);
    expect(catalogCostProfile('no-such-model')).toBeUndefined();
    expect(catalogCostProfile('no-such-model', 'no-such-profile')).toBeUndefined();
  });

  it('looks a catalogued model up by id and prices it through its first candidate profile', () => {
    const catalogued = ir.models.find((model) => catalogModel(model.modelId) !== undefined);
    if (catalogued === undefined) throw new Error('full.yaml uses no catalogued model');
    expect(catalogModel(catalogued.modelId)?.provider).toBeDefined();
    expect(catalogModel('no-such-model')).toBeUndefined();

    const priced = ir.models.find(
      (model) => catalogCostProfile(model.modelId, model.costProfileId) !== undefined,
    );
    expect(priced).toBeDefined();
  });
});

describe('IR shape constants', () => {
  it('keeps irVersion independent of specVersion', () => {
    expect(IR_VERSION).toBe('0.1.0');
    expect(IR_VERSION).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    expect(SPEC_VERSION).toBe('0.1');
    expect(IR_VERSION).not.toBe(SPEC_VERSION);
    expect(ir.irVersion).toBe(IR_VERSION);
    expect(ir.specVersion).toBe(SPEC_VERSION);
  });

  it('carries Phase 0 defaults for observability, runtime, and context limits', () => {
    expect(DEFAULT_OBSERVABILITY).toEqual({ trace: true, redact: [] });
    expect(DEFAULT_RUNTIME).toEqual({ controlFlow: 'plain-async' });
    expect(DEFAULT_MAX_CONTEXT_TOKENS).toBe(128_000);
  });

  it('knows its primitive types, eval target kinds, and providers', () => {
    expect(PRIMITIVE_TYPES).toEqual(['string', 'number', 'integer', 'boolean']);
    expect(EVAL_TARGET_KINDS).toEqual(['pipeline', 'prompt']);
    expect(DEFAULT_TARGET).toBe('py-fastapi');
    for (const provider of PROVIDERS) expect(isProvider(provider)).toBe(true);
    expect(isProvider('teleportation')).toBe(false);
    for (const provider of PHASE_0_PROVIDERS) {
      expect(PROVIDERS as readonly string[]).toContain(provider);
    }
  });

  it('pins the collection accounting constants', () => {
    expect(IR_COLLECTIONS.length).toBe(13);
    expect(IR_ONLY_COLLECTIONS).toEqual(['embeddings', 'stores']);
    expect(NON_COLLECTION_SECTIONS).toEqual(['specVersion', 'project']);
  });

  it('accounts for every top-level key as a section, a collection, or one of its own singletons', () => {
    const sectionKeys = new Set<string>([
      ...NON_COLLECTION_SECTIONS,
      ...Object.keys(POPULATED_COLLECTION_BY_SECTION),
    ]);
    expect(sectionKeys).toEqual(new Set<string>(SUPPORTED_SECTIONS));

    const accounted = new Set<string>([...sectionKeys, ...IR_COLLECTIONS]);
    expect(
      Object.keys(ir)
        .filter((key) => !accounted.has(key))
        .sort(),
    ).toEqual(['irVersion', 'observability', 'requiredCapabilities', 'runtime']);
  });

  it('derives identities from identity, not from content', () => {
    expect(modelIdentity('triage')).toBe('model:triage');
    expect(promptIdentity('classify_ticket', 2)).toBe('prompt:classify_ticket@2');
    expect(toolIdentity('issue_refund')).toBe('tool:issue_refund');
    expect(pipelineIdentity('handle_ticket')).toBe('pipeline:handle_ticket');
  });
});

describe('the gate contract', () => {
  it('binds the source file into every diagnostic a gate reports', () => {
    const report = reporter({ targetCapabilities: phase0TargetCapabilities(), file: 'app.yaml' });
    expect(report.error({ code: IR_DIAGNOSTIC_CODES.gateFailed, message: 'x' }).file).toBe(
      'app.yaml',
    );
    expect(report.warn({ code: IR_DIAGNOSTIC_CODES.evalUncovered, message: 'x' }).severity).toBe(
      'warning',
    );
  });

  it('runs exactly the six Phase 0 gates and merges their reports', () => {
    expect(Object.keys(GATES)).toEqual([
      'referential',
      'normalize',
      'capability',
      'cost',
      'security',
      'eval-coverage',
    ]);
    const result = gateFixture('eval-uncovered.yaml');
    expect(Object.keys(result.byGate)).toEqual(Object.keys(GATES));
    expect(codesOf(result.diagnostics)).toEqual([IR_DIAGNOSTIC_CODES.evalUncovered]);
  });

  it('fails the run only on an error-severity diagnostic', () => {
    expect(gateFixture('full.yaml').ok).toBe(true);
    expect(gateFixture('security-unauth-write.yaml').ok).toBe(false);
  });

  it('names every suppressed check with a reason rather than skipping it silently', () => {
    const result = runGates(ir);
    expect(result.suppressed.map((entry) => entry.check)).toEqual([
      'referential/request-input-fields',
      'security/input-output-guardrails',
    ]);
    for (const entry of result.suppressed) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('checks the capability set it derives, not one supplied alongside', () => {
    const narrow = { 'py-fastapi': ['http-trigger'] };
    const result = runGates(ir, { targetCapabilities: narrow });
    expect(result.ok).toBe(false);
    expect(codesOf(result.diagnostics)).toContain(IR_DIAGNOSTIC_CODES.capabilityMissing);
  });
});
