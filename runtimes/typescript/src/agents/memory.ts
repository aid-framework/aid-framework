/**
 * Agent memory: thread scope, and one durable adapter.
 *
 * Ratified decision D5 draws the line this module implements: in-process memory is the
 * default, exactly one store-backed adapter ships, and there is no plugin zoo. A `backend`
 * naming a declared store is served by whatever store the caller registered under that id;
 * with none registered, the in-process store answers.
 *
 * `thread` scope is the checkpointer unit -- the conversation the loop is already carrying
 * -- so it needs no store and no key. `user` and `global` scope are the cross-run facts,
 * keyed by a caller-supplied key and stored behind {@link MemoryStore}. The IR vocabulary is
 * `thread`/`user`/`global`; the `session` spelling L1 removed is not reintroduced here.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { estimateTokens } from '../cost.js';
import { ConfigurationError, FeatureDeferredError } from '../errors.js';
import { repr } from '../internal/json.js';
import type { Message } from '../types.js';

/** The IR's scope vocabulary. `session` is deliberately absent. */
export const MEMORY_SCOPES: readonly string[] = ['thread', 'user', 'global'];

/**
 * The kinds served without a summarizer or an embedding model. The rest are declared in
 * the IR and refused by name, never silently downgraded.
 */
export const IMPLEMENTED_MEMORY_KINDS: readonly string[] = ['buffer', 'window'];

/** Append-only, scoped storage behind the memory scopes that outlive a run. */
export interface MemoryStore {
  /** Every value recorded for `(scope, key)`, oldest first. */
  read(options: { readonly scope: string; readonly key: string }): Promise<readonly string[]>;
  /** Record one value. Append-only is what makes replay deterministic. */
  append(options: {
    readonly scope: string;
    readonly key: string;
    readonly value: string;
  }): Promise<void>;
}

/**
 * The default: a map, lost when the process ends.
 *
 * That is the honest default for a library that must not decide where a host application
 * keeps its data. A durable adapter is opt-in, and there is one.
 */
export class InProcessMemoryStore implements MemoryStore {
  readonly #values = new Map<string, string[]>();

  async read(options: {
    readonly scope: string;
    readonly key: string;
  }): Promise<readonly string[]> {
    return [...(this.#values.get(storageKey(options)) ?? [])];
  }

  async append(options: {
    readonly scope: string;
    readonly key: string;
    readonly value: string;
  }): Promise<void> {
    const key = storageKey(options);
    const existing = this.#values.get(key);
    if (existing === undefined) this.#values.set(key, [options.value]);
    else existing.push(options.value);
  }

  clear(): void {
    this.#values.clear();
  }
}

/**
 * One JSON file, one serialized writer.
 *
 * The file is rewritten through a temporary file and an atomic replace so a crash mid-write
 * cannot leave a half-file that a later read would parse as truth. Writes are serialized
 * through a promise chain, which is the single-writer guarantee without a lock: two appends
 * that overlap would otherwise both read, both mutate, and one would win.
 */
export class FileMemoryStore implements MemoryStore {
  readonly path: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async read(options: {
    readonly scope: string;
    readonly key: string;
  }): Promise<readonly string[]> {
    const data = await this.#load();
    return [...(data[options.scope]?.[options.key] ?? [])];
  }

  async append(options: {
    readonly scope: string;
    readonly key: string;
    readonly value: string;
  }): Promise<void> {
    const next = this.#queue.then(async () => {
      const data = await this.#load();
      let scope = data[options.scope];
      if (scope === undefined) {
        scope = {};
        data[options.scope] = scope;
      }
      const values = scope[options.key] ?? [];
      values.push(options.value);
      scope[options.key] = values;
      await this.#save(data);
    });
    this.#queue = next.catch(() => undefined);
    await next;
  }

