/**
 * Eval datasets: the probabilistic analogue of a golden fixture.
 *
 * A dataset is versioned and committed. The version matters as much as the cases:
 * comparing a run against a baseline recorded on a *different* dataset version is the
 * most common way an eval gate becomes noise, so the gate refuses it.
 */

import { readFileSync } from 'node:fs';

// biome-ignore lint/suspicious/noShadowRestrictedNames: the framework's own error name, matching the Python runtime's public surface
import { EvalError } from '../errors.js';
import { dumpsSorted } from '../internal/json.js';

export interface EvalCaseInit {
  readonly id: string;
  readonly input: string;
  readonly expected?: string | null;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

/** One input, its expected output, and any tags the metrics key off. */
export class EvalCase {
  readonly id: string;
  readonly input: string;
  readonly expected: string | null;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;

  constructor(init: EvalCaseInit) {
    if (init.id.length === 0) throw new RangeError('case id must not be empty');
    this.id = init.id;
    this.input = init.input;
    this.expected = init.expected ?? null;
    this.tags = init.tags ?? [];
    this.metadata = init.metadata ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      input: this.input,
      expected: this.expected,
      tags: [...this.tags],
      metadata: { ...this.metadata },
    };
  }
}

function parseCase(raw: unknown, where: string): EvalCase {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new EvalError(`dataset ${where} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const id = record.id;
  const input = record.input;
  if (typeof id !== 'string' || id.length === 0) {
    throw new EvalError(`dataset ${where} needs a non-empty 'id'`);
  }
  if (typeof input !== 'string') throw new EvalError(`case ${JSON.stringify(id)} needs an 'input'`);
  const expected = record.expected;
  if (expected !== undefined && expected !== null && typeof expected !== 'string') {
    throw new EvalError(`case ${JSON.stringify(id)} has a non-string 'expected'`);
  }
  const tags = record.tags;
  const metadata = record.metadata;
  return new EvalCase({
    id,
    input,
    expected: typeof expected === 'string' ? expected : null,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [],
    metadata:
      typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
        ? (metadata as Record<string, string>)
        : {},
  });
}

function parseDataset(payload: unknown): Dataset {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new EvalError('a dataset must be a JSON object');
  }
  const record = payload as Record<string, unknown>;
  const name = record.name;
  const version = record.version;
  const cases = record.cases;
  if (typeof name !== 'string' || name.length === 0) {
    throw new EvalError("a dataset needs a non-empty 'name'");
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new EvalError("a dataset needs a non-empty 'version'");
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new EvalError('a dataset needs at least one case');
  }
  return new Dataset({
    name,
    version,
    cases: cases.map((entry, index) => parseCase(entry, `case ${index}`)),
  });
}

/** An ordered, versioned set of cases. */
export class Dataset {
  readonly name: string;
  readonly version: string;
  readonly cases: readonly EvalCase[];

  constructor(init: {
    readonly name: string;
    readonly version: string;
    readonly cases: readonly EvalCase[];
  }) {
    if (init.name.length === 0) throw new RangeError('dataset name must not be empty');
    if (init.version.length === 0) throw new RangeError('dataset version must not be empty');
    if (init.cases.length === 0) throw new RangeError('a dataset needs at least one case');
    this.name = init.name;
    this.version = init.version;
    this.cases = init.cases;
  }

  get length(): number {
    return this.cases.length;
  }

  ids(): string[] {
    return this.cases.map((entry) => entry.id);
  }

  case(caseId: string): EvalCase {
    for (const candidate of this.cases) {
      if (candidate.id === caseId) return candidate;
    }
    throw new EvalError(
      `dataset ${JSON.stringify(this.name)} has no case ${JSON.stringify(caseId)}`,
    );
  }

  byTag(tag: string): EvalCase[] {
    return this.cases.filter((entry) => entry.tags.includes(tag));
  }

  static fromRecords(
    name: string,
    version: string,
    records: readonly Readonly<Record<string, unknown>>[],
  ): Dataset {
    return parseDataset({ name, version, cases: records });
  }

  static fromJson(payload: string): Dataset {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new EvalError(
        `a dataset must be JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseDataset(parsed);
  }

  static fromPath(path: string | URL): Dataset {
    return Dataset.fromJson(readFileSync(path, 'utf8'));
  }

  /** Canonical JSON: sorted keys, so a dataset diff is reviewable. */
  toJson(): string {
    const payload = {
      name: this.name,
      version: this.version,
      cases: this.cases.map((entry) => entry.toJSON()),
    };
    return `${dumpsSorted(payload)}\n`;
  }
}
