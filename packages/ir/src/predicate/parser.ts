/**
 * PredicateExpr recursive-descent parser. Total: it returns an AST plus
 * diagnostics and never lets an exception escape. An unparseable predicate yields
 * an `invalid` node and an error diagnostic -- never a missing condition, which a
 * caller could mistake for "nothing to check".
 */

import { IR_DIAGNOSTIC_CODES, type IrDiagnostic, irError, withPosition } from '../diagnostics.js';
import {
  formatPredicateExpr,
  isPredicateBuiltin,
  PREDICATE_BUILTIN_ARITY,
  PREDICATE_OPERATORS,
  type PredicateBuiltin,
  type PredicateCall,
  type PredicateNode,
  type PredicateOperator,
  predicateIsBoolean,
} from './ast.js';
import {
  type PredicateContext,
  type PredicateToken,
  predicateDiagnostic,
  tokenizePredicate,
  tokenText,
} from './lexer.js';

export interface PredicateParseResult {
  /** Always present: an unparseable source comes back as an `invalid` node. */
  ast: PredicateNode;
  diagnostics: IrDiagnostic[];
}

export function parsePredicateExpr(
  source: string,
  context: PredicateContext = {},
): PredicateParseResult {
  const diagnostics: IrDiagnostic[] = [];

  if (source.trim() === '') {
    diagnostics.push(
      predicateDiagnostic(
        source,
        context,
        0,
        IR_DIAGNOSTIC_CODES.predicateEmpty,
        'empty predicate expression',
        'an assert must evaluate to true or false; there is no implicit "pass"',
      ),
    );
    return { ast: invalidNode('empty predicate expression'), diagnostics };
  }

  const lexed = tokenizePredicate(source, context);
  diagnostics.push(...lexed.diagnostics);

  // A tokenization failure makes the token stream untrustworthy: parsing it would
  // report cascading syntax errors for characters the lexer already rejected.
  if (diagnostics.some((entry) => entry.severity === 'error')) {
    const first = diagnostics.find((entry) => entry.severity === 'error');
    return { ast: invalidNode(first?.message ?? 'predicate could not be read'), diagnostics };
  }

  let ast: PredicateNode | undefined;
  try {
    const parser = new Parser(source, context, lexed.tokens, diagnostics);
    ast = parser.parseExpression();
    if (ast !== undefined && !parser.atEnd()) {
      const token = parser.peek();
      diagnostics.push(
        predicateDiagnostic(
          source,
          context,
          token.start,
          IR_DIAGNOSTIC_CODES.predicateTrailingToken,
          `unexpected trailing ${tokenText(token)} after a complete expression`,
          'a predicate is a single expression; combine conditions with and/or',
        ),
      );
    }
  } catch (error) {
    diagnostics.push(
      withPosition(
        irError({
          code: IR_DIAGNOSTIC_CODES.predicateSyntax,
          message: `predicate expression could not be parsed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          path: context.path,
        }),
        { file: context.file },
      ),
    );
  }

  const firstError = diagnostics.find((entry) => entry.severity === 'error');
  if (firstError !== undefined || ast === undefined) {
    return {
      ast: invalidNode(firstError?.message ?? 'predicate could not be parsed'),
      diagnostics,
    };
  }

  // Every boolean position, not just the root: `length(prediction)` at the root and
  // `not prediction` under a `not` are the same mistake, and both must be refused
  // here rather than surfacing as "not a pass" at eval time.
  const mistyped = booleanPositionErrors(ast);
  if (mistyped.length > 0) {
    for (const node of mistyped) {
      diagnostics.push(
        predicateDiagnostic(
          source,
          context,
          0,
          IR_DIAGNOSTIC_CODES.predicateNotBoolean,
          `${formatPredicateExpr(node)} is not true or false`,
          'a predicate must evaluate to true or false; compare it, for example `prediction != ""` or `length(prediction) < 4000`',
        ),
      );
    }
    return {
      ast: invalidNode('a predicate must evaluate to true or false'),
      diagnostics,
    };
  }

  return { ast, diagnostics };
}

/**
 * Every node sitting in a boolean position that is not boolean by construction.
 *
 * `predicateIsBoolean` only answers for one node; `and`/`or`/`not` are boolean
 * whatever their operands are, so the walk is what catches a string or a number
 * smuggled into a boolean slot.
 */
function booleanPositionErrors(root: PredicateNode): PredicateNode[] {
  const wrong: PredicateNode[] = [];

  const visit = (node: PredicateNode, booleanPosition: boolean): void => {
    if (booleanPosition && !predicateIsBoolean(node)) wrong.push(node);
    switch (node.kind) {
      case 'and':
      case 'or':
        visit(node.left, true);
        visit(node.right, true);
        return;
      case 'not':
        visit(node.operand, true);
        return;
      case 'comparison':
        visit(node.left, false);
        visit(node.right, false);
        return;
      case 'call':
        for (const argument of node.args) visit(argument, false);
        return;
      default:
        return;
    }
  };

  visit(root, true);
  return wrong;
}

function invalidNode(reason: string): PredicateNode {
  return { kind: 'invalid', reason };
}

class Parser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly context: PredicateContext,
    private readonly tokens: PredicateToken[],
    private readonly diagnostics: IrDiagnostic[],
  ) {}

  atEnd(): boolean {
    return this.peek().type === 'eof';
  }

  peek(offset = 0): PredicateToken {
    const token = this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
    return token as PredicateToken;
  }

  parseExpression(): PredicateNode | undefined {
    return this.parseOr();
  }

  private parseOr(): PredicateNode | undefined {
    let left = this.parseAnd();
    while (this.isOperator('or')) {
      this.index += 1;
      const right = this.parseAnd();
      if (left === undefined || right === undefined) return left ?? right;
      left = { kind: 'or', left, right };
    }
    return left;
  }

  private parseAnd(): PredicateNode | undefined {
    let left = this.parseNot();
    while (this.isOperator('and')) {
      this.index += 1;
      const right = this.parseNot();
      if (left === undefined || right === undefined) return left ?? right;
      left = { kind: 'and', left, right };
    }
    return left;
  }

  /**
   * `not` binds looser than a comparison, so `not prediction == "a"` negates the
   * comparison rather than negating a string. Binding it tighter would let
   * `not <string path>` reach the evaluator as a well-typed-looking tree.
   */
  private parseNot(): PredicateNode | undefined {
    if (!this.isOperator('not')) return this.parseComparison();
    this.index += 1;
    const operand = this.parseNot();
    return operand === undefined ? undefined : { kind: 'not', operand };
  }

  private parseComparison(): PredicateNode | undefined {
    const left = this.parsePrimary();
    const token = this.peek();
    const op = token.type === 'operator' ? toOperator(String(token.value)) : undefined;
    if (op === undefined) return left;
    this.index += 1;
    const right = this.parsePrimary();
    if (left === undefined || right === undefined) return left ?? right;
    return { kind: 'comparison', op, left, right };
  }

  private parsePrimary(): PredicateNode | undefined {
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
          IR_DIAGNOSTIC_CODES.predicateUnclosedParen,
          'unclosed parenthesis in predicate expression',
          'add the matching ")"',
        );
        return inner;
      }
      this.index += 1;
      return inner;
    }
    if (token.type === 'identifier') {
      return this.parseIdentifier();
    }

    this.report(
      token.start,
      IR_DIAGNOSTIC_CODES.predicateExpected,
      token.type === 'eof'
        ? 'unexpected end of predicate expression'
        : `unexpected ${tokenText(token)} in predicate expression`,
      'expected prediction, case.id, case.metadata.<name>, a literal, or a builtin call',
    );
    return undefined;
  }

  private parseIdentifier(): PredicateNode | undefined {
    const token = this.peek();
    const name = String(token.value);
    if (this.peek(1).type === 'lparen') {
      return this.parseCall(token, name);
    }
    return this.parsePath(token, name);
  }

  private parseCall(token: PredicateToken, name: string): PredicateNode | undefined {
    if (!isPredicateBuiltin(name)) {
      this.report(
        token.start,
        IR_DIAGNOSTIC_CODES.predicateUnknownBuiltin,
        `unknown builtin "${name}"`,
        'a predicate naming a builtin the runtime cannot evaluate is rejected rather than treated as true',
      );
      this.skipCallArguments();
      return undefined;
    }

    this.index += 2; // identifier and '('
    const args: PredicateNode[] = [];
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
        IR_DIAGNOSTIC_CODES.predicateUnclosedParen,
        `unclosed argument list for ${name}(...)`,
        'add the matching ")"',
      );
      return undefined;
    }
    this.index += 1;

    const builtin = name as PredicateBuiltin;
    const arity = PREDICATE_BUILTIN_ARITY[builtin];
    if (args.length !== arity) {
      this.report(
        token.start,
        IR_DIAGNOSTIC_CODES.predicateArity,
        `${name}() takes ${arity} argument${arity === 1 ? '' : 's'}, received ${args.length}`,
      );
      return undefined;
    }

    const call: PredicateCall = { kind: 'call', name: builtin, args };
    return call;
  }

  private parsePath(token: PredicateToken, name: string): PredicateNode | undefined {
    if (name === 'prediction') {
      this.index += 1;
      return { kind: 'path', path: 'prediction' };
    }

    if (name !== 'case') {
      this.reportUnknownPath(token, name);
      this.index += 1;
      return undefined;
    }

    this.index += 1; // 'case'
    if (this.peek().type !== 'dot') {
      this.reportUnknownPath(token, name);
      return undefined;
    }
    this.index += 1; // '.'
    const field = this.peek();
    if (field.type !== 'identifier') {
      this.reportUnknownPath(token, name);
      return undefined;
    }
    const fieldName = String(field.value);
    this.index += 1;

    if (fieldName === 'id') {
      return { kind: 'path', path: 'case.id' };
    }
    if (fieldName !== 'metadata') {
      this.reportUnknownPath(token, `case.${fieldName}`);
      return undefined;
    }
    if (this.peek().type !== 'dot') {
      this.report(
        field.start,
        IR_DIAGNOSTIC_CODES.predicateUnknownPath,
        'case.metadata is not a value on its own; name one of its keys',
        'write case.metadata.<name>, for example case.metadata.locale',
      );
      return undefined;
    }
    this.index += 1; // '.'
    const key = this.peek();
    if (key.type !== 'identifier') {
      this.report(
        key.start,
        IR_DIAGNOSTIC_CODES.predicateUnknownPath,
        'case.metadata requires a key name after the final "."',
        'write case.metadata.<name>, for example case.metadata.locale',
      );
      return undefined;
    }
    this.index += 1;
    return { kind: 'path', path: 'case.metadata', name: String(key.value) };
  }

  private reportUnknownPath(token: PredicateToken, name: string): void {
    this.report(
      token.start,
      IR_DIAGNOSTIC_CODES.predicateUnknownPath,
      `unknown path "${name}"`,
      'the only paths are prediction, case.id, and case.metadata.<name>',
    );
  }

  /** Consumes a rejected call's arguments so one bad builtin yields one error. */
  private skipCallArguments(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.peek();
      this.index += 1;
      if (token.type === 'lparen') {
        depth += 1;
      } else if (token.type === 'rparen') {
        depth -= 1;
        if (depth <= 0) return;
      }
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
    this.diagnostics.push(
      predicateDiagnostic(this.source, this.context, offset, code, message, hint),
    );
  }
}

function toOperator(value: string): PredicateOperator | undefined {
  return (PREDICATE_OPERATORS as readonly string[]).includes(value)
    ? (value as PredicateOperator)
    : undefined;
}
