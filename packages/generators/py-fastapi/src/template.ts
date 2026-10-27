/**
 * Composition helpers for the emitted Python.
 *
 * Generated files are composed as *blocks*: each block carries its own internal
 * blank lines, and {@link assemble} guarantees exactly one blank line between
 * blocks plus exactly one trailing newline. That makes spacing a property of the
 * assembler rather than something 15 emitters have to agree on, which is what
 * keeps byte-exact golden output stable as the emitters change.
 */

import { generatedBanner, normalizeText } from '@aid/generator-sdk';

import { GENERATOR_NAME, GENERATOR_VERSION } from './manifest.js';
import { collapseWhitespace, MAX_LINE } from './python.js';

/** The ownership banner every generated file carries, as one comment block. */
export function banner(): string {
  return generatedBanner({
    generator: GENERATOR_NAME,
    version: GENERATOR_VERSION,
    comment: '#',
  });
}

/**
 * The banner a user-owned file carries, as one comment block.
 *
 * The generated banner promises that "an edit the next regeneration will refuse" (SDK
 * `determinism.ts`), which is true of `generated/` and false of `business/`: regeneration
 * creates a business file only when it is missing and otherwise leaves it alone, per
 * `docs/design.md` §10 step 3, which calls that work "sacred". Reusing the generated
 * banner here would tell a reader the opposite of what the drift logic does.
 */
export function businessBanner(): string {
  return [
    `# Created once by AID Framework "${GENERATOR_NAME}" v${GENERATOR_VERSION}. Edit freely.`,
    '# The generator never overwrites this file: it is yours. See aid.manifest.json.',
  ].join('\n');
}

/**
 * Remove trailing spaces and tabs from every line.
 *
 * A backward scan per line, not `/\s+$/`: the regex form is quadratic on a line of
 * whitespace (CodeQL `js/polynomial-redos`, `security_severity_level: high`).
 */
export function stripTrailingWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let end = line.length;
      while (end > 0) {
        const char = line.charCodeAt(end - 1);
        if (char !== 32 && char !== 9 && char !== 13) break;
        end -= 1;
      }
      return end === line.length ? line : line.slice(0, end);
    })
    .join('\n');
}

/** Drop leading and trailing blank lines. Linear scans, never a regex. */
export function trimBlankEdges(block: string): string {
  const lines = block.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start += 1;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Whether a block is a module docstring.
 *
 * `pythonDoc` at module level produces exactly one triple-quoted literal, and a
 * docstring at module level stands at column zero. A docstring inside a class or
 * function is indented, so it cannot match, and neither can any other block the
 * emitters build.
 */
function isModuleDocstring(block: string): boolean {
  return block.startsWith('"""');
}

/**
 * Whether a block opens a top-level definition, and so needs two blank lines around it.
 *
 * PEP 8 asks for two blank lines around a top-level `def` or `class` and one
 * everywhere else, which is also what `ruff format` rewrites to. Spacing is therefore
 * a property of this assembler rather than something fifteen emitters each have to
 * remember: output a formatter would rewrite is output whose recorded hash changes
 * under the user's feet, and the next `aid gen` would report that as drift.
 */
function opensDefinition(block: string): boolean {
  const end = block.indexOf('\n');
  const first = end === -1 ? block : block.slice(0, end);
  return (
    first.startsWith('def ') ||
    first.startsWith('async def ') ||
    first.startsWith('class ') ||
    first.startsWith('@')
  );
}

/**
 * Whether a line *ends* a docstring, at any indent.
 *
 * A docstring is emitted either as one triple-quoted literal on a single line, or -- when
 * its text would exceed the line budget -- as an opening `"""` line, wrapped text, and a
 * `"""` closing line of its own. Both endings are recognisable exactly: no other line the
 * emitters produce is `"""` alone, and a docstring's text is escaped, so a content line can
 * neither open nor close one. A line that only *starts* with `"""` is the opening of a
 * multi-line docstring, not its end.
 */
function isDocstringEnd(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '"""') return true;
  return trimmed.length >= 6 && trimmed.startsWith('"""') && trimmed.endsWith('"""');
}

/**
 * A blank line after every docstring that is followed by code.
 *
 * A formatter inserts that blank line, and a class body is the common case: an emitter
 * writes `class X(BaseModel):`, then the docstring, then the fields. Emitting the blank
 * here means twelve emitters do not each have to remember it -- and a file a formatter
 * rewrites is a file whose recorded hash moves under the user's feet.
 */
export function spaceAfterDocstrings(text: string): string {
  const lines = text.split('\n');
  const spaced: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    spaced.push(line);
    if (!isDocstringEnd(line)) continue;
    const next = lines[index + 1];
    if (next === undefined || next.trim() === '') continue;
    spaced.push('');
  }
  return spaced.join('\n');
}

