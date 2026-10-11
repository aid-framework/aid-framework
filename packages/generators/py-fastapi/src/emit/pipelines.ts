/**
 * The generated request models, pipeline modules, and HTTP routers.
 *
 * A pipeline becomes one module under `pipelines/` holding one async function per step
 * plus a factory that chains them, and one module under `routes/` holding the FastAPI
 * router that enters it. Splitting the two means the pipeline can be run by a test
 * without FastAPI at all -- which is what the generated eval does.
 *
 * Every generated step is thin glue: it reads the values it was given out of the
 * context, calls the runtime, and writes one binding back. Everything a reader cares
 * about -- what a prompt says, what a tool does -- lives in a prompt module and in
 * `business/`, so regenerating this file cannot lose behaviour.
 *
 * The request model is *derived* rather than declared. The IR gives no type for the
 * `event` root, so the fields of the body a route accepts are exactly the fields some
 * step reads off `event`, typed by the prompt variable, tool argument or emitted field
 * that reads them (`requestPlan`). That is what keeps the emitted code a function of
 * the IR alone: there is nowhere else for a request shape to come from.
 */

import type {
  IR,
  ModelParams,
  PipelineShape,
  PromptShape,
  StepInputValue,
  StepShape,
  TypeRef,
  TypeShape,
} from '@aid/ir';

import { annotationFor, className, fieldName, moduleName } from '../names.js';
import { interpolate, templatePlaceholders } from '../placeholders.js';
import {
  INDENT,
  MAX_LINE,
  pythonNumber,
  pythonString,
  pythonTuple,
  pythonValue,
} from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import type { ResponseSource, StepBinding } from '../validate.js';
import { bindingOf, renderNames, requestPlan, responsePlan } from '../validate.js';
import { DEPS_BINDING } from './deps.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { promptOf, scopesOf, structOf, toolOf, typeTable } from './ir.js';
import { orderedPipelines } from './order.js';
import { promptVersion } from './prompts.js';
import { require } from './require.js';
import { pythonDoc } from './text.js';

export const REQUESTS_PATH = `${GENERATED_ROOT}/requests.py`;
export const PIPELINES_INIT_PATH = `${GENERATED_ROOT}/pipelines/__init__.py`;
export const ROUTES_INIT_PATH = `${GENERATED_ROOT}/routes/__init__.py`;

/** The context key the request event travels under; reserved against user bindings. */
const EVENT_BINDING = 'event';

export function pipelinePath(pipelineId: string): string {
  return `${GENERATED_ROOT}/pipelines/${moduleName(pipelineId)}.py`;
}

export function routePath(pipelineId: string): string {
  return `${GENERATED_ROOT}/routes/${moduleName(pipelineId)}.py`;
}

/** The model a route accepts, derived from the pipeline's own uses of `event`. */
export function requestModelName(pipelineId: string): string {
  return `${className(pipelineId)}Request`;
}

/** The factory a route calls to get the pipeline it runs. */
export function factoryName(pipelineId: string): string {
  return `${moduleName(pipelineId)}_pipeline`;
}

/** The router object the app mounts. */
export function routerName(pipelineId: string): string {
  return `${moduleName(pipelineId)}_router`;
}

/** The Python name a binding is carried under, both in the context and as a local. */
export function contextKey(name: string): string {
  return moduleName(name);
}

export function stepFunctionName(step: StepShape): string {
  return contextKey(bindingOf(step) ?? 'response');
}

