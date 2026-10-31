/**
 * `generated/contracts/*` and `generated/tools/*`.
 *
 * A tool has two halves: the contract (what an implementation must accept and return)
 * and the adapter (the `Tool` the executor and the model see). Splitting them is what
 * lets `business/tools/<name>.ts` be hand-written against the contract without the
 * generator ever needing to read it back.
 */

import type { IR, ToolShape, TypeRef, TypeShape } from '@aid-framework/ir';
import { className, literal, memberAccess, propertyKey, toSnakeCase } from '../names.js';
import { type EmittedFile, generated, paths, toolAdapterPath, toolContractPath } from './file.js';
import { fits, importStatement, lines, moduleText, sortStatements } from './text.js';

/** The TypeScript type a `TypeRef` denotes, in a signature position. */
function refType(ref: TypeRef): string {
  if (ref.kind === 'named') return className(ref.name);
  switch (ref.name) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'unknown';
  }
}

function typeIndex(ir: IR): Map<string, TypeShape> {
  const map = new Map<string, TypeShape>();
  for (const shape of ir.types) map.set(shape.id, shape);
  return map;
}

export function emitContractsIndex(ir: IR): EmittedFile {
  void ir;
  const body = [
    '/** What a tool implementation is called with, beside the request itself. */',
    'export interface ToolContext {',
    '  readonly name: string;',
    '  readonly arguments: Readonly<Record<string, unknown>>;',
    '}',
    '',
    '/** Build the context a business tool receives. */',
    'export function toolContext(name: string, args: Readonly<Record<string, unknown>>): ToolContext {',
    '  return { name, arguments: args };',
    '}',
  ].join('\n');
  return generated(paths.contractsIndex, moduleText(body));
}

export function emitContractModule(ir: IR, tool: ToolShape): EmittedFile {
  const index = typeIndex(ir);
  const input = refType(tool.input);
  const output = refType(tool.output);
  const handler = `${className(tool.id)}Handler`;

  const typeImports: string[] = [];
  if (tool.input.kind === 'named' && index.has(tool.input.name))
    typeImports.push(className(tool.input.name));
  if (
    tool.output.kind === 'named' &&
    index.has(tool.output.name) &&
    tool.output.name !== (tool.input.kind === 'named' ? tool.input.name : undefined)
  ) {
    typeImports.push(className(tool.output.name));
  }

  const header =
    typeImports.length === 0
      ? importStatement('./index.js', [{ name: 'ToolContext', type: true }])
      : sortStatements([
          {
            from: '../schemas.js',
            text: importStatement(
              '../schemas.js',
              typeImports.map((name) => ({ name, type: true })),
            ),
          },
          {
            from: './index.js',
            text: importStatement('./index.js', [{ name: 'ToolContext', type: true }]),
          },
        ]).join('\n');

  const signature = `export type ${handler} = (context: ToolContext, request: ${input}) => Promise<${output}>;`;
  const body = [
    `/** What \`${tool.id}\` must implement. */`,
    ...(fits('', signature)
      ? [signature]
      : [
          `export type ${handler} = (`,
          '  context: ToolContext,',
          `  request: ${input},`,
          `) => Promise<${output}>;`,
        ]),
  ].join('\n');

  return generated(toolContractPath(tool.id), moduleText(header, body));
}

/** The flat JSON-Schema the runtime's tool validator enforces. */
function parametersFor(ir: IR, tool: ToolShape): { schema: string; required: string[] } {
  const index = typeIndex(ir);
  const properties: string[] = [];
  const required: string[] = [];
  if (tool.input.kind === 'named') {
    const shape = index.get(tool.input.name);
    if (shape !== undefined) {
      for (const field of shape.fields) {
        const type =
          field.type.kind === 'primitive' && field.type.name === 'integer' ? 'integer' : 'string';
        properties.push(`    ${propertyKey(field.name)}: { type: ${literal(type)} },`);
        if (field.required) required.push(field.name);
      }
    }
  }
  const schema = [
    'const PARAMETERS: ToolParameters = {',
    "  type: 'object',",
    '  additionalProperties: false,',
    '  properties: {',
    ...properties,
    '  },',
    `  required: [${required.map((name) => literal(name)).join(', ')}],`,
    '};',
  ].join('\n');
  return { schema, required };
}

