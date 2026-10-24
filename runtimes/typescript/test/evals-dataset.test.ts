import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Dataset, EvalCase, EvalError as FrameworkEvalError } from '../src/index.js';
import { capitalsDataset } from './support.js';

const workspaces: string[] = [];

function scratch(payload: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aid-dataset-'));
  workspaces.push(dir);
  const path = join(dir, 'dataset.json');
  writeFileSync(path, payload, 'utf8');
  return path;
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe('EvalCase', () => {
  it('defaults expected to null and the collections to empty', () => {
    const entry = new EvalCase({ id: 'a', input: 'hi' });

    expect(entry.expected).toBeNull();
    expect(entry.tags).toEqual([]);
    expect(entry.metadata).toEqual({});
  });

  it('refuses an empty id', () => {
    expect(() => new EvalCase({ id: '', input: 'hi' })).toThrow(/case id must not be empty/);
  });

  it('serializes tags as a copy', () => {
    const tags = ['fast'];
    const entry = new EvalCase({ id: 'a', input: 'hi', tags });

    const payload = entry.toJSON();
    expect(payload.tags).toEqual(['fast']);
    expect(payload.tags).not.toBe(tags);
  });
});

describe('Dataset', () => {
  it('reports its length and ids', () => {
    const dataset = capitalsDataset();

    expect(dataset.length).toBe(4);
    expect(dataset.ids()).toEqual(['capital-fr', 'capital-jp', 'capital-pe', 'capital-ke']);
  });

  it('looks a case up by id and names the miss', () => {
    const dataset = capitalsDataset();

    expect(dataset.case('capital-jp').expected).toBe('Tokyo');
    expect(() => dataset.case('atlantis')).toThrow(/has no case "atlantis"/);
  });

  it('filters by tag', () => {
    const dataset = Dataset.fromRecords('tagged', '1', [
      { id: 'a', input: 'x', tags: ['europe'] },
      { id: 'b', input: 'y', tags: ['asia', 'europe'] },
      { id: 'c', input: 'z' },
    ]);

    expect(dataset.byTag('europe').map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(dataset.byTag('nowhere')).toEqual([]);
  });

  it('refuses an empty name, version or case list', () => {
    const cases = [new EvalCase({ id: 'a', input: 'hi' })];

    expect(() => new Dataset({ name: '', version: '1', cases })).toThrow(
      /dataset name must not be empty/,
    );
    expect(() => new Dataset({ name: 'd', version: '', cases })).toThrow(
      /dataset version must not be empty/,
    );
    expect(() => new Dataset({ name: 'd', version: '1', cases: [] })).toThrow(
      /a dataset needs at least one case/,
    );
  });
});

describe('Dataset parsing', () => {
  it('round-trips through canonical JSON', () => {
    const dataset = capitalsDataset();
    const restored = Dataset.fromJson(dataset.toJson());

    expect(restored.name).toBe(dataset.name);
    expect(restored.version).toBe(dataset.version);
    expect(restored.ids()).toEqual(dataset.ids());
    expect(restored.case('capital-pe').expected).toBe('Lima');
  });

  it('writes sorted keys with a trailing newline', () => {
    const payload = capitalsDataset().toJson();

    expect(payload.endsWith('\n')).toBe(true);
    // 'cases' sorts before 'name', so the output is a reviewable diff.
    expect(payload.indexOf('"cases"')).toBeLessThan(payload.indexOf('"name"'));
  });

  it('accepts records and rejects a bad case', () => {
    const built = Dataset.fromRecords('d', '1', [{ id: 'a', input: 'hi' }]);
    expect(built.length).toBe(1);

    expect(() => Dataset.fromRecords('d', '1', [{ input: 'hi' }])).toThrow(
      /dataset case 0 needs a non-empty 'id'/,
    );
    expect(() => Dataset.fromRecords('d', '1', [{ id: 'a' }])).toThrow(/case "a" needs an 'input'/);
    expect(() => Dataset.fromRecords('d', '1', [{ id: 'a', input: 1 }])).toThrow(
      /case "a" needs an 'input'/,
    );
  });

  it('rejects a case whose expected value is not a string', () => {
    expect(() => Dataset.fromRecords('d', '1', [{ id: 'a', input: 'x', expected: 3 }])).toThrow(
      /has a non-string 'expected'/,
    );
  });

  it('discards non-string tags and a non-object metadata bag', () => {
    const built = Dataset.fromJson(
      JSON.stringify({
        name: 'd',
        version: '1',
        cases: [{ id: 'a', input: 'x', tags: ['ok', 7], metadata: ['no'] }],
      }),
    );

    expect(built.case('a').tags).toEqual(['ok']);
    expect(built.case('a').metadata).toEqual({});
  });

  it('rejects a payload that is not an object', () => {
    expect(() => Dataset.fromJson('[]')).toThrow(/a dataset must be a JSON object/);
  });

  it('rejects non-JSON', () => {
    expect(() => Dataset.fromJson('{')).toThrow(/a dataset must be JSON:/);
  });

  it('rejects a missing name, version and cases', () => {
    expect(() => Dataset.fromJson('{"version":"1","cases":[{"id":"a","input":"x"}]}')).toThrow(
      /needs a non-empty 'name'/,
    );
    expect(() => Dataset.fromJson('{"name":"d","cases":[{"id":"a","input":"x"}]}')).toThrow(
      /needs a non-empty 'version'/,
    );
    expect(() => Dataset.fromJson('{"name":"d","version":"1","cases":[]}')).toThrow(
      /a dataset needs at least one case/,
    );
  });

  it('rejects a non-object case entry', () => {
    expect(() => Dataset.fromJson('{"name":"d","version":"1","cases":[1]}')).toThrow(
      /dataset case 0 is not an object/,
    );
  });

  it('reads a dataset from a path', () => {
    const path = scratch(capitalsDataset().toJson());

    expect(Dataset.fromPath(path).ids()).toEqual([
      'capital-fr',
      'capital-jp',
      'capital-pe',
      'capital-ke',
    ]);
  });

  it('raises the framework error type', () => {
    expect(() => Dataset.fromJson('{}')).toThrow(FrameworkEvalError);
  });
});
