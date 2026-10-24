/**
 * The prompt registry.
 *
 * The registry exists because a prompt is a versioned artifact. The tests that matter
 * are the ones that refuse things: a duplicate name+version must not silently replace,
 * an unused variable must be reported rather than ignored, and version ordering must be
 * numeric (`v10` after `v9`) because string ordering gets that wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  Example,
  Message,
  PromptNotFoundError,
  PromptRegistry,
  PromptRenderError,
  PromptTemplate,
  RenderedPrompt,
} from '../src/index.js';
// Not in the package's public surface (Python's `__all__` excludes them too), so the
// tests reach for the module the way an internal caller would.
import { compareVersions, orderedVersions } from '../src/prompts.js';

function template(overrides: Partial<{ name: string; version: string; template: string }> = {}) {
  return new PromptTemplate({
    name: overrides.name ?? 'support-reply',
    version: overrides.version ?? '1',
    template: overrides.template ?? 'Answer {question} in {tone}.',
  });
}

describe('PromptTemplate', () => {
  it('reads the variables out of the body', () => {
    expect([...template().variables].sort()).toEqual(['question', 'tone']);
    expect(
      new PromptTemplate({ name: 'p', version: '1', template: 'no fields' }).variables,
    ).toEqual([]);
  });

  it('reads a variable that carries a format spec', () => {
    expect(
      new PromptTemplate({ name: 'p', version: '1', template: '|{topic:>8}|' }).variables,
    ).toEqual(['topic']);
  });

  it('treats doubled braces as literal text, not fields', () => {
    expect(
      new PromptTemplate({ name: 'p', version: '1', template: '{{"k": 1}} and {v}' }).variables,
    ).toEqual(['v']);
  });

  it('refuses a template it cannot parse', () => {
    expect(
      () => new PromptTemplate({ name: 'p', version: '1', template: 'unclosed {here' }).variables,
    ).toThrow(/unclosed '\{'/);
    expect(
      () => new PromptTemplate({ name: 'p', version: '1', template: 'stray } brace' }).variables,
    ).toThrow(/stray '\}'/);
  });

  it('refuses positional fields', () => {
    expect(
      () => new PromptTemplate({ name: 'p', version: '1', template: 'value: {}' }).variables,
    ).toThrow(/positional fields/);
  });

  it('needs a name and a version', () => {
    expect(() => new PromptTemplate({ name: '', version: '1', template: 'x' })).toThrow(
      /needs a name/,
    );
    expect(() => new PromptTemplate({ name: 'p', version: '', template: 'x' })).toThrow(
      /needs a version/,
    );
  });

  it('interpolates supplied values', () => {
    const rendered = template().render({ question: 'why?', tone: 'one line' });
    expect(rendered.text).toBe('Answer why? in one line.');
    expect(rendered.name).toBe('support-reply');
    expect(rendered.version).toBe('1');
  });

  it('keeps doubled braces as single braces', () => {
    const rendered = new PromptTemplate({
      name: 'p',
      version: '1',
      template: '{{"a": {value}}}',
    }).render({ value: '1' });
    expect(rendered.text).toBe('{"a": 1}');
  });

  it('does not unescape braces that arrived inside a value', () => {
    // A two-pass implementation mangles caller data here; a single pass does not.
    const rendered = new PromptTemplate({
      name: 'p',
      version: '1',
      template: 'json: {value}',
    }).render({ value: '{"nested": true}' });

    expect(rendered.text).toBe('json: {"nested": true}');
  });

  it('refuses a missing variable', () => {
    expect(() => template().render({ question: 'why?' })).toThrow(/is missing variables: tone/);
  });

  it('refuses a variable it does not use, which is usually a typo', () => {
    expect(() => template().render({ question: 'q', tone: 't', tone_of_voice: 'x' })).toThrow(
      /received unused variables: tone_of_voice/,
    );
  });

  it('accepts a demanded variable that the body never interpolates', () => {
    const demanding = new PromptTemplate({
      name: 'p',
      version: '1',
      template: 'Answer {question}.',
      required: ['trace_id'],
    });

    expect(demanding.render({ question: 'q', trace_id: 'abc' }).text).toBe('Answer q.');
    // It is demanded, so omitting it is a missing variable...
    expect(() => demanding.render({ question: 'q' })).toThrow(/missing variables: trace_id/);
  });

  it('applies right, left and centre alignment', () => {
    const pad = (spec: string) =>
      new PromptTemplate({ name: 'p', version: '1', template: `|{v${spec}}|` }).render({ v: 'ab' })
        .text;

    expect(pad(':>4')).toBe('|  ab|');
    expect(pad(':<4')).toBe('|ab  |');
    expect(pad(':^5')).toBe('| ab  |');
    expect(pad(':^4')).toBe('| ab |');
  });

  it('applies a fill character and a precision', () => {
    const pad = (spec: string) =>
      new PromptTemplate({ name: 'p', version: '1', template: `|{v${spec}}|` }).render({
        v: 'abcdef',
      }).text;

    expect(pad(':*<8')).toBe('|abcdef**|');
    expect(pad(':.3')).toBe('|abc|');
  });

  it('applies a repr conversion', () => {
    expect(
      new PromptTemplate({ name: 'p', version: '1', template: 'x={v!r}' }).render({ v: 'ab' }).text,
    ).toBe("x='ab'");
  });

  it('refuses a format spec it cannot honour instead of leaving it in the output', () => {
    expect(() =>
      new PromptTemplate({ name: 'p', version: '1', template: '{v:,.2f}' }).render({ v: 1 }),
    ).toThrow(/unsupported format spec/);
  });

  it('renders examples into message pairs between the system turn and the question', () => {
    const rendered = new PromptTemplate({
      name: 'p',
      version: '1',
      template: 'Answer {question}.',
      examples: [new Example({ input: 'q1', output: 'a1' })],
    }).render({ question: 'q2' });

    const messages = rendered.asMessages('be terse');
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages.map((message) => message.content)).toEqual([
      'be terse',
      'q1',
      'a1',
      'Answer q2.',
    ]);
  });

  it('omits the system turn when none is given', () => {
    const messages = new RenderedPrompt({ name: 'p', version: '1', text: 'hi' }).asMessages();
    expect(messages).toEqual([Message.user('hi')]);
  });
});

describe('version ordering', () => {
  it('compares dotted segments numerically', () => {
    expect(compareVersions('v9', 'v10')).toBeLessThan(0);
    expect(compareVersions('v10', 'v9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.10')).toBeLessThan(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
  });

  it('sorts oldest to newest, which is the opposite of string order', () => {
    expect(orderedVersions(['v10', 'v9', 'v2'])).toEqual(['v2', 'v9', 'v10']);
  });
});

describe('PromptRegistry', () => {
  it('reports its names and versions', () => {
    const registry = new PromptRegistry([
      template({ version: '2' }),
      template({ version: '10' }),
      new PromptTemplate({ name: 'other', version: '1', template: 'x' }),
    ]);

    expect(registry.names()).toEqual(['other', 'support-reply']);
    expect(registry.versions('support-reply')).toEqual(['2', '10']);
  });

  it('resolves the newest version by default', () => {
    const registry = new PromptRegistry([template({ version: '2' }), template({ version: '10' })]);
    expect(registry.latest('support-reply').version).toBe('10');
    expect(registry.get('support-reply').version).toBe('10');
  });

  it('resolves an explicit version', () => {
    const registry = new PromptRegistry([template({ version: '2' }), template({ version: '10' })]);
    expect(registry.get('support-reply', '2').version).toBe('2');
  });

  it('refuses to overwrite a name+version, because a baseline means "this text"', () => {
    const registry = new PromptRegistry([template()]);
    expect(() => registry.register(template())).toThrow(
      /prompt 'support-reply' v1 is already registered/,
    );
  });

  it('reports an unknown prompt, listing what it does know', () => {
    const registry = new PromptRegistry([template()]);

    expect(() => registry.get('absent')).toThrow(PromptNotFoundError);
    expect(() => registry.get('absent')).toThrow(
      /no prompt 'absent' \(latest\); registered: support-reply/,
    );
    expect(() => registry.get('support-reply', '99')).toThrow(/version '99'/);
  });

  it('lists an empty registry plainly', () => {
    expect(() => new PromptRegistry().get('anything')).toThrow(/registered: <none>/);
  });

  it('resolves and renders in one step', () => {
    const registry = new PromptRegistry([template()]);
    expect(registry.render('support-reply', { question: 'q', tone: 't' }).text).toBe(
      'Answer q in t.',
    );
  });

  it('rejects an unusable variable at render time through the registry too', () => {
    const registry = new PromptRegistry([template()]);
    expect(() => registry.render('support-reply', { question: 'q' })).toThrow(PromptRenderError);
    expect(registry.get('support-reply').examples).toEqual([]);
  });
});
