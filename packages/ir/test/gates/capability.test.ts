import { describe, expect, it } from 'vitest';

import {
  capabilityGate,
  deriveRequiredCapabilities,
  IR_DIAGNOSTIC_CODES,
  PHASE_0_TARGET_CAPABILITIES,
  phase0TargetCapabilities,
  REQUIRED_CAPABILITIES,
} from '../../src/index.js';
import { byId, first, gateFixture, messagesOf, mutateIR, onlyDiagnosticWith } from '../helpers.js';

/**
 * The seam layer 3 fills in. Layer 2 cannot import `packages/generator-sdk`, so a
 * target's capability declaration arrives as a gate argument.
 */
const PYTHON = { 'py-fastapi': ['http-trigger', 'json-schema', 'otel', 'tool-calling'] };

describe('capability gate', () => {
  it('satisfies every capability the IR derives from its own content', () => {
    const { byGate, ir } = gateFixture('full.yaml');
    expect(byGate.capability.diagnostics).toEqual([]);
    expect([...ir.requiredCapabilities].sort()).toEqual([
      'http-trigger',
      'json-schema',
      'otel',
      'tool-calling',
    ]);
  });

  it('derives requirements from the IR, not from a fixed list', () => {
    const ir = mutateIR('full.yaml');
    first(ir.pipelines).trigger = { kind: 'manual' };
    expect(deriveRequiredCapabilities(ir)).not.toContain('http-trigger');

    const structured = mutateIR('full.yaml');
    const prompt = first(structured.prompts.filter((entry) => entry.output.kind === 'structured'));
    prompt.output = { kind: 'text' };
    expect(deriveRequiredCapabilities(structured)).not.toContain('json-schema');
  });

  it('only ever requires a capability from the declared vocabulary', () => {
    const { ir } = gateFixture('full.yaml');
    expect(ir.requiredCapabilities.length).toBeGreaterThan(0);
    for (const capability of ir.requiredCapabilities) {
      expect(REQUIRED_CAPABILITIES).toContain(capability);
    }
  });

  it('treats a target with no declaration as unknown, not as a pass', () => {
    const { byGate } = gateFixture('full.yaml', { targetCapabilities: { 'py-flask': [] } });
    const unknown = onlyDiagnosticWith(
      byGate.capability.diagnostics,
      IR_DIAGNOSTIC_CODES.targetUnknown,
    );
    expect(unknown.severity).toBe('error');
    expect(unknown.path).toEqual(['project', 'targets']);
    expect(unknown.message).toContain('"py-fastapi"');
    expect(unknown.message).toContain('capability gate');
  });

  it('reports every capability the target does not declare', () => {
    const { byGate } = gateFixture('full.yaml', {
      targetCapabilities: { 'py-fastapi': ['http-trigger'] },
    });
    const missing = byGate.capability.diagnostics.filter(
      (diagnostic) => diagnostic.code === IR_DIAGNOSTIC_CODES.capabilityMissing,
    );
    expect(missing).toHaveLength(3);
    const text = messagesOf(missing);
    for (const capability of ['json-schema', 'tool-calling', 'otel']) {
      expect(text).toContain(`requires "${capability}", which this target does not declare`);
    }
    expect(missing.every((diagnostic) => diagnostic.path.join('.') === 'project.targets')).toBe(
      true,
    );
  });

  it('rejects a declared capability that is not in the vocabulary', () => {
    const { byGate } = gateFixture('full.yaml', {
      targetCapabilities: { 'py-fastapi': [...PYTHON['py-fastapi'], 'teleportation'] },
    });
    const unknown = onlyDiagnosticWith(
      byGate.capability.diagnostics,
      IR_DIAGNOSTIC_CODES.capabilityUnknown,
    );
    expect(unknown.message).toContain('"teleportation" is not a capability of the vocabulary');
    expect(unknown.path).toEqual(['project', 'targets']);
  });

  it('fails closed when the IR requires a capability outside the vocabulary', () => {
    const ir = mutateIR('full.yaml');
    (ir as { requiredCapabilities: string[] }).requiredCapabilities = ['teleportation'];

    const result = capabilityGate(ir, { targetCapabilities: phase0TargetCapabilities() });
    const missing = onlyDiagnosticWith(result.diagnostics, IR_DIAGNOSTIC_CODES.capabilityMissing);
    expect(missing.message).toContain('the IR requires "teleportation"');
  });

  it('rejects a structured-output prompt whose model cannot constrain output', () => {
    const ir = mutateIR('full.yaml');
    const model = byId(ir.models, 'triage');
    model.capabilities = model.capabilities.filter((entry) => entry !== 'json-schema');

    const result = capabilityGate(ir, { targetCapabilities: phase0TargetCapabilities() });
    const missing = onlyDiagnosticWith(
      result.diagnostics,
      IR_DIAGNOSTIC_CODES.modelCapabilityMissing,
    );
    expect(missing.severity).toBe('error');
    expect(missing.path).toEqual(['prompts', 'classify_ticket', 'model']);
    expect(missing.message).toContain('does not declare the "json-schema" capability');
  });

  it('exposes the Phase 0 declaration layer 3 will replace', () => {
    expect(phase0TargetCapabilities()).toBe(PHASE_0_TARGET_CAPABILITIES);
    expect(PHASE_0_TARGET_CAPABILITIES).toEqual(PYTHON);
    expect(
      gateFixture('full.yaml', { targetCapabilities: PYTHON }).byGate.capability.diagnostics,
    ).toEqual([]);
  });

  it('derives rerank from a retriever that declares a reranker', () => {
    const { ir } = gateFixture('retrieval.yaml');
    expect([...ir.requiredCapabilities].sort()).toEqual([
      'embeddings',
      'http-trigger',
      'json-schema',
      'otel',
      'rerank',
    ]);
    expect(deriveRequiredCapabilities(ir)).toContain('rerank');
  });

  it('derives rerank only from a retriever that declares a reranker', () => {
    const { ir } = gateFixture('retrieval.yaml');
    expect(deriveRequiredCapabilities(ir)).toContain('rerank');

    // Layer 1 has no rerank step shape (`StepShape` is generate|retrieve|tool|emit)
    // and no rerank spec model capability, so a retriever's reranker is the only
    // source the derivation reads; `{kind: 'rerank'}` stays reserved for later.
    expect(ir.retrievers.some((retriever) => retriever.rerank !== undefined)).toBe(true);
  });

  it('does not derive rerank when nothing in the IR reranks', () => {
    const ir = mutateIR('retrieval.yaml');
    delete first(ir.retrievers).rerank;
    expect(deriveRequiredCapabilities(ir)).not.toContain('rerank');
    expect(deriveRequiredCapabilities(ir)).toContain('embeddings');
  });

  it('refuses a reranked spec on a target that does not implement reranking', () => {
    const { byGate } = gateFixture('retrieval.yaml', { targetCapabilities: PYTHON });
    const missing = byGate.capability.diagnostics.filter(
      (diagnostic) => diagnostic.code === IR_DIAGNOSTIC_CODES.capabilityMissing,
    );
    const text = messagesOf(missing);
    for (const capability of ['embeddings', 'rerank']) {
      expect(text).toContain(`requires "${capability}", which this target does not declare`);
    }
  });

  it('accepts the same spec once the target declares both capabilities', () => {
    const { byGate } = gateFixture('retrieval.yaml', {
      targetCapabilities: { 'py-fastapi': [...PYTHON['py-fastapi'], 'embeddings', 'rerank'] },
    });
    expect(byGate.capability.diagnostics).toEqual([]);
  });
});

describe('L5 capability derivations (closes D-1b)', () => {
  it('derives streaming from a deployment that requests it', () => {
    const { ir } = gateFixture('deploy-streaming.yaml');
    expect(deriveRequiredCapabilities(ir)).toContain('streaming');
  });

  it('does not derive streaming when no deployment requests it', () => {
    const ir = mutateIR('deploy-streaming.yaml');
    first(ir.deployments).streaming = false;
    expect(deriveRequiredCapabilities(ir)).not.toContain('streaming');
  });

  it('derives prompt-cache from a model that declares a prompt cache', () => {
    const ir = mutateIR('full.yaml');
    byId(ir.models, 'triage').cache = { prompt: true };
    expect(deriveRequiredCapabilities(ir)).toContain('prompt-cache');
  });

  it('does not derive prompt-cache when no model declares a prompt cache', () => {
    const { ir } = gateFixture('full.yaml');
    expect(deriveRequiredCapabilities(ir)).not.toContain('prompt-cache');
  });
});
