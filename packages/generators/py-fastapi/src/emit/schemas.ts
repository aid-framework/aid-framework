/**
 * `app/generated/schemas.py`: one Pydantic model per declared struct.
 *
 * These models are the app's structured-output contracts. A model's reply is parsed
 * into one of them, a tool's arguments are validated into one, and the JSON Schema a
 * model is shown is derived from the same declaration -- so the three can never drift
 * apart.
 */

import type { IR, TypeField, TypeShape } from '@aid-framework/ir';

import { annotationFor, className, fieldName } from '../names.js';
import { MAX_LINE, pythonNumber, pythonString } from '../python.js';
import { assemble, HEADER, importFrom } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { pythonDoc } from './text.js';
import { orderedTypes } from './typeorder.js';

export const SCHEMAS_PATH = `${GENERATED_ROOT}/schemas.py`;

const NO_DESCRIPTION = 'Declared by the spec, with no description.';

export function emitSchemas(ir: IR): EmittedFile {
  const ordered = orderedTypes(ir.types);
  const usesLiteral = ordered.some((type) =>
    type.fields.some((field) => isEnum(field) && !field.type.list),
  );
  const usesField = ordered.some((type) =>
    type.fields.some((field) => fieldArguments(field).length > 0),
  );

  const blocks: string[] = [
    HEADER,
    pythonDoc(
      'Pydantic models for every struct the spec declares. They are the contracts the ' +
        'gateway parses into and the tool adapters validate against, generated from the ' +
        'one place the IR declares each shape.',
    ),
  ];
  const stdlib: string[] = [];
  if (usesLiteral) stdlib.push(importFrom('typing', ['Literal']));
  if (stdlib.length > 0) blocks.push(stdlib.join('\n'));
  if (ordered.length > 0) {
    blocks.push(importFrom('pydantic', usesField ? ['BaseModel', 'Field'] : ['BaseModel']));
  }

  if (ordered.length === 0) {
    blocks.push('# The spec declares no types, so this module has no models to define.');
  }
  for (const type of ordered) blocks.push(typeBlock(type));

  return generated(SCHEMAS_PATH, assemble(blocks));
}

function typeBlock(type: TypeShape): string {
  const lines: string[] = [
    `class ${className(type.id)}(BaseModel):`,
    pythonDoc(type.description ?? NO_DESCRIPTION, '    '),
  ];
  for (const field of type.fields) lines.push(fieldLine(field));
  return lines.join('\n');
}

function isEnum(field: TypeField): boolean {
  return field.enum !== undefined && field.enum.length > 0;
}

/** The Python literal for one enum member: strings quoted, booleans capitalised. */
function enumMember(value: string | number | boolean): string {
  if (typeof value === 'string') return pythonString(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return pythonNumber(value);
}

function annotationOf(field: TypeField): string {
  const optional = !field.required;
  if (isEnum(field) && !field.type.list) {
    const members = field.enum?.map(enumMember) ?? [];
    const union = `Literal[${members.join(', ')}]`;
    return optional ? `${union} | None` : union;
  }
  return annotationFor(field.type, optional);
}

/**
 * The `Field(...)` keyword arguments for a field.
 *
 * Only keywords Pydantic enforces are emitted: a bound nothing can violate is noise,
 * and a description that was dropped would lose the spec's prose.
 */
function fieldArguments(field: TypeField): string[] {
  const args: string[] = [];
  if (!field.required) args.push('default=None');
  const scalar = field.type.kind === 'primitive' && !field.type.list;
  const isText = scalar && field.type.name === 'string';
  if (scalar && !isText) {
    if (typeof field.minimum === 'number') args.push(`ge=${pythonNumber(field.minimum)}`);
    if (typeof field.maximum === 'number') args.push(`le=${pythonNumber(field.maximum)}`);
  } else if (isText) {
    if (typeof field.minimum === 'number') args.push(`min_length=${pythonNumber(field.minimum)}`);
    if (typeof field.maximum === 'number') args.push(`max_length=${pythonNumber(field.maximum)}`);
  }
  if (field.description !== undefined && field.description !== '') {
    args.push(`description=${pythonString(field.description)}`);
  }
  return args;
}

function fieldLine(field: TypeField): string {
  const indent = '    ';
  const head = `${indent}${fieldName(field.name)}: ${annotationOf(field)}`;
  const args = fieldArguments(field);
  if (args.length === 0) return head;
  if (args.length === 1 && args[0] === 'default=None') return `${head} = None`;
  const oneLine = `${head} = Field(${args.join(', ')})`;
  if (oneLine.length <= MAX_LINE) return oneLine;
  const inner = args.map((arg) => `${indent}${indent}${arg},`);
  return `${head} = Field(\n${inner.join('\n')}\n${indent})`;
}
