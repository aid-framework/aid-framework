import {
  DEFERRED_SECTIONS,
  SPEC_VERSION,
  SUPPORTED_SECTIONS,
  SUPPORTED_STEP_KINDS,
} from '@aid/spec';
import { describe, expect, it } from 'vitest';

import type { BuildContext } from '../src/index.js';
import {
  buildEvalTarget,
  buildIR,
  buildTypeRef,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_OBSERVABILITY,
  DEFAULT_RUNTIME,
  deriveRequiredCapabilities,
  IR_COLLECTIONS,
  IR_ONLY_COLLECTIONS,
  IR_VERSION,
  isBindingName,
  isSensitiveName,
  modelIdentity,
  NON_COLLECTION_SECTIONS,
  POPULATED_COLLECTION_BY_SECTION,
  PROVIDERS,
  pipelineIdentity,
  promptIdentity,
  REQUIRED_CAPABILITIES,
  sensitiveNames,
  sortedKeys,
  templatePlaceholders,
  toolIdentity,
} from '../src/index.js';
import { buildFixture } from './helpers.js';

/** The full §7.2 top level, in the order the builder emits it. */
const TOP_LEVEL_KEYS = [
  'irVersion',
  'specVersion',
  'project',
  'types',
  'models',
  'prompts',
  'tools',
  'retrievers',
  'embeddings',
  'stores',
  'memory',
  'agents',
  'pipelines',
  'evals',
  'guardrails',
  'deployments',
  'observability',
  'runtime',
  'requiredCapabilities',
];

const { ir, diagnostics } = buildFixture('full.yaml');

describe('buildIR', () => {
  it('builds the full fixture without diagnostics', () => {
    expect(diagnostics).toEqual([]);
  });

  it('carries the full §7.2 top level in a stable order', () => {
    expect(Object.keys(ir)).toEqual(TOP_LEVEL_KEYS);
  });

  it('populates the Phase 0 sections', () => {
    expect(ir.types.map((type) => type.id)).toEqual([
      'RefundRequest',
      'RefundResult',
      'TicketClassification',
      'TicketEvent',
    ]);
    expect(ir.models.map((model) => model.id)).toEqual(['local_stub', 'triage', 'triage_backup']);
    expect(ir.prompts.map((prompt) => prompt.id)).toEqual(['classify_ticket', 'summarize_ticket']);
    expect(ir.tools.map((tool) => tool.id)).toEqual(['fetch_order', 'issue_refund']);
    expect(ir.pipelines.map((pipeline) => pipeline.id)).toEqual(['handle_ticket']);
    expect(ir.evals.map((evaluation) => evaluation.id)).toEqual(['refund_regression']);
  });

  it('marks every deferred collection present and empty, never undefined', () => {
    for (const collection of [...DEFERRED_SECTIONS, ...IR_ONLY_COLLECTIONS]) {
      expect(ir[collection], collection).toEqual([]);
    }
  });

  it('keeps observability and runtime as objects with Phase 0 defaults', () => {
    expect(ir.observability).toEqual({ trace: DEFAULT_OBSERVABILITY.trace, redact: [] });
    expect(ir.runtime).toEqual({ controlFlow: DEFAULT_RUNTIME.controlFlow });
  });

  it('accounts for every collection exactly once', () => {
    const sectionCollections = Object.values(POPULATED_COLLECTION_BY_SECTION);

    const sections = new Set<string>([...NON_COLLECTION_SECTIONS, ...sectionCollections]);
    expect(sections).toEqual(new Set<string>(SUPPORTED_SECTIONS));

    const collections = [...sectionCollections, ...DEFERRED_SECTIONS, ...IR_ONLY_COLLECTIONS];
    expect(new Set<string>(collections)).toEqual(new Set<string>(IR_COLLECTIONS));
    expect(collections).toHaveLength(IR_COLLECTIONS.length);

    for (const section of DEFERRED_SECTIONS) {
      expect(IR_COLLECTIONS as readonly string[]).toContain(section);
    }
    for (const collection of IR_ONLY_COLLECTIONS) {
      expect(DEFERRED_SECTIONS as readonly string[]).not.toContain(collection);
    }
  });

  it('covers every supported step kind', () => {
    const kinds = ir.pipelines.flatMap((pipeline) => pipeline.steps.map((step) => step.kind));
    expect(new Set(kinds)).toEqual(new Set<string>(SUPPORTED_STEP_KINDS));
  });

  it('keeps irVersion and specVersion independent', () => {
    expect(ir.irVersion).toBe(IR_VERSION);
    expect(ir.specVersion).toBe(SPEC_VERSION);
    expect(ir.irVersion).not.toBe(ir.specVersion);
  });

  it('derives identities from ids rather than content', () => {
    expect(ir.models.find((model) => model.id === 'triage')?.identity).toBe(
      modelIdentity('triage'),
    );
    expect(ir.prompts[0]?.identity).toBe(promptIdentity('classify_ticket', 2));
    expect(ir.tools.find((tool) => tool.id === 'issue_refund')?.identity).toBe(
      toolIdentity('issue_refund'),
    );
    expect(ir.pipelines[0]?.identity).toBe(pipelineIdentity('handle_ticket'));
  });

  it('resolves TypeRefs eagerly', () => {
    const request = ir.types[0];
    const fields = new Map(request?.fields.map((field) => [field.name, field.type]));
    expect(fields.get('amount_usd')).toEqual({ kind: 'primitive', name: 'number', list: false });
    expect(fields.get('order_id')).toEqual({ kind: 'primitive', name: 'string', list: false });

    expect(ir.prompts[0]?.output).toEqual({
      kind: 'structured',
      schema: { kind: 'named', name: 'TicketClassification', list: false, resolved: true },
    });
    expect(ir.tools[0]?.input).toEqual({
      kind: 'named',
      name: 'RefundRequest',
      list: false,
      resolved: true,
    });
  });

  it('resolves eval targets to their kind and id', () => {
    expect(ir.evals[0]?.target).toEqual({
      kind: 'pipeline',
      id: 'handle_ticket',
      qualified: 'pipeline:handle_ticket',
      valid: true,
    });
  });

  it('exposes the capability set its own content requires', () => {
    const derived = deriveRequiredCapabilities(ir);
    expect(ir.requiredCapabilities).toEqual(derived);
    for (const capability of derived) {
      expect(REQUIRED_CAPABILITIES as readonly string[]).toContain(capability);
    }
    expect(derived).toContain('http-trigger');
    expect(derived).toContain('tool-calling');
    expect(derived).toContain('json-schema');
  });
});

