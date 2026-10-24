/**
 * Versioned prompt templates.
 *
 * A prompt is a versioned artifact, not a string constant, for the same reason a
 * model is pinned: a baseline recorded against `support-reply` v2 means nothing if
 * "v2" quietly becomes v3. The registry therefore refuses a duplicate name+version
 * rather than overwriting, and version ordering is defined here rather than left to
 * `Array.prototype.sort` on strings (`'v10' < 'v9'` lexicographically, which is
 * exactly the bug this ordering exists to prevent).
 */

import { PromptNotFoundError, PromptRenderError } from './errors.js';
import { repr } from './internal/json.js';
import { Message } from './types.js';

/** One worked example, rendered into the message list between system and user. */
export class Example {
  readonly input: string;
  readonly output: string;

  constructor(init: { readonly input: string; readonly output: string }) {
    this.input = init.input;
    this.output = init.output;
  }
}

/**
 * Parse `{name}` placeholders out of a template.
 *
 * `{{` and `}}` are literal braces, matching `str.format`. Field names run to the
 * first `}` or `:`, so `{topic:>10}` declares `topic`.
 */
function templateVariables(template: string): string[] {
  const names: string[] = [];
  let index = 0;
  while (index < template.length) {
    const character = template.charAt(index);
    if (character === '{') {
      if (template[index + 1] === '{') {
        index += 2;
        continue;
      }
      const close = template.indexOf('}', index + 1);
      if (close === -1) {
        throw new PromptRenderError(`unclosed '{' in prompt template: ${repr(template)}`);
      }
      const field = template.slice(index + 1, close);
      const stops = [field.indexOf(':'), field.indexOf('!')].filter((at) => at !== -1);
      const name = field.slice(0, stops.length === 0 ? field.length : Math.min(...stops)).trim();
      if (name.length === 0) {
        throw new PromptRenderError('prompt templates cannot use positional fields');
      }
      if (!names.includes(name)) names.push(name);
      index = close + 1;
      continue;
    }
    if (character === '}') {
      if (template[index + 1] !== '}') {
        throw new PromptRenderError("prompt templates cannot contain a stray '}'");
      }
      index += 2;
      continue;
    }
    index += 1;
  }
  return names;
}

/**
 * Substitute fields in one pass.
 *
 * One pass, not "replace each variable then unescape": doing it in two passes unescapes
 * braces that arrived *inside* a substituted value, which silently mangles data the
 * caller supplied.
 */
function formatTemplate(template: string, values: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  let index = 0;
  while (index < template.length) {
    const character = template.charAt(index);
    if (character === '{') {
      if (template[index + 1] === '{') {
        parts.push('{');
        index += 2;
        continue;
      }
      const close = template.indexOf('}', index + 1);
      if (close === -1) {
        throw new PromptRenderError(`unclosed '{' in prompt template: ${repr(template)}`);
      }
      parts.push(formatField(template.slice(index + 1, close), values));
      index = close + 1;
      continue;
    }
    if (character === '}') {
      if (template[index + 1] !== '}') {
        throw new PromptRenderError("prompt templates cannot contain a stray '}'");
      }
      parts.push('}');
      index += 2;
      continue;
    }
    parts.push(character);
    index += 1;
  }
  return parts.join('');
}

/** Render one `{name!conv:spec}` field. */
function formatField(raw: string, values: Readonly<Record<string, unknown>>): string {
  const colon = raw.indexOf(':');
  const bang = raw.indexOf('!');
  let nameEnd = raw.length;
  let conversion: string | undefined;
  let spec = '';

  if (bang !== -1 && (colon === -1 || bang < colon)) {
    nameEnd = bang;
    const specStart = raw.indexOf(':', bang + 1);
    conversion = (specStart === -1 ? raw.slice(bang + 1) : raw.slice(bang + 1, specStart)).trim();
    spec = specStart === -1 ? '' : raw.slice(specStart + 1);
  } else if (colon !== -1) {
    nameEnd = colon;
    spec = raw.slice(colon + 1);
  }

  const name = raw.slice(0, nameEnd).trim();
  if (name.length === 0) {
    throw new PromptRenderError('prompt templates cannot use positional fields');
  }
  if (!(name in values)) {
    throw new PromptRenderError(`prompt template is missing a value for ${repr(name)}`);
  }
  return applyFormatSpec(asText(values[name], conversion), spec);
}

