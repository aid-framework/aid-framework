import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  DEFAULT_OBSERVABILITY,
  DEFAULT_RUNTIME,
  IR_DIAGNOSTIC_CODES,
  isNormalized,
  normalize,
  runGates,
  serializeIR,
} from '../../src/index.js';
import {
  buildFixture,
  byId,
  first,
  gateFixture,
  mutateIR,
  onlyDiagnosticWith,
} from '../helpers.js';

/** Omits `observability`, which no valid spec can omit, to leave a default implicit. */
function withoutObservability() {
  const ir = mutateIR('full.yaml');
  delete (ir as { observability?: unknown }).observability;
  return ir;
}

describe('normalize gate', () => {
  it('passes, because the builder materializes every default it would apply', () => {
    const { byGate, ir } = gateFixture('full.yaml');
    expect(byGate.normalize.diagnostics).toEqual([]);
    expect(isNormalized(ir)).toBe(true);
  });

  it('suppresses nothing, so a silent skip is visible as an empty list', () => {
    expect(gateFixture('full.yaml').byGate.normalize.suppressed).toEqual([]);
  });

  it('makes the defaults visible in the IR rather than leaving them to a generator', () => {
    const { ir } = gateFixture('full.yaml');

    expect(ir.observability).toEqual(DEFAULT_OBSERVABILITY);
    expect(ir.runtime).toEqual(DEFAULT_RUNTIME);
    expect(ir.runtime.controlFlow).toBe('plain-async');

    for (const model of ir.models) {
      expect(model.capabilities).toBeInstanceOf(Array);
      expect(model.fallbacks).toBeInstanceOf(Array);
      expect(model.traits).toBeInstanceOf(Array);
      expect(model.params).toBeDefined();
      expect(model.limits.contextTokens).toBeGreaterThan(0);
    }

    for (const pipeline of ir.pipelines) {
      expect(pipeline.errorPolicy.retries).toBeGreaterThanOrEqual(0);
      expect(pipeline.observability).toEqual(ir.observability);
    }

    for (const evalShape of ir.evals) {
      expect(typeof evalShape.gate.ci).toBe('boolean');
      expect(typeof evalShape.gate.samples).toBe('number');
      expect(typeof evalShape.gate.maxRegression).toBe('number');
    }

    const write = first(ir.tools.filter((tool) => tool.id === 'issue_refund'));
    expect(write.requiresConfirmation).toBe(false);
  });

  it('is idempotent', () => {
    const { ir } = gateFixture('full.yaml');
    const once = normalize(ir);
    expect(canonicalJson(normalize(once))).toBe(canonicalJson(once));
  });

  it('is order-independent: YAML key order and whitespace cannot change it', () => {
    const a = buildFixture('key-order-a.yaml').ir;
    const b = buildFixture('key-order-b.yaml').ir;
    expect(serializeIR(normalize(a))).toBe(serializeIR(normalize(b)));
  });

  it('rejects a value left implicit, and stays idempotent while doing so', () => {
    const ir = withoutObservability();
    expect(isNormalized(ir)).toBe(false);

    const incomplete = onlyDiagnosticWith(
      runGates(ir).byGate.normalize.diagnostics,
      IR_DIAGNOSTIC_CODES.normalizationIncomplete,
    );
    expect(incomplete.severity).toBe('error');
    expect(incomplete.path).toEqual([]);
    expect(incomplete.message).toContain('normalize gate rejected this IR');
    expect(incomplete.message).toContain('observability');

    const once = normalize(ir);
    expect(canonicalJson(normalize(once))).toBe(canonicalJson(once));
  });

  it('rejects a provider Phase 0 does not serve', () => {
    const ir = mutateIR('full.yaml');
    const model = byId(ir.models, 'triage');
    model.provider = 'teleportation' as typeof model.provider;

    const unsupported = onlyDiagnosticWith(
      runGates(ir).byGate.normalize.diagnostics,
      IR_DIAGNOSTIC_CODES.providerUnsupported,
    );
    expect(unsupported.severity).toBe('error');
    expect(unsupported.path).toEqual(['models', 'triage', 'provider']);
    expect(unsupported.message).toContain('"teleportation"');
  });

  it('rejects params above the limit the IR itself carries', () => {
    const ir = mutateIR('full.yaml');
    const model = byId(ir.models, 'triage');
    expect(model.limits.maxOutputTokens).toBe(1024);
    model.params = { ...model.params, maxTokens: 4096 };

    const exceeds = onlyDiagnosticWith(
      runGates(ir).byGate.normalize.diagnostics,
      IR_DIAGNOSTIC_CODES.paramExceedsLimit,
    );
    expect(exceeds.path).toEqual(['models', 'triage', 'params', 'maxTokens']);
    expect(exceeds.message).toContain('above the catalog limit of 1024');
  });

  it('accepts params at the limit, so the comparison is not off by one', () => {
    const ir = mutateIR('full.yaml');
    const model = byId(ir.models, 'triage');
    model.params = { ...model.params, maxTokens: 1024 };

    const codes = runGates(ir).byGate.normalize.diagnostics.map((entry) => entry.code);
    expect(codes).not.toContain(IR_DIAGNOSTIC_CODES.paramExceedsLimit);
  });

  it('leaves an uncatalogued model without invented limits, rather than guessing them', () => {
    const { ir } = gateFixture('full.yaml');
    const stub = byId(ir.models, 'local_stub');

    expect(stub.limits.contextTokens).toBeGreaterThan(0);
    expect(stub.limits.maxOutputTokens).toBeUndefined();
    expect(stub.params).toEqual({});
    expect(stub.capabilities).toEqual([]);
  });

  it('accepts the retrieval fixture as normalized', () => {
    expect(gateFixture('retrieval.yaml').byGate.normalize.diagnostics).toEqual([]);
  });

  it('rejects a store whose dimensions contradict the embedding model', () => {
    const mismatch = onlyDiagnosticWith(
      gateFixture('normalize-dimensions.yaml').byGate.normalize.diagnostics,
      IR_DIAGNOSTIC_CODES.dimensionMismatch,
    );
    expect(mismatch.severity).toBe('error');
    expect(mismatch.path).toEqual(['stores', 'docs', 'dimensions']);
    expect(mismatch.message).toContain('"docs" declares 768 dimensions');
    expect(mismatch.message).toContain('"embed" produces 1536');
  });

  it('leaves a store with no declared width as the only claim to compare', () => {
    const ir = mutateIR('retrieval.yaml');
    delete first(ir.stores).dimensions;
    expect(runGates(ir).byGate.normalize.diagnostics).toEqual([]);
  });

  it('rejects an index metric outside the vocabulary', () => {
    const ir = mutateIR('retrieval.yaml');
    (first(ir.retrievers).index as { metric: string }).metric = 'jaccard';

    const unknown = onlyDiagnosticWith(
      runGates(ir).byGate.normalize.diagnostics,
      IR_DIAGNOSTIC_CODES.indexMetricUnknown,
    );
    expect(unknown.severity).toBe('error');
    expect(unknown.path).toEqual(['retrievers', 'handbook', 'index', 'metric']);
    expect(unknown.message).toContain('"jaccard" is not one of cosine, dot, l2');
  });
});
