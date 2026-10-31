/**
 * The P7b surface: `agents` and `memory`.
 *
 * P7a closed `deployments`, `guardrails` and streaming and left `UNSUPPORTED_COLLECTIONS` at
 * `['agents', 'memory']`. This layer consumes both, so both leave the list -- and every test
 * here is written so that undoing that consumption fails it rather than passing on a branch
 * the shipped example already takes.
 *
 * The load-bearing claim is the resume route's predicate. `RunStatus.PAUSED` is reachable
 * three ways and only one of them involves `humanInTheLoop`:
 *
 *   1. `agent.approval is not None` -- the spec's `humanInTheLoop`.
 *   2. any tool the agent calls with `requiresConfirmation: true`. `_needs_approval` checks
 *      this *before* it consults `agent.approval`, so it pauses an agent that declares no
 *      policy at all.
 *   3. any guardrail the agent names with `action: escalate`. `_guardrail_pause` fires at the
 *      input, output and tool-call stages with no approval involved.
 *
 * A generator that emitted the route only for (1) would ship an app that pauses with no way
 * to resume for an agent that only ever used (2) or (3). Each source therefore gets a spec
 * that turns on exactly that source and nothing else, and the negative case proves the route
 * is absent when none is on.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IR, MemoryShape } from '@aid-framework/ir';
import { deriveRequiredCapabilities } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { planPyFastApi } from '../src/index.js';
import {
  agentCanPause,
  agentModelClosure,
  checkPlan,
  SUPPORTED_MEMORY_KINDS,
  UNSUPPORTED_COLLECTIONS,
} from '../src/validate.js';
import { buildForSpecText, fileMap, lowerForSpecText, REPO_ROOT } from './helpers.js';

/** Every kind the spec language offers, so no kind can be neither emitted nor refused. */
const MEMORY_KINDS: readonly MemoryShape['kind'][] = [
  'buffer',
  'window',
  'summary',
  'semantic',
  'episodic',
  'vector',
];

/** The two fake models a pipeline can use and an agent cannot, priced and unpriced. */
const UNPRICED_FAKE_MODEL = 'fast';

/** A tool an agent may call that moves no money, so only `auth`/confirmation are in play. */
const READ_TOOL = 'lookup_customer';

interface Options {
  /** Source 1: the spec's `humanInTheLoop`. */
  readonly humanInTheLoop?: boolean;
  /** Source 2: `requiresConfirmation: true` on a tool the agent calls. */
  readonly confirmingTool?: boolean;
  /** Source 3: a guardrail the agent names with `action: escalate`. */
  readonly escalatingGuardrail?: boolean;
  /** Whether the agent declares a `buffer` memory tier at all. */
  readonly memory?: boolean;
  /** Overrides the tier's `kind`, for the refusal cases. */
  readonly memoryKind?: string;
  /** Extra YAML under the tier, for the fields the runtime drops. */
  readonly memoryExtra?: string;
  /** Extra fields under the agent, used to reach the refusals. */
  readonly agentExtra?: string;
  /** A `fallbacks` edge from the agent's model to an unpriced one. */
  readonly agentModelFallback?: boolean;
  /** Makes the agent's instructions prompt take a variable. */
  readonly instructionsWithVariables?: boolean;
}

/**
 * One py-fastapi app with exactly one agent, described so each variant flips one thing.
 *
 * There is deliberately no pipeline: the source of a pause must be unambiguous, and an HTTP
 * generate route would drag in the input-guardrail security gate, which is a P7a concern.
 */
