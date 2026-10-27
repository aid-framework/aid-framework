/**
 * `generated/schemas.ts` and `generated/requests.ts`.
 *
 * The plan's `emitsAgainst.structuredOutput = 'zod'` is realised here: every IR type
 * becomes a zod schema, and every structured prompt output validates through one. A zod
 * schema is used both as the runtime validator and, through `z.infer`, as the static
 * type, so there is exactly one definition of each shape per generated app.
 */

import type { IR, StepInputValue, StepShape, TypeField, TypeRef, TypeShape } from '@aid/ir';
import { className, literal, zodPrimitive } from '../names.js';
import { type EmittedFile, generated, paths } from './file.js';
import { moduleText } from './text.js';

const ZOD_HEADER = "import { z } from 'zod';";

/** The zod expression for one field's value, before optionality is applied. */
function fieldExpression(field: TypeField): string {
  if (field.enum !== undefined && field.enum.length > 0) {
    const strings = field.enum.every((value) => typeof value === 'string');
    if (strings) {
      return `z.enum([${field.enum.map((value) => literal(value)).join(', ')}])`;
    }
    return `z.union([${field.enum.map((value) => `z.literal(${literal(value)})`).join(', ')}])`;
  }
  if (field.type.kind === 'named') return className(field.type.name);
  let expression = zodPrimitive(field.type.name);
  if (field.minimum !== undefined) expression += `.min(${literal(field.minimum)})`;
  if (field.maximum !== undefined) expression += `.max(${literal(field.maximum)})`;
  return expression;
}

function fieldLine(field: TypeField): string {
  const expression = fieldExpression(field);
  return `  ${field.name}: ${field.required ? expression : `${expression}.optional()`},`;
}

function typeShapeModule(shape: TypeShape): string {
  const name = className(shape.id);
  const lines = [
    `export const ${name} = z.object({`,
    ...shape.fields.map(fieldLine),
    '});',
    '',
    `export type ${name} = z.infer<typeof ${name}>;`,
  ];
  return lines.join('\n');
}

export function emitSchemas(ir: IR): EmittedFile {
  const header = [
    ZOD_HEADER,
    '',
    // Import order matters for reading, not for correctness; schemas reference each
    // other only through `z.lazy`-free direct references, which the IR keeps acyclic.
  ].join('\n');
  const body = ir.types.map(typeShapeModule).join('\n\n');
  return generated(paths.schemas, moduleText(header, body));
}

/** Every field a pipeline can reference as `event.<name>`, with its declared type. */
export function eventFields(ir: IR): { name: string; field?: TypeField }[] {
  const byType = new Map<string, TypeShape>();
  for (const shape of ir.types) byType.set(shape.id, shape);

  const fieldIndex = new Map<string, TypeField>();
  for (const tool of ir.tools) {
    if (tool.input.kind !== 'named') continue;
    const shape = byType.get(tool.input.name);
    if (shape === undefined) continue;
    for (const field of shape.fields) fieldIndex.set(field.name, field);
  }

  const names: string[] = [];
  const visit = (value: StepInputValue): void => {
    if (value.kind !== 'reference') return;
    const [head, second, ...rest] = value.path;
    if (head !== 'event' || second === undefined || rest.length > 0) return;
    if (!names.includes(second)) names.push(second);
  };
  for (const pipeline of ir.pipelines) visitSteps(pipeline.steps, visit);
  return names.map((name) => {
    const field = fieldIndex.get(name);
    return field === undefined ? { name } : { name, field };
  });
}

/** Walks nested steps so a composite's inner references still shape the request schema. */
function visitSteps(steps: readonly StepShape[], visit: (value: StepInputValue) => void): void {
  for (const step of steps) {
    if (step.kind === 'branch') {
      visitSteps(step.then, visit);
      visitSteps(step.else, visit);
    } else if (step.kind === 'parallel') {
      for (const arm of step.branches) visitSteps(arm, visit);
    } else if (step.kind === 'map') {
      visitSteps([step.step], visit);
    } else if (step.kind === 'generate' || step.kind === 'tool') {
      for (const value of Object.values(step.input)) visit(value);
    }
  }
}

function requestFieldLine(entry: { name: string; field?: TypeField }): string {
  const field = entry.field;
  if (field === undefined) return `  ${entry.name}: z.string(),`;
  return fieldLine(field);
}

function requestModule(ir: IR): string | undefined {
  const fields = eventFields(ir);
  if (fields.length === 0) return undefined;
  const modules = ir.pipelines.map((pipeline) => {
    const name = `${className(pipeline.id)}Request`;
    return [
      `export const ${name} = z.object({`,
      ...fields.map(requestFieldLine),
      '});',
      '',
      `export type ${name} = z.infer<typeof ${name}>;`,
    ].join('\n');
  });
  return modules.join('\n\n');
}

export function emitRequests(ir: IR): EmittedFile | undefined {
  const body = requestModule(ir);
  if (body === undefined) return undefined;
  return generated(paths.requests, moduleText(ZOD_HEADER, body));
}

/** The request type name of one pipeline. */
export function requestTypeName(ir: IR, pipelineId: string): string {
  void ir;
  return `${className(pipelineId)}Request`;
}

/** The zod const name for one IR type. */
export function schemaName(ref: TypeRef): string {
  return ref.kind === 'named' ? className(ref.name) : 'z.unknown()';
}
