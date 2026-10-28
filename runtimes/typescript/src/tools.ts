/**
 * Tool dispatch with schema validation.
 *
 * The one place this module cannot mirror the reference runtime is the seam itself:
 * Python infers a tool's JSON schema from `inspect.signature` and a docstring, and
 * JavaScript has neither. So the schema is declared explicitly and validated against
 * the tool set here instead -- the runtime's job is to refuse a *wrong* invocation,
 * and that job is identical either way.
 *
 * The validator implements a deliberate subset of JSON Schema: `type`, `required`
 * and `additionalProperties: false`. That subset is documented rather than silently
 * partial, and an unknown `type` value is treated as unconstrained instead of
 * failing, because a schema written for a newer draft must not reject every call.
 */

import type { ConcurrencyLimiter } from './concurrency.js';
import { ConfigurationError, ToolExecutionError, ToolNotFoundError } from './errors.js';
import { dumpsSorted, repr } from './internal/json.js';
import { type ToolCall, ToolDefinition, ToolResult } from './types.js';

/** A handler receives validated arguments and may return anything serialisable. */
export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/** The JSON-Schema subset this validator enforces. */
export interface ToolParameters {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, { readonly type?: string }>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/** A registered tool: its public definition plus the code behind it. */
export class Tool {
  readonly definition_: ToolDefinition;
  readonly handler: ToolHandler;

  constructor(init: {
    readonly name: string;
    readonly handler: ToolHandler;
    readonly description?: string;
    readonly parameters?: ToolParameters;
  }) {
    this.definition_ = new ToolDefinition({
      name: init.name,
      description: init.description,
      parameters: (init.parameters ?? { type: 'object', properties: {} }) as Record<
        string,
        unknown
      >,
    });
    this.handler = init.handler;
    this.checkSchema();
  }

  /**
   * Declare a tool.
   *
   * `parameters` is required where Python would infer it. A schema whose `required`
   * list names a property it does not define is a wiring mistake, and it is reported
   * here rather than at the first call: that is the same failure Python reports as
   * "not accepted by the handler", just discovered from the other direction.
   */
  static of(init: {
    readonly name: string;
    readonly handler: ToolHandler;
    readonly description?: string;
    readonly parameters?: ToolParameters;
  }): Tool {
    return new Tool(init);
  }

  get name(): string {
    return this.definition_.name;
  }

  get definition(): ToolDefinition {
    return this.definition_;
  }

  private checkSchema(): void {
    const schema = this.definition_.parameters as ToolParameters;
    for (const property of schema.required ?? []) {
      if (schema.properties === undefined || !(property in schema.properties)) {
        throw new ConfigurationError(
          `tool ${repr(this.name)} declares required parameter ${repr(
            property,
          )} but its schema does not define it, so it is not accepted by the handler`,
        );
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeMatches(expected: unknown, value: unknown): boolean {
  const names = Array.isArray(expected) ? expected : [expected];
  return names.some((name) => singleTypeMatches(name, value));
}

function singleTypeMatches(expected: unknown, value: unknown): boolean {
  if (typeof expected !== 'string') return true;
  switch (expected) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      // A boolean is not a number, even though `true + 0` is 1.
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // An unknown type keyword is not a claim we can check, so it matches.
      return true;
  }
}

/**
 * Validate `args` against `schema`, returning every problem rather than the first.
 *
 * Returning all problems is what makes a single repair turn enough: a model told
 * about one bad field per round trips once per field.
 */
export function validateArguments(schema: ToolParameters, args: unknown): string[] {
  if (!isObject(args)) return ['arguments must be an object'];
  const problems: string[] = [];
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (!(name in args)) problems.push(`missing required property '${name}'`);
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!(name in properties)) problems.push(`unexpected property '${name}'`);
    }
  }
  for (const [name, rule] of Object.entries(properties)) {
    if (!(name in args)) continue;
    const value = args[name];
    if (value === null || value === undefined) continue;
    if (rule.type !== undefined && !typeMatches(rule.type, value)) {
      problems.push(`property '${name}' must be of type ${String(rule.type)}`);
    }
  }
  return problems;
}

/**
 * A set of tools, and the dispatcher for them.
 *
 * `strict` decides what a crashing handler means. The default is to hand the model
 * an error result so it can react; strict mode rethrows, because a caller that has
 * already decided a crash is a bug should not have to inspect a result to find out.
 */
export class ToolExecutor {
  private readonly _tools = new Map<string, Tool>();
  private readonly _strict: boolean;
  private readonly _limiter: ConcurrencyLimiter | undefined;

  constructor(
    tools: Iterable<Tool> = [],
    options: { readonly strict?: boolean; readonly limiter?: ConcurrencyLimiter } = {},
  ) {
    this._strict = options.strict ?? false;
    this._limiter = options.limiter;
    for (const tool of tools) this.register(tool);
  }

  /** The registered names, sorted. */
  names(): string[] {
    return [...this._tools.keys()].sort();
  }

  /** Add a tool. A duplicate name replaces, because a registry is a map. */
  register(tool: Tool): void {
    this._tools.set(tool.name, tool);
  }

  /** One tool's public definition. */
  definition(name: string): ToolDefinition {
    return this.require(name).definition;
  }

  /** Every registered definition, ordered by name. */
  definitions(): ToolDefinition[] {
    return this.names().map((name) => this.require(name).definition);
  }

  /** Whether a name is registered. */
  has(name: string): boolean {
    return this._tools.has(name);
  }

  /**
   * Run one call.
   *
   * An unknown tool throws: that is a wiring error in generated code, not something
   * a model can fix by trying again with the same name.
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    // When a limiter is shared with the gateway, the call holds one slot for its whole
    // duration, released on success, handler error, or cancellation.
    if (this._limiter === undefined) return this.dispatch(call);
    return this._limiter.run(() => this.dispatch(call));
  }

  private async dispatch(call: ToolCall): Promise<ToolResult> {
    const tool = this.require(call.name);
    const problems = validateArguments(tool.definition.parameters as ToolParameters, call.args);
    if (problems.length > 0) {
      return ToolResult.fromError(
        call,
        `invalid arguments: ${problems.join('; ')} -- ${dumpsSorted(call.args)}`,
      );
    }
    try {
      return ToolResult.fromValue(call, await tool.handler(call.args));
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (this._strict) throw new ToolExecutionError(detail);
      return ToolResult.fromError(call, detail);
    }
  }

  /** Run calls in order. Sequential on purpose: a tool set is a transcript, not a race. */
  async executeAll(calls: Iterable<ToolCall>): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) results.push(await this.execute(call));
    return results;
  }

  private require(name: string): Tool {
    const tool = this._tools.get(name);
    if (tool === undefined) throw new ToolNotFoundError(name, this.names());
    return tool;
  }
}
