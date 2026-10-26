import { describe, expect, it } from 'vitest';

import {
  checkIRSupport,
  GENERATOR_MANIFEST_VERSION,
  managedRoots,
  PY_FASTAPI_MANIFEST,
  PY_FASTAPI_MANIFEST_INPUT,
  PY_FASTAPI_TARGET,
  phase0Generators,
  phase0TargetCapabilities,
  supportsIR,
  validateGeneratorSet,
  validatePlan,
} from '../src/index.js';

describe('the Phase 0 generator set', () => {
  it('loads as a validated, versioned manifest', () => {
    expect(PY_FASTAPI_MANIFEST.manifestVersion).toBe(GENERATOR_MANIFEST_VERSION);
    expect(PY_FASTAPI_MANIFEST.name).toBe('@aid/generator-py-fastapi');
    expect(PY_FASTAPI_MANIFEST.target).toBe(PY_FASTAPI_TARGET);
  });

  it('is the replacement for the IR package placeholder', () => {
    expect(phase0TargetCapabilities()).toEqual({
      [PY_FASTAPI_TARGET]: [
        'agents',
        'cursor-memory',
        'embeddings',
        'guardrails',
        'http-trigger',
        'json-schema',
        'otel',
        'rerank',
        'streaming',
        'tool-calling',
      ],
    });
  });

  it('has unique names and targets', () => {
    expect(validateGeneratorSet(phase0Generators())).toEqual([]);
  });

  it('compiles the current IR version', () => {
    expect(supportsIR(PY_FASTAPI_MANIFEST)).toBe(true);
    expect(checkIRSupport(PY_FASTAPI_MANIFEST)).toEqual([]);
  });
});

describe('the py-fastapi declaration', () => {
  it('binds structured output to Pydantic and tracing to OTel GenAI', () => {
    expect(PY_FASTAPI_MANIFEST.emitsAgainst).toEqual({
      structuredOutput: 'pydantic',
      tracing: 'otel-genai',
    });
  });

  it('declares no orchestration framework, because Phase 0 control flow is plain async', () => {
    expect(PY_FASTAPI_MANIFEST.emitsAgainst.orchestration).toBeUndefined();
    expect(PY_FASTAPI_MANIFEST.capabilities).not.toContain('orchestration');
  });

  it('declares streaming, because the emitted route serves SSE and the Python runtime streams', () => {
    expect(PY_FASTAPI_MANIFEST.capabilities).toEqual([
      'agents',
      'cursor-memory',
      'embeddings',
      'guardrails',
      'http-trigger',
      'json-schema',
      'otel',
      'rerank',
      'streaming',
      'tool-calling',
    ]);
    expect(PY_FASTAPI_MANIFEST_INPUT.capabilities).toContain('tool-calling');
    // Defect D-1 was this declaration against a runtime that raised
    // `FeatureDeferredError`. It is declared again because the runtime implements
    // `ModelGateway.stream()` and the generator emits the `Accept: text/event-stream`
    // branch that calls it; the TypeScript target still omits it, which is L6's work.
    expect(PY_FASTAPI_MANIFEST.capabilities).toContain('streaming');
    expect(PY_FASTAPI_MANIFEST_INPUT.capabilities).toContain('streaming');
  });

  it('declares guardrails, because the Python runtime executes them', () => {
    // `guardrails` is the P7a half of the same question `streaming` answers: the
    // runtime ships `GuardrailEngine` and the generator emits the wiring that calls it.
    expect(PY_FASTAPI_MANIFEST.capabilities).toContain('guardrails');
    expect(PY_FASTAPI_MANIFEST_INPUT.capabilities).toContain('guardrails');
  });

  it('declares agents and cursor-memory since P7b, because the emitted route runs them', () => {
    // P7a pinned `not.toContain('agents')` here, and P7b is what changes the answer, so
    // the assertion inverts rather than disappearing: the declaration is the claim that
    // `generated/agents.py` serves the collection, and the evidence is that file plus the
    // example's `tests/test_agents.py`, which pauses a run and resumes it.
    expect(PY_FASTAPI_MANIFEST.capabilities).toContain('agents');
    expect(PY_FASTAPI_MANIFEST_INPUT.capabilities).toContain('agents');
    // The IR derives `cursor-memory` from a `memory` collection -- there is no `memory`
    // capability to declare -- so a target that serves memory backends says so by name.
    expect(PY_FASTAPI_MANIFEST.capabilities).toContain('cursor-memory');
    expect(PY_FASTAPI_MANIFEST_INPUT.capabilities).toContain('cursor-memory');
    // Both declarations moved together: the input is what the manifest is parsed from,
    // so a split between them would be a generated manifest that disagrees with itself.
    // Sorted first because parsing sorts and the input keeps declaration order.
    expect(PY_FASTAPI_MANIFEST.capabilities).toEqual(
      [...PY_FASTAPI_MANIFEST_INPUT.capabilities].sort(),
    );
  });

  it('declares the retrieval capabilities the emitted wiring satisfies', () => {
    expect(PY_FASTAPI_MANIFEST.capabilities).toContain('embeddings');
    expect(PY_FASTAPI_MANIFEST.capabilities).toContain('rerank');
  });

  it('lays out the app under a single root with two managed tiers', () => {
    expect(managedRoots(PY_FASTAPI_MANIFEST)).toEqual({
      generatedDir: 'app/generated',
      businessDir: 'app/business',
      manifestFilename: 'app/aid.manifest.json',
    });
  });

  it('accepts a plan written against its own layout', () => {
    const diagnostics = validatePlan(
      {
        files: [
          { path: 'app/generated/main.py', content: 'x = 1\n', owner: 'generated' },
          { path: 'app/business/handlers.py', content: '# stub\n', owner: 'business' },
        ],
      },
      managedRoots(PY_FASTAPI_MANIFEST),
    );
    expect(diagnostics).toEqual([]);
  });
});
