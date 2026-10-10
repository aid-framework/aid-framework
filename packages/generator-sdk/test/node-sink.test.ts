import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMemorySink, createNodeSink, normalizeText } from '../src/index.js';

const created: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'aid-gen-sdk-'));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createMemorySink', () => {
  it('reads, writes, and removes entries', () => {
    const sink = createMemorySink({ 'a.py': 'x\n' });
    expect(sink.read('a.py')).toBe('x\n');
    expect(sink.read('missing.py')).toBeUndefined();
    sink.write('b.py', 'y\n');
    expect(sink.read('b.py')).toBe('y\n');
    sink.remove('a.py');
    expect(sink.read('a.py')).toBeUndefined();
  });

  it('stays limited to the keys it was given', () => {
    expect(Object.keys(createMemorySink(undefined).files)).toEqual([]);
  });
});

describe('createNodeSink', () => {
  it('returns undefined for a file that does not exist yet', () => {
    const sink = createNodeSink(temporaryRoot());
    expect(sink.read('app/generated/main.py')).toBeUndefined();
  });

  it('creates missing parent directories on write', () => {
    const root = temporaryRoot();
    const sink = createNodeSink(root);
    sink.write('app/generated/nested/main.py', 'x = 1\n');
    expect(sink.read('app/generated/nested/main.py')).toBe('x = 1\n');
  });

  it('round-trips content byte for byte', () => {
    const sink = createNodeSink(temporaryRoot());
    const content = normalizeText('a\r\nb\r\n');
    sink.write('app/generated/a.py', content);
    expect(sink.read('app/generated/a.py')).toBe('a\nb\n');
    expect(sink.read('app/generated/a.py')).toBe(content);
  });

  it('overwrites an existing file without leaving a temp file behind', () => {
    const root = temporaryRoot();
    const sink = createNodeSink(root);
    sink.write('app/generated/a.py', 'old\n');
    sink.write('app/generated/a.py', 'new\n');
    expect(sink.read('app/generated/a.py')).toBe('new\n');

    const leftovers = createNodeSink(root);
    expect(leftovers.read('app/generated/a.py.aid-tmp')).toBeUndefined();
  });

  it('removes a file, and is a no-op for one that is already gone', () => {
    const sink = createNodeSink(temporaryRoot());
    sink.write('app/generated/a.py', 'x\n');
    sink.remove('app/generated/a.py');
    expect(sink.read('app/generated/a.py')).toBeUndefined();
    expect(() => sink.remove('app/generated/a.py')).not.toThrow();
  });

  it('refuses to read or write outside its root', () => {
    const sink = createNodeSink(temporaryRoot());
    expect(() => sink.write('../escaped.py', 'x\n')).toThrow(/escapes the sink root/);
    expect(() => sink.read('../escaped.py')).toThrow(/escapes the sink root/);
  });
});