  async #load(): Promise<Record<string, Record<string, string[]>>> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new ConfigurationError(`memory store ${this.path} is unreadable: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ConfigurationError(`memory store ${this.path} is unreadable: ${String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigurationError(`memory store ${this.path} is not a JSON object`);
    }
    const data: Record<string, Record<string, string[]>> = {};
    for (const [scope, keys] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) continue;
      const resolved: Record<string, string[]> = {};
      for (const [key, values] of Object.entries(keys as Record<string, unknown>)) {
        if (!Array.isArray(values)) continue;
        resolved[key] = values.map((value) => String(value));
      }
      data[scope] = resolved;
    }
    return data;
  }

  async #save(data: Record<string, Record<string, string[]>>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(
      dirname(this.path),
      `.${this.path.split(/[\\/]/).pop() ?? 'memory'}.${process.pid}.${Date.now()}.tmp`,
    );
    try {
      await writeFile(temporary, canonicalJson(data), 'utf8');
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

/** `json.dump(..., sort_keys=True, separators=(",", ":"))`, byte for byte. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function storageKey(options: { readonly scope: string; readonly key: string }): string {
  return `${options.scope}\u0000${options.key}`;
}

/**
 * Refuse a declared memory the runtime cannot honour exactly.
 *
 * `summary`, `semantic`, `episodic` and `vector` would each need a model or an index that
 * this layer does not have, and so would `summarizeModel`; `ttl` needs a clock and `redact`
 * needs redaction on the tracing path. Serving them approximately would make the
 * declaration lie, so they are refused by name.
 */
export function checkMemorySupported(options: {
  readonly memoryId: string;
  readonly kind: string;
  readonly summarizeModel: string | undefined;
  readonly ttl: string | undefined;
  readonly redact: readonly string[];
}): void {
  if (!IMPLEMENTED_MEMORY_KINDS.includes(options.kind)) {
    throw new FeatureDeferredError(
      `memory ${repr(options.memoryId)} asks for kind ${repr(options.kind)}; this layer ` +
        `implements ${IMPLEMENTED_MEMORY_KINDS.join(', ')} and refuses the rest by name`,
    );
  }
  if (options.summarizeModel !== undefined) {
    throw new FeatureDeferredError(
      `memory ${repr(options.memoryId)} names summarizeModel ` +
        `${repr(options.summarizeModel)}; no summarizer is implemented, so an unbounded ` +
        'buffer is served instead',
    );
  }
  if (options.ttl !== undefined) {
    throw new FeatureDeferredError(
      `memory ${repr(options.memoryId)} declares ttl ${repr(options.ttl)}; expiry ` +
        'enforcement is not implemented',
    );
  }
  if (options.redact.length > 0) {
    throw new FeatureDeferredError(
      `memory ${repr(options.memoryId)} declares redaction rules; memory redaction is not implemented`,
    );
  }
}

/**
 * Bounds the transcript a single agent turn may replay.
 *
 * `thread` scope is the conversation the loop is already carrying, so this is a trimmer
 * rather than a store: when the transcript exceeds `tokenBudget`, whole tool-call groups are
 * dropped oldest-first. A group is an assistant turn with its tool observations, because
 * dropping one without the other would replay a tool result whose call is gone.
 *
 * A message larger than the whole budget is kept rather than truncated: half a tool
 * observation is worse than an over-budget one, and the budget is a target for what to
 * *replay*, not a hard accounting ceiling.
 */
export class ThreadMemory {
  readonly tokenBudget: number | undefined;

  constructor(tokenBudget?: number) {
    if (tokenBudget !== undefined && tokenBudget < 1) {
      throw new ConfigurationError('thread memory tokenBudget must be positive');
    }
    this.tokenBudget = tokenBudget;
  }

  tokens(messages: readonly Message[]): number {
    return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
  }

  trim(messages: readonly Message[]): Message[] {
    if (this.tokenBudget === undefined) return [...messages];
    const kept = [...messages];
    let total = this.tokens(kept);
    let start = kept.findIndex((message) => (message.toolCalls?.length ?? 0) > 0);
    if (start === -1) start = kept.length;
    while (total > this.tokenBudget && start < kept.length) {
      let end = start + 1;
      while (end < kept.length && kept[end]?.role === 'tool') end += 1;
      total -= this.tokens(kept.slice(start, end));
      kept.splice(start, end - start);
    }
    while (total > this.tokenBudget) {
      let victim = -1;
      for (let index = 0; index < kept.length; index += 1) {
        if (kept[index]?.role !== 'system' && index < kept.length - 1) {
          victim = index;
          break;
        }
      }
      if (victim === -1) break;
      total -= estimateTokens(kept[victim]?.content ?? '');
      kept.splice(victim, 1);
    }
    return kept;
  }
}

/** Fit stored entries into `tokenBudget`, newest first. Returns text and tokens. */
export function renderContext(
  entries: readonly string[],
  tokenBudget: number,
): { readonly text: string; readonly tokens: number } {
  const chosen: string[] = [];
  let tokens = 0;
  for (const entry of [...entries].reverse()) {
    const cost = estimateTokens(entry) + 1;
    if (chosen.length > 0 && tokens + cost > tokenBudget) break;
    chosen.push(entry);
    tokens += cost;
    if (tokens >= tokenBudget) break;
  }
  return { text: [...chosen].reverse().join('\n'), tokens };
}
