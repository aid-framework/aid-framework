/**
 * The three collections the runtime can execute and this target now emits --
 * `guardrails`, `agents`, `memory` -- as the generated modules state them.
 *
 * The emission cases read the planned module text, because what matters is the file the
 * plan ships: a name that moved between the emitter and `plan.ts` would pass an emitter
 * unit test and break the generated app. The refusal cases go through `checkPlan` on an
 * IR that already passed the spec checks and the gates, which is what makes each refusal
 * this package's rather than an earlier stage's.
 */

import type { IR } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { planTsVercel } from '../src/index.js';
import { checkPlan } from '../src/validate.js';
import { buildForSpecText, fileMap, irForSpecText } from './helpers.js';

const GUARDRAILS = `guardrails:
  handbook_pii:
    stages: [input, output]
    policies: [pii-detect]
    action: block
    onFail:
      message: The payload was refused.
      log: true`;

const MEMORY = `memory:
  thread:
    kind: buffer
    scope: thread
    tokenBudget: 2000`;

const AGENTS = `agents:
  triage_agent:
    name: Triage
    instructions: brief
    model: triage
    tools: []
    guardrails: [handbook_pii]
    memory: [thread]
    maxSteps: 4
    maxCostBudget: 0.05
  backup_agent:
    name: Backup
    instructions: brief
    model: triage
    tools: []
    guardrails: []
    memory: []
    maxSteps: 2
    maxCostBudget: 0.02`;

interface Collections {
  readonly guardrails?: string | undefined;
  readonly memory?: string | undefined;
  readonly agents?: string | undefined;
}

/** A whole 0.2 spec whose collection blocks are the only interesting part. */
function specWith(collections: Collections = {}): string {
  const blocks = [
    collections.guardrails === undefined ? GUARDRAILS : collections.guardrails,
    collections.memory === undefined ? MEMORY : collections.memory,
    collections.agents === undefined ? AGENTS : collections.agents,
  ].filter((block) => block !== '');
  return `specVersion: "0.2"

project:
  name: demo
  namespace: aid.demo
  targets:
    - ts-vercel

types:
  Answer:
    kind: struct
    fields:
      summary:
        type: string
        required: true

models:
  fast:
    provider: fake
    modelId: fake-deterministic-1
    capabilities: [json-schema]
  embed:
    provider: fake
    modelId: text-embedding-3-small
    capabilities: [embeddings]
  triage:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools]
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 400

prompts:
  classify:
    version: 1
    model: fast
    template: |
      Classify {{ subject }}.
    variables:
      subject:
        type: string
        required: true
    output:
      kind: structured
      schema: Answer
  brief:
    version: 1
    model: triage
    template: |
      Triage the ticket in one sentence.
    output:
      kind: structured
      schema: Answer

${blocks.join('\n\n')}

pipelines:
  demo:
    description: A pipeline whose collections are the whole point.
    trigger:
      http:
        method: post
        path: /demo
    steps:
      - generate:
          prompt: brief
          as: answer
`;
}

/** The whole planned tree, as a path-to-text map. */
function planFor(collections: Collections = {}): Map<string, string> {
  return fileMap(planTsVercel(irForSpecText(specWith(collections))).files);
}

function moduleAt(collections: Collections, path: string): string {
  const content = planFor(collections).get(path);
  if (content === undefined) throw new Error(`the plan ships no ${path}`);
  return content;
}

/** Codes `checkPlan` reports, without planning -- the shape py's suite uses. */
function codes(ir: IR): string[] {
  return checkPlan(ir).map((problem) => problem.code);
}

function refusalCodes(collections: Collections): string[] {
  return codes(irForSpecText(specWith(collections)));
}

const AGENTS_PATH = 'app/generated/agents.ts';
const GUARDRAILS_PATH = 'app/generated/guardrails.ts';
const DEPS_PATH = 'app/generated/deps.ts';

describe('the guardrails collection', () => {
  it('emits the declarations, the lookup and the shared engine', () => {
    const content = moduleAt({}, GUARDRAILS_PATH);

    expect(content).toContain("id: 'handbook_pii'");
    expect(content).toContain("stages: ['input', 'output']");
    expect(content).toContain("action: 'block'");
    expect(content).toContain('export const BY_ID: ReadonlyMap<string, GuardrailDefinition>');
    expect(content).toContain('export const ENGINE = new GuardrailEngine(BY_ID);');
    expect(content).toContain('export function guardrailById(id: string): GuardrailDefinition {');
    expect(content).toContain('export function guardrailBlock(error: unknown)');
    expect(content).toContain('export function enforceGuardrail(verdict: GuardrailVerdict)');
  });

  it('emits a table only for a stage some declaration names', () => {
    const content = moduleAt({}, GUARDRAILS_PATH);

    expect(content).toContain('export const INPUT_GUARDRAILS: readonly GuardrailDefinition[]');
    expect(content).toContain('export const OUTPUT_GUARDRAILS: readonly GuardrailDefinition[]');
    expect(content).not.toContain('RETRIEVAL_GUARDRAILS');
    expect(content).not.toContain('TOOL_CALL_GUARDRAILS');
  });

  it('declares no export clause, so no name is exported twice', () => {
    // A `export { A, B }` clause beside inline `export const A` is a redeclaration the
    // generated app cannot compile, and the emitter used to write both.
    const content = moduleAt({}, GUARDRAILS_PATH);

    expect(content).not.toContain('export {');
    expect(content.match(/export const GUARDRAILS/g) ?? []).toHaveLength(1);
  });

  it('refuses a policy the runtime cannot evaluate', () => {
    expect(
      refusalCodes({
        guardrails: GUARDRAILS.replace('policies: [pii-detect]', 'policies: [toxicity]'),
      }),
    ).toContain('guardrail-unsupported');
  });

  it('refuses escalate, which a pipeline route cannot honour', () => {
    expect(
      refusalCodes({ guardrails: GUARDRAILS.replace('action: block', 'action: escalate') }),
    ).toContain('guardrail-unsupported');
  });

  it('refuses a redact that names anything but the payload text', () => {
    const redacting = GUARDRAILS.replace('action: block', 'action: redact\n    redact: [summary]');

    expect(refusalCodes({ guardrails: redacting })).toContain('guardrail-unsupported');
  });

  it('accepts a redact that names the payload text', () => {
    const redacting = GUARDRAILS.replace('action: block', 'action: redact\n    redact: [text]');

    expect(refusalCodes({ guardrails: redacting })).toEqual([]);
  });
});

