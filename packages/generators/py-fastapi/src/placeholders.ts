/**
 * The IR's `{{ name }}` placeholder mini-language, and its conversion to the
 * `str.format` fields the runtime renders with.
 *
 * One scanner, three consumers: `checkPlan` rejects templates the runtime cannot
 * render, the prompt emitter stores the runtime-syntax template, and the pipeline
 * emitter builds an f-string for a step input. Two independent scanners would be free
 * to disagree, and the disagreement would only show up as a runtime
 * `PromptRenderError` in generated code.
 *
 * The scan is a single pass over the characters and deliberately not a regular
 * expression: `/\{\{(.*?)\}\}/` backtracks, and the runtime's own parser is
 * `string.Formatter`, so a hand-written scanner is both faster on adversarial input
 * and easier to keep in step with the one Python actually uses.
 */

export type TemplatePart =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'placeholder'; readonly name: string };

/**
 * Whether `spec` is a dotted identifier.
 *
 * This is the only shape a placeholder may take. A body such as `a:>4`, `a-b` or
 * `a[0]` is not nameable, and the runtime supplies values as `**kwargs` -- so
 * accepting it would either silently drop the format spec or fail at render time.
 * Single-pass character classification, never a regex: a repeated-group pattern over
 * braces backtracks.
 */
export function isNameLike(spec: string): boolean {
  if (spec === '') return false;
  let atSegmentStart = true;
  for (const char of spec) {
    if (char === '.') {
      if (atSegmentStart) return false;
      atSegmentStart = true;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || char === '_';
    if (atSegmentStart) {
      if (!isLetter) return false;
      atSegmentStart = false;
      continue;
    }
    const isDigit = code >= 48 && code <= 57;
    if (!isLetter && !isDigit) return false;
  }
  return !atSegmentStart;
}

/**
 * Split a template into literal text and placeholders.
 *
 * A placeholder is `{{` a dotted identifier `}}`; **everything else is literal
 * text**, including a single brace or a brace run that does not close. That is the
 * IR's convention (its gate finds declarations with `/\{\{\s*(name)\s*\}\}/`, and a
 * step input of `"{{event.subject}}"` is a reference), and it differs from the
 * `str.format` convention the runtime renders with -- {@link interpolate} is where
 * the conversion happens, in one place, for both consumers.
 *
 * Leftover braces stay in the text parts so that a caller can see exactly what the
 * author wrote; {@link escapeBraces} then guarantees the runtime prints them
 * verbatim rather than treating them as fields.
 */
export function scanTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = '';
  let index = 0;

  const flush = (): void => {
    if (text === '') return;
    parts.push({ kind: 'text', value: text });
    text = '';
  };

  while (index < template.length) {
    if (template[index] === '{' && template[index + 1] === '{') {
      const close = template.indexOf('}}', index + 2);
      if (close !== -1) {
        const name = template.slice(index + 2, close).trim();
        if (isNameLike(name)) {
          flush();
          parts.push({ kind: 'placeholder', name });
          index = close + 2;
          continue;
        }
      }
    }
    text += template[index] ?? '';
    index += 1;
  }

  flush();
  return parts;
}

/** Every placeholder name in first-seen order, duplicates included. */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const part of scanTemplate(template)) {
    if (part.kind === 'placeholder') names.push(part.name);
  }
  return names;
}

/** Literal braces doubled, so a text part cannot introduce an f-string field. */
export function escapeBraces(text: string): string {
  let result = '';
  for (const char of text) result += char === '{' || char === '}' ? char + char : char;
  return result;
}

/**
 * The body of an f-string whose value equals `template`.
 *
 * Literal braces are doubled and each `{{ name }}` becomes `{<expression>}`, so the
 * runtime receives the author's text with the author's substitutions. `resolve` is
 * only called for placeholders the caller already validated.
 */
export function interpolate(template: string, resolve: (name: string) => string): string {
  let body = '';
  for (const part of scanTemplate(template)) {
    body += part.kind === 'text' ? escapeBraces(part.value) : `{${resolve(part.name)}}`;
  }
  return body;
}
