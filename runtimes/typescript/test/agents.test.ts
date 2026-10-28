/**
 * Runtime paths no conformance case observes.
 *
 * The corpus drives the agent loop end to end, so what is left here is the machinery
 * underneath it: the thread-scope trimmer, the bounded context renderer, the atomic file
 * store, and the refusal functions whose whole contract is which error they throw and what
 * they name. A refusal that throws the right error with the wrong message is a worse
 * outcome than no refusal, because the message is the whole diagnosis.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDefinition, GuardrailDefinition } from '../src/index.js';
import {
  AgentHandoffUnsupportedError,
  ConfigurationError,
  checkEngine,
  checkMemorySupported,
  DeepAgentsUnavailableError,
  DeepAgentsVersionMismatchError,
  FeatureDeferredError,
  FileMemoryStore,
  GuardrailBlockedError,
  GuardrailEngine,
  InProcessMemoryStore,
  Message,
  renderContext,
  ThreadMemory,
  ToolCall,
} from '../src/index.js';

const directories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aid-agents-test-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

/**
 * `estimateTokens` is `(length + 3) >> 2`, so four characters is one token. Writing
 * payloads at exactly that width keeps the budgets in these tests readable instead of
 * arithmetic puzzles.
 */
function tokens(count: number): string {
  return 'x'.repeat(count * 4 - 3);
}

function call(id: string, name: string): ToolCall {
  return new ToolCall({ id, name });
}

function agentDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'triage',
    name: 'Triage',
    instructions: 'triage',
    model: 'cheap',
    tools: [],
    memory: [],
    maxSteps: 4,
    maxTokensBudget: undefined,
    maxCostBudget: undefined,
    onBudgetExhausted: 'fail',
    handoffs: [],
    delegates: [],
    engine: 'native',
    engineVersion: '',
    approval: undefined,
    guardrails: [],
    ...overrides,
  };
}

function guardrailDefinition(overrides: Partial<GuardrailDefinition> = {}): GuardrailDefinition {
  return {
    id: 'pii',
    stages: ['input'],
    policies: ['pii-detect'],
    action: 'block',
    redact: [],
    tools: [],
    message: 'blocked by pii',
    fallbackPrompt: undefined,
    log: true,
    ...overrides,
  };
}

