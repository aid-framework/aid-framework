/**
 * Byte-level helpers every emitter goes through.
 *
 * A generated file is the banner, then the body, then exactly one trailing newline and
 * no tabs. `normalizeText` from the SDK enforces the newline half so the determinism
 * check and the emitters agree by construction rather than by convention.
 */

import {
  GENERATED_BANNER_MARKER,
  generatedBanner,
  normalizeText,
  sha256Hex,
} from '@aid-framework/generator-sdk';
import { GENERATOR_NAME, GENERATOR_VERSION } from '../manifest.js';
import { propertyKey, stringLiteral } from '../names.js';

export { GENERATED_BANNER_MARKER, sha256Hex };

/** The `DO NOT EDIT` banner every generated file starts with. */
export function banner(): string {
  return generatedBanner({ generator: GENERATOR_NAME, version: GENERATOR_VERSION, comment: '//' });
}

/**
 * The banner a business seed carries. It says the file is *not* owned by the generator
 * and is never overwritten, because that sentence is the whole point of the tier.
 */
export function businessBanner(): string {
  return [
    `// Created once by AID Framework "${GENERATOR_NAME}" v${GENERATOR_VERSION}. Edit freely.`,
    '// This file is yours: the generator seeds it on first run and never overwrites it.',
  ].join('\n');
}

/**
 * Drop leading and trailing newlines.
 *
 * A scan, not a regex: `/^\n+/` is linear but `/\n+$/` is unanchored on the left, so a
 * body carrying many newlines makes it retry "one-or-more, then end of input" at every
 * position. CodeQL reads spec-derived strings as untrusted input and was right to flag
 * that shape (`js/polynomial-redos`); this is linear in the part's length.
 */
function trimBlankEdges(part: string): string {
  let start = 0;
  while (start < part.length && part[start] === '\n') start += 1;
  let end = part.length;
  while (end > start && part[end - 1] === '\n') end -= 1;
  return part.slice(start, end);
}

