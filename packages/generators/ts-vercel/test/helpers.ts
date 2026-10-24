/**
 * Shared fixtures for this package's suite.
 *
 * Every test drives the generator the way a caller does -- spec text in, plan out --
 * and the spec it drives is the committed example. That is deliberate: the example is
 * the golden fixture, so the tree a reader can open and the bytes the golden test
 * compares cannot drift apart, and there is no second copy of the output to keep in
 * sync.
 *
 * The plan is built once per process. It is a pure function of the IR, so rebuilding it
 * per test would re-prove the same thing at the cost of re-running the whole pipeline.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AidManifest, AidManifestProvenance, Plan } from '@aid/generator-sdk';
import { parseAidManifestJson, sortByPath } from '@aid/generator-sdk';
import type { IR } from '@aid/ir';
import { buildIR, runGates } from '@aid/ir';
import { checkSpecText } from '@aid/spec';

import { planTsVercel, TS_VERCEL_MANIFEST, TS_VERCEL_TARGET } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(here, '..', '..', '..', '..');

/** The example app root: the directory the plan's paths are relative to. */
export const EXAMPLE_ROOT = join(REPO_ROOT, 'examples', 'support-copilot-ts');
export const EXAMPLE_SPEC_PATH = join(EXAMPLE_ROOT, 'app', 'app.spec.yaml');
export const EXAMPLE_MANIFEST_PATH = join(EXAMPLE_ROOT, 'app', 'aid.manifest.json');

/** Directories that hold build output rather than committed source. */
const CACHE_DIRS = new Set(['.git', 'coverage', 'dist', 'node_modules']);

/** A path inside the example's app directory, POSIX-joined, as the plan holds it. */
export function exampleAppPath(...segments: string[]): string {
  return ['app', ...segments].join('/');
}

/** A plan-relative path as an absolute OS path. */
export function absoluteFor(planPath: string): string {
  return join(EXAMPLE_ROOT, ...planPath.split('/'));
}

export interface SpecDiagnostic {
  severity: string;
  message: string;
  path?: readonly (string | number)[];
}

/**
 * Diagnostics as the CLI prints them. Rendered here rather than through
 * `formatDiagnostics` because this suite collects diagnostics from two packages whose
 * shapes agree structurally but not nominally.
 */
export function renderDiagnostics(diagnostics: readonly SpecDiagnostic[]): string {
  return diagnostics
    .map((line) => {
      const where = (line.path ?? []).join('.') || '<document>';
      return `  ${line.severity}: ${where}: ${line.message}`;
    })
    .join('\n');
}

function requireNoErrors(stage: string, diagnostics: readonly SpecDiagnostic[]): void {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length === 0) return;
  throw new Error(stage + ':\n' + renderDiagnostics(errors));
}

export interface ExampleBuild {
  ir: IR;
  plan: Plan;
}

/** Spec text to a plan, through the same checks and gates the CLI will run. */
export function buildForSpecText(text: string, file = EXAMPLE_SPEC_PATH): ExampleBuild {
  const spec = checkSpecText(text, { file });
  requireNoErrors('the spec did not pass the spec checks', spec.diagnostics);
  if (spec.value === undefined) {
    throw new Error('the spec parsed to nothing');
  }

  const { ir, diagnostics } = buildIR(spec.value, { file });
  requireNoErrors('the spec did not lower to an IR', diagnostics);

  // The catalog is injected rather than defaulted, exactly as the CLI injects it: the
  // gate's own fallback is `@aid/ir`'s placeholder vocabulary, which is narrower than
  // this target's declaration and would reject a spec this generator emits.
  const gates = runGates(ir, {
    targetCapabilities: { [TS_VERCEL_TARGET]: TS_VERCEL_MANIFEST.capabilities },
  });
  requireNoErrors('the IR did not pass the build gates', gates.diagnostics);

  return { ir, plan: planTsVercel(ir) };
}

/** The example's spec as authored. Read fresh, so a test can plan it more than once. */
export function exampleSpecText(): string {
  return readFileSync(EXAMPLE_SPEC_PATH, 'utf8');
}

let exampleBuild: ExampleBuild | undefined;

/** The example's spec, checked, lowered, gated and planned. Built at most once. */
export function example(): ExampleBuild {
  exampleBuild ??= buildForSpecText(exampleSpecText());
  return exampleBuild;
}

export function examplePlan(): Plan {
  return example().plan;
}

/** Every file on disk under `root`, POSIX-keyed and relative to it, caches excluded. */
export function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (CACHE_DIRS.has(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      const absolute = join(directory, entry.name);
      const key = relative(root, absolute).split(sep).join('/');
      files.set(key, readFileSync(absolute, 'utf8'));
    }
  };

  walk(root);
  return files;
}

/**
 * The two managed tiers as the example ships them, POSIX-keyed and app-relative.
 *
 * Only `generated/` and `business/` are included: everything else in the example --
 * the spec, the Next `app/api` shim, the tests, `package.json` -- is hand-written and
 * belongs to no tier, so including it would report the whole project as stray.
 */
export function shippedManagedTree(): Map<string, string> {
  const tree = readTree(join(EXAMPLE_ROOT, 'app'));
  const managed = new Map<string, string>();

  for (const [path, content] of tree) {
    if (path.startsWith('generated/') || path.startsWith('business/')) {
      managed.set(exampleAppPath(path), content);
    }
  }

  return managed;
}