/** Apply a `!s` / `!r` / `!a` conversion. */
function asText(value: unknown, conversion: string | undefined): string {
  if (conversion === undefined || conversion === 's') return String(value);
  if (conversion === 'r' || conversion === 'a') {
    return typeof value === 'string' ? repr(value) : String(value);
  }
  throw new PromptRenderError(`prompt templates do not support the ${repr(conversion)} conversion`);
}

/**
 * Apply a string format spec: `[[fill]align][width][.precision]`.
 *
 * A documented subset with a loud failure, in the same spirit as the tool-schema
 * validator: numeric specs (`:,.2f`) are meaningless for interpolated prompt text, and
 * leaving the spec in the output would be worse than refusing it.
 */
function applyFormatSpec(text: string, spec: string): string {
  if (spec === '') return text;
  const match = /^(?:(.)?([<>^]))?(\d+)?(?:\.(\d+))?$/.exec(spec);
  if (match === null) {
    throw new PromptRenderError(`unsupported format spec ${repr(spec)} in prompt template`);
  }
  const fill = match[1] ?? ' ';
  const align = match[2];
  const width = match[3] === undefined ? 0 : Number(match[3]);
  const precision = match[4] === undefined ? undefined : Number(match[4]);

  const trimmed = precision === undefined ? text : text.slice(0, precision);
  const padding = width - trimmed.length;
  if (align === undefined || padding <= 0) return trimmed;
  switch (align) {
    case '<':
      return trimmed + fill.repeat(padding);
    case '>':
      return fill.repeat(padding) + trimmed;
    default: {
      // Python's centre puts the extra space on the right: '{:^5}'.format('ab') -> ' ab  '.
      const left = Math.floor(padding / 2);
      return fill.repeat(left) + trimmed + fill.repeat(padding - left);
    }
  }
}

/** A template plus the metadata a registry keys it by. */
export class PromptTemplate {
  readonly name: string;
  readonly version: string;
  readonly template: string;
  readonly description: string;
  readonly examples: readonly Example[];
  readonly required: readonly string[];

  constructor(init: {
    readonly name: string;
    readonly version: string;
    readonly template: string;
    readonly description?: string;
    readonly examples?: readonly Example[];
    readonly required?: readonly string[];
  }) {
    if (init.name.length === 0) throw new PromptRenderError('a prompt needs a name');
    if (init.version.length === 0) throw new PromptRenderError('a prompt needs a version');
    this.name = init.name;
    this.version = init.version;
    this.template = init.template;
    this.description = init.description ?? '';
    this.examples = init.examples ?? [];
    this.required = init.required ?? [];
  }

  /** The variables the template body actually uses. */
  get variables(): readonly string[] {
    return templateVariables(this.template);
  }

  /** Fill the template, refusing both missing and unused variables. */
  render(values: Readonly<Record<string, unknown>> = {}): RenderedPrompt {
    // `required` is part of the contract, not documentation: a template may demand a
    // value it never interpolates (a routing hint, say), and Python unions the two
    // sets. Subtracting `required` from `unused` as well is what stops that demanded
    // value being reported as a typo.
    const expected = this.variables;
    const required = new Set<string>([...expected, ...this.required]);
    const missing = [...required].filter((name) => !(name in values)).sort();
    if (missing.length > 0) {
      throw new PromptRenderError(
        `prompt ${repr(this.name)} v${this.version} is missing variables: ${missing.join(', ')}`,
      );
    }
    const unused = Object.keys(values)
      .filter((name) => !required.has(name))
      .sort();
    if (unused.length > 0) {
      throw new PromptRenderError(
        `prompt ${repr(this.name)} v${this.version} received unused variables: ${unused.join(
          ', ',
        )}; template uses ${[...expected].sort().join(', ') || '<none>'}`,
      );
    }
    return new RenderedPrompt({
      name: this.name,
      version: this.version,
      text: formatTemplate(this.template, values),
      examples: this.examples,
    });
  }
}

