/**
 * PolicyExpr recursive-descent parser. Total: it returns either an AST or
 * diagnostics, and never lets an exception escape. An unparseable policy is a
 * validation error and never treated as `true` — a policy the runtime cannot
 * evaluate must fail closed.
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic, irError, withPosition } from '../diagnostics.js';
import {
  COMPARISON_OPERATORS,
  type ComparisonOperator,
  isPolicyBuiltin,
  POLICY_BUILTIN_ARITY,
  type PolicyBuiltin,
  type PolicyCall,
  type PolicyNode,
} from './ast.js';
import {
  type PolicyContext,
  type PolicyToken,
  policyDiagnostic,
  tokenize,
  tokenText,
} from './lexer.js';

export interface PolicyParseResult {
  ast?: PolicyNode;
  diagnostics: IrDiagnostic[];
}

export function parsePolicyExpr(source: string, context: PolicyContext = {}): PolicyParseResult {
  const diagnostics: IrDiagnostic[] = [];

  if (source.trim() === '') {
    diagnostics.push(
      policyDiagnostic(
        source,
        context,
        0,
        IR_DIAGNOSTIC_CODES.policyEmpty,
        'empty policy expression',
        'a policy must evaluate to true or false; there is no implicit "allow"',
      ),
    );
    return { diagnostics };
  }

  const lexed = tokenize(source, context);
  diagnostics.push(...lexed.diagnostics);

  try {
    const parser = new Parser(source, context, lexed.tokens, diagnostics);
    const ast = parser.parseExpression();
    if (ast !== undefined && !parser.atEnd()) {
      const token = parser.peek();
      diagnostics.push(
        policyDiagnostic(
          source,
          context,
          token.start,
          IR_DIAGNOSTIC_CODES.policyTrailingToken,
          `unexpected trailing ${tokenText(token)} after a complete expression`,
          'a policy is a single expression; combine conditions with and/or',
        ),
      );
    }
    if (diagnostics.some((entry) => entry.severity === 'error')) return { diagnostics };
    return ast === undefined ? { diagnostics } : { ast, diagnostics };
  } catch (error) {
    diagnostics.push(
      withPosition(
        irError({
          code: IR_DIAGNOSTIC_CODES.policySyntax,
          message: `policy expression could not be parsed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          path: context.path,
        }),
        { file: context.file },
      ),
    );
    return { diagnostics };
  }
}

class Parser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly context: PolicyContext,
    private readonly tokens: PolicyToken[],
    private readonly diagnostics: IrDiagnostic[],
  ) {}

  atEnd(): boolean {
    return this.peek().type === 'eof';
  }

  peek(offset = 0): PolicyToken {
    const token = this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
    return token as PolicyToken;
  }

  parseExpression(): PolicyNode | undefined {
    return this.parseOr();
  }

  private parseOr(): PolicyNode | undefined {
    let left = this.parseAnd();
    while (this.isOperator('or')) {
      this.index += 1;
      const right = this.parseAnd();
      if (left === undefined || right === undefined) return left ?? right;
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): PolicyNode | undefined {
    let left = this.parseComparison();
    while (this.isOperator('and')) {
      this.index += 1;
      const right = this.parseComparison();
      if (left === undefined || right === undefined) return left ?? right;
      left = { kind: 'and', left, right };
    }
    return left;
  }

  private parseComparison(): PolicyNode | undefined {
    const left = this.parseUnary();
    const token = this.peek();
    const op = token.type === 'operator' ? toComparisonOperator(String(token.value)) : undefined;
    if (op === undefined) return left;
    this.index += 1;
    const right = this.parseUnary();
    if (left === undefined || right === undefined) return left ?? right;
    return { kind: 'comparison', op, left, right };
  }

  private parseUnary(): PolicyNode | undefined {
    if (this.isOperator('not')) {
      this.index += 1;
      const operand = this.parseUnary();
      return operand === undefined ? undefined : { kind: 'not', operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): PolicyNode | undefined {
    const token = this.peek();

    if (token.type === 'boolean') {
      this.index += 1;
      return { kind: 'boolean', value: Boolean(token.value) };
    }
    if (token.type === 'number') {
      this.index += 1;
      return { kind: 'number', value: Number(token.value) };
    }
    if (token.type === 'string') {
      this.index += 1;
      return { kind: 'string', value: String(token.value) };
    }
    if (token.type === 'lparen') {
      this.index += 1;
      const inner = this.parseExpression();
      if (this.peek().type !== 'rparen') {
        this.report(
          this.peek().start,
          IR_DIAGNOSTIC_CODES.policyUnclosedParen,
          'unclosed parenthesis in policy expression',
          'add the matching ")"',
        );
        return inner;
      }
      this.index += 1;
      return inner;
    }
    if (token.type === 'identifier') {
      return this.parseCallOrIdentifier();
    }

    this.report(
      token.start,
      IR_DIAGNOSTIC_CODES.policyExpected,
      token.type === 'eof'
        ? 'unexpected end of policy expression'
        : `unexpected ${tokenText(token)} in policy expression`,
      'expected a builtin call such as isAuthenticated(), true/false, or a parenthesized expression',
    );
    return undefined;
  }

  private parseCallOrIdentifier(): PolicyNode | undefined {
    const token = this.peek();
    const name = String(token.value);
    this.index += 1;

    if (this.peek().type !== 'lparen') {
      this.report(
        token.start,
        IR_DIAGNOSTIC_CODES.policyUnknownIdentifier,
        `unknown identifier "${name}"`,
        'bare identifiers are not values; call one of the builtins hasRole, hasScope, isAuthenticated',
      );
      return undefined;
    }

    if (!isPolicyBuiltin(name)) {
      this.report(
        token.start,
        IR_DIAGNOSTIC_CODES.policyUnknownBuiltin,
        `unknown builtin "${name}"`,
        'a policy naming a builtin the runtime cannot evaluate is rejected rather than treated as true',
      );
      this.skipCallArguments();
      return undefined;
    }

    this.index += 1;
    const args: PolicyNode[] = [];
    if (this.peek().type !== 'rparen') {
      for (;;) {
        const argument = this.parsePrimary();
        if (argument === undefined) break;
        args.push(argument);
        if (this.peek().type !== 'comma') break;
        this.index += 1;
      }
    }
    if (this.peek().type !== 'rparen') {
      this.report(
        this.peek().start,
        IR_DIAGNOSTIC_CODES.policyUnclosedParen,
        `unclosed argument list for ${name}(...)`,
        'add the matching ")"',
      );
      return undefined;
    }
    this.index += 1;

    const arity = POLICY_BUILTIN_ARITY[name];
    if (args.length !== arity) {
      this.report(
        token.start,
        IR_DIAGNOSTIC_CODES.policyArity,
        `${name}() takes ${arity} argument${arity === 1 ? '' : 's'}, received ${args.length}`,
      );
      return undefined;
    }
    if (arity === 1 && args[0]?.kind !== 'string') {
      this.report(
        token.start,
        IR_DIAGNOSTIC_CODES.policyArgumentType,
        `${name}() expects a string literal argument`,
      );
      return undefined;
    }

    const call: PolicyCall = { kind: 'call', name: name as PolicyBuiltin, args };
    return call;
  }

  /** Consumes a rejected call's arguments so one bad builtin yields one error. */
  private skipCallArguments(): void {
    let depth = 1;
    while (!this.atEnd() && depth > 0) {
      const token = this.peek();
      if (token.type === 'lparen') depth += 1;
      if (token.type === 'rparen') depth -= 1;
      this.index += 1;
    }
  }

  private isOperator(value: string): boolean {
    const token = this.peek();
    return token.type === 'operator' && token.value === value;
  }

  private report(
    offset: number,
    code: (typeof IR_DIAGNOSTIC_CODES)[keyof typeof IR_DIAGNOSTIC_CODES],
    message: string,
    hint?: string,
  ): void {
    this.diagnostics.push(policyDiagnostic(this.source, this.context, offset, code, message, hint));
  }
}

function toComparisonOperator(value: string): ComparisonOperator | undefined {
  return (COMPARISON_OPERATORS as readonly string[]).includes(value)
    ? (value as ComparisonOperator)
    : undefined;
}
