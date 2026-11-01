/**
 * The local JSONL trace sink.
 *
 * These assert on the bytes actually written: the feature promises a file appears,
 * and nothing else about it is observable to the CLI that reads it.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localTraceEnabled, TRACE_DIR_ENV } from '../src/local-trace.js';
import { ATTRIBUTES, llmSpan, withLlmSpan } from '../src/tracing.js';

const created: string[] = [];

function traceDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aid-trace-'));
  created.push(dir);
  process.env[TRACE_DIR_ENV] = dir;
  return dir;
}

function lines(dir: string): Record<string, unknown>[] {
  const names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  expect(names).toHaveLength(1);
  return readFileSync(join(dir, names[0] as string), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  delete process.env[TRACE_DIR_ENV];
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('localTraceEnabled', () => {
  it('is off unless AID_TRACE_DIR is set', () => {
    expect(localTraceEnabled()).toBe(false);
    traceDir();
    expect(localTraceEnabled()).toBe(true);
  });
});

describe('the local trace sink', () => {
  it('writes one line per span', () => {
    const dir = traceDir();

    llmSpan({ model: 'm', system: 'p', costUsd: 0.25 }).end();

    const [record = {}] = lines(dir);
    expect(record.name).toBe('chat m');
    expect(record.kind).toBe('chat');
    expect(record.parent_span_id).toBeNull();
    expect((record.trace_id as string).length).toBe(32);
    expect((record.span_id as string).length).toBe(16);
    expect((record.attributes as Record<string, unknown>)[ATTRIBUTES.system]).toBe('p');
    expect((record.attributes as Record<string, unknown>)[ATTRIBUTES.costUsd]).toBe(0.25);
    expect(record.status).toBeNull();
    expect(record.duration_ms as number).toBeGreaterThanOrEqual(0);
  });

  it('points a nested span at its parent', async () => {
    const dir = traceDir();

    await withLlmSpan({ model: 'outer' }, async () => {
      await withLlmSpan({ model: 'inner' }, () => Promise.resolve());
    });

    const [inner = {}, outer = {}] = lines(dir);
    expect(inner.parent_span_id).toBe(outer.span_id);
    expect(inner.trace_id).toBe(outer.trace_id);
    expect(outer.parent_span_id).toBeNull();
  });

  it('records a failure once, with an error status', async () => {
    const dir = traceDir();

    await expect(
      withLlmSpan({ model: 'm' }, () => Promise.reject(new Error('kaboom'))),
    ).rejects.toThrow(/kaboom/);

    const [record = {}] = lines(dir);
    const status = record.status as unknown as { code: string; message: string };
    expect(status.code).toBe('ERROR');
    expect(status.message).toBe('kaboom');
    const events = record.events as unknown as {
      name: string;
      attributes: Record<string, string>;
    }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('exception');
    expect(events[0]?.attributes['exception.message']).toBe('kaboom');
  });

  it('coerces attributes JSON cannot hold', () => {
    const dir = traceDir();

    const handle = llmSpan({ model: 'm' });
    handle.span.setAttribute('infinite', Number.POSITIVE_INFINITY);
    handle.span.setAttribute('object', {} as unknown as string);
    handle.end();

    const [record = {}] = lines(dir);
    const attributes = record.attributes as unknown as Record<string, unknown>;
    expect(attributes.infinite).toBe('Infinity');
    expect(attributes.object).toBe('[object Object]');
  });

  it('writes one line however often the span is ended', () => {
    const dir = traceDir();

    const handle = llmSpan({ model: 'm' });
    handle.end();
    handle.end();

    expect(lines(dir)).toHaveLength(1);
  });

  it('writes nothing without the variable', () => {
    const dir = traceDir();
    delete process.env[TRACE_DIR_ENV];

    llmSpan({ model: 'm' }).end();

    expect(localTraceEnabled()).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
