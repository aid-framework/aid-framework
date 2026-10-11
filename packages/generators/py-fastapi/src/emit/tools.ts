/**
 * `app/generated/tools/`: one adapter per tool, turning a business implementation into
 * the runtime's `Tool` contract.
 *
 * The adapter is the only place that knows both sides. It is generated because it is
 * pure glue -- name, description, JSON Schema, one validation call and one
 * serialization -- and a hand-written copy of it would be the first thing to drift
 * when the spec changes. The behaviour stays in `app/business`, reached through the
 * `Protocol` in `app/generated/contracts`.
 */

import type { IR, ToolShape } from '@aid/ir';

import { className, moduleName } from '../names.js';
import { INDENT, pythonStatement, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom, tupleLiteral } from '../template.js';
import { BUSINESS_TOOLS_INIT_PATH } from './contracts.js';
import type { EmittedFile } from './file.js';
import { business, GENERATED_ROOT, generated } from './file.js';
import { jsonSchema, typeTable } from './ir.js';
import { orderedTools } from './order.js';
import { pythonDoc } from './text.js';

export const TOOLS_INIT_PATH = `${GENERATED_ROOT}/tools/__init__.py`;

export function toolAdapterPath(toolId: string): string {
  return `${GENERATED_ROOT}/tools/${moduleName(toolId)}.py`;
}

export function emitToolAdapter(ir: IR, tool: ToolShape): EmittedFile {
  const types = typeTable(ir);
  const module = moduleName(tool.id);
  const protocol = `${className(tool.id)}Tool`;
  const request = className(tool.input.name);

  const schema = jsonSchema(tool.input, types);
  // Only the request type is named in the adapter body: the response type appears solely
  // when the adapter annotates the implementation call, so an untyped pass-through does
  // not import a name it never mentions.
  const response =
    tool.output.kind === 'named' && tool.output.resolved ? className(tool.output.name) : undefined;
  const imported = new Set<string>();
  if (tool.input.kind === 'named' && tool.input.resolved) imported.add(request);
  if (response !== undefined) imported.add(response);
  const structured = response !== undefined;

  const adapter = [
    `def as_${module}(`,
    `${INDENT}implementation: ${protocol},`,
    ') -> Tool:',
    pythonDoc(
      `Adapt a hand-written \`${tool.name}\` implementation to the runtime's tool contract.`,
      INDENT,
    ),
    `${INDENT}async def handle(**arguments: object) -> object:`,
    pythonDoc(
      'Validate what the model passed, call the business implementation, and return a ' +
        'value the runtime can serialize.',
      INDENT + INDENT,
    ),
    `${INDENT}${INDENT}request = ${request}.model_validate(arguments)`,
    `${INDENT}${INDENT}context = ToolContext(name=NAME, arguments=arguments)`,
    `${INDENT}${INDENT}response${response === undefined ? '' : `: ${response}`} = ` +
      'await implementation(context, request)',
    structured
      ? `${INDENT}${INDENT}return response.model_dump(mode="json")`
      : `${INDENT}${INDENT}return response`,
    '',
    `${INDENT}return Tool.of(`,
    `${INDENT}${INDENT}NAME,`,
    `${INDENT}${INDENT}handle,`,
    `${INDENT}${INDENT}description=${pythonString(tool.description ?? '')},`,
    `${INDENT}${INDENT}parameters=PARAMETERS,`,
    `${INDENT})`,
  ];

  return generated(
    toolAdapterPath(tool.id),
    assemble([
      HEADER,
      pythonDoc(
        `The generated adapter for the \`${tool.name}\` tool: validate the arguments, call ` +
          `\`${protocol}\` in app/business, serialize the result.`,
      ),
      importFrom('typing', ['Any']),
      importFrom('aid_runtime', ['Tool']),
      importBlock([
        [
          // `ToolContext` is defined in the contracts package, so it is imported from
          // there rather than re-exported through the contract submodule: a name reaching
          // a third module through the contract is an implicit re-export, which a strict
          // consumer's `no_implicit_reexport` rejects. The explicit alternative, `X as X`,
          // would be flagged by `useless-import-alias` in a lint config that enables it.
          importFrom('..contracts', ['ToolContext']),
          `from ..contracts.${module} import ${protocol}`,
          imported.size === 0 ? undefined : importFrom('..schemas', [...imported].sort()),
        ].filter((line): line is string => line !== undefined),
      ]),
      [
        `NAME = ${pythonString(tool.name)}`,
        '',
        pythonStatement('PARAMETERS: dict[str, Any] = ', schema),
      ].join('\n'),
      adapter.join('\n'),
    ]),
  );
}