function byName(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * A call, wrapped when it does not fit the line budget.
 *
 * `indent` is the column the closing parenthesis belongs at and the arguments go one
 * level deeper, so a literal nested as an argument is laid out by the same rule as one
 * standing on its own. `prefixLength` is what the caller puts before the call on the
 * same line, which the budget has to account for.
 */
function call(callee: string, args: readonly string[], indent: string, prefixLength = 0): string {
  if (args.length === 0) return `${callee}()`;
  const oneLine = `${callee}(${args.join(', ')})`;
  const inline = !args.some((arg) => arg.includes('\n'));
  if (inline && indent.length + prefixLength + oneLine.length <= MAX_LINE) return oneLine;
  const inner = indent + INDENT;
  return `${callee}(\n${args.map((arg) => `${inner}${arg},`).join('\n')}\n${indent})`;
}

/** A statement whose value is a call, measured with the prefix it is assigned to. */
function callStatement(
  prefix: string,
  callee: string,
  args: readonly string[],
  indent: string,
): string {
  return `${indent}${prefix}${call(callee, args, indent, prefix.length)}`;
}

function mapping(pairs: readonly (readonly [string, string])[], indent: string): string {
  if (pairs.length === 0) return '{}';
  const entries = pairs.map(([key, value]) => `${pythonString(key)}: ${value}`);
  const oneLine = `{${entries.join(', ')}}`;
  const inline = !entries.some((entry) => entry.includes('\n'));
  if (inline && indent.length + oneLine.length <= MAX_LINE) return oneLine;
  const inner = indent + INDENT;
  return `{\n${entries.map((entry) => `${inner}${entry},`).join('\n')}\n${indent}}`;
}

function sortedPairs(pairs: readonly (readonly [string, string])[]): (readonly [string, string])[] {
  return [...pairs].sort((left, right) => byName(left[0], right[0]));
}

/** A reference path as Python reads it: context keys at the root, fields below it. */
export function renderReference(path: readonly string[]): string {
  return path
    .map((segment, index) => (index === 0 ? contextKey(segment) : fieldName(segment)))
    .join('.');
}

/**
 * The inputs a step declares.
 *
 * An `emit` step takes none, so the union cannot be indexed directly; every caller
 * wants the same empty set for those rather than a branch of its own.
 */
export function stepInputs(step: StepShape): Readonly<Record<string, StepInputValue>> {
  return step.kind === 'emit' ? {} : step.input;
}

/** The roots a step reads, whether directly or inside a template. */
export function referencedRoots(step: StepShape): string[] {
  const roots: string[] = [];
  const add = (name: string): void => {
    const root = name.split('.')[0] ?? '';
    if (root === '' || roots.includes(root)) return;
    roots.push(root);
  };
  for (const value of Object.values(stepInputs(step))) {
    if (value.kind === 'reference') add(value.path[0] ?? '');
    else if (value.kind === 'template') {
      for (const name of templatePlaceholders(value.template)) add(name);
    }
  }
  return roots.sort(byName);
}

/** The request model's own field types, the only typing `event` has. */
function eventFieldsOf(ir: IR, pipeline: PipelineShape): Map<string, TypeRef> {
  return new Map(requestPlan(ir, pipeline).fields.map((field) => [field.name, field.type]));
}

interface ExpressionContext {
  readonly types: Map<string, TypeShape>;
  readonly scope: readonly StepBinding[];
  readonly eventFields: ReadonlyMap<string, TypeRef>;
}

/**
 * The type of the value a reference path names, walked through the declared structs.
 *
 * Without `eventFields` a field of the request event would look untyped, and every
 * value handed to a prompt would be converted with `str` instead of only the ones that
 * are not already text.
 */
export function typeOfPath(
  path: readonly string[],
  context: ExpressionContext,
): TypeRef | undefined {
  const [root, ...rest] = path;
  if (root === undefined) return undefined;
  if (contextKey(root) === EVENT_BINDING) {
    const [head, ...tail] = rest;
    return walk(context.eventFields.get(head ?? ''), tail, context.types);
  }
  const declared = context.scope.find((binding) => binding.name === root)?.type;
  return walk(declared, rest, context.types);
}

function walk(
  ref: TypeRef | undefined,
  segments: readonly string[],
  types: Map<string, TypeShape>,
): TypeRef | undefined {
  let current = ref;
  for (const segment of segments) {
    current = structOf(current, types)?.fields.find((field) => field.name === segment)?.type;
  }
  return current;
}

/** Whether a value is known to be a `str`, so a prompt needs no conversion for it. */
function isStringRef(ref: TypeRef | undefined): boolean {
  return ref !== undefined && !ref.list && ref.kind === 'primitive' && ref.name === 'string';
}

interface StepImports {
  readonly runtime: Set<string>;
  readonly schemas: Set<string>;
  readonly typing: Set<string>;
  readonly json: Set<string>;
  readonly gateway: Set<string>;
}

/**
 * A step input as a Python expression.
 *
 * `asPromptValue` reflects that the prompt registry takes `Mapping[str, str]`: a value
 * that is not provably text is converted, so an integer request field reaches a prompt
 * as text rather than as a type error. A tool argument is not converted, because the
 * declared type is what the tool is entitled to receive.
 */
function valueExpression(
  value: StepInputValue,
  context: ExpressionContext,
  asPromptValue: boolean,
): string {
  if (value.kind === 'literal') {
    if (!asPromptValue) return pythonValue(value.value);
    return typeof value.value === 'string'
      ? pythonString(value.value)
      : `str(${pythonValue(value.value)})`;
  }
  if (value.kind === 'reference') {
    const reference = renderReference(value.path);
    if (!asPromptValue) return reference;
    return isStringRef(typeOfPath(value.path, context)) ? reference : `str(${reference})`;
  }
  const body = interpolate(value.template, (name) => {
    const path = name.split('.');
    const reference = renderReference(path);
    return isStringRef(typeOfPath(path, context)) ? reference : `str(${reference})`;
  });
  return `f${pythonString(body)}`;
}

function promptValues(
  prompt: PromptShape,
  step: StepShape,
  context: ExpressionContext,
): (readonly [string, string])[] {
  const inputs = stepInputs(step);
  return sortedPairs(
    renderNames(prompt).map((name) => [
      name,
      valueExpression(
        require(inputs[name], `an input for variable '${name}' of prompt '${prompt.id}'`),
        context,
        true,
      ),
    ]),
  );
}

/** The request settings the runtime can carry, alphabetically for stable output. */
export function requestArgs(params: ModelParams | undefined): (readonly [string, string])[] {
  const args: (readonly [string, string])[] = [];
  if (params?.maxTokens !== undefined) {
    args.push(['max_output_tokens', pythonNumber(params.maxTokens)]);
  }
  if (params?.temperature !== undefined) {
    args.push(['temperature', pythonNumber(params.temperature)]);
  }
  if (params?.stop !== undefined && params.stop.length > 0) {
    args.push(['stop', pythonTuple(params.stop.map((entry) => pythonString(entry)))]);
  }
  return args.sort((left, right) => byName(left[0], right[0]));
}

function localLine(key: string, ref: TypeRef | undefined, imports: StepImports): string {
  const expression = `ctx.require(${pythonString(key)})`;
  const castTo =
    ref !== undefined && ref.kind === 'named' && !ref.list ? className(ref.name) : undefined;
  if (castTo === undefined) return `${key} = ${expression}`;
  imports.typing.add('cast');
  imports.schemas.add(castTo);
  return `${key} = cast(${castTo}, ${expression})`;
}

/**
 * The locals a step body opens with.
 *
 * `deps` is always read, because every step calls the runtime through it; the rest are
 * the roots the step actually refers to, so a step body never names a value it does
 * not use.
 */
function localLines(
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
): string[] {
  imports.typing.add('cast');
  const lines = [`${DEPS_BINDING} = cast(Deps, ctx.require(${pythonString(DEPS_BINDING)}))`];
  for (const root of referencedRoots(step)) {
    const key = contextKey(root);
    if (key === DEPS_BINDING) continue;
    if (key === EVENT_BINDING) {
      lines.push(`${key} = cast(${request}, ctx.require(${pythonString(EVENT_BINDING)}))`);
      continue;
    }
    const binding = context.scope.find((candidate) => candidate.name === root);
    lines.push(localLine(key, binding?.type, imports));
  }
  return lines;
}

/** The closure that makes one gateway call, so a retry re-sends rather than re-renders. */
function callClosure(
  alias: string,
  params: readonly (readonly [string, string])[],
  hasFallbacks: boolean,
): string[] {
  const inner = INDENT + INDENT;
  const lines = [`${INDENT}async def _call(text: str) -> str:`];
  lines.push(pythonDoc('Ask the model for one completion.', inner));
  if (params.length === 0) {
    lines.push(`${inner}_request = CompletionRequest.prompt(text)`);
  } else {
    lines.push(
      callStatement(
        '_request = ',
        'CompletionRequest',
        sortedPairs([['messages', '(Message.user(text),)'], ...params]).map(
          ([name, value]) => `${name}=${value}`,
        ),
        inner,
      ),
    );
  }
  // The runtime defaults `fallbacks` to empty, so passing it is only honest when the
  // spec gave the model a chain; otherwise the argument would name an empty mapping.
  const arguments_ = [alias, '_request'];
  if (hasFallbacks) arguments_.push(`fallbacks=FALLBACKS.get(${alias}, ())`);
  lines.push(callStatement('_response = await ', 'deps.gateway.generate', arguments_, inner));
  lines.push(`${inner}return _response.text`);
  return lines;
}

function emitGenerateStep(
  ir: IR,
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
): string {
  const prompt = require(step.kind === 'generate'
    ? promptOf(ir, step.prompt)
    : undefined, 'a prompt for a generate step');
  const alias = step.kind === 'generate' ? step.model : '';
  const key = stepFunctionName(step);
  // The validator refuses a structured output whose schema is not a declared struct,
  // because the runtime's structured path parses into a Pydantic model.
  const schema = prompt.output.kind === 'structured' ? prompt.output.schema : undefined;
  const params = requestArgs(prompt.params);

  imports.runtime.add('PipelineContext');
  imports.runtime.add('CompletionRequest');
  imports.runtime.add('Pipeline');
  // `Message.user` only appears when the model's request carries the prompt as a message
  // list rather than as a rendered string.
  if (params.length > 0) imports.runtime.add('Message');
  const hasFallbacks = (ir.models.find((model) => model.id === alias)?.fallbacks ?? []).length > 0;
  if (hasFallbacks) imports.gateway.add('FALLBACKS');
  const lines = [`async def ${key}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(
    pythonDoc(
      `Run prompt \`${prompt.id}\` v${promptVersion(prompt.version)} on model \`${alias}\`.`,
      INDENT,
    ),
  );
  lines.push(...localLines(step, context, imports, request).map((line) => `${INDENT}${line}`));
  lines.push('');
  lines.push(...callClosure(pythonString(alias), params, hasFallbacks));
  lines.push('');
  lines.push(
    callStatement(
      '_rendered = ',
      'deps.prompts.render',
      [
        pythonString(prompt.id),
        `version=${pythonString(promptVersion(prompt.version))}`,
        `values=${mapping(promptValues(prompt, step, context), INDENT + INDENT)}`,
      ],
      INDENT,
    ),
  );
  if (schema !== undefined && schema.kind === 'named') {
    imports.runtime.add('run_structured');
    imports.schemas.add(className(schema.name));
    lines.push(
      callStatement(
        `${key} = await `,
        'run_structured',
        ['_call', className(schema.name), '_rendered.text'],
        INDENT,
      ),
    );
  } else {
    lines.push(callStatement(`${key} = await `, '_call', ['_rendered.text'], INDENT));
  }
  lines.push(`${INDENT}return ctx.with_values(${key}=${key})`);
  return lines.join('\n');
}