function specText(options: Options = {}): string {
  const kind = options.memoryKind ?? 'buffer';
  const tool = options.confirmingTool ? 'issue_refund' : READ_TOOL;
  const guardrails = options.escalatingGuardrail ? '[held, inspected]' : '[inspected]';
  const memoryTier =
    options.memory === false
      ? ''
      : `
memory:
  thread:
    kind: ${kind}
    scope: thread
    tokenBudget: 2000${options.memoryExtra ?? ''}
`;
  const agentMemory = options.memory === false ? '' : '\n    memory: [thread]';
  const approval =
    options.humanInTheLoop === true
      ? `
    humanInTheLoop:
      when: "true"
      channel: reviews`
      : '';
  const variables =
    options.instructionsWithVariables === true
      ? `
    variables:
      subject:
        type: string
        required: true`
      : '';

  return `specVersion: "0.2"

project:
  name: agents
  namespace: aid.test.agents
  description: One agent, for exercising the P7b surface.
  targets: [py-fastapi]

types:
  Reply:
    kind: struct
    fields:
      summary:
        type: string
        required: true
  Customer:
    kind: struct
    fields:
      id:
        type: string
        required: true
  Refund:
    kind: struct
    fields:
      amount:
        type: number
        required: true
      subject:
        type: string
        required: true
  RefundReceipt:
    kind: struct
    fields:
      reference:
        type: string
        required: true

models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema, streaming]
  triage:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools]
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 400${
        options.agentModelFallback === true ? `\n    fallbacks: [${UNPRICED_FAKE_MODEL}]` : ''
      }

prompts:
  agent_instructions:
    version: 1
    model: triage
    template: |
      Look the account up, then answer in one sentence.
    output:
      kind: text${variables}

tools:
  lookup_customer:
    description: Look up the account that filed a ticket.
    input: Customer
    output: Customer
    handler:
      kind: business
      symbol: lookup_customer
    sideEffects: read
  issue_refund:
    description: Issue a refund against the account that filed a ticket.
    input: Refund
    output: RefundReceipt
    handler:
      kind: business
      symbol: issue_refund
    sideEffects: write
    requiresConfirmation: true
    auth: isAuthenticated()

guardrails:
  inspected:
    stages: [tool-call]
    policies: [secret-scan]
    action: block
    onFail:
      message: The call was refused.
      log: true
  held:
    stages: [tool-call]
    policies: [secret-scan]
    action: escalate
    onFail:
      message: The call was held for a person to look at.
      log: true
${memoryTier}
agents:
  helper:
    name: Helper
    instructions: agent_instructions
    model: triage
    tools: [${tool}]
    guardrails: ${guardrails}${agentMemory}
    maxSteps: 4
    maxCostBudget: 0.05${approval}${options.agentExtra ?? ''}
`;
}

type Built = ReturnType<typeof buildForSpecText>;

/** Codes `checkPlan` reports for a spec, without planning it. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

/** The `thread` tier replaced by `mutate`, leaving every other collection alone. */
function withMemoryTier(ir: IR, mutate: (tier: MemoryShape) => MemoryShape): IR {
  return {
    ...ir,
    memory: (ir.memory ?? []).map((tier) => (tier.id === 'thread' ? mutate(tier) : tier)),
  };
}

/** The diagnostics `checkPlan` reports, rendered for a failure message. */
function renderProblems(ir: IR): string {
  return checkPlan(ir)
    .map((problem) => `  ${problem.code}: ${problem.path}: ${problem.message}`)
    .join('\n');
}

/** `app/generated/agents.py` as the plan writes it, or `undefined` when there is no emitter. */
function agentsSource(built: Built): string | undefined {
  return fileMap(built.plan.files).get('app/generated/agents.py');
}

/** `app/generated/deps.py` as the plan writes it. */
function depsSource(built: Built): string {
  const source = fileMap(built.plan.files).get('app/generated/deps.py');
  if (source === undefined) throw new Error('the plan wrote no deps.py');
  return source;
}

/** `app/generated/tools/__init__.py` as the plan writes it. */
function toolsSource(built: Built): string {
  const source = fileMap(built.plan.files).get('app/generated/tools/__init__.py');
  if (source === undefined) throw new Error('the plan wrote no tools/__init__.py');
  return source;
}

/** The `DOCUMENT` literal's `models` ids, in emitted order. */
function documentModels(built: Built): string[] {
  const source = agentsSource(built);
  if (source === undefined) throw new Error('the plan wrote no agents.py');
  const start = source.indexOf('"models": [');
  if (start === -1) throw new Error('DOCUMENT carries no models');
  // The document is emitted with sorted keys at four-space indent, so the only `    ],`
  // after the opening bracket is the one that closes `models`.
  const end = source.indexOf('\n    ],', start);
  const block = source.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/^ {12}"id": "([^"]+)",$/gm)].map((match) => match[1] as string);
}