describe('the agents collection', () => {
  it('emits ids in declaration-independent order', () => {
    const content = moduleAt({}, AGENTS_PATH);

    expect(content).toContain('export const AGENT_IDS: readonly string[] = [');
    expect(content.indexOf("'backup_agent'")).toBeLessThan(content.indexOf("'triage_agent'"));
  });

  it('projects the document from the IR and the prompts from the registry', () => {
    const content = moduleAt({}, AGENTS_PATH);

    expect(content).toContain('const ENTRIES: Record<string, unknown> =');
    expect(content).toContain('export function agentDocument(deps: Deps)');
    expect(content).toContain('return { ...ENTRIES, prompts: promptDocument(deps) };');
    expect(content).toContain('function promptDocument(deps: Deps): readonly unknown[] {');
    expect(content).toContain('return deps.prompts');
  });

  it('builds the runtime over the caller-supplied gateway and tools', () => {
    const content = moduleAt({}, AGENTS_PATH);

    expect(content).toContain('export function buildAgentRuntime(deps: Deps = getDeps())');
    expect(content).toContain('return new AgentRuntime(fromIr({ ...agentDocument(deps) })');
    expect(content).toContain('tools: deps.toolList,');
  });

  it('ships no agent module when the spec declares no agent', () => {
    expect(planFor({ agents: '' }).has(AGENTS_PATH)).toBe(false);
  });

  it('refuses an agent that validates structured output the loop never checks', () => {
    const structured = `agents:
  structured_agent:
    name: Structured
    instructions: brief
    model: triage
    tools: []
    guardrails: []
    memory: []
    maxSteps: 2
    maxCostBudget: 0.02
    structuredOutput: Answer`;

    expect(refusalCodes({ agents: structured })).toContain('agent-unsupported');
  });

  it('refuses an agent whose instructions prompt declares variables', () => {
    expect(
      refusalCodes({ agents: AGENTS.replace('instructions: brief', 'instructions: classify') }),
    ).toContain('agent-unsupported');
  });

  it('refuses an agent whose model is not priced', () => {
    const unpriced = `agents:
  triage_agent:
    name: Triage
    instructions: brief
    model: fast
    tools: []
    guardrails: []
    memory: []
    maxSteps: 4
    maxCostBudget: 0.05`;

    expect(refusalCodes({ agents: unpriced })).toContain('agent-unsupported');
  });
});

describe('the memory collection', () => {
  it('wires the declaration into the document the agent loop reads', () => {
    // `memoryEntry` is reachable only from `agentDocumentEntries`, and these two fragments
    // are rendered only by it -- so this pins the projection into the registered document,
    // not merely the presence of a memory module. Drop the `memory:` entry from that object
    // and both fragments vanish from the emitted file.
    const content = moduleAt({}, AGENTS_PATH);

    expect(content).toContain("memory: [{ id: 'thread', kind: 'buffer'");
    expect(content).toContain('tokenBudget: 2000 }],');
  });

  it('ships a tool list in deps only when an agent can run', () => {
    expect(moduleAt({}, DEPS_PATH)).toContain('readonly toolList?: readonly Tool[];');
    expect(moduleAt({ agents: '' }, DEPS_PATH)).not.toContain('toolList');
  });

  it('refuses a memory that declares an expiry nothing enforces', () => {
    expect(refusalCodes({ memory: `${MEMORY}\n    ttl: 60s` })).toContain('memory-unsupported');
  });

  it('refuses a summarize model, which no memory tier calls', () => {
    const summarizing = `${MEMORY}\n    summarizeModel: fast`;

    expect(refusalCodes({ memory: summarizing })).toContain('memory-unsupported');
  });
});

describe('the collections gate the plan', () => {
  it('plans a spec that declares all three collections', () => {
    const build = buildForSpecText(specWith());

    expect(checkPlan(build.ir)).toEqual([]);
  });

  it('ships all three modules for that spec', () => {
    const files = planFor();

    expect(files.has(GUARDRAILS_PATH)).toBe(true);
    expect(files.has(AGENTS_PATH)).toBe(true);
  });
});