function emitToolStep(
  ir: IR,
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
): string {
  const tool = require(step.kind === 'tool'
    ? toolOf(ir, step.tool)
    : undefined, 'a tool for a tool step');
  const key = stepFunctionName(step);
  const inner = INDENT + INDENT;
  const arguments_ = sortedPairs(
    Object.entries(stepInputs(step)).map(([name, value]) => [
      name,
      valueExpression(value, context, false),
    ]),
  );

  imports.runtime.add('PipelineContext');
  imports.runtime.add('Pipeline');
  imports.runtime.add('ToolCall');
  const lines = [`async def ${key}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(pythonDoc(`Call tool \`${tool.id}\` and bind what it returns.`, INDENT));
  lines.push(...localLines(step, context, imports, request).map((line) => `${INDENT}${line}`));
  lines.push('');
  lines.push(
    callStatement(
      '_outcome = await ',
      `${DEPS_BINDING}.tools.execute`,
      [
        call(
          'ToolCall',
          [
            `arguments=${mapping(arguments_, inner)}`,
            `id=${pythonString(key)}`,
            `name=${pythonString(tool.name)}`,
          ],
          inner,
          INDENT.length,
        ),
      ],
      INDENT,
    ),
  );
  lines.push(`${INDENT}if _outcome.is_error:`);
  lines.push(
    `${INDENT}${INDENT}raise RuntimeError(f${pythonString(
      `tool ${tool.name} failed: {_outcome.content}`,
    )})`,
  );
  const ref = tool.output;
  if (ref !== undefined && ref.kind === 'named' && !ref.list) {
    imports.schemas.add(className(ref.name));
    lines.push(`${INDENT}${key} = ${className(ref.name)}.model_validate_json(_outcome.content)`);
  } else {
    imports.json.add('loads');
    lines.push(`${INDENT}${key} = loads(_outcome.content)`);
  }
  lines.push(`${INDENT}return ctx.with_values(${key}=${key})`);
  return lines.join('\n');
}