/**
 * A `from ... import ...` line taken apart, tolerating the parenthesised form
 * {@link importFrom} writes for a header too long for one line.
 *
 * Grouping is line-based, so a multi-line import has to be understood before it can be
 * re-rendered: slicing the names out of the raw text would pick up the closing paren as a
 * name and emit `import (a, ), b`.
 */
function parseImportLine(line: string): { module: string; names: readonly string[] } | undefined {
  const flat = collapseWhitespace(line);
  const marker = flat.indexOf(' import ');
  if (!flat.startsWith('from ') || marker === -1) return undefined;
  let names = flat.slice(marker + ' import '.length);
  if (names.startsWith('(')) names = names.slice(1);
  if (names.endsWith(')')) names = names.slice(0, -1);
  return {
    module: flat.slice(5, marker),
    names: names
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  };
}

/**
 * Order two modules the way isort does, with ruff's default
 * `relative-imports-order = furthest-to-closest`: absolute modules first, then relative
 * ones from the most dots down to the fewest, and alphabetical within a level.
 *
 * `from ..schemas import Customer` therefore precedes `from . import ToolContext`, which
 * plain lexicographic ordering gets backwards -- ruff rewrites it, and a file the
 * formatter rewrites is a file whose recorded hash moves under the user's feet.
 */
function compareModules(left: string, right: string): number {
  if (left === right) return 0;
  let leftDots = 0;
  while (left[leftDots] === '.') leftDots += 1;
  let rightDots = 0;
  while (right[rightDots] === '.') rightDots += 1;
  if ((leftDots === 0) !== (rightDots === 0)) return leftDots === 0 ? -1 : 1;
  if (leftDots !== rightDots) return rightDots - leftDots;
  return left < right ? -1 : 1;
}

/** isort's default within a section: plain imports first, then `from` imports, each sorted. */
function isortLines(lines: readonly string[]): string[] {
  const unique = [...new Set(lines.map((line) => line.trim()).filter((line) => line !== ''))];
  const plain = unique.filter((line) => line.startsWith('import ')).sort();
  const merged = new Map<string, string[]>();
  for (const line of unique) {
    const parsed = parseImportLine(line);
    if (parsed === undefined) continue;
    const names = merged.get(parsed.module) ?? [];
    names.push(...parsed.names);
    merged.set(parsed.module, names);
  }
  const from = [...merged.keys()]
    .sort(compareModules)
    .map((module) => importFrom(module, merged.get(module) ?? []));
  return [...plain, ...from];
}

/**
 * Import lines grouped the way isort asks: stdlib, third-party, then local, one blank
 * line between groups and none inside one.
 *
 * An `assemble` block boundary *is* a blank line, so an emitter that pushed one block
 * per import would put a blank line between every import -- valid Python, but not what
 * the formatter leaves behind, which is what makes the recorded hash move. Grouping
 * here keeps a whole header as one block.
 */
export function importBlock(groups: readonly (readonly string[])[]): string {
  return groups
    .map((group) => isortLines(group))
    .filter((group) => group.length > 0)
    .map((group) => group.join('\n'))
    .join('\n\n');
}

/**
 * Whether a block's last line is a decorator, and so belongs flush against the definition
 * it decorates rather than two blank lines away from it.
 *
 * `def`/`class` spacing is a two-sided rule -- two blank lines *around* a definition -- but
 * a decorator is one-sided: leading two, trailing zero.
 */
function endsWithDecorator(block: string): boolean {
  const lines = block.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line !== '') return line.startsWith('@');
  }
  return false;
}

/** How many blank lines belong between two adjacent top-level parts. */
function blankLinesBetween(previous: string, next: string): number {
  if (endsWithDecorator(previous)) return 0;
  return opensDefinition(previous) || opensDefinition(next) ? 2 : 1;
}

/**
 * Top-level parts joined with the blank lines PEP 8 asks for.
 *
 * {@link assemble} uses this for the whole module; an emitter that builds several
 * top-level definitions into one string uses it directly, so the module-wide rule and
 * the block-local one cannot disagree.
 */
export function moduleBody(parts: readonly string[]): string {
  let text = '';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    if (index === 0) {
      text = part;
      continue;
    }
    text += `${'\n'.repeat(blankLinesBetween(parts[index - 1] ?? '', part))}\n${part}`;
  }
  return text;
}

/**
 * Join blocks with the blank lines PEP 8 asks for, then canonicalise.
 *
 * `normalizeText` supplies the canonical newline and single trailing newline
 * contract; the banner is always first and is never hand-written at call sites.
 * An `undefined` block is how a conditional section is spelled, so an emitter can
 * build its block list in one pass instead of branching around it.
 *
 * Module order is a property of the target, not of each emitter, so the assembler
 * enforces it: a module docstring has to be the *first statement* to bind `__doc__`,
 * while `from __future__` has to precede every other statement. That leaves exactly
 * one legal order -- docstring, future import, everything else -- and repeating it at
 * twenty call sites is twenty chances to get it wrong.
 *
 * `owner` selects the banner, because the ownership tier's promise differs: a
 * `business` file is written once and then left alone, so it must not claim that
 * regeneration will refuse an edit.
 */