/** Whether the emitted router binds `/agents/resume`, which is the whole claim. */
function hasResumeRoute(built: Built): boolean {
  return (agentsSource(built) ?? '').includes('"/agents/resume"');
}

/** Asserts which of the three pause sources a spec actually turns on. */
function sourcesOn(built: Built): string[] {
  const agent = built.ir.agents[0];
  if (agent === undefined) throw new Error('the spec declares no agent');
  const on: string[] = [];
  if (agent.humanInTheLoop !== undefined) on.push('humanInTheLoop');
  const byTool = new Map(built.ir.tools.map((tool) => [tool.id, tool]));
  if (agent.tools.some((id) => byTool.get(id)?.requiresConfirmation === true)) {
    on.push('requiresConfirmation');
  }
  const byGuardrail = new Map((built.ir.guardrails ?? []).map((entry) => [entry.id, entry]));
  if (agent.guardrails.some((id) => byGuardrail.get(id)?.action === 'escalate')) {
    on.push('escalate');
  }
  return on;
}

describe('the resume route is emitted for each way a run can pause', () => {
  /**
   * Each variant turns on exactly one source, so a predicate that dropped that source fails
   * here and nowhere else. Asserting the *other* two are off is what makes that true: a
   * variant that quietly turned on a second source would still emit the route and the test
   * would prove nothing.
   */
  const cases = [
    {
      name: 'a humanInTheLoop policy',
      options: { humanInTheLoop: true },
      source: 'humanInTheLoop',
    },
    {
      name: 'a confirming tool',
      options: { confirmingTool: true },
      source: 'requiresConfirmation',
    },
    {
      name: 'an escalating guardrail',
      options: { escalatingGuardrail: true },
      source: 'escalate',
    },
  ] as const;

  for (const { name, options, source } of cases) {
    it(`emits it for ${name}, with no other source involved`, () => {
      const built = buildForSpecText(specText(options));

      expect(sourcesOn(built)).toEqual([source]);
      expect(checkPlan(built.ir)).toEqual([]);
      expect(hasResumeRoute(built)).toBe(true);
    });
  }

  it('emits no route, and no checkpoint plumbing, when nothing can pause', () => {
    const built = buildForSpecText(specText());

    expect(sourcesOn(built)).toEqual([]);
    const only = built.ir.agents[0];
    if (only === undefined) throw new Error('the spec declares no agent');
    expect(agentCanPause(built.ir, only)).toBe(false);
    expect(hasResumeRoute(built)).toBe(false);

    // The imports follow the route, or an app that cannot pause would carry a name it never
    // uses -- which `ruff` rejects at F401 rather than tolerating.
    const source = agentsSource(built) ?? '';
    expect(source).not.toContain('AgentCheckpoint');
    expect(source).not.toContain('HumanDecision');
    expect(source).not.toContain('ValidationError');
    expect(source).not.toContain('resume_agent');

    // The prose follows the route too: a checkpoint nobody can hand back is not "what
    // `/agents/resume` takes back", and ruff does not catch a docstring that lies.
    expect(source).not.toContain('/agents/resume');
  });
});

