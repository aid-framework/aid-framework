/**
 * Read models over the IR that every emitter shares.
 *
 * The emitters must never re-derive a decision the validator already made, so the
 * lookups here are deliberately mechanical: they answer "what is bound here" and
 * "what does this type look like as JSON Schema", not "is this allowed".
 */

import type {
  IR,
  PipelineShape,
  PromptShape,
  StepShape,
  ToolShape,
  TypeField,
  TypeRef,
  TypeShape,
} from '@aid/ir';
import type { StepBinding } from '../validate.js';
import { bindingOf, sortedTypes } from '../validate.js';

export function typeTable(ir: IR): Map<string, TypeShape> {
  return sortedTypes(ir);
}

/** The declared struct a ref names, or `undefined` for a primitive or list ref. */
export function structOf(
  ref: TypeRef | undefined,
  types: Map<string, TypeShape>,
): TypeShape | undefined {
  return ref !== undefined && ref.kind === 'named' ? types.get(ref.name) : undefined;
}

export function promptOf(ir: IR, id: string): PromptShape | undefined {
  return ir.prompts.find((prompt) => prompt.id === id);
}

export function toolOf(ir: IR, id: string): ToolShape | undefined {
  return ir.tools.find((tool) => tool.id === id);
}

/**
 * The type a prompt's structured output parses into.
 *
 * A `text` prompt binds a plain string, which is what the runtime's gateway returns,
 * so a reference to such a step renders as the model's raw output.
 */
export function promptOutputRef(prompt: PromptShape): TypeRef {
  if (prompt.output.kind === 'structured' && prompt.output.schema !== undefined) {
    return prompt.output.schema;
  }
  return { kind: 'primitive', name: 'string', list: false };
}

/** The event type the pipeline's final emit step responds with. */
export function eventTypeOf(pipeline: PipelineShape): string | undefined {
  for (const step of pipeline.steps ?? []) {
    if (step.kind === 'emit') return step.event;
  }
  return undefined;
}

/**
 * The bindings in scope before each step, mirroring the validator's construction.
 *
 * `[stepIndex]` is the scope *entering* that step (excluding its own binding), which
 * is exactly what a step's input references are resolved against.
 */
export function scopesOf(pipeline: PipelineShape, ir: IR): StepBinding[][] {
  const scopes: StepBinding[][] = [];
  let inScope: StepBinding[] = [{ name: 'event', type: undefined }];
  for (const step of pipeline.steps ?? []) {
    scopes.push(inScope);
    const bound = bindingOf(step);
    if (bound === undefined) continue;
    const type = bindingType(step, ir);
    inScope = [...inScope, { name: bound, type }];
  }
  return scopes;
}

function bindingType(step: StepShape, ir: IR): TypeRef | undefined {
  if (step.kind === 'tool') return toolOf(ir, step.tool)?.output;
  if (step.kind === 'generate') {
    const prompt = promptOf(ir, step.prompt);
    return prompt === undefined ? undefined : promptOutputRef(prompt);
  }
  return undefined;
}

/** Every step's index with the name it binds, for stable naming. */
export function stepNames(pipeline: PipelineShape): string[] {
  return (pipeline.steps ?? []).map((step) => bindingOf(step) ?? 'response');
}

const PRIMITIVE_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  string: { type: 'string' },
  number: { type: 'number' },
  integer: { type: 'integer' },
  boolean: { type: 'boolean' },
};

/**
 * A JSON Schema for a type reference, inlined rather than `$ref`-ed.
 *
 * The schema is what a model is shown when it composes a tool call and what a
 * `json-schema` eval metric validates against, so it is derived from the one place
 * the IR declares the shape. Schema keywords are the ones both consumers accept:
 * `enum`, `minimum`/`maximum`, and `minLength`/`maxLength` for strings.
 */
export function jsonSchema(ref: TypeRef | undefined, types: Map<string, TypeShape>): unknown {
  if (ref === undefined) return { type: 'object' };
  return schemaFor(ref, types, new Set<string>());
}

function schemaFor(
  ref: TypeRef,
  types: Map<string, TypeShape>,
  seen: Set<string>,
): Record<string, unknown> {
  if (ref.kind === 'primitive') {
    const base = PRIMITIVE_SCHEMAS[ref.name] ?? {};
    return ref.list ? { type: 'array', items: base } : { ...base };
  }
  if (ref.list) {
    return { type: 'array', items: schemaFor({ ...ref, list: false }, types, seen) };
  }
  const struct = types.get(ref.name);
  if (struct === undefined) return {};
  // The IR's own gate refuses a cyclic type, so this guard is only a backstop: an
  // unbounded inline expansion would never terminate.
  if (seen.has(struct.id)) return { type: 'object' };
  const nested = new Set(seen);
  nested.add(struct.id);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of struct.fields) {
    properties[field.name] = fieldSchema(field, types, nested);
    if (field.required) required.push(field.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function fieldSchema(
  field: TypeField,
  types: Map<string, TypeShape>,
  seen: Set<string>,
): Record<string, unknown> {
  const schema = schemaFor(field.type, types, seen);
  if (field.enum !== undefined && field.enum.length > 0) schema.enum = [...field.enum];
  const scalar = field.type.kind === 'primitive' && !field.type.list;
  const isText = scalar && field.type.name === 'string';
  // Bounds are only meaningful on a scalar: `minimum` on an array says nothing, and
  // a string's length keyword is spelled differently in JSON Schema.
  if (scalar && !isText) {
    if (typeof field.minimum === 'number') schema.minimum = field.minimum;
    if (typeof field.maximum === 'number') schema.maximum = field.maximum;
  } else if (isText) {
    if (typeof field.minimum === 'number') schema.minLength = field.minimum;
    if (typeof field.maximum === 'number') schema.maxLength = field.maximum;
  }
  return schema;
}