/** Join sections with single blank lines, dropping empty ones. */
export function sections(...parts: readonly string[]): string {
  return parts
    .map(trimBlankEdges)
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/** A line fragment that may be omitted; a blank string is a real blank line. */
export type LinePart = string | readonly string[] | false | undefined;

/** Flatten line fragments, dropping only the omitted ones so blank lines survive. */
export function lines(...parts: readonly LinePart[]): string[] {
  const collected: string[] = [];
  for (const part of parts) {
    if (part === false || part === undefined) continue;
    if (typeof part === 'string') collected.push(part);
    else collected.push(...part);
  }
  return collected;
}

/** A complete generated module body: banner, then sections, then one newline. */
export function moduleText(...parts: readonly string[]): string {
  return normalizeText(`${banner()}\n\n${sections(...parts)}`);
}

/** A complete business seed body. */
export function seedText(...parts: readonly string[]): string {
  return normalizeText(`${businessBanner()}\n\n${sections(...parts)}`);
}

/**
 * A multi-line string as the TS literal whose value is exactly that string.
 *
 * No re-indentation: template contents are emitted verbatim, because the value is the
 * prompt text a model is shown and adding indentation to each line would change it.
 */
export function templateLiteral(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `\`${escaped}\``;
}

/** Render a JSON object as TypeScript source with sorted keys. */
export function jsonLiteral(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text ?? 'null';
}

/**
 * The column budget. Emitted code is formatted the way the repository formatter would
 * format it, because the example keeps its generated tree inside `biome ci` rather than
 * excluding it: `py-fastapi` keeps its emitted tree `ruff format --check` clean, and an
 * exemption here would be the weaker promise.
 */
export const LINE_WIDTH = 100;

export function fits(indent: string, text: string): boolean {
  return indent.length + text.length <= LINE_WIDTH;
}

export type Entry = readonly [string, string];

/** An object literal: inline when it fits, otherwise one entry per line. */
export function objectLiteral(entries: readonly Entry[], indent: string): string {
  if (entries.length === 0) return '{}';
  const inline = `{ ${entries.map(([key, value]) => `${key}: ${value}`).join(', ')} }`;
  if (fits(indent, inline)) return inline;
  const lines = entries.map(([key, value]) => `${indent}  ${key}: ${value},`);
  return ['{', ...lines, `${indent}}`].join('\n');
}

/** An array literal: inline when it fits, otherwise one item per line. */
export function arrayLiteral(items: readonly string[], indent: string): string {
  if (items.length === 0) return '[]';
  const inline = `[${items.join(', ')}]`;
  // An array of two or more objects is always one item per line, even when the inline
  // form fits: `biome` expands it that way, measured on both a top-level array of two
  // inline objects and the same array as a property of a multi-line object, and keeps a
  // one-element array inline. Emitting the inline form there is a `biome ci` failure in
  // the consumer's project rather than a matter of taste.
  const expandedObjects = items.length > 1 && items.every((item) => item.startsWith('{'));
  if (!expandedObjects && fits(indent, inline)) return inline;
  return ['[', ...items.map((item) => `${indent}  ${item},`), `${indent}]`].join('\n');
}

/** A named object argument spread over lines when the call would not fit. */
export function callOf(callee: string, entries: readonly Entry[], indent: string): string {
  const argument = objectLiteral(entries, `${indent}  `);
  return `${callee}(${argument})`;
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

/**
 * The order the import organiser uses: natural (so `x2` sorts before `x10`),
 * case-insensitive, with an uppercase-first tie-break on the first character whose case
 * differs, and shorter-first when one name is a prefix of the other. That is why
 * `RetrievalMetricSpec` sorts before `retrievalMetrics`, `ALIASES` before `aB`, and
 * `Pipeline` before `PipelineError`. The `type` modifier is not part of the key.
 */
export function compareNames(a: string, b: string): number {
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    const leftChar = a[left] as string;
    const rightChar = b[right] as string;
    if (isDigit(leftChar) && isDigit(rightChar)) {
      let leftEnd = left;
      while (leftEnd < a.length && isDigit(a[leftEnd] as string)) leftEnd += 1;
      let rightEnd = right;
      while (rightEnd < b.length && isDigit(b[rightEnd] as string)) rightEnd += 1;
      const leftNumber = Number(a.slice(left, leftEnd));
      const rightNumber = Number(b.slice(right, rightEnd));
      if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
      left = leftEnd;
      right = rightEnd;
      continue;
    }
    const leftLower = leftChar.toLowerCase();
    const rightLower = rightChar.toLowerCase();
    if (leftLower !== rightLower) return leftLower < rightLower ? -1 : 1;
    if (leftChar !== rightChar) return leftChar < rightChar ? -1 : 1;
    left += 1;
    right += 1;
  }
  const leftRest = a.length - left;
  const rightRest = b.length - right;
  if (leftRest !== rightRest) return leftRest < rightRest ? -1 : 1;
  return 0;
}

/** A list of names sorted the way the import organisers sort them. */
export function sortedNames(names: Iterable<string>): string[] {
  return [...names].sort(compareNames);
}

export interface ImportName {
  readonly name: string;
  readonly type: boolean;
}

/**
 * One import statement. Type-only members carry the inline `type` modifier, which is
 * what the formatter wants when a statement mixes values and types; a statement that is
 * entirely types is written `import type`.
 */
export function importStatement(from: string, names: readonly ImportName[]): string {
  const sorted = [...names].sort((a, b) => compareNames(a.name, b.name));
  if (sorted.every((entry) => entry.type)) {
    return `import type { ${sorted.map((entry) => entry.name).join(', ')} } from ${stringLiteral(from)};`;
  }
  const members = sorted.map((entry) => (entry.type ? `type ${entry.name}` : entry.name));
  const inline = `import { ${members.join(', ')} } from ${stringLiteral(from)};`;
  if (fits('', inline)) return inline;
  return [
    'import {',
    ...members.map((member) => `  ${member},`),
    `} from ${stringLiteral(from)};`,
  ].join('\n');
}

/** An `export { a, b as c } from '...'` statement, expanded when it would not fit. */
export function exportStatement(from: string, names: readonly Entry[]): string {
  const sorted = [...names].sort((a, b) => compareNames(a[0], b[0]));
  const members = sorted.map(([local, exported]) =>
    local === exported ? local : `${local} as ${exported}`,
  );
  const inline = `export { ${members.join(', ')} } from ${stringLiteral(from)};`;
  if (fits('', inline)) return inline;
  return [
    'export {',
    ...members.map((member) => `  ${member},`),
    `} from ${stringLiteral(from)};`,
  ].join('\n');
}

/** An `export { a, b }` statement for names declared in the same module. */
export function localExportStatement(names: readonly string[]): string {
  return `export { ${sortedNames(names).join(', ')} };`;
}

/**
 * Order a group of import or export statements by their specifier, the way the
 * import organiser does. Statements in one group have to be emitted in this order
 * rather than in the order the IR happens to list them.
 */
export function sortStatements(
  statements: readonly { readonly from: string; readonly text: string }[],
): string[] {
  return [...statements]
    .sort((a, b) => compareNames(a.from, b.from))
    .map((statement) => statement.text);
}

/** Render a literal value as formatted TypeScript source, expanding what would not fit. */
export function tsValue(value: unknown, indent: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return stringLiteral(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return arrayLiteral(
      value.map((item) => tsValue(item, `${indent}  `)),
      indent,
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return objectLiteral(
      entries.map(([key, item]) => [propertyKey(key), tsValue(item, `${indent}  `)] as const),
      indent,
    );
  }
  return 'null';
}