/** The result of rendering a template. */
export class RenderedPrompt {
  readonly name: string;
  readonly version: string;
  readonly text: string;
  readonly examples: readonly Example[];

  constructor(init: {
    readonly name: string;
    readonly version: string;
    readonly text: string;
    readonly examples?: readonly Example[];
  }) {
    this.name = init.name;
    this.version = init.version;
    this.text = init.text;
    this.examples = init.examples ?? [];
  }

  /**
   * The message list this prompt becomes: system, then one pair per example, then
   * the user turn.
   *
   * The examples sit between the system turn and the real question deliberately:
   * they are part of the instructions, and putting them after the question invites
   * a model to answer the last example instead.
   */
  asMessages(system?: string): Message[] {
    const messages: Message[] = [];
    if (system !== undefined) messages.push(Message.system(system));
    for (const example of this.examples) {
      messages.push(Message.user(example.input));
      messages.push(Message.assistant(example.output));
    }
    messages.push(Message.user(this.text));
    return messages;
  }
}

/**
 * One version token of a version string.
 *
 * Numeric tokens compare numerically and sort before textual ones, so `1.10` is
 * after `1.9` and `2.0.0-rc1` sorts predictably against `2.0.0`.
 */
type VersionToken = readonly [rank: number, value: number, text: string];

function versionKey(version: string): VersionToken[] {
  return version.split('.').map((segment) => {
    const stripped = segment.startsWith('v') ? segment.slice(1) : segment;
    if (/^\d+$/.test(stripped)) return [0, Number.parseInt(stripped, 10), ''] as const;
    return [1, 0, stripped] as const;
  });
}

/** Compare two version strings by dotted-segment order. */
export function compareVersions(left: string, right: string): number {
  const a = versionKey(left);
  const b = versionKey(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const one = a[index];
    const other = b[index];
    if (one === undefined || other === undefined) break;
    if (one[0] !== other[0]) return one[0] - other[0];
    if (one[1] !== other[1]) return one[1] - other[1];
    if (one[2] !== other[2]) return one[2] < other[2] ? -1 : 1;
  }
  return a.length - b.length;
}

/** Sort version strings oldest to newest. */
export function orderedVersions(versions: Iterable<string>): string[] {
  return [...versions].sort(compareVersions);
}

/** A closed set of templates, keyed by name and version. */
export class PromptRegistry {
  private readonly _templates = new Map<string, PromptTemplate>();

  constructor(templates: Iterable<PromptTemplate> = []) {
    for (const template of templates) this.register(template);
  }

  /** Add a template. A duplicate name+version is a configuration error, not a replace. */
  register(template: PromptTemplate): void {
    const key = this.key(template.name, template.version);
    if (this._templates.has(key)) {
      throw new PromptRenderError(
        `prompt ${repr(template.name)} v${template.version} is already registered`,
      );
    }
    this._templates.set(key, template);
  }

  /** The registered names, sorted. */
  names(): string[] {
    return [...new Set([...this._templates.values()].map((template) => template.name))].sort();
  }

  /** Every version of one prompt, oldest first. */
  versions(name: string): string[] {
    return orderedVersions(
      [...this._templates.values()]
        .filter((template) => template.name === name)
        .map((template) => template.version),
    );
  }

  /** The newest version of one prompt. */
  latest(name: string): PromptTemplate {
    const versions = this.versions(name);
    const newest = versions.at(-1);
    if (newest === undefined) throw new PromptNotFoundError(name, undefined, this.names());
    return this.get(name, newest);
  }

  /** One prompt, by explicit version or the newest. */
  get(name: string, version?: string): PromptTemplate {
    const resolved = version ?? this.versions(name).at(-1);
    if (resolved === undefined) throw new PromptNotFoundError(name, version, this.names());
    const template = this._templates.get(this.key(name, resolved));
    if (template === undefined) throw new PromptNotFoundError(name, version, this.names());
    return template;
  }

  /** Resolve and render in one step. */
  render(
    name: string,
    values: Readonly<Record<string, unknown>> = {},
    version?: string,
  ): RenderedPrompt {
    return this.get(name, version).render(values);
  }

  private key(name: string, version: string): string {
    return `${name}\u0000${version}`;
  }
}
