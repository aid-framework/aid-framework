/**
 * Python literal and expression rendering.
 *
 * Rendering is a pure function of `(value, indent)`, so the emitters decide *what*
 * to render and this module decides *how* it looks. Line width is a property of the
 * target rather than of one emitter, so it lives here as data instead of being
 * repeated in every call site.
 */

/** The generated Python's line budget; the example's ruff configuration sets the same. */
export const MAX_LINE = 100;

/** One level of Python indentation. */
export const INDENT = '    ';

/**
 * A Python string literal.
 *
 * JSON's escaping is a strict subset of Python's, so `JSON.stringify` round-trips
 * every value exactly -- and it escapes quotes and newlines, which is what keeps a
 * template's embedded quote from ending the literal early.
 */
export function pythonString(value: string): string {
  return JSON.stringify(value);
}

/** A Python number literal. Non-finite numbers have no literal, so they become `None`. */
export function pythonNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'None';
}

/**
 * Code-unit ordering, never `localeCompare`.
 *
 * Determinism is a byte-level promise: a locale-dependent comparison would order the
 * same IR differently on two machines and change the output without changing the
 * input.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Entries of a JSON object in sorted key order. */
function sortedEntries(value: object): [string, unknown][] {
  return Object.entries(value).sort((left, right) => compareStrings(left[0], right[0]));
}

/** A one-line rendering, or `undefined` when the value cannot stay on one line. */
function compact(value: unknown): string | undefined {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'string') return pythonString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items: string[] = [];
    for (const item of value) {
      const rendered = compact(item);
      if (rendered === undefined) return undefined;
      items.push(rendered);
    }
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = sortedEntries(value);
    if (entries.length === 0) return '{}';
    const items: string[] = [];
    for (const [key, item] of entries) {
      const rendered = compact(item);
      if (rendered === undefined) return undefined;
      items.push(`${pythonString(key)}: ${rendered}`);
    }
    return `{${items.join(', ')}}`;
  }
  return undefined;
}

/**
 * One entry of an expanded literal: the flat form when it fits, otherwise the form ruff
 * itself would produce.
 *
 * A long **string** leaf has no flat form that fits and no container left to expand, so
 * without this it emits a line over the limit and `ruff format --check` fails on generated
 * output. The wrapped form is parenthesised implicit concatenation, which ruff leaves
 * alone: it does not merge string literals, and the flat form does not fit by construction.
 * Nothing changes for an entry that already fits, which is why this is invisible to every
 * literal emitted before it existed.
 */
function entryLine(prefix: string, item: unknown, indent: string): string {
  const flat = compact(item);
  if (flat !== undefined && indent.length + prefix.length + flat.length + 1 <= MAX_LINE) {
    return `${indent}${prefix}${flat},`;
  }
  if (typeof item === 'string') return `${wrappedString(prefix, item, indent)},`;
  return `${indent}${prefix}${pythonValue(item, indent, prefix, ',')},`;
}

function expanded(value: unknown, indent: string): string {
  const inner = `${indent}${INDENT}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => entryLine('', item, inner));
    return `[\n${items.join('\n')}\n${indent}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = sortedEntries(value);
    if (entries.length === 0) return '{}';
    const items = entries.map(([key, item]) => entryLine(`${pythonString(key)}: `, item, inner));
    return `{\n${items.join('\n')}\n${indent}}`;
  }
  return compact(value) ?? 'None';
}

/**
 * A Python literal for an IR value.
 *
 * Objects render with **sorted** keys: a literal's key order is not part of its
 * meaning, and sorting keeps the bytes stable when a spec author reorders a map.
 *
 * `prefix` and `suffix` are the text that shares the *first and last* line with the
 * literal -- a mapping key and a comma, when this value is one entry of a larger
 * literal. The line budget only means anything if it counts what is actually on the
 * line: measuring a nested value by itself lets a 88-character list pass a 100-column
 * check and still emit a 110-column line.
 */
export function pythonValue(value: unknown, indent = '', prefix = '', suffix = ''): string {
  const oneLine = compact(value);
  if (
    oneLine !== undefined &&
    indent.length + prefix.length + oneLine.length + suffix.length <= MAX_LINE
  ) {
    return oneLine;
  }
  return expanded(value, indent);
}

/**
 * A whole statement: `prefix` (for example `'return '`) plus a literal.
 *
 * `prefix` is measured *with* the literal for the line budget, so a statement cannot
 * overflow the width just because its keyword was not counted; the continuation lines
 * still indent from the statement's own column.
 */
export function pythonStatement(prefix: string, value: unknown, indent = ''): string {
  const oneLine = compact(value);
  if (oneLine !== undefined && indent.length + prefix.length + oneLine.length <= MAX_LINE) {
    return `${indent}${prefix}${oneLine}`;
  }
  return `${indent}${prefix}${expanded(value, indent)}`;
}

/** A one-line tuple. A single element needs the trailing comma Python requires. */
export function pythonTuple(values: readonly string[]): string {
  if (values.length === 0) return '()';
  const items = values.join(', ');
  return values.length === 1 ? `(${items},)` : `(${items})`;
}

/** Every run of whitespace collapsed to a single space. */
export function collapseWhitespace(text: string): string {
  let result = '';
  let pendingSpace = false;
  for (const char of text) {
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f') {
      pendingSpace = result !== '';
      continue;
    }
    if (pendingSpace) {
      result += ' ';
      pendingSpace = false;
    }
    result += char;
  }
  return result;
}

