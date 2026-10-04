import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_CODES,
  findMalformedTemplate,
  parseSpecDocument,
  type SourceDocument,
} from '../src/index.js';
import { readFixture } from './fixtures.js';

describe('parseSpecDocument', () => {
  it('parses a valid document into a plain value', () => {
    const result = parseSpecDocument(readFixture('valid/minimal.spec.yaml'), {
      file: 'minimal.spec.yaml',
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.value).toEqual({ specVersion: '0.1', project: { name: 'minimal' } });
  });

  it('reports a syntax error with a file, line, and column', () => {
    const result = parseSpecDocument(readFixture('invalid/syntax-error.spec.yaml'), {
      file: 'syntax-error.spec.yaml',
    });

    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);

    const [diagnostic] = result.diagnostics;
    expect(diagnostic?.code).toBe(DIAGNOSTIC_CODES.yamlSyntax);
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.file).toBe('syntax-error.spec.yaml');
    // Unterminated flow sequence: the position is where the parser gave up, not
    // the line that opened it.
    expect(diagnostic?.line).toBe(6);
    expect(diagnostic?.column).toBe(1);
  });

  it('rejects duplicate keys instead of silently keeping the last one', () => {
    const result = parseSpecDocument('specVersion: "0.1"\nproject:\n  name: a\n  name: b\n', {
      file: 'duplicate.spec.yaml',
    });

    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      DIAGNOSTIC_CODES.yamlSyntax,
    ]);
  });
});

describe('SourceDocument.positionAt', () => {
  const text = readFixture('valid/minimal.spec.yaml');

  function document(): SourceDocument {
    return parseSpecDocument(text, { file: 'minimal.spec.yaml' }).document;
  }

  it('resolves a top-level key to its own line', () => {
    expect(document().positionAt(['project'])).toEqual({ line: 3, column: 1 });
  });

  it('resolves a nested key to the key itself, not the value that follows it', () => {
    expect(document().positionAt(['project', 'name'])).toEqual({ line: 4, column: 3 });
  });

  it('falls back to the nearest existing ancestor when a segment is missing', () => {
    expect(document().positionAt(['project', 'missing'])).toEqual({ line: 3, column: 1 });
    expect(document().positionAt(['project', 'missing', 'deeper'])).toEqual({ line: 3, column: 1 });
  });

  it('falls back to the document root when the first segment is missing', () => {
    expect(document().positionAt(['nope'])).toEqual({ line: 1, column: 1 });
  });

  it('indexes into a sequence', () => {
    const full = parseSpecDocument(readFixture('valid/full.spec.yaml')).document;
    const position = full.positionAt(['pipelines', 'answer_ticket', 'steps', 0]);

    if (!position) throw new Error('expected a source position for steps[0]');

    const line = full.text.split('\n')[position.line - 1];
    expect(line).toContain('- tool:');
  });
});

describe('findMalformedTemplate', () => {
  it.each([
    ['no placeholders at all', 'Classify this.'],
    ['one placeholder', 'Classify {{ text }}'],
    ['two adjacent placeholders', '{{ a }} {{ b }}'],
    ['a dotted path', 'Subject: {{ ticket.subject }}'],
    ['a placeholder hugging the edges', '{{a}}'],
    ['an underscore-leading name', '{{_x}}'],
    ['braces in ordinary prose', 'Use {curly} braces'],
  ])('accepts %s', (_label, text) => {
    expect(findMalformedTemplate(text)).toBeUndefined();
  });

  it.each([
    ['an unclosed placeholder', 'Classify {{ text }'],
    ['a stray double close', 'Classify }} text'],
    ['an empty placeholder', 'Classify {{ }} text'],
    ['a numeric name', 'Classify {{ 1 }} text'],
    ['a solitary open brace pair', 'Classify {{ text'],
  ])('rejects %s', (_label, text) => {
    expect(findMalformedTemplate(text)).toBeTypeOf('string');
  });

  it('accepts a well-formed multi-line template', () => {
    const template = readFixture('valid/full.spec.yaml');
    expect(findMalformedTemplate(template)).toBeUndefined();
  });
});
