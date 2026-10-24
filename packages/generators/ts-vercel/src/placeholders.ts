/**
 * The IR's `{{ name }}` placeholder mini-language, and its conversion to the
 * `str.format` fields the runtime renders with.
 *
 * One scanner, two consumers: `checkPlan` rejects templates the runtime cannot render,
 * and the prompt emitter stores the runtime-syntax template. Two independent scanners
 * would be free to disagree, and the disagreement would only show up at request time.
 *
 * The two conventions are not the same language. The IR interpolates mustache
 * placeholders, so `{{ name }}` is a substitution site and a lone brace is literal
 * text; the runtime's `PromptTemplate` parses with `str.format`, where `{{ name }}` is
 * an *escaped* literal and `{name}` is the substitution site. Emitting the IR's text
 * unchanged therefore produces a template with no variables at all -- exactly the
 * defect this module exists to prevent.
 */

export type TemplatePart =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'placeholder'; readonly name: string };

/**
 * Whether `spec` is a dotted identifier -- the only shape a placeholder may take.
 *
 * `a:>4`, `a-b` and `a[0]` are not nameable, and the runtime supplies values as
 * keywords, so accepting one would either drop the format spec or fail at render time.
 */
export function isNameLike(spec: string): boolean {
  if (spec.length === 0) return false;
  let atSegmentStart = true;
  for (const character of spec) {
    if (character === '.') {
      if (atSegmentStart) return false;
      atSegmentStart = true;
      continue;
    }
    const isLetter =
      (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
    const isDigit = character >= '0' && character <= '9';
    const isUnderscore = character === '_';
    if (atSegmentStart) {
      if (!isLetter && !isUnderscore) return false;
    } else if (!isLetter && !isDigit && !isUnderscore) {
      return false;
    }
    atSegmentStart = false;
  }
  return !atSegmentStart;
}

/**
 * Split a template into literal text and placeholders.
 *
 * A placeholder is `{{` a dotted identifier `}}`; everything else is literal text,
 * including a single brace or a run that never closes. That is the IR's convention,
 * and it differs from what the runtime renders with -- {@link runtimeTemplate} is the
 * single place the conversion happens.
 */
export function scanTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let text = '';
  let index = 0;
  const flush = (): void => {
    if (text.length > 0) {
      parts.push({ kind: 'text', value: text });
      text = '';
    }
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

/** Every placeholder name in first-seen order. */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const part of scanTemplate(template)) {
    if (part.kind === 'placeholder' && !names.includes(part.name)) names.push(part.name);
  }
  return names;
}

/** Literal braces doubled, so a text part cannot introduce a field. */
function escapeBraces(text: string): string {
  let result = '';
  for (const character of text) {
    result += character === '{' || character === '}' ? character + character : character;
  }
  return result;
}

/**
 * The IR's template as the `str.format` body the runtime renders.
 *
 * `{{ name }}` becomes `{name}` and every literal brace is doubled, so the model sees
 * the text the spec asked for and the runtime sees the fields it can bind.
 */
export function runtimeTemplate(template: string): string {
  let body = '';
  for (const part of scanTemplate(template)) {
    body += part.kind === 'text' ? escapeBraces(part.value) : `{${part.name}}`;
  }
  return body;
}