describe('the emitted agent surface', () => {
  it('resolves every relative import to a sibling the same plan emits', () => {
    const built = buildForSpecText(specText());
    const source = agentsSource(built) ?? '';
    const emitted = new Set(built.plan.files.map((file) => file.path));

    // `agents.py` is a single module in `app/generated/`, so one dot is that directory and two
    // escape to `app/`, which owns neither `prompts` nor `deps`. That is an ImportError at
    // boot: no type checker sees generated Python, and ruff only checks what it can import.
    const relative = [...source.matchAll(/^from (\.[\w.]*) import /gm)].map(
      (match) => match[1] ?? '',
    );

    expect(relative.length).toBeGreaterThan(0);
    for (const specifier of relative) {
      const depth = specifier.length - specifier.replace(/^\.+/, '').length;
      expect(depth, specifier).toBe(1);
      const module = specifier.slice(depth).replaceAll('.', '/');
      const resolves =
        emitted.has(`app/generated/${module}.py`) ||
        emitted.has(`app/generated/${module}/__init__.py`);
      expect(resolves, specifier).toBe(true);
    }
  });

  it('carries the tool flags the runtime reads, rather than dropping them', () => {
    const built = buildForSpecText(specText({ confirmingTool: true }));
    const source = agentsSource(built) ?? '';

    // `requires_confirmation` and `auth` live on the IR `ToolSpec`, which `from_ir` reads
    // from the document -- not on the runtime `Tool` object -- so the document is the only
    // place they can be lost, and the only place worth pinning.
    expect(source).toContain('"requiresConfirmation": True');
    expect(source).toContain('"sideEffects": "write"');
    expect(source).toContain('"kind": "call"');
    expect(source).toContain('"name": "isAuthenticated"');
  });

  it('narrows the document to the models the agent route can actually reach', () => {
    const built = buildForSpecText(specText());

    // `fast` is declared but unpriced and no agent names it; emitting it would make
    // `from_ir` build a spec for it and `_model` refuse the whole document.
    expect(built.ir.models.map((model) => model.id)).toContain(UNPRICED_FAKE_MODEL);
    expect(agentModelClosure(built.ir).map((model) => model.id)).toEqual(['triage']);
    expect(documentModels(built)).toEqual(['triage']);
  });
});

describe('two seams over one tool set', () => {
  it('builds the executor from the agent tools rather than adapting them twice', () => {
    const built = buildForSpecText(specText());
    const source = toolsSource(built);

    // A second `Tool.of` per tool would let the pipeline route and the agent route drift on
    // permission and confirmation; deriving one from the other makes that unrepresentable.
    expect(source.match(/Tool\.of\(/g) ?? []).toHaveLength(0);
    expect(source).toContain('tools = build_agent_tools(');
    expect(source).toContain('return ToolExecutor(tools=tools)');
  });

  it('shares one tuple with the dependency container', () => {
    const built = buildForSpecText(specText());
    const source = depsSource(built);

    expect(source).toContain(
      'agent_tools: tuple[Tool, ...] = field(default_factory=build_agent_tools)',
    );
    expect(source).toContain(
      'declared_tools = build_agent_tools() if agent_tools is None else agent_tools',
    );
    expect(source).toContain('agent_tools=declared_tools');
  });
});

describe('memory backends the runtime cannot serve are refused', () => {
  it('pins the generator to the kinds the runtime actually implements', () => {
    // Read the runtime rather than restating it: a kind added there without the generator
    // following is exactly the drift this layer exists to prevent.
    const source = readFileSync(
      join(REPO_ROOT, 'runtimes', 'python', 'src', 'aid_runtime', 'agents', 'memory.py'),
      'utf8',
    );
    const match = /IMPLEMENTED_MEMORY_KINDS\s*(?::[^=]+)?=\s*\(([^)]*)\)/.exec(source);
    expect(match, 'IMPLEMENTED_MEMORY_KINDS was not found in memory.py').not.toBeNull();
    const implemented = [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);

    expect([...SUPPORTED_MEMORY_KINDS]).toEqual(implemented);
  });

  it('accepts the kinds it implements', () => {
    for (const kind of SUPPORTED_MEMORY_KINDS) {
      const built = buildForSpecText(specText({ memoryKind: kind }));
      expect(checkPlan(built.ir)).toEqual([]);
      expect(agentsSource(built) ?? '').toContain(`"kind": "${kind}"`);
    }
  });

  /**
   * Bad memory tiers, each made by editing one that lowers and gates cleanly.
   *
   * These are IR edits rather than spec text on purpose. The IR-level `memory` gate already
   * rejects `summary` without a `summarizeModel`, an undeclared `backend` and an undeclared
   * `store`, so spec text would test that gate and never reach this target. The target still
   * has to refuse them: `planPyFastApi` is a public entry point over an arbitrary IR, and a
   * tier this emitter silently dropped would be invisible at the gate that let it through.
   */
  const refusals: readonly {
    name: string;
    mutate: (tier: MemoryShape) => MemoryShape;
    path: string;
  }[] = [
    {
      name: 'a `summary` tier',
      mutate: (tier) => ({ ...tier, kind: 'summary' }),
      path: 'memory.thread.kind',
    },
    {
      name: 'a `summarizeModel`',
      mutate: (tier) => ({ ...tier, summarizeModel: 'triage' }),
      path: 'memory.thread.summarizeModel',
    },
    {
      name: 'a `ttl`',
      mutate: (tier) => ({ ...tier, ttl: '1h' }),
      path: 'memory.thread.ttl',
    },
    {
      name: 'a non-empty `redact`',
      mutate: (tier) => ({ ...tier, redact: ['email'] }),
      path: 'memory.thread.redact',
    },
    {
      name: 'a backend no generated app registers',
      mutate: (tier) => ({ ...tier, backend: 'redis' }),
      path: 'memory.thread.backend',
    },
    {
      name: 'a `store` the runtime never reads',
      mutate: (tier) => ({ ...tier, store: 'handbook' }),
      path: 'memory.thread.store',
    },
  ];

  for (const { name, mutate, path } of refusals) {
    it(`refuses ${name} instead of ignoring it`, () => {
      const ir = withMemoryTier(lowerForSpecText(specText({ memory: true })), mutate);

      expect(codes(ir)).toContain('unsupported-memory');
      expect(checkPlan(ir).map((problem) => problem.path)).toContain(path);
    });
  }

  it('rejects every declared memory kind but the two the runtime implements', () => {
    // The strong version: for each kind, either the generator emits it or it refuses. A
    // kind that is neither is one the document would name and the runtime would not serve.
    for (const kind of MEMORY_KINDS) {
      const ir = withMemoryTier(lowerForSpecText(specText({ memory: true })), (tier) => ({
        ...tier,
        kind,
      }));
      // Widened deliberately: the point is that a kind outside the supported set is refused,
      // so `includes` is being asked about the spec's wider union, not the emitted subset.
      const emitted = (SUPPORTED_MEMORY_KINDS as readonly string[]).includes(kind);

      expect(checkPlan(ir).length === 0, `kind '${kind}'`).toBe(emitted);
    }
  });

  it('accepts `in-process`, which is the store a generated app actually gets', () => {
    const built = buildForSpecText(specText({ memoryExtra: '\n    backend: in-process' }));
    expect(checkPlan(built.ir)).toEqual([]);
  });
});

