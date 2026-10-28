/**
 * D5: in-process memory, one durable adapter, and no plugin zoo.
 *
 * Mirrors `tests/test_agents_memory.py`. `thread` scope is the checkpointer unit -- the
 * transcript the loop already carries -- so it is a trimmer and never a store. `user` and
 * `global` scope are the cross-run facts, and they are the only reason a store exists.
 *
 * The pure `renderContext` / `InProcessMemoryStore` / `FileMemoryStore` unit tests live in
 * `agents.test.ts`; what is asserted here is how the loop *uses* them.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FeatureDeferredError,
  FileMemoryStore,
  InProcessMemoryStore,
  type MemoryStore,
  type Message,
  ScriptedTurn,
} from '../src/index.js';
import {
  build,
  type JsonObject,
  memoryDef,
  recordingTool,
  solo,
  toolDef,
} from './agent-support.js';

const PROMPT = 'You are a helpful assistant.';
const QUESTION = 'How long does delivery take?';
const LONG = 'y'.repeat(300);

/** A store that records every touch, so "never stored" is observable. */
class SpyStore implements MemoryStore {
  readonly reads: [string, string][] = [];
  readonly appends: [string, string, string][] = [];

  async read(options: {
    readonly scope: string;
    readonly key: string;
  }): Promise<readonly string[]> {
    this.reads.push([options.scope, options.key]);
    return [];
  }

  async append(options: {
    readonly scope: string;
    readonly key: string;
    readonly value: string;
  }): Promise<void> {
    this.appends.push([options.scope, options.key, options.value]);
  }
}

function remembering(options: { readonly scope: string; readonly backend?: string }): JsonObject {
  const memory: JsonObject = {
    ...memoryDef('m1', {
      scope: options.scope,
      ...(options.backend === undefined ? {} : { backend: options.backend }),
    }),
  };
  return solo({ prompt: PROMPT, memory: [memory] });
}

function loopy(tokenBudget: number): JsonObject {
  return solo({
    prompt: PROMPT,
    toolSpecs: [toolDef('t1', 'search')],
    memory: [memoryDef('m1', { scope: 'thread', tokenBudget })],
    tools: ['t1'],
    maxSteps: 6,
  });
}

function script(): ScriptedTurn[] {
  return [
    ScriptedTurn.tool('search', { query: 'one' }),
    ScriptedTurn.tool('search', { query: 'two' }),
    ScriptedTurn.tool('search', { query: 'three' }),
    ScriptedTurn.answer('done'),
  ];
}

/** The replayed transcript as `[role, content]` pairs, which is what a provider sees. */
function replayed(messages: readonly Message[]): [string, string][] {
  return messages.map((message) => [message.role, message.content]);
}

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('thread scope', () => {
  it('trims the replayed transcript without changing the work', async () => {
    const trimmedTool = recordingTool('search', { answer: LONG });
    const fullTool = recordingTool('search', { answer: LONG });
    const trimmed = build(loopy(120), { tools: [trimmedTool.tool], script: script() });
    const untrimmed = build(loopy(100_000), { tools: [fullTool.tool], script: script() });

    expect((await trimmed.runtime.run('solo', QUESTION)).answer).toBe('done');
    expect((await untrimmed.runtime.run('solo', QUESTION)).answer).toBe('done');

    // Same conversation, same work: only what was replayed differs.
    expect([trimmedTool.recorder.calls, fullTool.recorder.calls]).toEqual([3, 3]);
    const kept = trimmed.provider.calls.at(-1)?.messages ?? [];
    const whole = untrimmed.provider.calls.at(-1)?.messages ?? [];
    expect(kept.length).toBeLessThan(whole.length);

    // The system prompt and the user's question are never trimmed away.
    expect(replayed(kept.slice(0, 2))).toEqual([
      ['system', PROMPT],
      ['user', QUESTION],
    ]);

    // Whole tool-call groups: no observation outlives its call, and no call is left
    // behind without its observation.
    const seen = new Set<string>();
    for (const message of kept) {
      for (const call of message.toolCalls) seen.add(call.id);
      if (message.role === 'tool') {
        expect(seen.has(message.toolCallId ?? '')).toBe(true);
      }
    }
    const answered = new Set(
      kept.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
    );
    expect([...answered].sort()).toEqual([...seen].sort());
  });

  it('never touches a store', async () => {
    const spy = new SpyStore();
    const { tool } = recordingTool('search', { answer: LONG });
    const harness = build(loopy(120), {
      tools: [tool],
      script: script(),
      memoryStore: spy,
    });

    await harness.runtime.run('solo', QUESTION);

    expect(spy.reads).toEqual([]);
    expect(spy.appends).toEqual([]);
  });
});

