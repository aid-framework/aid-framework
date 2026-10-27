/**
 * Driving specs that declare composite steps, from spec text to emitted bytes.
 *
 * The committed `packages/ir/test/fixtures/composite.yaml` is the one spec in the
 * repository that declares all four kinds, so it is what the emitter's composite path is
 * pinned against. It is lowered and planned here *without* `runGates`: the security gate
 * requires an input guardrail, and the `guard`/`agent` surface that would declare one is
 * L5c -- deliberately not part of this layer, so requiring it here would make this suite
 * depend on a layer that does not exist yet. Nothing this file exercises is downstream of
 * that gate: `planPyFastApi` is a pure function of the IR and runs before it.
 *
 * The one rule every test in this suite follows: assert on emitted bytes, not on the
 * emitter's internal helpers. A helper that returns the right shape into a body that then
 * ignores it is exactly the defect these tests exist to catch.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Plan } from '@aid/generator-sdk';
import type { IR } from '@aid/ir';
import { buildIR } from '@aid/ir';
import { checkSpecText } from '@aid/spec';

import { planPyFastApi } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root, two levels above this package. */
export const PACKAGE_REPO_ROOT = resolve(here, '..', '..', '..', '..');

const COMPOSITE_FIXTURE = join(
  PACKAGE_REPO_ROOT,
  'packages',
  'ir',
  'test',
  'fixtures',
  'composite.yaml',
);

/** A spec that declares all four composite kinds. */
export function compositeSpecText(): string {
  return readFileSync(COMPOSITE_FIXTURE, 'utf8');
}

function requireNoErrors(
  stage: string,
  diagnostics: readonly { severity: string; message: string }[],
) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length === 0) return;
  throw new Error(`${stage}:\n${errors.map((error) => `  ${error.message}`).join('\n')}`);
}

/** Spec text to an IR, stopping before the gates. */
export function irForSpecText(text: string, file = COMPOSITE_FIXTURE): IR {
  const spec = checkSpecText(text, { file });
  requireNoErrors('the spec did not pass the spec checks', spec.diagnostics);
  if (spec.value === undefined) throw new Error('the spec parsed to nothing');

  const { ir, diagnostics } = buildIR(spec.value, { file });
  requireNoErrors('the spec did not lower to an IR', diagnostics);
  return ir;
}

/** Spec text to this target's plan, stopping before the gates. */
export function planForSpecText(text: string, file = COMPOSITE_FIXTURE): Plan {
  return planPyFastApi(irForSpecText(text, file));
}

let composite: Plan | undefined;

/** The composite fixture, planned once per process. */
export function compositePlan(): Plan {
  composite ??= planForSpecText(compositeSpecText());
  return composite;
}

/** One file of a plan by path, or a failure naming what the plan does hold. */
export function fileAt(plan: Plan, path: string): string {
  const found = plan.files.find((file) => file.path === path);
  if (found === undefined) {
    throw new Error(
      `${path} is not in the plan; it holds:\n  ${plan.files.map((f) => f.path).join('\n  ')}`,
    );
  }
  return found.content;
}

/** A plan's files, POSIX-keyed by path. */
export function planFileMap(plan: Plan): Map<string, string> {
  return new Map(plan.files.map((file) => [file.path, file.content]));
}

/** A copy of spec text with one line replaced, which is how a variant spec is built. */
export function withLine(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`the spec does not contain ${JSON.stringify(from)}`);
  return text.split(from).join(to);
}