describe('an agent declaration the runtime would drop is refused', () => {
  it('refuses an agent whose model reaches an unpriced model through a fallback', () => {
    const ir = lowerForSpecText(specText({ agentModelFallback: true }));

    // The closure is what gets emitted, so the fallback is what the route would read -- and
    // `_model` refuses an unpriced model, so the document would fail on the first request.
    expect(agentModelClosure(ir).map((model) => model.id)).toEqual(['fast', 'triage']);
    expect(checkPlan(ir).map((problem) => problem.path)).toContain(
      `models.${UNPRICED_FAKE_MODEL}.costProfile`,
    );
  });

  it('refuses instructions whose prompt declares variables the loop never renders', () => {
    const ir = lowerForSpecText(specText({ instructionsWithVariables: true }));

    expect(checkPlan(ir).map((problem) => problem.path)).toContain('agents.helper.instructions');
    expect(renderProblems(ir)).toContain('never renders');
  });

  const agentRefusals: readonly { name: string; extra: string; path: string }[] = [
    {
      name: 'structuredOutput',
      extra: '\n    structuredOutput: Reply',
      path: 'agents.helper.structuredOutput',
    },
    {
      name: 'engine `deepagents`',
      extra: '\n    engine: deepagents\n    engineVersion: "0.0.1"',
      path: 'agents.helper.engine',
    },
  ];

  for (const { name, extra, path } of agentRefusals) {
    it(`refuses ${name}`, () => {
      const ir = lowerForSpecText(specText({ agentExtra: extra }));
      expect(checkPlan(ir).map((problem) => problem.path)).toContain(path);
    });
  }

  it('refuses retrievers, which the loop has no step to run', () => {
    // Done as an IR edit rather than spec text: `agents.helper.retrievers: []` is the
    // default, and a non-empty list would need a whole retriever and store declared to
    // pass the build gates -- which would make this test about the retriever layer.
    const ir = lowerForSpecText(specText());
    const agent = ir.agents[0];
    if (agent === undefined) throw new Error('the spec declares no agent');
    const withRetriever: IR = {
      ...ir,
      agents: [{ ...agent, retrievers: ['handbook'] }],
    };

    expect(codes(withRetriever)).toContain('unsupported-agent');
    expect(() => planPyFastApi(withRetriever)).toThrow(/no retrieval step/);
  });
});

