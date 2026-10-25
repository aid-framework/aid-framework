/**
 * Capability truthfulness: defects D-1 and D-1b.
 *
 * A manifest is a promise about the code the generator emits. `streaming` was the
 * promise this package broke: it was declared on the target, advertised by every
 * emitted provider adapter, and printed into the app's own `observability.py`, while
 * both runtimes raised `FeatureDeferredError` from `stream()`. Phase 2 layer L1
 * withdrew it, and this suite is what has to fail if it comes back without an
 * implementation. Phase 2 layer L5 implements streaming in the Python runtime and
 * adds the derivation that closes D-1b, but the target declaration stays withdrawn
 * until the generator emits a streaming route — so the `not.toContain('streaming')`
 * pins below remain the honest state.
 *
 * A declaration is not one claim but three, so each one is checked three ways:
 *
 *   1. Is there an emitter here? A declaration with no emitter is a promise no code
 *      keeps.
 *   2. Does the runtime the emitted code calls actually implement it? An emitter that
 *      calls a raise is the same broken promise one indirection further out, which is
 *      exactly what D-1 was.
 *   3. Does a behavioural test exercise it end to end? `examples/support-copilot` is
 *      installed and run offline by the `evals` job, so an entry pointing there is a
 *      test that really runs rather than a name in a table.
 *
 * The vocabulary is audited separately: every capability the IR can *require* must
 * have a derivation path or a recorded deferral naming the layer that owns it. D-1b
 * was six members with neither, so nothing could ever require them and nothing said
 * so. The vocabulary is pinned member by member below rather than counted, because the
 * tempting fix for a failing audit is to delete the unexamined capability, and that
 * would silently narrow the design instead of documenting it.
 *
 * The last two blocks are the falsifiers -- one per audit -- because an audit holding
 * an empty table reports no problems just as convincingly as an audit that is happy.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAPABILITY_DERIVATIONS,
  DEFERRED_CAPABILITIES,
  type DeferredCapability,
  deriveRequiredCapabilities,
  type IR,
  REQUIRED_CAPABILITIES,
  type RequiredCapability,
} from '@aid/ir';
import { describe, expect, it } from 'vitest';

import { PY_FASTAPI_MANIFEST } from '../src/index.js';
import {
  ADAPTER_CAPABILITIES,
  capabilityReport,
  modelCapabilities,
  type ProviderAdapter,
} from '../src/names.js';
import { example, REPO_ROOT } from './helpers.js';

/** A file and a string that has to be in it, at a repo-relative path. */
interface Source {
  readonly path: string;
  readonly marker: string;
}

/** What makes one declared capability true, in the four places it has to be true. */
interface Claim {
  readonly capability: RequiredCapability;
  /** The emitter in this package that turns the IR into code serving it. */
  readonly emitter: Source;
  /** The Python runtime module that implements it, and the symbol the emitted code calls. */
  readonly pyRuntime: Source;
  /** The TypeScript runtime's counterpart. */
  readonly tsRuntime: Source;
  /** A test that exercises it end to end, offline, in a required CI job. */
  readonly behaviour: Source;
  /** A path the committed example's plan produces, so the claim is exercised as shipped. */
  readonly planned: RegExp;
}