export function emitPipeline(ir: IR, pipeline: PipelineShape): EmittedFile {
  const types = typeTable(ir);
  const scopes = scopesOf(pipeline, ir);
  const request = requestModelName(pipeline.id);
  const eventFields = eventFieldsOf(ir, pipeline);
  const imports: StepImports = {
    runtime: new Set<string>(),
    schemas: new Set<string>(),
    typing: new Set<string>(),
    json: new Set<string>(),
    gateway: new Set<string>(),
  };
  const blocks: string[] = [];
  (pipeline.steps ?? []).forEach((step, index) => {
    if (step.kind === 'emit') return;
    const context: ExpressionContext = { types, scope: scopes[index] ?? [], eventFields };
    blocks.push(
      step.kind === 'generate'
        ? emitGenerateStep(ir, step, context, imports, request)
        : emitToolStep(ir, step, context, imports, request),
    );
  });

  const steps = (pipeline.steps ?? []).filter((step) => step.kind !== 'emit');
  const factory = [
    `def ${factoryName(pipeline.id)}() -> Pipeline:`,
    pythonDoc(`The \`${pipeline.id}\` pipeline, in the order the spec declares it.`, INDENT),
    `${INDENT}return Pipeline.of(${steps.map((step) => stepFunctionName(step)).join(', ')})`,
  ].join('\n');

  const stdlib: string[] = [];
  if (imports.json.size > 0) stdlib.push(importFrom('json', [...imports.json].sort(byName)));
  if (imports.typing.size > 0) stdlib.push(importFrom('typing', [...imports.typing].sort(byName)));
  const headers = importBlock([
    stdlib,
    imports.runtime.size > 0 ? [importFrom('aid_runtime', [...imports.runtime].sort(byName))] : [],
    [
      importFrom(`..${'deps'}`, ['Deps']),
      importFrom('..requests', [request]),
      ...(imports.schemas.size > 0
        ? [importFrom('..schemas', [...imports.schemas].sort(byName))]
        : []),
      ...(imports.gateway.size > 0
        ? [importFrom('..gateway.models', [...imports.gateway].sort(byName))]
        : []),
    ],
  ]);

  return generated(
    pipelinePath(pipeline.id),
    assemble([
      HEADER,
      pythonDoc(`Pipeline \`${pipeline.id}\`, generated from the spec. Do not edit.`),
      headers,
      ...blocks,
      factory,
    ]),
  );
}