export function emitToolsInit(ir: IR): EmittedFile {
  const tools = orderedTools(ir);
  const imports = tools.map(
    (tool) => `from .${moduleName(tool.id)} import as_${moduleName(tool.id)}`,
  );
  const protocols = tools.map(
    (tool) => `from ..contracts.${moduleName(tool.id)} import ${className(tool.id)}Tool`,
  );
  const parameters = tools.map(
    (tool) =>
      `${INDENT}${moduleName(tool.id)}: ${className(tool.id)}Tool = ` +
      `IMPLEMENTATIONS[${pythonString(tool.id)}],`,
  );
  const adapted = tools.map((tool) => `as_${moduleName(tool.id)}(${moduleName(tool.id)})`);

  const hasTools = tools.length > 0;
  const signature = hasTools
    ? ['def build_executor(', `${INDENT}*,`, ...parameters, ') -> ToolExecutor:']
    : ['def build_executor() -> ToolExecutor:'];
  const body = hasTools
    ? [
        `${INDENT}return ToolExecutor(`,
        `${INDENT}${INDENT}tools=${tupleLiteral(adapted, INDENT + INDENT, 'tools=')},`,
        `${INDENT})`,
      ]
    : [`${INDENT}return ToolExecutor(tools=())`];

  return generated(
    TOOLS_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        "The tool executor for this app, assembled from the spec's declared tools. A " +
          'test that needs a deterministic tool passes its own implementation by keyword.',
      ),
      importBlock([
        [importFrom('aid_runtime', ['ToolExecutor'])],
        ...(hasTools
          ? [['from ...business.tools import IMPLEMENTATIONS', ...imports, ...protocols]]
          : []),
      ]),
      [
        ...signature,
        pythonDoc('Every declared tool, adapted and ready to execute.', INDENT),
        ...body,
      ].join('\n'),
    ]),
  );
}

/**
 * The business tools seed: written once, then owned by the developer.
 *
 * The mapping is keyed by *tool id* -- the identity the spec declares and the adapter
 * looks up -- while each file is named after its handler symbol, which the spec may
 * choose independently (`docs/design.md` §8.4). `Any` is the honest value type: the
 * declared tools have unrelated signatures, and `build_executor` narrows each one back
 * to its own `Protocol` at the point of use.
 */
export function emitBusinessToolsInit(ir: IR): EmittedFile {
  const tools = orderedTools(ir);
  const imports = tools.map((tool) => {
    const symbol = tool.handler.symbol ?? tool.name;
    return `from .${symbol} import ${className(symbol)}`;
  });
  const entries = tools.map((tool) => {
    const symbol = tool.handler.symbol ?? tool.name;
    return `${INDENT}${pythonString(tool.id)}: ${className(symbol)}(),`;
  });

  return business(
    BUSINESS_TOOLS_INIT_PATH,
    assemble(
      [
        HEADER,
        pythonDoc(
          'The implementation of every tool the spec declares, keyed by tool id. The ' +
            'generated executor reads this mapping, so adding a tool means adding it here too.',
        ),
        importBlock([[importFrom('typing', ['Any'])], imports]),
        ['IMPLEMENTATIONS: dict[str, Any] = {', ...entries, '}'].join('\n'),
      ],
      'business',
    ),
  );
}