describe('the collection list', () => {
  it('is empty, because both emitters now exist', () => {
    // P7a left `['agents', 'memory']` here. P21 decision 4 allows an entry to leave only
    // when its emitter does, and both now do -- the assertion above and the tests in this
    // file are what "does" means.
    expect([...UNSUPPORTED_COLLECTIONS]).toEqual([]);
  });
});

describe('a spec with no agent and no memory', () => {
  it('gets no agent module, no agent tools and no agent dependency', () => {
    const built = buildForSpecText(specText({ memory: false }).replace(/agents:\n(?:.*\n)*$/, ''));

    expect(built.ir.agents ?? []).toEqual([]);
    expect(built.ir.memory ?? []).toEqual([]);
    expect(agentsSource(built)).toBeUndefined();
    expect(depsSource(built)).not.toContain('agent_tools');
    expect(toolsSource(built)).not.toContain('build_agent_tools');
    // And the app does not derive the capabilities it does not carry, which is what makes
    // the manifest a description of this app rather than of the target's whole vocabulary.
    const derived = deriveRequiredCapabilities(built.ir);
    expect(derived).not.toContain('agents');
    expect(derived).not.toContain('cursor-memory');
  });

  it('is the case the example is not, so the omission is proven rather than assumed', () => {
    const derived = deriveRequiredCapabilities(buildForSpecText(specText()).ir);
    expect(derived).toContain('agents');
    expect(derived).toContain('cursor-memory');
  });
});

/**
 * The pre-P7b example, byte for byte.
 *
 * "An app with no agent emits what it emitted before" is the claim that makes this layer
 * additive, and absence assertions cannot support it: `not.toContain('build_agent_tools')`
 * passes just as happily for a `deps.py` that was rewritten in some other way. So the
 * fixture is the example as it stood at `1eb143fe` (the P7a top commit): its spec, and the
 * SHA-256 of each of the 27 files the generator owned for it. The spec is the input and the
 * digests are the expected output, so a single changed byte anywhere in the generator-owned
 * tier fails this test and names the file.
 *
 * Only the `generated` tier is pinned. The `business` tier is developer-owned -- the
 * generator seeds it once and never rewrites it -- so pinning those bytes would pin the
 * fixture's own contents rather than anything the generator decides.
 *
 * Every digest here was re-recorded once, when the package scope changed to `@aid-framework/*`:
 * the generator's name is written into each generated file, so that rename moved all 27. The
 * `observability.py` pin is deliberately left at its pre-rename value, so the exclusion below
 * still has exactly one file that has moved.
 */