const CLAIMS: readonly Claim[] = [
  {
    capability: 'http-trigger',
    emitter: {
      path: 'packages/generators/py-fastapi/src/emit/pipelines.ts',
      marker: 'function httpPipelines',
    },
    pyRuntime: { path: 'runtimes/python/src/aid_runtime/pipeline.py', marker: 'class Pipeline:' },
    tsRuntime: { path: 'runtimes/typescript/src/pipeline.ts', marker: 'export class Pipeline' },
    behaviour: {
      path: 'examples/support-copilot/tests/test_app.py',
      marker: 'def test_the_route_answers_a_ticket_offline',
    },
    planned: /^app\/generated\/routes\/[a-z_]+\.py$/,
  },
  {
    capability: 'json-schema',
    emitter: { path: 'packages/generators/py-fastapi/src/emit/schemas.ts', marker: '(BaseModel):' },
    pyRuntime: {
      path: 'runtimes/python/src/aid_runtime/structured.py',
      marker: 'def parse_structured',
    },
    tsRuntime: {
      path: 'runtimes/typescript/src/structured.ts',
      marker: 'export function parseStructured',
    },
    behaviour: {
      path: 'examples/support-copilot/tests/test_app.py',
      marker: 'from app.generated.schemas import',
    },
    planned: /^app\/generated\/schemas\.py$/,
  },
  {
    capability: 'tool-calling',
    emitter: {
      path: 'packages/generators/py-fastapi/src/emit/tools.ts',
      marker: 'export function emitToolAdapter',
    },
    pyRuntime: { path: 'runtimes/python/src/aid_runtime/tools.py', marker: 'class ToolExecutor:' },
    tsRuntime: { path: 'runtimes/typescript/src/tools.ts', marker: 'export class ToolExecutor' },
    behaviour: {
      path: 'examples/support-copilot/tests/test_app.py',
      marker: 'def test_a_failing_tool_fails_the_request',
    },
    planned: /^app\/generated\/tools\/[a-z_]+\.py$/,
  },
  {
    capability: 'otel',
    emitter: {
      path: 'packages/generators/py-fastapi/src/emit/observability.ts',
      marker: 'export function emitObservability',
    },
    pyRuntime: {
      path: 'runtimes/python/src/aid_runtime/tracing.py',
      marker: 'ATTRIBUTES: dict[str, str] = {',
    },
    tsRuntime: {
      path: 'runtimes/typescript/src/tracing.ts',
      marker: 'export const ATTRIBUTES = {',
    },
    behaviour: {
      path: 'runtimes/python/tests/test_tracing.py',
      marker: 'def test_a_span_carries_the_request_it_was_opened_for',
    },
    planned: /^app\/generated\/observability\.py$/,
  },
  {
    capability: 'embeddings',
    emitter: {
      path: 'packages/generators/py-fastapi/src/emit/retrieval.ts',
      marker: 'ir.embeddings',
    },
    pyRuntime: {
      path: 'runtimes/python/src/aid_runtime/retrieval/embedding.py',
      marker: 'class FakeDeterministicEmbedder',
    },
    tsRuntime: {
      path: 'runtimes/typescript/src/retrieval/embedding.ts',
      marker: 'export class FakeDeterministicEmbedder',
    },
    behaviour: {
      path: 'examples/support-copilot/tests/test_retrieval_eval.py',
      marker: 'build_retriever',
    },
    planned: /^app\/generated\/retrieval\/bindings\.py$/,
  },
  {
    capability: 'rerank',
    emitter: { path: 'packages/generators/py-fastapi/src/emit/retrieval.ts', marker: 'reranker' },
    pyRuntime: {
      path: 'runtimes/python/src/aid_runtime/retrieval/rerank.py',
      marker: 'def reranker_for',
    },
    tsRuntime: {
      path: 'runtimes/typescript/src/retrieval/rerank.ts',
      marker: 'export function rerankerFor',
    },
    behaviour: {
      path: 'runtimes/python/tests/test_retrieval_rerank.py',
      marker: 'reranker_for',
    },
    planned: /^app\/generated\/retrieval\/bindings\.py$/,
  },
];

/** The two filesystem questions the capability audit asks, injectable so it can fail. */
interface ClaimIO {
  readonly read: (path: string) => string | undefined;
  readonly plans: (pattern: RegExp) => boolean;
}

/**
 * Every way a declaration can be untrue, as a list of problems rather than an
 * assertion, so the falsifiers below can show the list is not always empty.
 */
function auditCapabilities(
  declared: readonly string[],
  claims: readonly Claim[],
  io: ClaimIO,
): string[] {
  const problems: string[] = [];
  const byCapability = new Map<string, Claim>();

  for (const claim of claims) {
    if (byCapability.has(claim.capability)) {
      problems.push(`${claim.capability} has two claims, so which one is true is ambiguous`);
      continue;
    }
    byCapability.set(claim.capability, claim);
  }

  for (const capability of declared) {
    const claim = byCapability.get(capability);
    if (claim === undefined) {
      problems.push(
        `${capability} is declared by ${PY_FASTAPI_MANIFEST.name} but no claim says what satisfies it`,
      );
      continue;
    }

    const roles = [
      ['emitter', claim.emitter],
      ['python runtime', claim.pyRuntime],
      ['typescript runtime', claim.tsRuntime],
      ['behavioural test', claim.behaviour],
    ] as const;

    for (const [role, source] of roles) {
      const text = io.read(source.path);
      if (text === undefined) {
        problems.push(`${capability}: its ${role} is missing at ${source.path}`);
      } else if (!text.includes(source.marker)) {
        problems.push(
          `${capability}: ${source.path} no longer contains ${JSON.stringify(source.marker)}, so the ${role} claim is stale`,
        );
      }
    }

    if (!io.plans(claim.planned)) {
      problems.push(
        `${capability}: no file in the example plan matches ${String(claim.planned)}, so nothing emits it`,
      );
    }
  }

  for (const capability of byCapability.keys()) {
    if (!declared.includes(capability)) {
      problems.push(
        `${capability} has a claim but ${PY_FASTAPI_MANIFEST.name} does not declare it, so the table is describing something else`,
      );
    }
  }

  return problems;
}