describe('ThreadMemory', () => {
  it('rejects a budget that cannot hold a single token', () => {
    expect(() => new ThreadMemory(0)).toThrow(ConfigurationError);
    expect(() => new ThreadMemory(0)).toThrow(/must be positive/);
  });

  it('copies the transcript when no budget is declared', () => {
    const memory = new ThreadMemory();
    const messages = [Message.user('hello')];
    const trimmed = memory.trim(messages);
    expect(trimmed).toEqual(messages);
    expect(trimmed).not.toBe(messages);
  });

  it('drops a tool call together with the observation it produced', () => {
    // The whole point of trimming by group: a tool result whose call is gone replays as an
    // unattributable message, which providers reject or misread.
    const memory = new ThreadMemory(5);
    const messages = [
      Message.user(tokens(2)),
      Message.assistantToolCalls('', [call('call_1', 'search')]),
      Message.tool('call_1', tokens(3)),
      Message.assistant(tokens(1)),
    ];
    const trimmed = memory.trim(messages);
    expect(trimmed.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(trimmed[1]?.toolCalls).toEqual([]);
    expect(trimmed.some((message) => message.role === 'tool')).toBe(false);
  });

  it('keeps a message larger than the whole budget rather than truncating it', () => {
    // Half a tool observation is worse than an over-budget one, and the budget targets what
    // to replay rather than acting as a hard accounting ceiling.
    const memory = new ThreadMemory(1);
    const oversized = Message.user(tokens(20));
    expect(memory.trim([oversized])).toEqual([oversized]);
  });

  it('never drops the final message', () => {
    const memory = new ThreadMemory(1);
    const messages = [Message.user(tokens(4)), Message.assistant(tokens(4))];
    expect(memory.trim(messages).at(-1)).toBe(messages[1]);
  });

  it('accounts tokens at four characters each', () => {
    expect(new ThreadMemory().tokens([Message.user(tokens(5))])).toBe(5);
  });
});

describe('renderContext', () => {
  it('keeps the newest entries when the budget is short', () => {
    expect(renderContext(['oldest', 'middle', 'newest'], 2).text).toBe('newest');
  });

  it('joins the kept entries oldest first', () => {
    expect(renderContext(['a', 'b'], 100).text).toBe('a\nb');
  });

  it('always keeps at least one entry, whatever it costs', () => {
    // An empty context would silently erase memory that exists; one over-budget entry is
    // the honest degradation.
    const rendered = renderContext([tokens(50)], 1);
    expect(rendered.text).toBe(tokens(50));
    expect(rendered.tokens).toBeGreaterThan(1);
  });

  it('reports nothing for no entries', () => {
    expect(renderContext([], 10)).toEqual({ text: '', tokens: 0 });
  });
});

describe('InProcessMemoryStore', () => {
  it('appends per scope and key, oldest first', async () => {
    const store = new InProcessMemoryStore();
    await store.append({ scope: 'user', key: 'u1', value: 'a' });
    await store.append({ scope: 'user', key: 'u1', value: 'b' });
    await store.append({ scope: 'user', key: 'u2', value: 'c' });
    expect(await store.read({ scope: 'user', key: 'u1' })).toEqual(['a', 'b']);
    expect(await store.read({ scope: 'user', key: 'u2' })).toEqual(['c']);
    expect(await store.read({ scope: 'global', key: 'u1' })).toEqual([]);
  });

  it('clears every scope', async () => {
    const store = new InProcessMemoryStore();
    await store.append({ scope: 'user', key: 'u1', value: 'a' });
    store.clear();
    expect(await store.read({ scope: 'user', key: 'u1' })).toEqual([]);
  });

  it('returns a copy so a caller cannot mutate stored history', async () => {
    const store = new InProcessMemoryStore();
    await store.append({ scope: 'user', key: 'u1', value: 'a' });
    const read = await store.read({ scope: 'user', key: 'u1' });
    (read as string[]).push('injected');
    expect(await store.read({ scope: 'user', key: 'u1' })).toEqual(['a']);
  });
});

describe('FileMemoryStore', () => {
  it('survives a second instance reading the same path', async () => {
    const path = join(await workspace(), 'nested', 'memory.json');
    await new FileMemoryStore(path).append({ scope: 'user', key: 'u1', value: 'a' });
    expect(await new FileMemoryStore(path).read({ scope: 'user', key: 'u1' })).toEqual(['a']);
  });

  it('serializes overlapping appends so neither is lost', async () => {
    // Without the promise chain both appends read the same snapshot and one wins.
    const path = join(await workspace(), 'memory.json');
    const store = new FileMemoryStore(path);
    await Promise.all([
      store.append({ scope: 'user', key: 'u1', value: 'first' }),
      store.append({ scope: 'user', key: 'u1', value: 'second' }),
    ]);
    expect(await new FileMemoryStore(path).read({ scope: 'user', key: 'u1' })).toEqual([
      'first',
      'second',
    ]);
  });

  it('leaves no temporary file behind after an append', async () => {
    const directory = await workspace();
    await new FileMemoryStore(join(directory, 'memory.json')).append({
      scope: 'user',
      key: 'u1',
      value: 'a',
    });
    expect(await readdir(directory)).toEqual(['memory.json']);
  });

  it('writes canonical JSON so the bytes are stable', async () => {
    const path = join(await workspace(), 'memory.json');
    await new FileMemoryStore(path).append({ scope: 'user', key: 'u1', value: 'a' });
    expect(await readFile(path, 'utf8')).toBe('{"user":{"u1":["a"]}}');
  });

  it('names the path when the file cannot be parsed', async () => {
    const path = join(await workspace(), 'memory.json');
    await writeFile(path, 'not json', 'utf8');
    await expect(new FileMemoryStore(path).read({ scope: 'user', key: 'u1' })).rejects.toThrow(
      ConfigurationError,
    );
    await expect(new FileMemoryStore(path).read({ scope: 'user', key: 'u1' })).rejects.toThrow(
      'memory.json',
    );
  });

  it('refuses a JSON document that is not an object', async () => {
    const path = join(await workspace(), 'memory.json');
    await writeFile(path, '[]', 'utf8');
    await expect(new FileMemoryStore(path).read({ scope: 'user', key: 'u1' })).rejects.toThrow(
      /is not a JSON object/,
    );
  });

  it('skips malformed entries instead of failing the whole store', async () => {
    const path = join(await workspace(), 'memory.json');
    await writeFile(path, '{"user":{"ok":["a"],"bad":"nope"},"scalar":7}', 'utf8');
    expect(await new FileMemoryStore(path).read({ scope: 'user', key: 'ok' })).toEqual(['a']);
    expect(await new FileMemoryStore(path).read({ scope: 'user', key: 'bad' })).toEqual([]);
    expect(await new FileMemoryStore(path).read({ scope: 'scalar', key: 'ok' })).toEqual([]);
  });

  it('treats a missing file as empty rather than an error', async () => {
    const path = join(await workspace(), 'absent.json');
    expect(await new FileMemoryStore(path).read({ scope: 'user', key: 'u1' })).toEqual([]);
  });
});

describe('checkMemorySupported', () => {
  const accepted = {
    memoryId: 'm',
    kind: 'buffer',
    summarizeModel: undefined,
    ttl: undefined,
    redact: [],
  };

  it('accepts the two kinds this layer implements', () => {
    expect(() => checkMemorySupported(accepted)).not.toThrow();
    expect(() => checkMemorySupported({ ...accepted, kind: 'window' })).not.toThrow();
  });

  it('refuses an unimplemented kind by name', () => {
    // Naming the kind is the contract: a bare "unsupported" would leave the author guessing
    // which of four plausible causes fired.
    expect(() => checkMemorySupported({ ...accepted, kind: 'semantic' })).toThrow(
      FeatureDeferredError,
    );
    expect(() => checkMemorySupported({ ...accepted, kind: 'semantic' })).toThrow(/'semantic'/);
  });

  it('refuses a summarizeModel rather than serving an unbounded buffer silently', () => {
    expect(() => checkMemorySupported({ ...accepted, summarizeModel: 'cheap' })).toThrow(/'cheap'/);
  });

  it('refuses a ttl rather than ignoring expiry', () => {
    expect(() => checkMemorySupported({ ...accepted, ttl: '7d' })).toThrow(/'7d'/);
  });

  it('refuses redaction rules rather than keeping the unredacted text', () => {
    expect(() => checkMemorySupported({ ...accepted, redact: ['email'] })).toThrow(
      /redaction rules/,
    );
  });
});

describe('checkEngine', () => {
  it('serves a native agent without probing for the optional extra', () => {
    expect(checkEngine(agentDefinition())).toBe('native');
  });

  it('refuses an engine the IR does not admit, naming the admitted set', () => {
    const agent = agentDefinition({ engine: 'crewai' });
    expect(() => checkEngine(agent)).toThrow(ConfigurationError);
    expect(() => checkEngine(agent)).toThrow(/'crewai'/);
  });

  it('refuses handoffs before versions, because a handoff cannot be honoured at all', () => {
    // Order is the whole diagnosis: reporting "install the extra" for an agent whose
    // handoffs are unsupported would send the author to fix the wrong thing.
    const agent = agentDefinition({
      engine: 'deepagents',
      engineVersion: '0.0.1',
      handoffs: ['billing'],
    });
    expect(() => checkEngine(agent)).toThrow(AgentHandoffUnsupportedError);
    expect(() => checkEngine(agent)).not.toThrow(DeepAgentsVersionMismatchError);
  });

  it('refuses a version mismatch before reporting the extra missing', () => {
    const agent = agentDefinition({ engine: 'deepagents', engineVersion: '0.0.1' });
    expect(() => checkEngine(agent)).toThrow(DeepAgentsVersionMismatchError);
    expect(() => checkEngine(agent)).toThrow(/'0\.0\.1'/);
    expect(() => checkEngine(agent)).not.toThrow(DeepAgentsUnavailableError);
  });
});

describe('GuardrailEngine', () => {
  it('fails closed on a policy it has no evaluator for', () => {
    // Unknown is not "no match": treating it as a pass would silently disable a guardrail
    // the author declared.
    const engine = new GuardrailEngine();
    const guardrail = guardrailDefinition({ policies: ['no-such-policy'] });
    expect(() => engine.checkInput([guardrail], 'hello')).toThrow(GuardrailBlockedError);
    expect(() => engine.checkInput([guardrail], 'hello')).toThrow(/'no-such-policy'/);
  });

  it('names the guardrail that carries the unknown policy', () => {
    const engine = new GuardrailEngine();
    const guardrail = guardrailDefinition({ id: 'sentinel', policies: ['no-such-policy'] });
    expect(() => engine.checkInput([guardrail], 'hello')).toThrow(/'sentinel'/);
  });

  it('reports no action when nothing matches', () => {
    const engine = new GuardrailEngine();
    expect(
      engine.checkInput([guardrailDefinition()], 'nothing to see here').action,
    ).toBeUndefined();
  });

  it('blocks an address the pii detector recognises', () => {
    const engine = new GuardrailEngine();
    const verdict = engine.checkInput([guardrailDefinition()], 'write to user@example.com');
    expect(verdict.action).toBe('block');
    expect(verdict.deciding?.guardrail).toBe('pii');
    expect(verdict.deciding?.policies).toEqual(['pii-detect']);
  });

  it('ignores a guardrail declared for another stage', () => {
    const engine = new GuardrailEngine();
    const guardrail = guardrailDefinition({ stages: ['retrieval'] });
    expect(engine.checkInput([guardrail], 'user@example.com').action).toBeUndefined();
  });

  it('refuses an action outside the closed vocabulary', () => {
    // `decide` finds `block` by equality, so an unrecognised action could never decide a
    // block and would fall through as an allow nobody declared.
    const engine = new GuardrailEngine();
    const guardrail = guardrailDefinition({ action: 'ignore' });
    expect(() => engine.checkInput([guardrail], 'user@example.com')).toThrow(ConfigurationError);
    expect(() => engine.checkInput([guardrail], 'user@example.com')).toThrow(/'ignore'/);
  });
});
