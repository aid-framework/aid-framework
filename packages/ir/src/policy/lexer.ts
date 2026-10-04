/**
 * PolicyExpr lexer. Tracks byte offsets so every diagnostic can point at the
 * offending span. Never throws: malformed input yields tokens plus diagnostics.
 */

import type { DiagnosticPath } from '@aid/spec';
import {
  IR_DIAGNOSTIC_CODES,
  type IrDiagnostic,
  irError,
  offsetPosition,
  withPosition,
} from '../diagnostics.js';

export type PolicyTokenType =
  | 'boolean'
  | 'number'
  | 'string'
  | 'identifier'
  | 'operator'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'eof';

export interface PolicyToken {
  type: PolicyTokenType;
  /** Decoded value for literals and identifiers; the raw text for operators. */
  value: string | number | boolean;
  start: number;
  end: number;
}

export interface PolicyContext {
  path?: DiagnosticPath;
  file?: string;
}

export interface LexResult {
  tokens: PolicyToken[];
  diagnostics: IrDiagnostic[];
}

const KEYWORDS = new Set(['true', 'false', 'and', 'or', 'not']);

export function policyDiagnostic(
  source: string,
  context: PolicyContext,
  offset: number,
  code: (typeof IR_DIAGNOSTIC_CODES)[keyof typeof IR_DIAGNOSTIC_CODES],
  message: string,
  hint?: string,
): IrDiagnostic {
  const { line, column } = offsetPosition(source, offset);
  return withPosition(irError({ code, message, path: context.path, hint }), {
    file: context.file,
    line,
    column,
  });
}

export function tokenize(source: string, context: PolicyContext = {}): LexResult {
  const tokens: PolicyToken[] = [];
  const diagnostics: IrDiagnostic[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '(' || char === ')' || char === ',') {
      const type: PolicyTokenType = char === '(' ? 'lparen' : char === ')' ? 'rparen' : 'comma';
      tokens.push({ type, value: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = scanString(source, index, char);
      if (end === -1) {
        diagnostics.push(
          policyDiagnostic(
            source,
            context,
            index,
            IR_DIAGNOSTIC_CODES.policyUnterminatedString,
            'unterminated string literal',
            'close the string with the same quote character it opened with',
          ),
        );
        index = source.length;
        continue;
      }
      tokens.push({
        type: 'string',
        value: decodeString(source.slice(index + 1, end - 1)),
        start: index,
        end,
      });
      index = end;
      continue;
    }
    if (char >= '0' && char <= '9') {
      const end = scanNumber(source, index);
      tokens.push({ type: 'number', value: Number(source.slice(index, end)), start: index, end });
      index = end;
      continue;
    }
    if (isIdentifierStart(char)) {
      const end = scanIdentifier(source, index);
      const text = source.slice(index, end);
      if (text === 'true' || text === 'false') {
        tokens.push({ type: 'boolean', value: text === 'true', start: index, end });
      } else if (KEYWORDS.has(text)) {
        tokens.push({ type: 'operator', value: text, start: index, end });
      } else {
        tokens.push({ type: 'identifier', value: text, start: index, end });
      }
      index = end;
      continue;
    }

    const pair = source.slice(index, index + 2);
    if (pair === '==' || pair === '!=' || pair === '<=' || pair === '>=') {
      tokens.push({ type: 'operator', value: pair, start: index, end: index + 2 });
      index += 2;
      continue;
    }
    if (char === '<' || char === '>') {
      tokens.push({ type: 'operator', value: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    diagnostics.push(
      policyDiagnostic(
        source,
        context,
        index,
        IR_DIAGNOSTIC_CODES.policySyntax,
        `unexpected character ${JSON.stringify(char)}`,
        'PolicyExpr supports literals, comparisons, and/or/not, parentheses, and the hasRole/hasScope/isAuthenticated builtins',
      ),
    );
    index += 1;
  }

  tokens.push({ type: 'eof', value: '', start: source.length, end: source.length });
  return { tokens, diagnostics };
}

/** The token's text as written, for messages. */
export function tokenText(token: PolicyToken): string {
  if (token.type === 'string') return JSON.stringify(token.value);
  if (token.type === 'boolean') return String(token.value);
  return String(token.value);
}

function scanString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  return -1;
}

function decodeString(raw: string): string {
  let decoded = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char === '\\' && index + 1 < raw.length) {
      const next = raw[index + 1] as string;
      decoded += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      index += 1;
      continue;
    }
    decoded += char;
  }
  return decoded;
}

function scanNumber(source: string, start: number): number {
  let index = start;
  while (index < source.length && isDigit(source[index] as string)) index += 1;
  if (index < source.length && source[index] === '.') {
    index += 1;
    while (index < source.length && isDigit(source[index] as string)) index += 1;
  }
  return index;
}

function scanIdentifier(source: string, start: number): number {
  let index = start;
  while (index < source.length && isIdentifierPart(source[index] as string)) index += 1;
  return index;
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentifierStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char);
}