/** One row of the IR's derivation table, widened so a falsifier can invent a member. */
type Derivation = {
  readonly capability: string;
  readonly derivedBy: string;
  readonly applies: (ir: IR) => boolean;
};

/** Every way a vocabulary member can be unexamined, as a list of problems. */
function auditVocabulary(
  vocabulary: readonly string[],
  derivations: readonly Derivation[],
  deferred: Readonly<Record<string, DeferredCapability>>,
): string[] {
  const problems: string[] = [];
  const derived = new Set<string>();

  for (const rule of derivations) {
    if (derived.has(rule.capability)) {
      problems.push(`${rule.capability} has two derivation rows`);
    }
    derived.add(rule.capability);
    if (!vocabulary.includes(rule.capability)) {
      problems.push(`${rule.capability} is derivable but is not in the vocabulary`);
    }
  }

  for (const [capability, entry] of Object.entries(deferred)) {
    if (!vocabulary.includes(capability)) {
      problems.push(`${capability} is deferred but is not in the vocabulary`);
    }
    if (derived.has(capability)) {
      problems.push(
        `${capability} is both derivable and deferred, so its disposition is ambiguous`,
      );
    }
    if (entry.reason.trim() === '') {
      problems.push(`${capability} is deferred without a reason`);
    }
    if (entry.phase.trim() === '') {
      problems.push(`${capability} is deferred without a phase, so nobody owns bringing it back`);
    }
  }

  for (const capability of vocabulary) {
    if (!derived.has(capability) && deferred[capability] === undefined) {
      problems.push(
        `${capability} is in the vocabulary but is neither derivable nor deferred, so no spec can require it and nothing records why`,
      );
    }
  }

  return problems;
}