describe('user scope', () => {
  it('is remembered across runs', async () => {
    const store = new InProcessMemoryStore();
    const harness = build(remembering({ scope: 'user' }), {
      script: [ScriptedTurn.answer('first answer'), ScriptedTurn.answer('second answer')],
      memoryStore: store,
    });

    const first = await harness.runtime.run('solo', QUESTION);
    // Nothing was stored yet, so the transcript is just the prompt and the question.
    expect(replayed(harness.provider.calls[0]?.messages ?? [])).toEqual([
      ['system', PROMPT],
      ['user', QUESTION],
    ]);

    await harness.runtime.run('solo', QUESTION);

    expect(first.answer).toBe('first answer');
    expect(replayed(harness.provider.calls[1]?.messages ?? [])).toEqual([
      ['system', PROMPT],
      ['system', '[m1]\nfirst answer'],
      ['user', QUESTION],
    ]);
  });

  it('is keyed per caller', async () => {
    const store = new InProcessMemoryStore();
    const doc = remembering({ scope: 'user' });
    const alice = build(doc, { script: [ScriptedTurn.answer('alice secret')], memoryStore: store });
    const bob = build(doc, { script: [ScriptedTurn.answer('bob answer')], memoryStore: store });

    await alice.runtime.run('solo', QUESTION, { memoryKey: 'alice' });
    await bob.runtime.run('solo', QUESTION, { memoryKey: 'bob' });

    expect(replayed(bob.provider.calls[0]?.messages ?? [])).toEqual([
      ['system', PROMPT],
      ['user', QUESTION],
    ]);
  });

  it('is served by the backend the document registered', async () => {
    const store = new InProcessMemoryStore();
    const harness = build(remembering({ scope: 'user', backend: 'pg' }), {
      script: [ScriptedTurn.answer('kept')],
      stores: { pg: store },
    });

    await harness.runtime.run('solo', QUESTION);

    // The default memory key is the agent id, and the storage key is scoped by both.
    expect(await store.read({ scope: 'user', key: 'solo:m1' })).toEqual(['kept']);
  });

  it('fails closed on a backend nobody registered', async () => {
    const harness = build(remembering({ scope: 'user', backend: 'postgres' }), { script: [] });

    await expect(harness.runtime.run('solo', QUESTION)).rejects.toThrow(
      /which is not registered here/,
    );
  });
});

describe('global scope', () => {
  it('is shared by every caller', async () => {
    const store = new InProcessMemoryStore();
    const doc = remembering({ scope: 'global' });
    const alice = build(doc, { script: [ScriptedTurn.answer('shared fact')], memoryStore: store });
    const bob = build(doc, { script: [ScriptedTurn.answer('bob answer')], memoryStore: store });

    await alice.runtime.run('solo', QUESTION, { memoryKey: 'alice' });
    await bob.runtime.run('solo', QUESTION, { memoryKey: 'bob' });

    expect(replayed(bob.provider.calls[0]?.messages ?? [])).toEqual([
      ['system', PROMPT],
      ['system', '[m1]\nshared fact'],
      ['user', QUESTION],
    ]);
  });
});