export function assemble(
  blocks: readonly (string | undefined)[],
  owner: 'generated' | 'business' = 'generated',
): string {
  const body: string[] = [];
  let future = false;
  for (const block of blocks) {
    if (block === undefined) continue;
    const trimmed = trimBlankEdges(block);
    if (trimmed === '') continue;
    if (trimmed === HEADER) {
      future = true;
      continue;
    }
    body.push(trimmed);
  }

  const ordered = [owner === 'business' ? businessBanner() : banner()];
  const [first, ...rest] = body;
  if (first !== undefined && isModuleDocstring(first)) {
    ordered.push(first);
    if (future) ordered.push(HEADER);
    ordered.push(...rest);
  } else {
    if (future) ordered.push(HEADER);
    ordered.push(...body);
  }
  return normalizeText(stripTrailingWhitespace(spaceAfterDocstrings(moduleBody(ordered))));
}

/**
 * A union expression in a stable order.
 *
 * Deterministic ordering is a correctness property here: `str | int` and
 * `int | str` are the same type, so emitting whichever the input happened to list
 * first would make byte-identical output depend on spec authoring order.
 */
export function union(members: readonly string[]): string {
  const unique = [...new Set(members)].sort();
  if (unique.length === 0) return 'Any';
  if (unique.length === 1) return unique[0] ?? 'Any';
  return unique.join(' | ');
}

/**
 * A single- or multi-line tuple literal, deterministic order preserved.
 *
 * `prefix` and `suffix` are measured with the literal, because a tuple written by an
 * assignment or a `return` shares its line with them; measuring only the literal lets a
 * short tuple overflow the width and get rewritten.
 *
 * A one-element tuple keeps the trailing comma Python requires to make it a tuple at all,
 * and it must stay on one line: because that comma is *required*, `ruff format` does not
 * treat it as the "magic trailing comma" that pins a collection open, and folds the
 * exploded form back down.
 */
export function tupleLiteral(
  values: readonly string[],
  indent: string,
  prefix = '',
  suffix = '',
): string {
  if (values.length === 0) return '()';
  if (values.length === 1) return `(${values[0] ?? ''},)`;
  const oneLine = `(${values.join(', ')})`;
  if (indent.length + prefix.length + oneLine.length + suffix.length <= MAX_LINE) return oneLine;
  const inner = values.map((value) => `${indent}    ${value},`).join('\n');
  return `(\n${inner}\n${indent})`;
}

/** A dict literal, or `{}` when empty. */
export function dictLiteral(
  entries: readonly (readonly [string, string])[],
  indent: string,
): string {
  if (entries.length === 0) return '{}';
  const rendered = entries.map(([key, value]) => `${indent}    ${key}: ${value},`);
  return `{\n${rendered.join('\n')}\n${indent}}`;
}

/**
 * A dict assignment whose body is already rendered one entry per line.
 *
 * Empty is `{}` on the assignment's own line: `ruff format` folds an exploded but empty
 * literal back down, so emitting `{\n}` there produces a file the format check rejects.
 * A map is empty whenever the spec declares none of what it holds -- a document with one
 * model and no fallbacks, or no business tools -- which a second example reaches even
 * though the first never does.
 */
export function dictBlock(assignment: string, entries: readonly string[]): string {
  if (entries.length === 0) return `${assignment} {}`;
  return [`${assignment} {`, ...entries, '}'].join('\n');
}

/**
 * The rank isort's `order_by_type` assigns an imported name: constants first, then classes, then
 * functions. Without it a class whose name has an interior capital (`RerankSpec` next to
 * `Reranker`) sorts differently here than ruff does, and the emitted file fails `I001`.
 */
function importRank(name: string): number {
  if (name === name.toUpperCase()) return 0;
  return /^[A-Z]/.test(name) ? 1 : 2;
}

/** isort's ordering: by type rank, then case-insensitively, then case-sensitively. */
function importOrder(left: string, right: string): number {
  const byRank = importRank(left) - importRank(right);
  if (byRank !== 0) return byRank;
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft !== foldedRight) return foldedLeft < foldedRight ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** `from x import (a, b)` when long, one line when short. */
export function importFrom(module: string, names: readonly string[], indent = ''): string {
  const sorted = [...new Set(names)].sort(importOrder);
  const oneLine = `from ${module} import ${sorted.join(', ')}`;
  if (indent === '' && oneLine.length <= 88) return oneLine;
  const inner = sorted.map((name) => `${indent}    ${name},`).join('\n');
  return `from ${module} import (\n${inner}\n${indent})`;
}

export const HEADER = 'from __future__ import annotations';