/** The generated tier alone, from the same read as {@link shippedManagedTree}. */
export function shippedGeneratedTree(): Map<string, string> {
  const generated = new Map<string, string>();
  for (const [path, content] of shippedManagedTree()) {
    if (path.startsWith('app/generated/')) generated.set(path, content);
  }
  return generated;
}

/** The plan's files by owner, which is what the golden comparison and manifest check use. */
export function planFilesByOwner(
  owner: string,
): { path: string; content: string; owner: string }[] {
  return examplePlan().files.filter((file) => file.owner === owner);
}

/** A copy of a tree with one file's content replaced. */
export function withRewrite(
  tree: ReadonlyMap<string, string>,
  path: string,
  mutate: (content: string) => string,
): Map<string, string> {
  const next = new Map(tree);
  const current = next.get(path);
  if (current === undefined) throw new Error(`${path} is not in the tree`);
  next.set(path, mutate(current));
  return next;
}

/** A copy of a tree with one file removed. */
export function without(tree: ReadonlyMap<string, string>, path: string): Map<string, string> {
  const next = new Map(tree);
  if (!next.delete(path)) throw new Error(`${path} is not in the tree`);
  return next;
}

/** A file's content at a plan-relative path, or `undefined` when it is absent. */
export function onDisk(planPath: string): string | undefined {
  try {
    return readFileSync(absoluteFor(planPath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The layout the generator declares, needed to read back a manifest it wrote. */
export const MANIFEST_LAYOUT = {
  generatedDir: 'app/generated',
  businessDir: 'app/business',
} as const;

/** The manifest the example ships, parsed the way a caller reads it back. */
export function shippedManifest(): AidManifest {
  const parsed = parseAidManifestJson(readFileSync(EXAMPLE_MANIFEST_PATH, 'utf8'), MANIFEST_LAYOUT);
  requireNoErrors('the committed aid.manifest.json did not parse', parsed.diagnostics);
  if (parsed.manifest === undefined) {
    throw new Error('the committed aid.manifest.json parsed to no manifest');
  }
  return parsed.manifest;
}

/** The provenance a run of this generator records. */
export function provenanceFor(ir: IR): AidManifestProvenance {
  return {
    generator: TS_VERCEL_MANIFEST.name,
    generatorVersion: TS_VERCEL_MANIFEST.version,
    irVersion: ir.irVersion,
  };
}

/** The plan's files as a path-to-content map, for comparisons that ignore order. */
export function fileMap(files: readonly { path: string; content: string }[]): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.content]));
}

export type TreeMismatch =
  | { kind: 'missing'; path: string }
  | { kind: 'content'; path: string }
  | { kind: 'extra'; path: string };

/**
 * How a set of expected files differs from what is on disk.
 *
 * Pure, so its branches are reachable without a filesystem: a tree that matches, one
 * that is missing a file, one whose bytes differ, and one with a file the plan does not
 * account for.
 *
 * Bytes are compared only for generated files. A `business` file belongs to the
 * developer -- the example's implemented tool deliberately differs from the seed that
 * created it -- so for those the only thing that can be asserted is that they are still
 * there. That is not a weaker check than it looks: an emitter that mislabelled a
 * business seed as generated would put the untouched seed's content in the plan and be
 * caught by the byte comparison on the next line.
 */
export function diffTree(
  expected: readonly { path: string; content: string; owner: string }[],
  actual: ReadonlyMap<string, string>,
): TreeMismatch[] {
  const mismatches: TreeMismatch[] = [];
  const planned = new Set<string>();

  for (const file of expected) {
    planned.add(file.path);
    const found = actual.get(file.path);
    if (found === undefined) mismatches.push({ kind: 'missing', path: file.path });
    else if (file.owner === 'generated' && found !== file.content) {
      mismatches.push({ kind: 'content', path: file.path });
    }
  }

  for (const path of actual.keys()) {
    if (!planned.has(path)) mismatches.push({ kind: 'extra', path });
  }

  return sortByPath(mismatches);
}

/** The first line on which two versions of a file disagree, for a readable failure. */
export function firstDifference(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const limit = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < limit; index += 1) {
    const left = expectedLines[index];
    const right = actualLines[index];
    if (left === right) continue;
    return [
      `line ${index + 1}:`,
      `  plan:   ${JSON.stringify(left ?? null)}`,
      `  on disk: ${JSON.stringify(right ?? null)}`,
    ].join('\n');
  }
  return 'the files differ without differing on any line';
}

export function formatMismatches(
  mismatches: readonly TreeMismatch[],
  tree: ReadonlyMap<string, string>,
): string {
  const plan = examplePlan();
  return mismatches
    .map((mismatch) => {
      if (mismatch.kind === 'content') {
        const expected = plan.files.find((file) => file.path === mismatch.path)?.content ?? '';
        return `content: ${mismatch.path}\n${firstDifference(expected, tree.get(mismatch.path) ?? '')}`;
      }
      return `${mismatch.kind}: ${mismatch.path}`;
    })
    .join('\n');
}

/** Every backtick-delimited segment of `text`, in order, without the delimiters. */
export function templateSegments(text: string): string[] {
  const segments: string[] = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] !== '`') {
      index += 1;
      continue;
    }
    const close = text.indexOf('`', index + 1);
    if (close === -1) break;
    segments.push(text.slice(index + 1, close));
    index = close + 1;
  }

  return segments;
}