function httpPipelines(ir: IR): PipelineShape[] {
  return orderedPipelines(ir).filter((pipeline) => pipeline.trigger?.kind === 'http');
}

export function emitPipelinesInit(ir: IR): EmittedFile {
  const pipelines = orderedPipelines(ir);
  const imports = pipelines.map(
    (pipeline) => `from .${moduleName(pipeline.id)} import ${factoryName(pipeline.id)}`,
  );
  const exports = pipelines.map((pipeline) => pythonString(factoryName(pipeline.id)));
  return generated(
    PIPELINES_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc('Every pipeline the spec declares, under the name the app calls it by.'),
      imports.join('\n'),
      `__all__ = [${exports.join(', ')}]`,
    ]),
  );
}

/**
 * The request models, one per HTTP pipeline.
 *
 * Every field is required: a step reads it off `event` and hands it to a prompt or a
 * tool declared to take it, so a request that omitted it would fail inside a step
 * rather than at the edge where a 422 belongs.
 */
export function emitRequests(ir: IR): EmittedFile {
  const names = new Set<string>();
  const classes = httpPipelines(ir).map((pipeline) => {
    const plan = requestPlan(ir, pipeline);
    for (const field of plan.fields) {
      if (field.type.kind === 'named') names.add(className(field.type.name));
    }
    const trigger = pipeline.trigger;
    const method = trigger?.kind === 'http' ? trigger.method.toUpperCase() : '';
    const path = trigger?.kind === 'http' ? trigger.path : '';
    const lines = [`class ${requestModelName(pipeline.id)}(BaseModel):`];
    lines.push(pythonDoc(`The request body of \`${method} ${path}\`.`, INDENT));
    for (const field of plan.fields) {
      lines.push(`${INDENT}${fieldName(field.name)}: ${annotationFor(field.type, false)}`);
    }
    return lines.join('\n');
  });
  const blocks: string[] = [
    HEADER,
    pythonDoc('The request bodies the app accepts, derived from what each pipeline reads.'),
    importFrom('pydantic', ['BaseModel']),
  ];
  if (names.size > 0) blocks.push(importFrom('.schemas', [...names]));
  return generated(REQUESTS_PATH, assemble([...blocks, ...classes]));
}