export function emitToolAdapter(ir: IR, tool: ToolShape): EmittedFile {
  const index = typeIndex(ir);
  const handler = `${className(tool.id)}Handler`;
  const factory = `as${className(tool.id)}`;
  const inputType = refType(tool.input);
  const inputSchema =
    tool.input.kind === 'named' && index.has(tool.input.name)
      ? className(tool.input.name)
      : undefined;
  const { schema } = parametersFor(ir, tool);
  const constant = `${toSnakeCase(tool.id).toUpperCase()}_NAME`;

  const header = lines(
    importStatement('@aid-framework/runtime', [
      { name: 'Tool', type: false },
      { name: 'ToolParameters', type: true },
    ]),
    importStatement('../contracts/index.js', [{ name: 'toolContext', type: false }]),
    importStatement(`../contracts/${tool.id}.js`, [{ name: handler, type: true }]),
    inputSchema !== undefined &&
      importStatement('../schemas.js', [{ name: inputSchema, type: false }]),
  ).join('\n');

  const body = [
    `const ${constant} = ${literal(tool.id)};`,
    `const DESCRIPTION = ${literal(tool.description)};`,
    '',
    schema,
    '',
    '/**',
    ` * Bind a \`${tool.id}\` implementation to the tool the executor and the model see.`,
    ' * The request is validated against its schema before the implementation runs, so a',
    ' * malformed tool call is a typed error rather than a downstream surprise.',
    ' */',
    `export function ${factory}(implementation: ${handler}): Tool {`,
    '  return Tool.of({',
    `    name: ${constant},`,
    '    description: DESCRIPTION,',
    '    parameters: PARAMETERS,',
    '    handler: async (args) => {',
    inputSchema === undefined
      ? `      return await implementation(toolContext(${constant}, args), args as ${inputType});`
      : [
          `      const request = ${inputSchema}.parse(args);`,
          `      return await implementation(toolContext(${constant}, args), request);`,
        ].join('\n'),
    '    },',
    '  });',
    '}',
  ].join('\n');

  return generated(toolAdapterPath(tool.id), moduleText(header, body));
}

export function emitToolsIndex(ir: IR): EmittedFile {
  const tools = ir.tools;
  const toolImports = tools.flatMap((tool) => [
    { specifier: `../contracts/${tool.id}.js`, name: `${className(tool.id)}Handler`, type: true },
    { specifier: `./${tool.id}.js`, name: `as${className(tool.id)}`, type: false },
  ]);
  const header = [
    importStatement('@aid-framework/runtime', [
      { name: 'ConfigurationError', type: false },
      { name: 'Tool', type: true },
      { name: 'ToolExecutor', type: false },
    ]),
    ...sortStatements([
      ...toolImports.map((entry) => ({
        from: entry.specifier,
        text: importStatement(entry.specifier, [{ name: entry.name, type: entry.type }]),
      })),
      {
        from: '../../business/tools/index.js',
        text: importStatement('../../business/tools/index.js', [
          { name: 'IMPLEMENTATIONS', type: false },
        ]),
      },
    ]),
  ].join('\n');

  const optionLines = tools.map(
    (tool) => `  readonly ${propertyKey(tool.id)}?: ${className(tool.id)}Handler;`,
  );
  const args = tools.map((tool) => {
    const local = `${className(tool.id)}Implementation`;
    const handler = `${className(tool.id)}Handler`;
    const assignment = `  const ${local} = options${memberAccess(
      tool.id,
    )} ?? (IMPLEMENTATIONS${memberAccess(tool.id)} as ${handler} | undefined);`;
    const broken = [
      `  const ${local} =`,
      `    options${memberAccess(tool.id)} ??`,
      `    (IMPLEMENTATIONS${memberAccess(tool.id)} as ${handler} | undefined);`,
    ].join('\n');
    return [
      fits('', assignment) ? assignment : broken,
      `  if (${local} === undefined) {`,
      `    throw new ConfigurationError(${literal(`no implementation is registered for ${tool.id}`)});`,
      '  }',
      `  adapters.push(as${className(tool.id)}(${local}));`,
    ].join('\n');
  });

  const body = [
    '/** The implementations a caller may override; the business tier supplies the rest. */',
    'export interface BuildExecutorOptions {',
    ...optionLines,
    '}',
    '',
    '/** Build the adapters with every IR tool bound to an implementation. */',
    'export function buildTools(options: BuildExecutorOptions = {}): Tool[] {',
    '  const adapters: Tool[] = [];',
    ...args,
    '  return adapters;',
    '}',
    '',
    '/** Build the executor over those adapters. */',
    'export function buildExecutor(options: BuildExecutorOptions = {}): ToolExecutor {',
    '  return new ToolExecutor(buildTools(options));',
    '}',
  ].join('\n');

  const fullHeader = header;
  return generated(paths.toolsIndex, moduleText(fullHeader, body));
}