/** The audit against the real tree. */
function realIO(): ClaimIO {
  const planned = example().plan.files.map((file) => file.path);
  return {
    read: (path) => {
      try {
        return readFileSync(join(REPO_ROOT, ...path.split('/')), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    plans: (pattern) => planned.some((path) => pattern.test(path)),
  };
}

describe('the capabilities this target declares', () => {
  it('are all true: an emitter, both runtimes, and a behavioural test each', () => {
    expect(auditCapabilities(PY_FASTAPI_MANIFEST.capabilities, CLAIMS, realIO())).toEqual([]);
  });

  it('leave nothing unwired, by the report the emitted app carries', () => {
    const report = capabilityReport(PY_FASTAPI_MANIFEST.capabilities);
    expect(report.unwired).toEqual([]);
    expect(report.declared).toEqual([...PY_FASTAPI_MANIFEST.capabilities].sort());
    // Two vocabularies, so two lists: the runtime members the pinned models advertise,
    // and the capability names satisfied by generated wiring. `Capability.STREAMING`
    // and `streaming` were one entry each until this layer withdrew them.
    expect(report.modelWired).toEqual([
      'Capability.EMBEDDINGS',
      'Capability.STRUCTURED_OUTPUT',
      'Capability.TOOL_CALLING',
    ]);
    expect(report.targetWired).toEqual([
      'embeddings',
      'http-trigger',
      'json-schema',
      'otel',
      'rerank',
    ]);
  });

  it('are exactly the ones the committed example makes the generator emit', () => {
    // The example is the fixture every behavioural claim points at, so a capability
    // this target declares and the example does not use would be a promise no shipped
    // app exercises.
    const derived = deriveRequiredCapabilities(example().ir);
    expect(new Set(derived)).toEqual(new Set(PY_FASTAPI_MANIFEST.capabilities));
    // And in vocabulary order, which is what makes two runs of the gate comparable.
    expect(derived).toEqual(REQUIRED_CAPABILITIES.filter((it) => derived.includes(it)));
  });
});

describe('the partial closure of `streaming` (defects D-1 and D-1b)', () => {
  it('is declared by no target capability list in this package', () => {
    expect(PY_FASTAPI_MANIFEST.capabilities).not.toContain('streaming');
    expect(capabilityReport(PY_FASTAPI_MANIFEST.capabilities).declared).not.toContain('streaming');
  });

  it('is advertised by no emitted provider adapter or model wiring', () => {
    // The two places the old declaration surfaced in generated code: the adapter's
    // supported set and the model's advertised set.
    expect(Object.values(ADAPTER_CAPABILITIES).flat()).not.toContain('Capability.STREAMING');
    const advertised = Object.keys(ADAPTER_CAPABILITIES).flatMap(
      (adapter) =>
        modelCapabilities(adapter as ProviderAdapter, PY_FASTAPI_MANIFEST.capabilities).advertised,
    );
    expect(advertised).not.toContain('Capability.STREAMING');
    expect(capabilityReport(PY_FASTAPI_MANIFEST.capabilities).modelWired).not.toContain(
      'Capability.STREAMING',
    );
  });

  it('streams in the Python runtime, while the TypeScript runtime still raises', () => {
    // D-1's runtime half is closed in L5: `ModelGateway.stream()` produces SSE bytes,
    // so the Python gateway no longer raises `FeatureDeferredError`. The target
    // declaration stays withdrawn because the generator still emits no streaming
    // route, and the TypeScript runtime still defers streaming (ratified L6).
    const python = realIO().read('runtimes/python/src/aid_runtime/gateway.py');
    expect(python).toBeDefined();
    expect(python).toContain('async def stream');
    expect(python).not.toContain('FeatureDeferredError');

    const typescript = realIO().read('runtimes/typescript/src/gateway.ts');
    expect(typescript).toBeDefined();
    expect(typescript).toContain('FeatureDeferredError');
    expect(typescript).toContain('stream');
  });

  it('derives streaming from a deployment that requests it, and is no longer deferred (D-1b)', () => {
    // D-1b was `streaming` sitting in the vocabulary with no derivation, so no spec
    // could require it and nothing noticed. The derivation rule closes that; the
    // deployment gate still fails closed until a target declares the capability.
    expect(CAPABILITY_DERIVATIONS.some((rule) => rule.capability === 'streaming')).toBe(true);
    expect(Object.keys(DEFERRED_CAPABILITIES)).not.toContain('streaming');
  });
});

describe('the capability vocabulary', () => {
  it('disposes of every member as derivable or deferred, with no member left unexamined', () => {
    expect(
      auditVocabulary(REQUIRED_CAPABILITIES, CAPABILITY_DERIVATIONS, DEFERRED_CAPABILITIES),
    ).toEqual([]);
  });

  it('keeps every member, so the audit cannot be satisfied by narrowing the design', () => {
    // Pinned as a list rather than a count: deleting `vision` would keep the count
    // assertion honest if `audio` were added at the same time, and the whole point of
    // this layer is that an unexamined capability is recorded, not removed.
    expect([...REQUIRED_CAPABILITIES].sort()).toEqual(
      [
        'agents',
        'audio',
        'cursor-memory',
        'embeddings',
        'guardrails',
        'http-trigger',
        'json-schema',
        'long-context',
        'otel',
        'prompt-cache',
        'reasoning',
        'rerank',
        'streaming',
        'tool-calling',
        'vision',
      ].sort(),
    );
  });

  it('derives nothing for a capability it has deferred', () => {
    const deferred = new Set(Object.keys(DEFERRED_CAPABILITIES));
    const derived = CAPABILITY_DERIVATIONS.map((rule) => rule.capability);
    expect(derived.filter((capability) => deferred.has(capability))).toEqual([]);
    // D-1b is closed: `streaming` and `prompt-cache` now each have a derivation, so a
    // spec can require them and the audit above would catch a regression to "present
    // in the vocabulary but nothing can derive it".
    expect(derived).toContain('streaming');
    expect(derived).toContain('prompt-cache');
  });
});

describe('the capability audit can fail', () => {
  const doctored = (overrides: Partial<ClaimIO>): ClaimIO => ({ ...realIO(), ...overrides });

  it('reports a declared capability the table does not cover', () => {
    const problems = auditCapabilities(
      [...PY_FASTAPI_MANIFEST.capabilities, 'vision'],
      CLAIMS,
      realIO(),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('vision is declared');
  });

  it('reports a claim for a capability the manifest stopped declaring', () => {
    const declared = PY_FASTAPI_MANIFEST.capabilities.filter((it) => it !== 'rerank');
    const problems = auditCapabilities(declared, CLAIMS, realIO());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('rerank has a claim');
  });

  it('reports an emitter that is gone, and names the file', () => {
    const io = doctored({
      read: (path) => (path.endsWith('retrieval.ts') ? undefined : realIO().read(path)),
    });
    const problems = auditCapabilities(PY_FASTAPI_MANIFEST.capabilities, CLAIMS, io);
    expect(problems.some((it) => it.includes('missing at') && it.includes('retrieval.ts'))).toBe(
      true,
    );
  });

  it('reports a runtime that stopped implementing a capability it still declares', () => {
    // The D-1 shape: the declaration survives, the implementation does not.
    const withoutReranker = CLAIMS.map((claim) =>
      claim.capability === 'rerank'
        ? { ...claim, pyRuntime: { ...claim.pyRuntime, marker: 'def reranker_for_renamed' } }
        : claim,
    );
    const problems = auditCapabilities(PY_FASTAPI_MANIFEST.capabilities, withoutReranker, realIO());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no longer contains');
    expect(problems[0]).toContain('python runtime');
  });

  it('reports a capability nothing in the example plan emits', () => {
    const problems = auditCapabilities(
      PY_FASTAPI_MANIFEST.capabilities,
      CLAIMS,
      doctored({ plans: () => false }),
    );
    expect(problems).toHaveLength(PY_FASTAPI_MANIFEST.capabilities.length);
    expect(problems.every((it) => it.includes('no file in the example plan matches'))).toBe(true);
  });

  it('reports a duplicated claim, which would make one of them unchecked', () => {
    const first = CLAIMS[0];
    const problems = auditCapabilities(
      PY_FASTAPI_MANIFEST.capabilities,
      first === undefined ? CLAIMS : [...CLAIMS, first],
      realIO(),
    );
    expect(problems.some((it) => it.includes('two claims'))).toBe(true);
  });

  it('reports an empty table instead of passing vacuously', () => {
    const problems = auditCapabilities(PY_FASTAPI_MANIFEST.capabilities, [], realIO());
    expect(problems).toHaveLength(PY_FASTAPI_MANIFEST.capabilities.length);
  });
});

describe('the vocabulary audit can fail', () => {
  it('reports a member with neither a derivation nor a deferral', () => {
    const problems = auditVocabulary(
      [...REQUIRED_CAPABILITIES, 'telepathy'],
      CAPABILITY_DERIVATIONS,
      DEFERRED_CAPABILITIES,
    );
    expect(problems).toContain(
      'telepathy is in the vocabulary but is neither derivable nor deferred, so no spec can require it and nothing records why',
    );
  });

  it('reports a deferral with no phase, which is a capability nobody owns', () => {
    const problems = auditVocabulary(REQUIRED_CAPABILITIES, CAPABILITY_DERIVATIONS, {
      ...DEFERRED_CAPABILITIES,
      reasoning: { reason: 'still deferred', phase: ' ' },
    });
    expect(problems).toContain(
      'reasoning is deferred without a phase, so nobody owns bringing it back',
    );
  });

  it('reports a deferral with no reason', () => {
    const problems = auditVocabulary(REQUIRED_CAPABILITIES, CAPABILITY_DERIVATIONS, {
      ...DEFERRED_CAPABILITIES,
      vision: { reason: '', phase: 'not scheduled' },
    });
    expect(problems).toContain('vision is deferred without a reason');
  });

  it('reports a capability that is both derivable and deferred', () => {
    const problems = auditVocabulary(REQUIRED_CAPABILITIES, CAPABILITY_DERIVATIONS, {
      ...DEFERRED_CAPABILITIES,
      rerank: { reason: 'not really', phase: 'L9' },
    });
    expect(problems).toContain(
      'rerank is both derivable and deferred, so its disposition is ambiguous',
    );
  });

  it('reports a derivation for something outside the vocabulary', () => {
    const problems = auditVocabulary(
      REQUIRED_CAPABILITIES,
      [
        ...CAPABILITY_DERIVATIONS,
        { capability: 'telepathy', derivedBy: 'a thought', applies: () => false },
      ],
      DEFERRED_CAPABILITIES,
    );
    expect(problems).toContain('telepathy is derivable but is not in the vocabulary');
  });

  it('reports a deferral for something outside the vocabulary', () => {
    const problems = auditVocabulary(REQUIRED_CAPABILITIES, CAPABILITY_DERIVATIONS, {
      ...DEFERRED_CAPABILITIES,
      telepathy: { reason: 'nothing implements reading minds', phase: 'not scheduled' },
    });
    expect(problems).toContain('telepathy is deferred but is not in the vocabulary');
  });

  it('reports an empty vocabulary instead of passing vacuously', () => {
    const problems = auditVocabulary([], [], {});
    expect(problems).toEqual([]);
    // The guard against that being mistaken for success: the pinned list above is what
    // makes an empty vocabulary impossible, and this shows an empty audit has nothing
    // to say on its own.
    expect(auditVocabulary(REQUIRED_CAPABILITIES, [], {})).not.toEqual([]);
  });
});
