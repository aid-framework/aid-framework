/**
 * `app/generated/contracts/`: the typed seam between generated wiring and the
 * hand-written tool implementations.
 *
 * The generator never writes business logic (`docs/design.md` §8.3), so the boundary
 * between the two has to be a declared type rather than a convention. Each tool gets a
 * `Protocol` naming exactly the call the generated adapter makes; the business module
 * implements it. The business file is created once and then owned by the user, so the
 * protocol is what makes a hand-written implementation safe to type-check against.
 */

import type { ToolShape } from '@aid-framework/ir';

import { annotationFor, className, moduleName } from '../names.js';
import { INDENT, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom, moduleBody } from '../template.js';
import type { EmittedFile } from './file.js';
import { BUSINESS_ROOT, business, GENERATED_ROOT, generated } from './file.js';
import { pythonDoc } from './text.js';

export const CONTRACTS_INIT_PATH = `${GENERATED_ROOT}/contracts/__init__.py`;
export const BUSINESS_TOOLS_INIT_PATH = `${BUSINESS_ROOT}/tools/__init__.py`;

export function contractsPath(toolId: string): string {
  return `${GENERATED_ROOT}/contracts/${moduleName(toolId)}.py`;
}

export function businessToolPath(symbol: string): string {
  return `${BUSINESS_ROOT}/tools/${symbol}.py`;
}

export function emitContractsInit(): EmittedFile {
  return generated(
    CONTRACTS_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The seam between generated wiring and hand-written tools: every tool the spec ' +
          'declares is called through the context on this module.',
      ),
      importBlock([
        [importFrom('collections.abc', ['Mapping']), importFrom('dataclasses', ['dataclass'])],
      ]),
      [
        '@dataclass(frozen=True, slots=True)',
        'class ToolContext:',
        pythonDoc(
          'What the generated adapter hands a tool: the wire name the model would call ' +
            'it by, and the validated arguments it would pass.',
          INDENT,
        ),
        `${INDENT}name: str`,
        `${INDENT}arguments: Mapping[str, object]`,
      ].join('\n'),
    ]),
  );
}

/** The seam's one signature, so the contract and the seed that implements it cannot drift. */
export interface ToolSignature {
  /** The `Protocol` the business module implements. */
  readonly protocol: string;
  /** The method the protocol declares. */
  readonly method: string;
  readonly request: string;
  readonly response: string;
  /** Declared structs the signature names, imported from `schemas`. */
  readonly imported: readonly string[];
}

/**
 * The tool's call signature.
 *
 * The method is `__call__` rather than the tool's name because the generated adapter
 * holds the implementation as a *callable* -- `await implementation(context, request)`
 * -- and a `Protocol` whose only member is some other name describes an object that
 * cannot be called at all. Naming it after the tool would leave `implementation(...)`
 * failing at run time with `TypeError: 'X' object is not callable`, on a signature the
 * type checker had already approved.
 */
export function toolSignature(tool: ToolShape): ToolSignature {
  const imported = new Set<string>();
  for (const ref of [tool.input, tool.output]) {
    if (ref.kind === 'named' && ref.resolved) imported.add(className(ref.name));
  }
  return {
    protocol: `${className(tool.id)}Tool`,
    method: '__call__',
    request: annotationFor(tool.input, false),
    response: annotationFor(tool.output, false),
    imported: [...imported].sort(),
  };
}

/** The repo-relative path of a tool's business seed, for a docstring. */
function businessToolRef(symbol: string): string {
  return businessToolPath(symbol).slice(BUSINESS_ROOT.length + 1);
}

/** The typed call the business module must implement for one tool. */
export function emitToolContract(tool: ToolShape): EmittedFile {
  const { protocol, method, request, response, imported } = toolSignature(tool);

  // The parameter schema is not repeated here. It is one long JSON object with no space
  // to break on, so it cannot be wrapped to the line budget, and pasting a copy would be
  // the second place the tool's arguments are declared. Its one home is `PARAMETERS` in
  // the generated adapter, which this docstring points at.
  const notes = [
    tool.description ?? `${tool.name} is declared by the spec with no description.`,
    `The adapter in ${GENERATED_ROOT}/tools/${moduleName(tool.id)}.py holds the parameter ` +
      `schema and validates the model's arguments into ${request} before calling, so an ` +
      `implementation never parses raw JSON.`,
  ].join(' ');

  const body = moduleBody([
    importBlock([
      [importFrom('typing', ['Protocol'])],
      [
        ...(imported.length === 0 ? [] : [importFrom('..schemas', imported)]),
        'from . import ToolContext',
      ],
    ]),
    [
      `class ${protocol}(Protocol):`,
      pythonDoc(notes, INDENT),
      '',
      `${INDENT}async def ${method}(self, ctx: ToolContext, req: ${request}) -> ${response}:`,
      pythonDoc('Run the tool. Raise any exception to fail the pipeline step.', INDENT + INDENT),
      `${INDENT}${INDENT}...`,
    ].join('\n'),
  ]);

  return generated(
    contractsPath(tool.id),
    assemble([
      HEADER,
      pythonDoc(
        `The call signature for the \`${tool.name}\` tool. Implement it in ` +
          `\`${businessToolRef(tool.handler.symbol ?? tool.name)}\`.`,
      ),
      body,
    ]),
  );
}

/**
 * The tool's business seed: written once, then owned by the developer.
 *
 * `docs/design.md` §8.4: the contract is generated, the implementation is written once
 * and never touched again. The stub raises rather than returning a placeholder, so a
 * project that never implements a tool fails loudly at the call rather than quietly
 * behaving as if the tool had succeeded.
 */
export function emitBusinessToolSeed(tool: ToolShape): EmittedFile {
  const symbol = tool.handler.symbol ?? tool.name;
  const { protocol, method, request, response, imported } = toolSignature(tool);
  const implementation = className(symbol);
  const contractsPackage = '...generated.contracts';
  const contractModule = `${contractsPackage}.${moduleName(tool.id)}`;

  return business(
    businessToolPath(symbol),
    assemble(
      [
        HEADER,
        pythonDoc(
          `The \`${tool.name}\` tool. The generator wrote this file once and never rewrites ` +
            'it: fill in the body, and regenerate freely.',
        ),
        importBlock([
          [
            // `ToolContext` lives in the contracts package, so the seed imports it from
            // there: re-exporting it through the contract submodule would be an implicit
            // re-export, which a strict consumer's `no_implicit_reexport` rejects.
            importFrom(contractsPackage, ['ToolContext']),
            importFrom(contractModule, [protocol]),
            ...(imported.length === 0 ? [] : [importFrom('...generated.schemas', imported)]),
          ],
        ]),
        [
          `class ${implementation}(${protocol}):`,
          pythonDoc(`The business implementation of \`${tool.name}\`.`, INDENT),
          '',
          `${INDENT}async def ${method}(self, ctx: ToolContext, req: ${request}) -> ${response}:`,
          pythonDoc(
            'The validated arguments are in `req`; `ctx` carries the wire name and the raw ' +
              'arguments the model passed.',
            INDENT + INDENT,
          ),
          `${INDENT}${INDENT}raise NotImplementedError(`,
          `${INDENT}${INDENT}${INDENT}${pythonString(`implement ${symbol} in ${businessToolRef(symbol)}`)},`,
          `${INDENT}${INDENT})`,
        ].join('\n'),
      ],
      'business',
    ),
  );
}
