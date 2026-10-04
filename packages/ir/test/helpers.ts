/**
 * Fixture loading for the IR tests. Fixtures live in this package so its tests do
 * not couple to `@aid/spec`'s own fixtures, which must be free to change.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSpecText, type Diagnostic } from '@aid/spec';

import type { BuildResult, GateOptions, GateRunResult, IR } from '../src/index.js';
import { buildIR, runGates } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = join(HERE, 'fixtures');
/** `__golden__` is the repo convention; biome and gitattributes both already skip it. */
export const GOLDEN_DIR = join(HERE, '__golden__');

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

export function goldenText(name: string): string {
  return readFileSync(join(GOLDEN_DIR, name), 'utf8');
}

/** Parses and validates a fixture, failing loudly rather than testing a broken input. */
export function fixtureValue(name: string): unknown {
  const checked = checkSpecText(fixtureText(name), { file: name });
  if (!checked.ok) {
    throw new Error(
      `${name} is not a valid spec:\n${checked.diagnostics
        .map((diagnostic) => `  ${diagnostic.code}: ${diagnostic.message}`)
        .join('\n')}`,
    );
  }
  return checked.value;
}

export function buildFixture(name: string): BuildResult {
  return buildIR(fixtureValue(name), { file: name });
}

/**
 * A detached copy of a fixture's IR, for the negative cases no valid spec can
 * express: layer 1 rejects them before an IR exists, so the gate's own rule has to
 * be driven directly.
 */
export function mutateIR(name: string): IR {
  return structuredClone(buildFixture(name).ir);
}

export interface GateFixtureResult extends GateRunResult {
  ir: IR;
}

export function gateFixture(name: string, options: Partial<GateOptions> = {}): GateFixtureResult {
  const built = buildFixture(name);
  return { ...runGates(built.ir, options), ir: built.ir };
}

/** The first element, so tests stay clean under `noUncheckedIndexedAccess`. */
export function first<T>(items: readonly T[]): T {
  const head = items[0];
  if (head === undefined) {
    throw new Error('expected a non-empty collection');
  }
  return head;
}

export function codesOf<C extends string>(diagnostics: readonly Diagnostic<C>[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code).sort();
}

export function messagesOf<C extends string>(diagnostics: readonly Diagnostic<C>[]): string {
  return diagnostics.map((diagnostic) => diagnostic.message).join('\n');
}

/** The one diagnostic with `code`, or a failure naming what was actually emitted. */
export function onlyDiagnosticWith<C extends string>(
  diagnostics: readonly Diagnostic<C>[],
  code: C,
): Diagnostic<C> {
  const matches = diagnostics.filter((diagnostic) => diagnostic.code === code);
  const only = matches[0];
  if (only === undefined || matches.length !== 1) {
    throw new Error(
      `expected exactly one ${code}, found ${matches.length} in:\n${messagesOf(diagnostics)}`,
    );
  }
  return only;
}

/** The one diagnostic at spec path `path`, or a failure naming what was emitted. */
export function diagnosticAt<C extends string>(
  diagnostics: readonly Diagnostic<C>[],
  path: string,
): Diagnostic<C> {
  const matches = diagnostics.filter((diagnostic) => diagnostic.path.join('.') === path);
  const only = matches[0];
  if (only === undefined || matches.length !== 1) {
    throw new Error(
      `expected exactly one diagnostic at ${path}, found ${matches.length} in:\n${messagesOf(
        diagnostics,
      )}`,
    );
  }
  return only;
}

/** A collection member by id, so an assertion never depends on the IR's array order. */
export function byId<T extends { id: string }>(items: readonly T[], id: string): T {
  const found = items.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`no member with id "${id}", only [${items.map((item) => item.id).join(', ')}]`);
  }
  return found;
}
