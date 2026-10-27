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
import { isCompositeStep } from '@aid/ir';

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
import { streamedStepIndex, streams } from '../streaming.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import type { ResponseSource, StepBinding } from '../validate.js';
import { bindingOf, ITERATION_ITEM, renderNames, requestPlan, responsePlan } from '../validate.js';
import {
  ANONYMOUS_PRINCIPAL,
  childrenOf,
  DEPTH_KEY,
  hasBranch,
  hasComposite,
  hasFanOut,
  LIMITER_KEY,
  PRINCIPAL_KEY,
  REDUCED_KEY,
} from './control.js';
import { DEPS_BINDING } from './deps.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { hasGuardrails, stageGuardrails, stageTable } from './guardrails.js';
import { promptOf, scopeMap, structOf, toolOf, typeTable } from './ir.js';
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

/**
 * The Python function a step is emitted as.
 *
 * A composite binds no name of its own, so `names` supplies the module-unique function
 * name `compositeNames` assigned it; every other kind is named after what it binds.
 */
export function stepFunctionName(step: StepShape, names?: ReadonlyMap<StepShape, string>): string {
  return names?.get(step) ?? contextKey(bindingOf(step) ?? 'response');
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

/**
 * `PipelineContext(values=...)` for `_stream_request`, on one line when it fits and as an
 * exploded call otherwise.
 *
 * `mapping` sizes its output for the column it is handed, and on one line the brace sits
 * behind the whole `ctx = PipelineContext(values=` prefix -- not behind the indent. Passing
 * the indent alone therefore reports a seed as short enough while the line it lands on
 * overflows, which is exactly what a four-entry seed did. The two shapes measure different
 * columns because they are different plants: exploded, the brace follows `values=` on a
 * line of its own.
 */
function contextCall(
  pipeline: PipelineShape,
  deps: string,
  indent: string,
  prefix: string,
): string {
  const seed = contextSeed(pipeline, deps);
  const head = `${indent}${prefix}PipelineContext(`;
  const oneLine = `${head}values=${mapping(seed, ' '.repeat(head.length))})`;
  if (oneLine.length <= MAX_LINE) return oneLine;
  const inner = `${indent}${INDENT}`;
  const brace = inner.length + 'values='.length;
  return `${head}\n${inner}values=${mapping(seed, ' '.repeat(brace))}\n${indent})`;
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

/**
 * A reference path as Python reads it: context keys at the root, fields below it.
 *
 * `root` decides how the first segment is spelled, which is what lets a caller read a
 * binding straight out of the context (`ctx.require("x")`) instead of relying on a local.
 */
export function renderReference(
  path: readonly string[],
  root: (key: string) => string = contextKey,
): string {
  return path
    .map((segment, index) => (index === 0 ? root(contextKey(segment)) : fieldName(segment)))
    .join('.');
}

/**
 * The inputs a step declares.
 *
 * An `emit` step takes none and a `retrieve` step carries a query instead, so the
 * union cannot be indexed directly; every caller wants the same empty set for those
 * rather than a branch of its own. The composite kinds take no template input either:
 * `branch` and `parallel` are decided by their arms, and `map`/`reduce` name the list
 * they iterate in `over` -- a bare binding, not a template, so it is surfaced as the
 * reference it is rather than silently dropped.
 */
export function stepInputs(step: StepShape): Readonly<Record<string, StepInputValue>> {
  if (step.kind === 'emit' || step.kind === 'retrieve') return {};
  if (step.kind === 'branch' || step.kind === 'parallel') return {};
  if (step.kind === 'map' || step.kind === 'reduce') {
    return {
      over: { kind: 'reference', path: [step.over] },
      ...(step.kind === 'reduce'
        ? { prompt: { kind: 'template' as const, template: step.prompt } }
        : {}),
    };
  }
  // The wiring leaves carry scalar templates where a generate or tool step carries an
  // `input` map. `over` is the one bare binding among them; a `guard` at the retrieval
  // stage is a template holding one reference, so it needs no branch of its own.
  if (step.kind === 'rerank') {
    return {
      over: { kind: 'reference', path: [step.over] },
      query: { kind: 'template', template: step.query },
    };
  }
  if (step.kind === 'guard' || step.kind === 'agent') {
    return { text: { kind: 'template', template: step.text } };
  }
  return step.input;
}

/**
 * The roots a step reads, whether directly, inside a template, or through the retrieve
 * binding a generate step inlines.
 *
 * `step.context` is not an input key, so it has to be named here for the generated body
 * to open the local that holds the retrieved items: the rendered call reads them. A
 * `retrieve` step's query is interpolated the same way a template input is, so its
 * placeholders name roots too -- and unlike an input they are not reachable through
 * `stepInputs`, which is empty for that step kind. Omitting them emits a query that
 * reads a local the body never opened, which fails at request time rather than at build
 * time because nothing byte-compares a name against the scope it lands in.
 */
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
  if (step.kind === 'retrieve') {
    for (const name of templatePlaceholders(step.query)) add(name);
  }
  const retrieved = step.kind === 'generate' ? step.context : undefined;
  if (retrieved !== undefined) add(retrieved);
  for (const child of childrenOf(step)) {
    for (const name of referencedRoots(child)) add(name);
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
  readonly guardrails: Set<string>;
  readonly control: Set<string>;
  readonly agents: Set<string>;
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
  root?: (key: string) => string,
): string {
  if (value.kind === 'literal') {
    if (!asPromptValue) return pythonValue(value.value);
    return typeof value.value === 'string'
      ? pythonString(value.value)
      : `str(${pythonValue(value.value)})`;
  }
  if (value.kind === 'reference') {
    const reference = renderReference(value.path, root);
    if (!asPromptValue) return reference;
    return isStringRef(typeOfPath(value.path, context)) ? reference : `str(${reference})`;
  }
  const body = interpolate(value.template, (name) => {
    const path = name.split('.');
    const reference = renderReference(path, root);
    // An f-string converts through `__format__`, so the coercion is the `!s` flag rather
    // than a nested `str(...)` call: the same text, and one expression instead of two.
    return isStringRef(typeOfPath(path, context)) ? reference : `${reference}!s`;
  });
  return `f${pythonString(body)}`;
}

function promptValues(
  prompt: PromptShape,
  step: StepShape,
  context: ExpressionContext,
  root?: (key: string) => string,
): (readonly [string, string])[] {
  const inputs = stepInputs(step);
  // The retrieved context is not a step input. The runtime inlines the items a
  // `retrieve` step bound and the prompt reads their rendered form, so what the mapping
  // carries is the binding's `.context` rather than the binding itself.
  const retrieved = step.kind === 'generate' ? step.context : undefined;
  return sortedPairs(
    renderNames(prompt).map((name) => [
      name,
      retrieved !== undefined && name === retrieved
        ? `${renderReference([retrieved], root)}.context`
        : valueExpression(
            require(inputs[name], `an input for variable '${name}' of prompt '${prompt.id}'`),
            context,
            true,
            root,
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
 * `deps` is read by every step that calls the runtime through it; a `guard` step reads no
 * container at all -- it hands one declaration and one payload to the engine -- so it asks
 * for no such local rather than opening one the generated body would never use. The rest
 * are the roots the step actually refers to, so a step body never names a value it does
 * not use.
 */
function localLines(
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
  withDeps = true,
): string[] {
  const lines: string[] = [];
  if (withDeps) {
    lines.push(`${DEPS_BINDING} = cast(Deps, ctx.require(${pythonString(DEPS_BINDING)}))`);
  }
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
  if (lines.length > 0) imports.typing.add('cast');
  return lines;
}

/**
 * The check one stage runs, or `undefined` when the spec declares no guardrail for it.
 *
 * Every declared `input` guardrail runs on every HTTP `generate` route: the IR attaches
 * a guardrail to a prompt or an agent and gives a pipeline no field for one, so there is
 * no per-pipeline subset to honour (see `emit/guardrails.ts`).
 */
function guardrailCheck(
  ir: IR,
  stage: 'input' | 'output',
  imports: StepImports,
  value: string,
): string | undefined {
  if (stageGuardrails(ir, stage).length === 0) return undefined;
  const table = stageTable(stage);
  for (const name of ['ENGINE', 'enforce_guardrail', table]) imports.guardrails.add(name);
  return `enforce_guardrail(ENGINE.check_${stage}(${table}, ${value}))`;
}

/** The closure that makes one gateway call, so a retry re-sends rather than re-renders. */
function callClosure(
  alias: string,
  params: readonly (readonly [string, string])[],
  hasFallbacks: boolean,
  outputCheck: string | undefined,
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
  // Checking the reply here is what stops a caller parsing it unchecked: `_call` is the
  // only place a completion is read.
  if (outputCheck === undefined) {
    lines.push(`${inner}return _response.text`);
  } else {
    lines.push(`${inner}_verdict = ${outputCheck}`);
    lines.push(`${inner}return _verdict.text`);
  }
  return lines;
}

function emitGenerateStep(
  ir: IR,
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
  bodyName?: string,
): string {
  const prompt = require(step.kind === 'generate'
    ? promptOf(ir, step.prompt)
    : undefined, 'a prompt for a generate step');
  const alias = step.kind === 'generate' ? step.model : '';
  /* A `reduce` synthesizes a generate step of its own, which is not one of the spec's
   * steps and so has no entry in the composite name map; its function name is handed in.
   * The binding it writes is still the one its `as` names: two reduce composites in one
   * pipeline would otherwise collide on the module-level definition, but the runtime
   * collects a fixed key per item, so the binding cannot be renamed without breaking it. */
  const key = stepFunctionName(step);
  const fn = bodyName ?? key;
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
  const outputCheck = guardrailCheck(ir, 'output', imports, '_response.text');
  const lines = [`async def ${fn}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(
    pythonDoc(
      `Run prompt \`${prompt.id}\` v${promptVersion(prompt.version)} on model \`${alias}\`.`,
      INDENT,
    ),
  );
  lines.push(...localLines(step, context, imports, request).map((line) => `${INDENT}${line}`));
  lines.push('');
  lines.push(...callClosure(pythonString(alias), params, hasFallbacks, outputCheck));
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
  // The `input` stage's payload is `{"text": text}`, so the check sees exactly what the
  // model is about to be sent, and the model is sent `_verdict.text`: a `redact` action
  // that only reported would leave the payload untouched.
  const inputCheck = guardrailCheck(ir, 'input', imports, '_rendered.text');
  const text = inputCheck === undefined ? '_rendered.text' : '_verdict.text';
  if (inputCheck !== undefined) lines.push(`${INDENT}_verdict = ${inputCheck}`);
  if (schema !== undefined && schema.kind === 'named') {
    imports.runtime.add('run_structured');
    imports.schemas.add(className(schema.name));
    lines.push(
      callStatement(
        `${key} = await `,
        'run_structured',
        ['_call', className(schema.name), text],
        INDENT,
      ),
    );
  } else {
    lines.push(callStatement(`${key} = await `, '_call', [text], INDENT));
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
  bodyName?: string,
): string {
  const tool = require(step.kind === 'tool'
    ? toolOf(ir, step.tool)
    : undefined, 'a tool for a tool step');
  const key = stepFunctionName(step);
  /* A nested step takes the position-qualified name the composite map assigned
   * it; the binding it writes stays the one its `as` names. */
  const fn = bodyName ?? key;
  const inner = INDENT + INDENT;
  const arguments_ = sortedPairs(
    Object.entries(stepInputs(step)).map(([name, value]) => [
      name,
      valueExpression(value, context, false),
    ]),
  );
  // The `tool-call` stage's payload is the tool's own arguments, so the check sees the
  // values about to be sent and the call is made with `_verdict.arguments`: a `redact`
  // action on a tool argument has to change the argument, not just the log line.
  const toolGuard = stageGuardrails(ir, 'tool-call').length > 0;
  let callArguments = mapping(arguments_, inner);

  imports.runtime.add('PipelineContext');
  imports.runtime.add('Pipeline');
  imports.runtime.add('ToolCall');
  const lines = [`async def ${fn}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(pythonDoc(`Call tool \`${tool.id}\` and bind what it returns.`, INDENT));
  lines.push(...localLines(step, context, imports, request).map((line) => `${INDENT}${line}`));
  lines.push('');
  if (toolGuard) {
    const table = stageTable('tool-call');
    for (const name of ['ENGINE', 'enforce_guardrail', table]) imports.guardrails.add(name);
    lines.push(
      callStatement(
        '_verdict = ',
        'enforce_guardrail',
        [call('ENGINE.check_tool_call', [table, pythonString(tool.id), callArguments], inner)],
        INDENT,
      ),
    );
    // `GuardrailVerdict.arguments` is a `Mapping` and `ToolCall.arguments` is a `dict`: a
    // copy keeps the redaction while satisfying the call, which mypy checks on the emitted
    // tree. This branch is only reachable once some guardrail declares the `tool-call` stage.
    callArguments = 'dict(_verdict.arguments)';
  }
  lines.push(
    callStatement(
      '_outcome = await ',
      `${DEPS_BINDING}.tools.execute`,
      [
        call(
          'ToolCall',
          [
            `arguments=${callArguments}`,
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

function emitRetrieveStep(
  ir: IR,
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
  bodyName?: string,
): string {
  const retrieverId = require(step.kind === 'retrieve'
    ? step.retriever
    : undefined, 'a retriever for a retrieve step');
  const retriever = require(ir.retrievers.find(
    (entry) => entry.id === retrieverId,
  ), `the '${retrieverId}' retriever a retrieve step names`);
  const key = stepFunctionName(step);
  /* A nested step takes the position-qualified name the composite map assigned
   * it; the binding it writes stays the one its `as` names. */
  const fn = bodyName ?? key;
  // The query is interpolated per request, so it is rendered as the f-string the
  // runtime's `PipelineContext.require` can fill in; the validator has already checked
  // that every placeholder names a value the step body holds.
  const query = valueExpression(
    { kind: 'template', template: step.kind === 'retrieve' ? step.query : '' },
    context,
    false,
  );

  imports.runtime.add('PipelineContext');
  imports.runtime.add('Pipeline');
  const lines = [`async def ${fn}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(
    pythonDoc(`Search the \`${retriever.id}\` index and bind the cited passages.`, INDENT),
  );
  lines.push(...localLines(step, context, imports, request).map((line) => `${INDENT}${line}`));
  lines.push('');
  lines.push(
    callStatement(
      `${key} = await `,
      `${DEPS_BINDING}.retriever(${pythonString(retriever.id)}).retrieve`,
      [query],
      INDENT,
    ),
  );
  lines.push(`${INDENT}return ctx.with_values(${key}=${key})`);
  return lines.join('\n');
}

/** The engine method one guard stage calls. `tool-call` is absent: a step has no tool. */
const GUARD_METHODS = {
  input: 'check_input',
  output: 'check_output',
  retrieval: 'check_retrieval',
} as const;

type GuardShape = Extract<StepShape, { kind: 'guard' }>;

/**
 * The payload a guard step hands the engine.
 *
 * The engine takes a *sequence* of declarations and filters it by stage, so a step
 * resolves the one it names through `BY_ID` into a one-element tuple. A guardrail whose
 * `stages` omit the step's stage would otherwise be a silent no-op -- the step would
 * appear to check something it never ran -- which is why the plan gate refuses that
 * pairing instead of emitting it.
 *
 * What `text` means depends on the stage. At `input` and `output` it is a template
 * rendered against the pipeline's bindings, and the engine reads `{"text": ...}`. At
 * `retrieval` it names the retrieval binding whose passages are guarded, and the step
 * projects `item.chunk.text` over its items: that stage guards the text a model would be
 * handed, so it takes strings and not the result object.
 */
function guardPayload(step: GuardShape, context: ExpressionContext): string {
  if (step.stage !== 'retrieval') {
    return valueExpression({ kind: 'template', template: step.text }, context, false);
  }
  const [placeholder = ''] = templatePlaceholders(step.text);
  return `[item.chunk.text for item in ${contextKey(placeholder)}.items]`;
}

/**
 * A guard step: run one declared guardrail at one stage, over one payload.
 *
 * It binds nothing. A step that decides and passes the context on is the whole of what a
 * pipeline does with a `block`: the engine raises, the runtime wraps that as a
 * `PipelineError`, and the route answers 400. Nothing here inspects the verdict, because
 * the verdict a caller may ignore is exactly the one it must not.
 */
function emitGuardStep(
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
  bodyName?: string,
): string {
  const guard = require(step.kind === 'guard' ? step : undefined, 'a guard step');
  const method = require(guard.stage === 'tool-call'
    ? undefined
    : GUARD_METHODS[guard.stage], 'an emitter for a guard step at the tool-call stage');
  const fn = bodyName ?? stepFunctionName(step);
  imports.runtime.add('PipelineContext');
  for (const name of ['BY_ID', 'ENGINE', 'enforce_guardrail']) imports.guardrails.add(name);
  const lines = [`async def ${fn}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(
    pythonDoc(
      `Run the \`${guard.guardrail}\` guardrail at the \`${guard.stage}\` stage, and pass ` +
        'the context on: a guardrail that allows the payload has nothing to bind.',
      INDENT,
    ),
  );
  const locals = localLines(step, context, imports, request, false);
  if (locals.length > 0) lines.push(...locals.map((line) => `${INDENT}${line}`), '');
  // Bound to a name before the call at every stage: a rendered template or the retrieval
  // projection can each run longer than the emitted code's line limit, and the payload is
  // the part of that call a reader most needs to see whole.
  lines.push(`${INDENT}_payload = ${guardPayload(guard, context)}`, '');
  const check = call(
    `ENGINE.${method}`,
    [`(BY_ID[${pythonString(guard.guardrail)}],)`, '_payload'],
    INDENT,
  );
  lines.push(callStatement('', 'enforce_guardrail', [check], INDENT));
  lines.push(`${INDENT}return ctx`);
  return lines.join('\n');
}

/**
 * A rerank step: score the passages a retrieval binding holds against a query, and bind
 * the reordered result.
 *
 * `rerank` returns a tuple of items, not a result, so the step rescored through
 * `model_copy` keeps the provenance the retrieval established -- the retriever, the
 * query, what the retrieval stage recorded -- and replaces only the order. A caller that
 * compares `len(ranked)` to `len(handbook)` gets the truth, and a later `retrieve`-style
 * consumer still finds `.items` where it expects it.
 *
 * The model selects the scorer through the container, so an app cannot run a scorer it
 * never built and a test can hand the step a scorer of its own.
 */
function emitRerankStep(
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
  bodyName?: string,
): string {
  const rerank = require(step.kind === 'rerank' ? step : undefined, 'a rerank step');
  const key = contextKey(rerank.as);
  const over = contextKey(rerank.over);
  const fn = bodyName ?? stepFunctionName(step);
  const query = valueExpression({ kind: 'template', template: rerank.query }, context, false);
  const topN = pythonNumber(rerank.topN);
  imports.runtime.add('PipelineContext');
  const lines = [`async def ${fn}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(
    pythonDoc(
      `Rescore the \`${rerank.over}\` passages with the \`${rerank.model}\` reranker and ` +
        `bind the top ${topN}, keeping the provenance the retrieval established.`,
      INDENT,
    ),
  );
  lines.push(...localLines(step, context, imports, request).map((line) => `${INDENT}${line}`));
  lines.push('');
  lines.push(
    callStatement(
      '_scored = await ',
      `${DEPS_BINDING}.reranker(${pythonString(rerank.model)}, ${topN}).rerank`,
      [query, `${over}.items`, `top_n=${topN}`],
      INDENT,
    ),
  );
  lines.push(`${INDENT}${key} = ${over}.model_copy(update={"items": _scored})`);
  lines.push(`${INDENT}return ctx.with_values(${key}=${key})`);
  return lines.join('\n');
}

/**
 * An agent step: run one declared agent over a rendered text, and bind its answer.
 *
 * The run is its own: no thread is carried in and none is continued, because a pipeline
 * step has no conversation to continue and the plan gate refuses an agent target that
 * declares `memory`. The runtime is built over the pipeline's own gateway, so the tokens
 * this run spends are metered by the same ledger the rest of the request draws from.
 *
 * A run that did not complete is not an answer. `PAUSED` cannot arrive here -- the gate
 * refuses an agent target that can pause, so the four stages of `humanInTheLoop` stay the
 * route's business and `escalate` never becomes a second pause -- but `MAX_STEPS` can, and
 * binding an empty answer as though the agent had spoken would be the failure that hides.
 */
function emitAgentStep(
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
  bodyName?: string,
): string {
  const agent = require(step.kind === 'agent' ? step : undefined, 'an agent step');
  const key = contextKey(agent.as);
  const fn = bodyName ?? stepFunctionName(step);
  const text = valueExpression({ kind: 'template', template: agent.text }, context, false);
  imports.runtime.add('PipelineContext');
  imports.agents.add('build_runtime');
  const lines = [`async def ${fn}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(
    pythonDoc(
      `Run the \`${agent.agent}\` agent over the rendered text and bind its answer.`,
      INDENT,
    ),
  );
  lines.push(...localLines(step, context, imports, request).map((line) => `${INDENT}${line}`));
  lines.push('');
  lines.push(
    callStatement(
      '_runtime = ',
      'build_runtime',
      [`gateway=${DEPS_BINDING}.gateway`, `tools=${DEPS_BINDING}.agent_tools`],
      INDENT,
    ),
  );
  lines.push(
    callStatement('_outcome = await ', '_runtime.run', [pythonString(agent.agent), text], INDENT),
  );
  lines.push(`${INDENT}if not _outcome.completed:`);
  lines.push(
    `${INDENT}${INDENT}raise RuntimeError(` +
      `f"agent ${agent.agent} did not complete: {_outcome.status}")`,
  );
  lines.push(`${INDENT}${key} = _outcome.answer`);
  lines.push(`${INDENT}return ctx.with_values(${key}=${key})`);
  return lines.join('\n');
}

/**
 * The Python function name of every step a composite nests, plus every step that binds
 * no name of its own.
 *
 * A `branch` and a `parallel` bind no name, so `stepFunctionName` has nothing to call
 * them after, and `Pipeline.of` refuses two steps with one name -- a pipeline holding two
 * branches would collide on the second. A `guard` binds nothing for the same reason a
 * composite does not: it decides and passes the context on, it does not contribute a
 * value, so two guards in one pipeline would both fall back to the same name and the
 * second `def` would shadow the first. A nested step *does* bind a name, but two arms of
 * one branch may bind the same one (the validator accepts arms with identical key sets),
 * and Python's module scope is flat, so binding names alone would emit two `def escalation`
 * where the second shadows the first and both arms run it. Every nested step therefore
 * takes a position-qualified name, `<composite>_<arm>_<index>_<binding>`.
 *
 * The leading underscore is a spelling the validator already refuses for a user binding,
 * so these names cannot shadow one, and numbering them by position keeps the output a
 * function of the IR alone. Composites share one counter and a binding-less leaf counts
 * among its own kind, so a pipeline that gains a `guard` renumbers nothing that already
 * had a name.
 */
export function compositeNames(pipeline: PipelineShape): Map<StepShape, string> {
  const names = new Map<StepShape, string>();
  let composites = 0;
  const leaves = new Map<string, number>();
  const unique = (step: StepShape, name: string): string => {
    names.set(step, name);
    return name;
  };
  const nested = (steps: readonly StepShape[], prefix: string): void => {
    steps.forEach((step, index) => {
      const own = unique(
        step,
        `${prefix}_${index + 1}_${contextKey(bindingOf(step) ?? step.kind)}`,
      );
      if (isCompositeStep(step)) arms(step, own);
    });
  };
  const arms = (step: StepShape, prefix: string): void => {
    if (step.kind === 'branch') {
      nested(step.then, `${prefix}_then`);
      nested(step.else, `${prefix}_else`);
    } else if (step.kind === 'parallel') {
      for (const [index, arm] of step.branches.entries()) nested(arm, `${prefix}_arm_${index + 1}`);
    } else if (step.kind === 'map') {
      nested([step.step], `${prefix}_body`);
    }
  };
  for (const step of pipeline.steps ?? []) {
    if (step.kind === 'emit') continue;
    if (isCompositeStep(step)) {
      composites += 1;
      arms(step, unique(step, `_${step.kind}_${composites}`));
      continue;
    }
    if (bindingOf(step) !== undefined) continue;
    // A binding-less leaf is numbered among its own kind, so launching one cannot move a
    // composite's name; composites share one counter, as they always have.
    const next = (leaves.get(step.kind) ?? 0) + 1;
    leaves.set(step.kind, next);
    unique(step, `_${step.kind}_${next}`);
  }
  return names;
}

/** What emitting one pipeline module needs to know that is not per-step. */
interface PipelineEmitter {
  readonly ir: IR;
  readonly names: ReadonlyMap<StepShape, string>;
  readonly scopes: ReadonlyMap<StepShape, StepBinding[]>;
  readonly types: Map<string, TypeShape>;
  readonly eventFields: ReadonlyMap<string, TypeRef>;
  readonly imports: StepImports;
  readonly request: string;
}

function contextOf(emitter: PipelineEmitter, step: StepShape): ExpressionContext {
  return {
    types: emitter.types,
    scope: emitter.scopes.get(step) ?? [],
    eventFields: emitter.eventFields,
  };
}

/** The pipeline a composite arm runs, as the callable the runtime is handed. */
function pipelineCall(
  steps: readonly StepShape[],
  names: ReadonlyMap<StepShape, string>,
  indent: string,
): string {
  return call(
    'Pipeline.of',
    steps.map((step) => stepFunctionName(step, names)),
    indent,
  );
}

/** A list literal of expressions, wrapped when it does not fit the line budget. */
function expressionList(items: readonly string[], indent: string, prefixLength = 0): string {
  if (items.length === 0) return '[]';
  const oneLine = `[${items.join(', ')}]`;
  // `prefixLength` is the keyword the list is assigned to (`branches=`), which sits in
  // front of the bracket on the one-line form and is absent once the list moves to lines
  // of its own. Measuring without it lets a list that is short against the indent alone
  // overflow the line it is actually written on.
  const inline = !items.some((item) => item.includes('\n'));
  if (inline && indent.length + prefixLength + oneLine.length <= MAX_LINE) return oneLine;
  const deeper = indent + INDENT;
  return `[\n${items.map((item) => `${deeper}${item},`).join('\n')}\n${indent}]`;
}

/**
 * The values a context starts with, before a pipeline's first step runs.
 *
 * `deps` and `event` are what a flat pipeline has always needed. A composite needs three
 * more, and only a composite: the principal a `branch` is evaluated against, the one
 * limiter a fan-out draws from, and the nesting depth it is at. Seeding them only when
 * this pipeline actually has one keeps every other generated route byte-identical to what
 * it was before this layer -- and keeps a principal out of an app that never branches,
 * where its presence would suggest an authorization decision the app does not make.
 *
 * `ANONYMOUS_PRINCIPAL` is *unauthenticated* on purpose. `Principal()` defaults
 * `authenticated` to true, so seeding a bare `Principal()` would make every
 * `isAuthenticated()` predicate vacuously true and send every caller down `then`. A
 * generated app has no auth layer of its own, so the closed answer is the honest one.
 */
function contextSeed(pipeline: PipelineShape, deps: string): [string, string][] {
  const values: [string, string][] = [
    [DEPS_BINDING, deps],
    [EVENT_BINDING, EVENT_BINDING],
  ];
  if (!hasComposite([pipeline])) return values;
  if (hasBranch([pipeline])) values.push([PRINCIPAL_KEY, ANONYMOUS_PRINCIPAL]);
  if (hasFanOut([pipeline])) values.push([LIMITER_KEY, `${deps}.limiter`]);
  values.push([DEPTH_KEY, '0']);
  return values;
}

/**
 * One composite step, as the callable that hands the runtime its arms.
 *
 * The factory call is assigned and then awaited rather than written as
 * `await branch(...)(ctx)`: a call of a call is the one place `ruff format` disagrees
 * with a hand-laid-out argument list, and the generated tree is compared byte for byte.
 *
 * The body opens no locals. Every arm is its own step function, so it opens the locals it
 * needs; the enclosing body only passes the context through. The roots an arm reaches still
 * have to reach the request model, and `requestPlan` walking the arms is what does that --
 * a composite reading `event.subject` would otherwise reject a body the model had never
 * heard of. The `referencedRoots` recursion is not the mechanism: it is total over all
 * eight kinds, but has no live caller for a composite wrapper, which opens no locals.
 */
function emitCompositeSteps(emitter: PipelineEmitter, step: StepShape): string[] {
  const { ir, names, imports } = emitter;
  const name = require(names.get(step), 'a function name for a composite step');
  const inner = INDENT + INDENT;
  imports.runtime.add('Pipeline');
  imports.runtime.add('PipelineContext');
  imports.control.add('MAX_STEP_DEPTH');
  const common = ['max_depth=MAX_STEP_DEPTH', `name=${pythonString(name)}`];
  let doc: string;
  let callee: string;
  let args: string[];
  const extra: string[] = [];

  if (step.kind === 'branch') {
    imports.runtime.add('branch');
    doc =
      "Run the arm the caller's principal selects. `when` is evaluated against the " +
      'principal and nothing else, so the predicate answers who is asking rather than ' +
      'what an earlier step produced.';
    callee = 'branch';
    args = [
      `when=${pythonValue(step.when, inner)}`,
      `then=${pipelineCall(step.then, names, inner)}`,
      ...(step.else.length > 0 ? [`otherwise=${pipelineCall(step.else, names, inner)}`] : []),
      ...common,
    ];
  } else if (step.kind === 'parallel') {
    imports.runtime.add('parallel');
    doc =
      `Run all ${step.branches.length} arms concurrently under the deployment's single ` +
      'concurrency cap, then merge what they bound in branch order.';
    callee = 'parallel';
    args = [
      // `+ 1` is the separator `call` appends after every argument when it explodes the
      // call, which lands on this line too: without it a list measured at exactly the
      // width is emitted one column over.
      `branches=${expressionList(
        step.branches.map((arm) => pipelineCall(arm, names, inner + INDENT)),
        inner,
        'branches='.length + 1,
      )}`,
      ...common,
    ];
  } else if (step.kind === 'map') {
    imports.runtime.add('map_step');
    doc =
      `Run the body once per item of \`${step.over}\` under the concurrency cap and bind ` +
      `the results, in the item's own order, as \`${step.as}\`.`;
    callee = 'map_step';
    args = [
      `over=${pythonString(contextKey(step.over))}`,
      `as_=${pythonString(contextKey(step.as))}`,
      `step=${pipelineCall([step.step], names, inner)}`,
      ...common,
    ];
  } else if (step.kind === 'reduce') {
    imports.runtime.add('reduce_step');
    const prompt = require(promptOf(
      ir,
      step.prompt,
    ), `the '${step.prompt}' prompt a reduce step names`);
    doc =
      `Render prompt \`${prompt.id}\` once per item of \`${step.over}\` under the ` +
      `concurrency cap and bind the replies, in the item's own order, as \`${step.as}\`.`;
    // A `reduce` has no step of its own to run, so it gets one: a generate step whose only
    // input is the iteration item. Composing it from the same emitter the spec's own
    // generate steps use is what keeps the guardrails, the structured-output path and the
    // request settings identical between the two -- and `reduced` is the binding the
    // runtime's `reduce` collects, in place of a name the body would have chosen.
    const variable = require(prompt
      .variables[0], `the single variable of the '${prompt.id}' prompt a reduce step names`).name;
    const body: StepShape = {
      kind: 'generate',
      prompt: prompt.id,
      model: step.model,
      as: REDUCED_KEY,
      input: { [variable]: { kind: 'reference', path: [ITERATION_ITEM] } },
    };
    const bodyName = `${name}_item`;
    extra.push(
      emitGenerateStep(ir, body, contextOf(emitter, step), imports, emitter.request, bodyName),
    );
    callee = 'reduce_step';
    args = [
      `over=${pythonString(contextKey(step.over))}`,
      `as_=${pythonString(contextKey(step.as))}`,
      `step=Pipeline.of(${bodyName})`,
      ...common,
    ];
  } else {
    return [];
  }

  const lines = [`async def ${name}(ctx: PipelineContext) -> PipelineContext:`];
  lines.push(pythonDoc(doc, INDENT));
  lines.push(callStatement('_step = ', callee, args, INDENT));
  lines.push(`${INDENT}return await _step(ctx)`);
  return [lines.join('\n'), ...extra];
}

/**
 * The request an SSE route streams from.
 *
 * The route cannot reuse the pipeline: `Pipeline.run` collects one value per step, so it
 * cannot return until the last step has, which is the wait a stream exists to remove. It
 * cannot reuse the step's `_call` either, because that awaits `generate`. So this function
 * *is* the pipeline without its generate step: it runs the same leading step functions,
 * in the same order, then builds the request from the same rendered prompt. Calling the
 * step functions rather than re-implementing them is what keeps the tool-call and
 * retrieval guardrails enforced on the streaming path exactly as on the JSON path -- a
 * re-implementation would be a second, unguarded copy of every leading step.
 *
 * The `input` guardrail runs *here*, before a byte is returned, so a refusal is a real
 * 4xx rather than a stream that closes early.
 */
function emitStreamRequest(
  ir: IR,
  pipeline: PipelineShape,
  index: number,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
): string {
  const entry = (pipeline.steps ?? [])[index];
  const step = require(entry?.kind === 'generate' ? entry : undefined, 'a streamed generate step');
  const prompt = require(promptOf(ir, step.prompt), 'a prompt for a streamed generate step');
  const alias = step.model;
  const params = requestArgs(prompt.params);
  imports.runtime.add('PipelineContext');
  imports.runtime.add('CompletionRequest');
  if (params.length > 0) imports.runtime.add('Message');
  const leading = (pipeline.steps ?? []).slice(0, index).filter((entry) => entry.kind !== 'emit');
  // Inline when it fits: ruff format leaves a signature under the line limit on one line,
  // and a generated file that the example's own `ruff format --check` would rewrite is a
  // drift failure rather than a style preference. When it does not fit, the trailing comma
  // selects ruff's exploded form, which puts *one parameter per line* -- two parameters on
  // one line is itself a shape ruff rewrites, so the fallback has to match it exactly.
  const signature =
    `async def _stream_request(${DEPS_BINDING}: Deps, ${EVENT_BINDING}: ${request})` +
    ' -> tuple[str, CompletionRequest]:';
  const lines = [
    ...(signature.length <= MAX_LINE
      ? [signature]
      : [
          'async def _stream_request(',
          `${INDENT}${DEPS_BINDING}: Deps,`,
          `${INDENT}${EVENT_BINDING}: ${request},`,
          ') -> tuple[str, CompletionRequest]:',
        ]),
  ];
  lines.push(
    pythonDoc(
      `Build the \`${alias}\` request for prompt \`${prompt.id}\` without sending it, after ` +
        "running the steps that come before it. A stream can only carry the model's own " +
        'text, so everything the pipeline does before the model call still has to happen ' +
        'first; the non-streaming route reaches this point through the pipeline and this ' +
        'route reaches it directly.',
      INDENT,
    ),
  );
  lines.push(contextCall(pipeline, DEPS_BINDING, INDENT, 'ctx = '));
  if (hasComposite([pipeline])) {
    imports.control.add('MAX_STEP_DEPTH');
    if (hasBranch([pipeline])) imports.control.add(ANONYMOUS_PRINCIPAL);
  }
  const names = compositeNames(pipeline);
  for (const entry of leading) {
    lines.push(`${INDENT}ctx = await ${stepFunctionName(entry, names)}(ctx)`);
  }
  // No locals, and so no `localLines`. The step functions of this module are named
  // after their bindings, so a local for binding `handbook` would shadow the function
  // `handbook` this body calls above -- and because Python scopes a name for the whole
  // function, the call would raise before the assignment. Reading each binding out of
  // the context instead keeps the two name spaces apart.
  const fromContext = (key: string): string =>
    key === EVENT_BINDING || key === DEPS_BINDING ? key : `ctx.require(${pythonString(key)})`;
  lines.push('');
  lines.push(
    callStatement(
      '_rendered = ',
      `${DEPS_BINDING}.prompts.render`,
      [
        pythonString(prompt.id),
        `version=${pythonString(promptVersion(prompt.version))}`,
        `values=${mapping(promptValues(prompt, step, context, fromContext), INDENT + INDENT)}`,
      ],
      INDENT,
    ),
  );
  const inputCheck = guardrailCheck(ir, 'input', imports, '_rendered.text');
  const text = inputCheck === undefined ? '_rendered.text' : '_verdict.text';
  if (inputCheck !== undefined) lines.push(`${INDENT}_verdict = ${inputCheck}`);
  if (params.length === 0) {
    lines.push(`${INDENT}_request = CompletionRequest.prompt(${text})`);
  } else {
    lines.push(
      callStatement(
        '_request = ',
        'CompletionRequest',
        sortedPairs([['messages', `(Message.user(${text}),)`], ...params]).map(
          ([name, value]) => `${name}=${value}`,
        ),
        INDENT,
      ),
    );
  }
  lines.push(`${INDENT}return ${pythonString(alias)}, _request`);
  return lines.join('\n');
}

/**
 * The definition of one step that is not a composite.
 *
 * A composite is expanded before its arms get here, and an `emit` step is the response
 * itself and is skipped by the walk, so the remaining kinds are the leaves that bind a
 * value: the ones that call a model, an index, a tool or an agent, and the `guard` that
 * binds nothing. A kind that reached the default would be a step this emitter does not
 * know, which after a clean plan check is a generator bug rather than a spec problem.
 */
function stepBlock(
  ir: IR,
  step: StepShape,
  context: ExpressionContext,
  imports: StepImports,
  request: string,
  bodyName: string | undefined,
): string {
  switch (step.kind) {
    case 'generate':
      return emitGenerateStep(ir, step, context, imports, request, bodyName);
    case 'retrieve':
      return emitRetrieveStep(ir, step, context, imports, request, bodyName);
    case 'tool':
      return emitToolStep(ir, step, context, imports, request, bodyName);
    case 'rerank':
      return emitRerankStep(step, context, imports, request, bodyName);
    case 'guard':
      return emitGuardStep(step, context, imports, request, bodyName);
    case 'agent':
      return emitAgentStep(step, context, imports, request, bodyName);
    default:
      return require<string>(undefined, `an emitter for a ${step.kind} step`);
  }
}

/** What one pipeline module's steps are emitted against, gathered once. */
function emitterFor(ir: IR, pipeline: PipelineShape): PipelineEmitter {
  return {
    ir,
    names: compositeNames(pipeline),
    scopes: scopeMap(pipeline, ir),
    types: typeTable(ir),
    eventFields: eventFieldsOf(ir, pipeline),
    imports: {
      runtime: new Set<string>(),
      schemas: new Set<string>(),
      typing: new Set<string>(),
      json: new Set<string>(),
      gateway: new Set<string>(),
      guardrails: new Set<string>(),
      control: new Set<string>(),
      agents: new Set<string>(),
    },
    request: requestModelName(pipeline.id),
  };
}

export function emitPipeline(ir: IR, pipeline: PipelineShape): EmittedFile {
  const emitter = emitterFor(ir, pipeline);
  const { scopes, imports, request, names } = emitter;
  const blocks: string[] = [];

  /* Composites nest: an arm is a step list that may itself hold a composite, down to the
   * depth the spec gate enforces. Every step in the tree becomes its own function, so the
   * walk is recursive and children are emitted before the composite that names them --
   * a module that referenced an arm it never defined would fail at import time. */
  const emitSteps = (steps: readonly StepShape[]): void => {
    for (const step of steps) {
      if (step.kind === 'emit') continue;
      if (isCompositeStep(step)) {
        emitSteps(childrenOf(step));
        blocks.push(...emitCompositeSteps(emitter, step));
        continue;
      }
      const context: ExpressionContext = {
        types: emitter.types,
        scope: scopes.get(step) ?? [],
        eventFields: emitter.eventFields,
      };
      // A nested step is defined under its position-qualified name; a top-level one keeps
      // its binding name, which is what the name map leaves unmapped.
      const bodyName = names.get(step);
      blocks.push(stepBlock(ir, step, context, imports, request, bodyName));
    }
  };
  emitSteps(pipeline.steps ?? []);
  const streamedIndex = streams(ir, pipeline) ? streamedStepIndex(pipeline) : undefined;
  if (streamedIndex !== undefined) {
    const entry = (pipeline.steps ?? [])[streamedIndex];
    const context: ExpressionContext = {
      types: emitter.types,
      scope: (entry === undefined ? undefined : scopes.get(entry)) ?? [],
      eventFields: emitter.eventFields,
    };
    blocks.push(emitStreamRequest(ir, pipeline, streamedIndex, context, imports, request));
  }

  const steps = (pipeline.steps ?? []).filter((step) => step.kind !== 'emit');
  const factory = [
    `def ${factoryName(pipeline.id)}() -> Pipeline:`,
    pythonDoc(`The \`${pipeline.id}\` pipeline, in the order the spec declares it.`, INDENT),
    `${INDENT}return Pipeline.of(${steps.map((step) => stepFunctionName(step, names)).join(', ')})`,
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
      ...(imports.guardrails.size > 0
        ? [importFrom('..guardrails', [...imports.guardrails].sort(byName))]
        : []),
      ...(imports.control.size > 0
        ? [importFrom('..control', [...imports.control].sort(byName))]
        : []),
      ...(imports.agents.size > 0
        ? [importFrom('..agents', [...imports.agents].sort(byName))]
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
  const scopes = scopeMap(pipeline, ir);
  const steps = pipeline.steps ?? [];
  const emitIndex = steps.findIndex((step) => step.kind === 'emit');
  const emitStep = steps[emitIndex];
  const eventType = require(emitStep?.kind === 'emit'
    ? emitStep.event
    : undefined, `an emit step for pipeline '${pipeline.id}'`);
  const plans = responsePlan(
    (emitStep === undefined ? undefined : scopes.get(emitStep)) ?? [],
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
    [mapping(contextSeed(pipeline, DEPS_BINDING), INDENT + INDENT + INDENT)],
    INDENT + INDENT,
  );
  const servesStreams = streams(ir, pipeline);
  const guarded = hasGuardrails(ir);

  // A blocked step is not a downstream failure: the app asked the guardrail and the
  // guardrail said no, so it is a 400. `Pipeline.run` wraps every step exception in a
  // `PipelineError`, which is why the block is dug back out of the cause chain rather
  // than caught directly -- the 502 below is the honest answer for everything else.
  const failed = guarded
    ? [
        `${INDENT}except PipelineError as exc:`,
        `${INDENT}${INDENT}_blocked = guardrail_block(exc)`,
        `${INDENT}${INDENT}if _blocked is not None:`,
        `${INDENT}${INDENT}${INDENT}raise HTTPException(` +
          'status_code=400, detail=str(_blocked)) from exc',
        `${INDENT}${INDENT}raise HTTPException(status_code=502, detail=str(exc)) from exc`,
      ]
    : [
        `${INDENT}except PipelineError as exc:`,
        `${INDENT}${INDENT}raise HTTPException(status_code=502, detail=str(exc)) from exc`,
      ];

  // `Accept: text/event-stream` on the same path, because a second route would be a
  // second description of one endpoint's contract. `_stream_request` runs the steps
  // before the generate step and then applies the input guardrail, all before the
  // response object exists, so a refusal is a 4xx and not a truncated stream.
  const streamed = servesStreams
    ? [
        `${INDENT}if wants_event_stream(request):`,
        `${INDENT}${INDENT}try:`,
        callStatement(
          '_alias, _request = await ',
          '_stream_request',
          [DEPS_BINDING, EVENT_BINDING],
          INDENT + INDENT + INDENT,
        ),
        `${INDENT}${INDENT}except GuardrailBlockedError as exc:`,
        `${INDENT}${INDENT}${INDENT}raise HTTPException(` +
          'status_code=400, detail=str(exc)) from exc',
        callStatement(
          'return ',
          'StreamingResponse',
          [`${DEPS_BINDING}.gateway.stream(_alias, _request)`, 'media_type=EVENT_STREAM'],
          INDENT + INDENT,
        ),
      ]
    : [];

  const handlerLines = [
    `async def ${handler}(`,
    `${INDENT}event: ${requestModelName(pipeline.id)},`,
    ...(servesStreams ? [`${INDENT}request: Request,`] : []),
    `${INDENT}${DEPS_BINDING}: Annotated[Deps, Depends(get_deps)],`,
    `) -> ${servesStreams ? `${response} | Response` : response}:`,
    pythonDoc(
      `Run pipeline \`${pipeline.id}\`. A failing step is a 502 rather than a 500, because ` +
        'the failure is in a downstream model or tool, not in this request.' +
        (guarded
          ? ' A step a guardrail stopped is a 400 instead, because nothing downstream failed.'
          : '') +
        (servesStreams
          ? " A request that accepts `text/event-stream` is answered with the model's " +
            'deltas as SSE frames instead of waiting for the whole reply.'
          : ''),
      INDENT,
    ),
    ...streamed,
    `${INDENT}try:`,
    run,
    ...failed,
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
          importFrom('fastapi', [
            'APIRouter',
            'Depends',
            'HTTPException',
            ...(servesStreams ? ['Request', 'Response'] : []),
          ]),
          ...(servesStreams ? [importFrom('fastapi.responses', ['StreamingResponse'])] : []),
          importFrom('aid_runtime', [
            'PipelineError',
            ...(servesStreams ? ['GuardrailBlockedError'] : []),
          ]),
        ],
        [
          ...(hasBranch([pipeline]) ? [importFrom('..control', [ANONYMOUS_PRINCIPAL])] : []),
          importFrom('..deps', ['Deps', 'get_deps']),
          ...(guarded ? [importFrom('..guardrails', ['guardrail_block'])] : []),
          ...(servesStreams ? [importFrom('..sse', ['EVENT_STREAM', 'wants_event_stream'])] : []),
          importFrom(`..pipelines.${moduleName(pipeline.id)}`, [
            factoryName(pipeline.id),
            ...(servesStreams ? ['_stream_request'] : []),
          ]),
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