describe('building the same spec twice', () => {
  it('produces deeply equal IR', () => {
    expect(buildFixture('full.yaml').ir).toEqual(ir);
  });
});

describe('buildTypeRef', () => {
  const context: BuildContext = { diagnostics: [], typeNames: new Set(['RefundRequest']) };

  it('parses primitives, lists, and named references', () => {
    expect(buildTypeRef('string', context)).toEqual({
      kind: 'primitive',
      name: 'string',
      list: false,
    });
    expect(buildTypeRef('boolean[]', context)).toEqual({
      kind: 'primitive',
      name: 'boolean',
      list: true,
    });
    expect(buildTypeRef('RefundRequest', context)).toEqual({
      kind: 'named',
      name: 'RefundRequest',
      list: false,
      resolved: true,
    });
    expect(buildTypeRef('Missing', context)).toEqual({
      kind: 'named',
      name: 'Missing',
      list: false,
      resolved: false,
    });
    expect(buildTypeRef('RefundRequest[]', context)).toEqual({
      kind: 'named',
      name: 'RefundRequest',
      list: true,
      resolved: true,
    });
    expect(buildTypeRef(undefined, context)).toEqual({
      kind: 'named',
      name: '',
      list: false,
      resolved: false,
    });
  });
});

describe('buildEvalTarget', () => {
  it('accepts a known kind and rejects anything else', () => {
    expect(buildEvalTarget('prompt:classify_ticket')).toEqual({
      kind: 'prompt',
      id: 'classify_ticket',
      qualified: 'prompt:classify_ticket',
      valid: true,
    });
    expect(buildEvalTarget('handle_ticket')).toEqual({
      kind: 'pipeline',
      id: 'handle_ticket',
      qualified: 'handle_ticket',
      valid: false,
    });
    expect(buildEvalTarget('agent:support').valid).toBe(false);
  });
});

describe('name helpers', () => {
  it('recognises binding names', () => {
    expect(isBindingName('ticket')).toBe(true);
    expect(isBindingName('ticket_2')).toBe(true);
    expect(isBindingName('_x1')).toBe(false);
    expect(isBindingName('1ticket')).toBe(false);
    expect(isBindingName('Ticket')).toBe(false);
    expect(isBindingName('')).toBe(false);
  });

  it('infers sensitivity from a field or variable name', () => {
    expect(isSensitiveName('password')).toBe(true);
    expect(isSensitiveName('apiKey')).toBe(true);
    expect(isSensitiveName('order_id')).toBe(false);
  });

  it('collects sensitive names sorted and deduplicated', () => {
    expect(sensitiveNames({ types: ir.types, prompts: ir.prompts })).toEqual([]);
  });

  it('extracts template placeholders in first-seen order', () => {
    expect(templatePlaceholders('a {{one}} b {{two.x}} c {{one}}')).toEqual(['one', 'two']);
    expect(templatePlaceholders('none')).toEqual([]);
  });

  it('sorts object keys so YAML order never reaches the IR', () => {
    expect(sortedKeys({ b: 1, a: 2 })).toEqual(['a', 'b']);
  });
});

describe('buildIR with a sparse value', () => {
  it('produces no diagnostics and leaves unknown sections empty', () => {
    const built = buildIR({ specVersion: '0.1', project: { name: 'x' } });
    expect(built.diagnostics).toEqual([]);
    expect(built.ir.types).toEqual([]);
    expect(built.ir.pipelines).toEqual([]);
    expect(Object.keys(built.ir)).toEqual(TOP_LEVEL_KEYS);
  });

  it('falls back to catalog limits when a model is unlisted', () => {
    const built = buildIR({
      specVersion: '0.1',
      project: { name: 'x' },
      models: { ghost: { provider: 'fake', modelId: 'nothing-like-this' } },
    });
    expect(built.ir.models[0]?.limits.contextTokens).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(built.ir.models[0]?.costProfile).toBeUndefined();
  });
});

describe('provider surface', () => {
  it('accepts Phase 0 providers and keeps the union wider', () => {
    expect(PROVIDERS).toContain('openai');
    expect(PROVIDERS).toContain('fake');
  });
});