describe('the file store', () => {
  it('is the one durable adapter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aid-memory-'));
    temporary.push(directory);
    const path = join(directory, 'memory.json');
    const doc = remembering({ scope: 'user' });
    const first = build(doc, {
      script: [ScriptedTurn.answer('first answer')],
      memoryStore: new FileMemoryStore(path),
    });

    await first.runtime.run('solo', QUESTION, { memoryKey: 'alice' });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      user: { 'alice:m1': ['first answer'] },
    });

    // A fresh runtime and a fresh store object: whatever it sees came off the disk.
    const second = build(doc, {
      script: [ScriptedTurn.answer('second answer')],
      memoryStore: new FileMemoryStore(path),
    });
    await second.runtime.run('solo', QUESTION, { memoryKey: 'alice' });

    expect(replayed(second.provider.calls[0]?.messages ?? [])).toEqual([
      ['system', PROMPT],
      ['system', '[m1]\nfirst answer'],
      ['user', QUESTION],
    ]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      user: { 'alice:m1': ['first answer', 'second answer'] },
    });
  });

  it('writes the bytes Python writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aid-memory-'));
    temporary.push(directory);
    const path = join(directory, 'memory.json');
    const store = new FileMemoryStore(path);

    await store.append({ scope: 'b', key: 'k2', value: 'second' });
    await store.append({ scope: 'a', key: 'k1', value: 'first' });
    await store.append({ scope: 'a', key: 'k1', value: 'next' });

    // json.dump(data, sort_keys=True, separators=(",", ":")): sorted scopes, sorted keys,
    // no spaces. A checkpoint one runtime wrote is a file the other can read.
    expect(await readFile(path, 'utf8')).toBe(
      '{"a":{"k1":["first","next"]},"b":{"k2":["second"]}}',
    );
  });

  it('treats a scope named __proto__ as an ordinary scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aid-memory-'));
    temporary.push(directory);
    const path = join(directory, 'memory.json');
    const store = new FileMemoryStore(path);

    await store.append({ scope: '__proto__', key: 'polluted', value: 'yes' });

    // On a plain object this write would resolve `__proto__` to Object.prototype and
    // assign `polluted` there, making every object in the process inherit it.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(await store.read({ scope: '__proto__', key: 'polluted' })).toEqual(['yes']);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      ['__proto__']: { polluted: ['yes'] },
    });

    const reopened = new FileMemoryStore(path);
    expect(await reopened.read({ scope: '__proto__', key: 'polluted' })).toEqual(['yes']);
  });

  it('treats a key named __proto__ as an ordinary key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aid-memory-'));
    temporary.push(directory);
    const path = join(directory, 'memory.json');
    const store = new FileMemoryStore(path);

    await store.append({ scope: 'user', key: '__proto__', value: 'yes' });

    expect(({} as Record<string, unknown>).length).toBeUndefined();
    expect(await store.read({ scope: 'user', key: '__proto__' })).toEqual(['yes']);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });
});

describe('refusals', () => {
  it.each(['summary', 'semantic', 'episodic', 'vector'])(
    'refuses memory kind %s by name',
    async (kind) => {
      const harness = build(solo({ prompt: PROMPT, memory: [memoryDef('m1', { kind })] }), {
        script: [ScriptedTurn.answer('x')],
      });
      const run = harness.runtime.run('solo', QUESTION);

      await expect(run).rejects.toThrow(FeatureDeferredError);
      await expect(run).rejects.toThrow(new RegExp(kind));
    },
  );

  it.each([
    ['summarizeModel', 'cheap'],
    ['ttl', 'PT1H'],
    ['redact', ['email']],
  ] as const)('refuses memory feature %s by name', async (field, value) => {
    const memory: JsonObject = {
      ...memoryDef('m1', { scope: 'user', [field]: Array.isArray(value) ? [...value] : value }),
    };
    const harness = build(solo({ prompt: PROMPT, memory: [memory] }), {
      script: [ScriptedTurn.answer('x')],
    });
    const needle =
      field === 'summarizeModel' ? /summarizeModel/ : field === 'ttl' ? /ttl/ : /redaction/;
    const run = harness.runtime.run('solo', QUESTION);

    await expect(run).rejects.toThrow(FeatureDeferredError);
    await expect(run).rejects.toThrow(needle);
  });
});