describe('the pre-P7b example', () => {
  const FIXTURE = join(REPO_ROOT, 'packages/generators/py-fastapi/test/fixtures/p7a');
  const specPath = join(FIXTURE, 'app.spec.yaml');
  const expected = JSON.parse(readFileSync(join(FIXTURE, 'digests.json'), 'utf8')) as Record<
    string,
    string
  >;

  /**
   * The one file this layer is allowed to move, and the reason.
   *
   * `observability.py` reports the *target's* declared capability set, not the spec's -- it
   * already named `embeddings` and `rerank` for an example that uses neither. Widening the
   * declaration therefore rewrites it for every spec, including this one, and no emitter
   * change can avoid that. Every other file in the tier is held to the old bytes.
   *
   * The recorded digest of `guardrails.py` was re-baselined once, by L5c, and this is the
   * only file that layer touched here: a `guard` step runs one named declaration, so that
   * module's id table went from private `_BY_ID` to public `BY_ID` and its docstring grew a
   * paragraph saying why. Re-recording is deliberate rather than tolerated -- a second
   * file moving would still fail, which is what the count below is for.
   */
  const DECLARATION_ONLY = 'app/generated/observability.py';

  function digest(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  function planFor(): {
    paths: string[];
    digests: Record<string, string>;
    content: Map<string, string>;
  } {
    const built = buildForSpecText(readFileSync(specPath, 'utf8'), specPath);
    // The claim is about a spec that carries no agent and no memory, which is what this
    // fixture is; if that ever stopped being true the digests would be pinned against a
    // spec that runs the emitters this test exists to hold apart.
    expect(built.ir.agents ?? []).toEqual([]);
    expect(built.ir.memory ?? []).toEqual([]);

    const generated = built.plan.files.filter((file) => file.owner === 'generated');
    return {
      paths: generated.map((file) => file.path).sort(),
      digests: Object.fromEntries(generated.map((file) => [file.path, digest(file.content)])),
      content: new Map(generated.map((file) => [file.path, file.content])),
    };
  }

  it('reproduces every generated byte, so the new emitters are additive', () => {
    const { paths, digests } = planFor();
    // Path sets first, so a file added or removed is reported as that rather than as one
    // inscrutable digest mismatch in a wall of 27 equal ones.
    expect(paths).toEqual(Object.keys(expected).sort());

    const moved = paths.filter((path) => digests[path] !== expected[path]);
    expect(moved).toEqual([DECLARATION_ONLY]);
    // Spelled out rather than only asserted as "one file moved": deleting the exclusion
    // above must fail loudly instead of quietly shrinking the pin.
    expect(paths.length - moved.length).toBe(26);
  });

  it('moved that one file only because the target declared more, not because an emitter ran', () => {
    const { content } = planFor();
    const observability = content.get(DECLARATION_ONLY) ?? '';
    // The declaration block is the whole diff: the two new names are present for a spec that
    // declares neither, because this file reports the target's set and that is deliberately
    // wider than the document's.
    expect(observability).toContain('"agents"');
    expect(observability).toContain('"cursor-memory"');

    // ...and nothing that only an agent route would need is emitted anywhere else. The probe
    // is structural rather than the word "agent", because `guardrails.py` has talked about
    // agents in its docstring since P7a and matching that would pin prose, not wiring.
    //
    // The bare tokens `agents`, `cursor-memory` and `Capability.AGENTS` are deliberately NOT
    // probed for: `observability.py` is the one file that carries them, and it should, because
    // it reports the *target's* set rather than the spec's. Asserting them absent from the
    // other 26 files is the right claim; asserting them absent outright would fail on a file
    // that is behaving correctly and invite weakening the real assertion.
    const others = [...content.entries()].filter(([path]) => path !== DECLARATION_ONLY);
    const markers = [
      'AgentRuntime',
      'AgentDefinition',
      'AgentCheckpoint',
      'AgentRuntimeState',
      'AGENT_IDS',
      'build_agent_tools',
      'build_agent_runtime',
      'agent_router',
      'from aid_runtime.agents import AgentRuntime',
    ];
    const emitted = others.flatMap(([path, text]) =>
      markers.filter((marker) => text.includes(marker)).map((marker) => `${path}: ${marker}`),
    );
    expect(emitted).toEqual([]);
  });

  it('would notice the agent emitter writing a file for it anyway', () => {
    // The mutation this test is built to catch, made by hand rather than described: the
    // digest map is the pre-P7b tree, and `agents.py` is not in it. Asserting the absence
    // here as well keeps the failure legible if the emitter ever stops being gated.
    const { paths } = planFor();
    expect(paths).not.toContain('app/generated/agents.py');
    expect(Object.keys(expected)).not.toContain('app/generated/agents.py');
  });

  it('shipped a fixture whose own digests are intact', () => {
    // The fixture is only evidence if it faithfully records `1eb143fe`. Every digest is a
    // 64-character lowercase hex string, no two files share one, and there are as many as
    // the pre-P7b tree had -- which is what a mis-copied fixture breaks.
    const values = Object.values(expected);
    expect(values).toHaveLength(27);
    expect(values.every((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });
});