/** The expression that fills one field of the response, read back out of the context. */
function responseValue(source: ResponseSource): string {
  const [root = '', name = ''] = source.path;
  const attribute = fieldName(name);
  if (contextKey(root) === EVENT_BINDING) return `${EVENT_BINDING}.${attribute}`;
  return `context.require(${pythonString(contextKey(root))}).${attribute}`;
}

export function emitRoute(ir: IR, pipeline: PipelineShape): EmittedFile {
  const types = typeTable(ir);
  const scopes = scopesOf(pipeline, ir);
  const steps = pipeline.steps ?? [];
  const emitIndex = steps.findIndex((step) => step.kind === 'emit');
  const emitStep = steps[emitIndex];
  const eventType = require(emitStep?.kind === 'emit'
    ? emitStep.event
    : undefined, `an emit step for pipeline '${pipeline.id}'`);
  const plans = responsePlan(
    scopes[emitIndex] ?? [],
    eventType,
    types,
    `pipelines.${pipeline.id}.steps[${emitIndex}]`,
  );
  const trigger = pipeline.trigger;
  const method = trigger?.kind === 'http' ? trigger.method.toLowerCase() : '';
  const path = trigger?.kind === 'http' ? trigger.path : '';
  const router = routerName(pipeline.id);
  const handler = `${moduleName(pipeline.id)}_endpoint`;
  const response = className(eventType);
  const fields = sortedPairs(
    plans.sources.map((source) => [fieldName(source.field), responseValue(source)]),
  );
  const run = callStatement(
    'context = await ',
    `${factoryName(pipeline.id)}().run`,
    [
      mapping(
        [
          [DEPS_BINDING, DEPS_BINDING],
          [EVENT_BINDING, EVENT_BINDING],
        ],
        INDENT + INDENT + INDENT,
      ),
    ],
    INDENT + INDENT,
  );

  const handlerLines = [
    `async def ${handler}(`,
    `${INDENT}event: ${requestModelName(pipeline.id)},`,
    `${INDENT}${DEPS_BINDING}: Annotated[Deps, Depends(get_deps)],`,
    `) -> ${response}:`,
    pythonDoc(
      `Run pipeline \`${pipeline.id}\`. A failing step is a 502 rather than a 500, because ` +
        'the failure is in a downstream model or tool, not in this request.',
      INDENT,
    ),
    `${INDENT}try:`,
    run,
    `${INDENT}except PipelineError as exc:`,
    `${INDENT}${INDENT}raise HTTPException(status_code=502, detail=str(exc)) from exc`,
    callStatement(
      'return ',
      response,
      fields.map(([name, value]) => `${name}=${value}`),
      INDENT,
    ),
  ];

  return generated(
    routePath(pipeline.id),
    assemble([
      HEADER,
      pythonDoc(`The \`${method.toUpperCase()} ${path}\` route of pipeline \`${pipeline.id}\`.`),
      importBlock([
        [importFrom('typing', ['Annotated'])],
        [
          importFrom('fastapi', ['APIRouter', 'Depends', 'HTTPException']),
          importFrom('aid_runtime', ['PipelineError']),
        ],
        [
          importFrom('..deps', ['Deps', 'get_deps']),
          importFrom(`..pipelines.${moduleName(pipeline.id)}`, [factoryName(pipeline.id)]),
          importFrom('..requests', [requestModelName(pipeline.id)]),
          importFrom('..schemas', [response]),
        ],
      ]),
      `${router} = APIRouter()`,
      `@${router}.${method}(${pythonString(path)}, response_model=${response})`,
      handlerLines.join('\n'),
    ]),
  );
}

export function emitRoutesInit(ir: IR): EmittedFile {
  const pipelines = httpPipelines(ir);
  const imports = pipelines.map(
    (pipeline) => `from .${moduleName(pipeline.id)} import ${routerName(pipeline.id)}`,
  );
  const exports = pipelines.map((pipeline) => pythonString(routerName(pipeline.id)));
  return generated(
    ROUTES_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc('Every HTTP route the spec declares.'),
      imports.join('\n'),
      `__all__ = [${exports.join(', ')}]`,
    ]),
  );
}

/** Every generated file the pipelines, their requests and their routes account for. */
export function emitPipelines(ir: IR): EmittedFile[] {
  return [
    emitRequests(ir),
    ...orderedPipelines(ir).map((pipeline) => emitPipeline(ir, pipeline)),
    emitPipelinesInit(ir),
    ...httpPipelines(ir).map((pipeline) => emitRoute(ir, pipeline)),
    emitRoutesInit(ir),
  ];
}
