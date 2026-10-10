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
      [PY_FASTAPI_TARGET]: ['http-trigger', 'json-schema', 'otel', 'streaming', 'tool-calling'],
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

  it('declares streaming as a capability the emitted code has', () => {
    expect(PY_FASTAPI_MANIFEST.capabilities).toEqual([
      'http-trigger',
      'json-schema',
      'otel',
      'streaming',
      'tool-calling',
    ]);
    expect(PY_FASTAPI_MANIFEST_INPUT.capabilities).toContain('streaming');
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