/**
 * `text` split into lines that fit `firstWidth` columns on the first line and
 * `restWidth` on each line after it, greedily.
 *
 * Linear, and deliberately not a regex. A word longer than the budget cannot be broken
 * without cutting an identifier in half, so it is left over-long: callers keep such text
 * out of a docstring instead of relying on wrapping to rescue it.
 */
export function wrapText(text: string, firstWidth: number, restWidth = firstWidth): string[] {
  const lines: string[] = [];
  let current = '';
  let width = firstWidth;
  for (const word of text.split(' ')) {
    if (word === '') continue;
    if (current === '') {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
    width = restWidth;
  }
  lines.push(current);
  return lines;
}

/**
 * A docstring for `text`, wrapped to the code line budget.
 *
 * `ruff format` does not reflow the contents of a string, so an over-long description
 * stays over-long and trips the line budget; it has to be wrapped here. The wrap uses a
 * real newline inside one literal rather than echoing the text as adjacent literals,
 * because the formatter *does* join adjacent literals inside a docstring -- and a file
 * the formatter rewrites is a file whose recorded hash changes under the user's feet.
 *
 * Backslashes and every `"` are escaped, so no description can end the literal
 * early -- the one failure a triple-quoted string cannot recover from. Whitespace is
 * collapsed first, so a description's own line breaks cannot decide the emitted line
 * count.
 */
export function docstring(text: string, indent = ''): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed === '') return '';
  const escaped = collapsed.split('\\').join('\\\\').split('"').join('\\"');
  // Six quote characters: three opening, three closing.
  if (indent.length + 6 + escaped.length <= MAX_LINE) {
    return `${indent}"""${escaped}"""`;
  }
  // The opening line carries the three quotes; the closing quotes take a line of their
  // own, which is the shape `ruff format` leaves untouched.
  const lines = wrapText(escaped, MAX_LINE - indent.length - 3, MAX_LINE - indent.length);
  return [
    `${indent}"""${lines[0] ?? ''}`,
    ...lines.slice(1).map((line) => `${indent}${line}`),
    `${indent}"""`,
  ].join('\n');
}

/** Lines of `text` with their terminators kept. Linear, and deliberately not a regex. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (char === '\n') {
      lines.push(current);
      current = '';
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** How many extra characters JSON escaping adds to one character. */
function escapeCost(char: string): number {
  if (char === '\\' || char === '"') return 2;
  if (char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\b') return 2;
  return (char.codePointAt(0) ?? 0) < 0x20 ? 6 : 1;
}

function renderedLength(text: string): number {
  let length = 0;
  for (const char of text) length += escapeCost(char);
  return length;
}

/**
 * Split `text` into pieces whose *escaped* length fits `budget`, preferring the last
 * space that fits.
 *
 * The budget is measured after escaping rather than before, because `"\n"` costs two
 * characters and a budget on raw length would overflow the line for exactly the
 * templates that are already long. A word longer than the budget is cut mid-word
 * rather than emitted as an unbounded line. The pieces concatenate back to `text`
 * exactly, which is the property the unit test asserts.
 */
function splitEscaped(text: string, budget: number): string[] {
  const limit = Math.max(budget, 1);
  const pieces: string[] = [];
  let current = '';
  let rendered = 0;
  let lastBreak = -1;

  for (const char of text) {
    const cost = escapeCost(char);
    if (rendered + cost > limit && current !== '') {
      if (lastBreak > 0 && lastBreak < current.length) {
        pieces.push(current.slice(0, lastBreak));
        current = current.slice(lastBreak);
        rendered = renderedLength(current);
      } else {
        pieces.push(current);
        current = '';
        rendered = 0;
      }
      lastBreak = -1;
    }
    current += char;
    rendered += cost;
    if (char === ' ') lastBreak = current.length;
  }

  if (current !== '') pieces.push(current);
  return pieces;
}

/**
 * A keyword argument whose value is a possibly multi-line string.
 *
 * The keyword is part of the width budget here, which is what a prompt template
 * needs: `template=` alone is nine columns, and a block string that ignored them
 * would overflow by exactly the length of the word it is attached to.
 */
export function argumentString(keyword: string, text: string, indent = ''): string {
  return wrappedString(`${keyword}=`, text, indent);
}

/**
 * `prefix` (a mapping key or a keyword-argument binder) followed by `text`: on one line
 * when the prefix and the text together fit, otherwise as parenthesised implicit
 * concatenation.
 *
 * The two cases measure against **different** columns, which is the whole point. A text
 * that does not fit beside the prefix may still fit on a line of its own inside the
 * parentheses, and that is the shape `ruff format` produces and leaves alone: it merges
 * adjacent pieces greedily up to the width, so a piece sized for the prefix column would
 * be merged back and the file would fail `ruff format --check`. The pieces are therefore
 * sized for the continuation column, and a text that fits there is emitted as a single
 * parenthesised piece rather than overflowing the line it shares with the prefix.
 */
function wrappedString(prefix: string, text: string, indent: string): string {
  const oneLine = `${indent}${prefix}${pythonString(text)}`;
  if (!text.includes('\n') && oneLine.length <= MAX_LINE) return oneLine;
  const inner = `${indent}${INDENT}`;
  const budget = MAX_LINE - inner.length - 3;
  const pieces: string[] = [];
  for (const line of splitLines(text)) pieces.push(...splitEscaped(line, budget));
  const rendered = pieces.map((piece) => `${inner}${pythonString(piece)}`);
  return `${indent}${prefix}(\n${rendered.join('\n')}\n${indent})`;
}
