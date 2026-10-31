/**
 * `generated/pipelines/*` and `generated/routes/*`.
 *
 * A pipeline is plain sequential async code, because that is what Phase 1 emits: no
 * graph engine, no scheduler. Each step is a named `Step` that returns a new
 * `PipelineContext`, so the step names survive into tracing and the values each step
 * binds are readable in a diff.
 *
 * A route is deliberately *not* a Next.js module. It is a small
 * `(request) => { status, body }` function, and the example's hand-written
 * `app/api/<path>/route.ts` is the adapter that turns it into what Next serves. That
 * split is forced by the ownership model: a path under `app/api` has no owner, so
 * emitting it would break `validatePlan` and the next `aid gen`. See the README.
 */

import type {
  AgentStep,
  BranchStep,
  GenerateStep,
  GuardStep,
  IR,
  MapStep,
  ParallelStep,
  PipelineShape,
  ReduceStep,
  RerankStep,
  StepInput,
  StepInputValue,
  StepShape,
  ToolStep,
  TypeField,
} from '@aid-framework/ir';
import { TsVercelPlanError } from '../errors.js';
import { className, literal, memberAccess, propertyKey, toSnakeCase } from '../names.js';
import { problem, stepUnsupported } from '../validate.js';
import { type EmittedFile, generated, paths, pipelinePath, routePath } from './file.js';
import { stageTable, usesStage } from './guardrails.js';
import { requestTypeName } from './schemas.js';
import {
  type Entry,
  exportStatement,
  fits,
  type ImportName,
  importStatement,
  moduleText,
  objectLiteral,
  sortedNames,
} from './text.js';

/** `packages/ir`'s barrel does not re-export this one, so it is derived from the union. */
type RetrieveStep = Extract<StepShape, { kind: 'retrieve' }>;

/**
 * How one binding is read out of the pipeline context.
 *
 * `event` is the one binding that is a real local in every emitted step; every other name
 * lives in the pipeline context, so it is read back through `require` rather than emitted
 * as an identifier that would not resolve. That is also what makes a composite body able
 * to read the `item` its iteration seeded.
 *
 * `require` is typed `unknown`, so a *dotted* read has to cast to the binding's declared
 * type to compile at all. Casting to the declared type rather than to `any` is what makes
 * a field the spec does not declare a compile error in the emitted application instead of
 * `undefined` at run time.
 */
function readBinding(head: string, tail: string, types?: ReadonlyMap<string, string>): string {
  if (head === 'event') return `event${tail}`;
  const base = `context.require(${literal(head)})`;
  if (tail.length === 0) return base;
  const type = types?.get(head);
  return type === undefined ? `${base}${tail}` : `(${base} as ${type})${tail}`;
}

/** Render one `StepInputValue` as a TypeScript expression. */
function valueExpression(value: StepInputValue, types?: ReadonlyMap<string, string>): string {
  if (value.kind === 'literal') return literal(value.value);
  if (value.kind === 'reference') {
    const [head, ...rest] = value.path;
    if (head === undefined) return 'undefined';
    return readBinding(head, rest.map((part) => memberAccess(part)).join(''), types);
  }
  return templateToTs(value.template);
}

/**
 * Turn an IR interpolation template into a TypeScript template literal.
 *
 * `{{ event.subject }}` becomes `${event.subject}`. The two forms use different
 * delimiters on purpose: the IR's spelling is language-neutral, and rewriting it at
 * emit time is the whole job of the target.
 *
 * `resolve` decides what a reference becomes. A prompt's template names its *variables*,
 * which `generateStepModule` binds as object-literal keys, so the default is a bare
 * identifier. A guard step's, a rerank step's and an agent step's template name pipeline
 * *bindings* instead, and those are read back through `context.require` -- see
 * `contextTemplate`.
 */
export function templateToTs(
  template: string,
  resolve: (path: readonly string[]) => string = (path) => path.map(propertyKey).join('.'),
): string {
  const parts: string[] = [];
  let index = 0;
  while (index < template.length) {
    const open = template.indexOf('{{', index);
    if (open === -1) {
      parts.push(escapeLiteral(template.slice(index)));
      break;
    }
    parts.push(escapeLiteral(template.slice(index, open)));
    const close = template.indexOf('}}', open + 2);
    if (close === -1) {
      parts.push(escapeLiteral(template.slice(open)));
      break;
    }
    const path = template
      .slice(open + 2, close)
      .trim()
      .split('.')
      .map((part) => part.trim());
    parts.push(`\${${resolve(path)}}`);
    index = close + 2;
  }
  return `\`${parts.join('')}\``;
}

/**
 * The same rendering for a template that names pipeline bindings.
 *
 * `{{ handbook }}` becomes `${context.require('handbook')}`, matching what
 * `valueExpression` does for a `reference` StepInputValue. `event` stays a bare local
 * because it is the one binding every emitted step receives as an argument.
 */
export function contextTemplate(template: string, types?: ReadonlyMap<string, string>): string {
  return templateToTs(template, (path) => {
    const [head, ...rest] = path;
    if (head === undefined) return 'undefined';
    return readBinding(head, rest.map((part) => memberAccess(part)).join(''), types);
  });
}

/** The first binding a template names, which is how a `retrieval` guard finds its input. */
export function firstReference(template: string): string | undefined {
  const open = template.indexOf('{{');
  if (open === -1) return undefined;
  const close = template.indexOf('}}', open + 2);
  if (close === -1) return undefined;
  const [head] = template
    .slice(open + 2, close)
    .trim()
    .split('.');
  return head?.trim();
}

function escapeLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * A step this target emits as its own `Step` function.
 *
 * `emit` is not one: it declares which value the answer is and the route reads that
 * binding, so it renders no code. The composite kinds are emitted, but not by the six
 * leaf emitters below -- they wrap the runtime's helpers and are built by
 * `compositeStepModule`.
 */
type LeafStep = GenerateStep | RetrieveStep | ToolStep | RerankStep | GuardStep | AgentStep;

function isLeafStep(step: StepShape): step is LeafStep {
  return (
    step.kind === 'generate' ||
    step.kind === 'retrieve' ||
    step.kind === 'tool' ||
    step.kind === 'rerank' ||
    step.kind === 'guard' ||
    step.kind === 'agent'
  );
}

/** The leaf steps that bind a value: every leaf but `guard`, which only refuses. */
type BindingLeaf = Exclude<LeafStep, GuardStep>;

function isBindingLeaf(step: StepShape): step is BindingLeaf {
  return isLeafStep(step) && step.kind !== 'guard';
}

/**
 * A step that binds a value a later step or the route can read.
 *
 * This is what "the answer" means to the route: the last step that adds a binding. The
 * composites are the reason the question has to be asked of the shape rather than of the
 * kind -- `map` and `reduce` bind, `branch`, `parallel` and `guard` bind nothing, and a
 * `branch` whose arms end in a `generate` binds only what that arm bound.
 */
type BindingStep = BindingLeaf | MapStep | ReduceStep;

function isBindingStep(step: StepShape): step is BindingStep {
  return isBindingLeaf(step) || step.kind === 'map' || step.kind === 'reduce';
}

/**
 * One step's place in a pipeline, as the segments that make its name unique.
 *
 * The segments are the step's own index at the top level, plus the position inside every
 * composite it sits in: `['2', 'then', '0']` is the first step of the third step's `then`
 * arm. Indices rather than ids because two steps may legally bind the same name in two
 * different arms -- `Pipeline` scopes a binding to its own pipeline -- and the emitter
 * cannot, so position is the only thing guaranteed unique.
 */
type StepPath = readonly string[];

/**
 * The module-level constant one step is emitted as.
 *
 * A top-level binding step keeps the name it had before composites existed
 * (`<pipeline><Binding>Step`), so the emitted tree does not churn; everything else -- a
 * nested step, and a step that binds nothing -- carries its path instead.
 */
function stepConstant(pipeline: PipelineShape, step: StepShape, path: StepPath): string {
  const suffix = isBindingStep(step) ? toSnakeCase(step.as) : step.kind;
  const topLevel = path.length === 1;
  // A nested name carries its whole path, prefixed with `step` so the index is not a
  // leading digit (`className` would otherwise paper over that with a `T`).
  const segments = isBindingStep(step) && topLevel ? [suffix] : ['step', ...path, suffix];
  return `${camel(pipeline.id)}${className(segments.join('_'))}Step`;
}

/** One emitted step: its module text, its constant, and the name it registers under. */
interface EmittedStep {
  readonly text: string;
  readonly constant: string;
  readonly name: string;
}

/**
 * The `structuredOutput(...)` constant a `generate` step parses its reply with.
 *
 * Named after the binding, because that is how a spec reads it -- except for a nested
 * step, where two arms may legally bind the same name. Those are named after the step's
 * own constant instead, so the declaration is unique while nothing already emitted has
 * to be renamed.
 */
function outputConstant(pipeline: PipelineShape, step: GenerateStep, path: StepPath): string {
  const base = path.length === 1 ? step.as : stepConstant(pipeline, step, path);
  return `${toSnakeCase(base).toUpperCase()}_OUTPUT`;
}

/**
 * Every step in a pipeline, including the ones nested in a composite and the `generate`
 * a `reduce` synthesises for its body.
 *
 * Import sets, output constants and "does this pipeline use X" are all questions about
 * code, not about the top level, so they have to be answered over this walk. A nested
 * `generate` that was not walked would emit a reference to an `_OUTPUT` constant the
 * module never declares.
 */
function* walkSteps(
  ir: IR,
  steps: readonly StepShape[],
  parentPath: StepPath = [],
): Generator<{ readonly step: StepShape; readonly path: StepPath }> {
  for (const [index, step] of steps.entries()) {
    const path = [...parentPath, String(index)];
    yield { step, path };
    if (step.kind === 'branch') {
      yield* walkSteps(ir, step.then, [...path, 'then']);
      yield* walkSteps(ir, step.else, [...path, 'else']);
    } else if (step.kind === 'parallel') {
      for (const [armIndex, arm] of step.branches.entries()) {
        yield* walkSteps(ir, arm, [...path, 'arm', String(armIndex)]);
      }
    } else if (step.kind === 'map') {
      yield* walkSteps(ir, [step.step], [...path, 'step']);
    } else if (step.kind === 'reduce') {
      yield* walkSteps(ir, [reduceBody(ir, step)], [...path, 'item']);
    }
  }
}

/** The binding the runtime's `reduceStep` collects; the body may not choose its own. */
const REDUCED_BINDING = 'reduced';

/** The context value `mapStep` and `reduceStep` seed per iteration. */
const ITERATION_ITEM = 'item';

/**
 * The `generate` step a `reduce` runs once per item.
 *
 * A `reduce` has no step of its own, so it gets one: a `generate` whose only input is
 * the iteration item, emitted by the same function the spec's own `generate` steps go
 * through. That is what keeps the guardrails, the structured-output path and the request
 * settings identical between the two, and `reduced` is the name the runtime collects
 * rather than one the body would have chosen.
 */
function reduceBody(ir: IR, step: ReduceStep): GenerateStep {
  const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
  const variable = prompt?.variables[0]?.name ?? ITERATION_ITEM;
  return {
    kind: 'generate',
    prompt: step.prompt,
    model: step.model,
    as: REDUCED_BINDING,
    input: { [variable]: { kind: 'reference', path: [ITERATION_ITEM] } },
  };
}

/**
 * The name and TypeScript type a step binds, or `undefined` for a step that binds nothing.
 *
 * `RetrievalResult`, `string`, `Array<Record<string, unknown>>` and `unknown[]` are what
 * the runtime itself binds: a retrieval step binds a result object, an agent step binds
 * the answer string, a `map` binds one record of the names its body bound per item, and a
 * `reduce` binds one `reduced` value per item. A `branch`, `parallel`, `guard` or `emit`
 * binds nothing of its own, so it has no entry and a read of it stays uncast.
 */
function bindingType(
  ir: IR,
  step: StepShape,
): { readonly name: string; readonly type: string } | undefined {
  switch (step.kind) {
    case 'generate': {
      const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
      const schema = prompt?.output.schema;
      return {
        name: step.as,
        type: schema !== undefined && schema.kind === 'named' ? className(schema.name) : 'string',
      };
    }
    case 'tool': {
      const tool = ir.tools.find((candidate) => candidate.id === step.tool);
      return { name: step.as, type: schemaNameFor(tool?.output) ?? 'string' };
    }
    case 'retrieve':
    case 'rerank':
      return { name: step.as, type: 'RetrievalResult' };
    case 'agent':
      return { name: step.as, type: 'string' };
    case 'map':
      return { name: step.as, type: 'Array<Record<string, unknown>>' };
    case 'reduce':
      return { name: step.as, type: 'unknown[]' };
    default:
      return undefined;
  }
}

/**
 * Every binding a pipeline's steps can leave, by name.
 *
 * A dotted read needs it: `require` is typed `unknown` and the runtime offers nothing
 * narrower, so the emitter casts to the type the spec declared for that binding. The walk
 * covers nested steps, because a `branch` arm's binding is read by a later top-level step.
 * A name with no entry is one the gates have already refused to let a step read.
 */
function bindingTypes(ir: IR, pipeline: PipelineShape): ReadonlyMap<string, string> {
  const types = new Map<string, string>();
  for (const { step } of walkSteps(ir, pipeline.steps)) {
    const binding = bindingType(ir, step);
    if (binding !== undefined) types.set(binding.name, binding.type);
  }
  return types;
}

function inputEntries(input: StepInput, types?: ReadonlyMap<string, string>): Entry[] {
  return Object.keys(input)
    .sort()
    .map(
      (key) => [propertyKey(key), valueExpression(input[key] as StepInputValue, types)] as const,
    );
}

function inputObject(input: StepInput, indent = '', types?: ReadonlyMap<string, string>): string {
  return objectLiteral(inputEntries(input, types), indent);
}

function camel(value: string): string {
  const pascal = className(value);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

function eventCast(ir: IR, pipeline: PipelineShape): string {
  return requestTypeName(ir, pipeline.id);
}

/**
 * The module for one step, or the named diagnostic when this target has no emitter.
 *
 * D-4 lives here. The old form threw a bare `Error`, which reached a caller as an
 * internal crash -- no code, no path, nothing a CLI could print as a finding. The
 * refusal is now the *same* diagnostic the validate layer produces, wrapped in
 * `TsVercelPlanError` so `problems[0].code` is `step-unsupported` however it is reached.
 * The validator runs first and is the surface users see; this is the backstop that keeps
 * the two from disagreeing.
 */
function leafModule(
  ir: IR,
  pipeline: PipelineShape,
  step: StepShape,
  path: StepPath,
  contextType: string,
): string {
  switch (step.kind) {
    case 'emit':
      // The step declares which value the answer is; the route reads that binding, so
      // there is no function to emit.
      return '';
    case 'tool':
      return toolStepModule(ir, pipeline, step, path, contextType);
    case 'retrieve':
      return retrieveStepModule(ir, pipeline, step, path, contextType);
    case 'generate':
      return generateStepModule(ir, pipeline, step, path, contextType);
    case 'rerank':
      return rerankStepModule(ir, pipeline, step, path, contextType);
    case 'guard':
      return guardStepModule(ir, pipeline, step, path, contextType);
    case 'agent':
      return agentStepModule(ir, pipeline, step, path, contextType);
    default:
      throw new TsVercelPlanError([stepUnsupported(step.kind, stepAt(pipeline, path))]);
  }
}

/** The four step kinds whose code is a wrapper over a runtime helper. */
function isCompositeKind(
  step: StepShape,
): step is BranchStep | ParallelStep | MapStep | ReduceStep {
  return (
    step.kind === 'branch' ||
    step.kind === 'parallel' ||
    step.kind === 'map' ||
    step.kind === 'reduce'
  );
}

/**
 * The `Pipeline` a composite arm or body runs, from already-emitted steps.
 *
 * Built with `new Pipeline([...])` rather than `Pipeline.of(...)` because `of` names each
 * step after the function, and the emitted constant is not the name the spec gave the
 * binding -- the trace of a nested arm should read `answer`, not `triageAnswerStep`.
 */
function pipelineOf(steps: readonly EmittedStep[], indent: string): string {
  const entries = steps.map((step) => `[${literal(step.name)}, ${step.constant}]`);
  const inline = `new Pipeline([${entries.join(', ')}])`;
  if (fits(indent, inline)) return inline;
  return ['new Pipeline([', ...entries.map((entry) => `${indent}  ${entry},`), `${indent}])`].join(
    '\n',
  );
}

/** The `branches:` value: one `Pipeline.of(...)` per arm, always one per line. */
function branchList(arms: readonly (readonly EmittedStep[])[], indent: string): string {
  const values = arms.map((arm) => pipelineOf(arm, `${indent}  `));
  return ['[', ...values.map((value) => `${indent}  ${value},`), `${indent}]`].join('\n');
}

/**
 * One composite step: children first, then the wrapper that calls the runtime helper.
 *
 * The wrapper is an ordinary `Step` that builds the helper and calls it, rather than the
 * helper itself exported as the step, because the helper takes its max depth and its
 * name as options and a `Step` takes neither. Nesting is bounded by `MAX_STEP_DEPTH`,
 * which is the runtime's own constant passed through rather than a number written here:
 * a spec cannot declare a deeper nest than the runtime will execute, and the validator
 * does not have to duplicate the bound for the two to agree.
 *
 * The wrapper registers under its constant even when it binds (`map`, `reduce`): the
 * runtime binds through `withValues`, so the registered name is for tracing, and the
 * constant is unique across arms where a binding name is not.
 */
function compositeStep(
  ir: IR,
  pipeline: PipelineShape,
  step: BranchStep | ParallelStep | MapStep | ReduceStep,
  path: StepPath,
  contextType: string,
): EmittedStep {
  const constant = stepConstant(pipeline, step, path);
  const common: Entry[] = [
    ['maxDepth', 'MAX_STEP_DEPTH'],
    ['name', literal(constant)],
  ];
  let children: EmittedStep[];
  let entries: Entry[];
  let doc: string;

  if (step.kind === 'branch') {
    const then = emitSteps(ir, pipeline, step.then, contextType, [...path, 'then']);
    const otherwise =
      step.else.length === 0
        ? []
        : emitSteps(ir, pipeline, step.else, contextType, [...path, 'else']);
    children = [...then, ...otherwise];
    entries = [
      ['when', literal(step.when)],
      ['then', pipelineOf(then, '    ')],
      ...(otherwise.length === 0
        ? []
        : [['otherwise', pipelineOf(otherwise, '    ')] as const satisfies Entry]),
      ...common,
    ];
    doc =
      "Run the arm the caller's principal selects. `when` is answered from the principal " +
      'and nothing else, so no earlier binding can decide it.';
  } else if (step.kind === 'parallel') {
    const arms = step.branches.map((arm, armIndex) =>
      emitSteps(ir, pipeline, arm, contextType, [...path, 'arm', String(armIndex)]),
    );
    children = arms.flat();
    entries = [['branches', branchList(arms, '    ')], ...common];
    doc =
      `Run all ${step.branches.length} arms concurrently under the deployment's one ` +
      'concurrency cap, then merge what they bound in arm order.';
  } else if (step.kind === 'map') {
    const body = emitSteps(ir, pipeline, [step.step], contextType, [...path, 'step']);
    children = body;
    entries = [
      ['over', literal(step.over)],
      ['as', literal(step.as)],
      ['step', pipelineOf(body, '    ')],
      ...common,
    ];
    doc =
      `Run the body once per item of \`${step.over}\`, under the concurrency cap, and ` +
      `bind the results in item order as \`${step.as}\`.`;
  } else {
    const body = reduceBody(ir, step);
    const bodyPath = [...path, 'item'];
    const bodyConstant = stepConstant(pipeline, body, bodyPath);
    children = [
      {
        text: generateStepModule(ir, pipeline, body, bodyPath, contextType),
        constant: bodyConstant,
        name: REDUCED_BINDING,
      },
    ];
    entries = [
      ['over', literal(step.over)],
      ['as', literal(step.as)],
      ['step', `new Pipeline([[${literal(REDUCED_BINDING)}, ${bodyConstant}]])`],
      ...common,
    ];
    doc =
      `Render \`${step.prompt}\` once per item of \`${step.over}\`, under the concurrency ` +
      `cap, and bind the replies in item order as \`${step.as}\`.`;
  }

  const wrapper = [
    `/** ${doc} */`,
    `export const ${constant}: Step = async (context) => {`,
    `  const step = ${step.kind === 'map' || step.kind === 'reduce' ? `${step.kind}Step` : step.kind}({`,
    // `then` is the runtime's own field name for a branch arm. It is a `Pipeline`, not a
    // function, so the object is not thenable -- but the lint rule cannot know that.
    ...entries.flatMap(([key, value]) =>
      key === 'then'
        ? [
            '    // biome-ignore lint/suspicious/noThenProperty: branch arm data, not a thenable',
            `    then: ${value},`,
          ]
        : [`    ${key}: ${value},`],
    ),
    '  });',
    '  return await step(context);',
    '};',
  ].join('\n');
  const text = [...children.map((child) => child.text).filter((part) => part.length > 0), wrapper];
  return { text: text.join('\n\n'), constant, name: constant };
}

/**
 * Every step of one list, flattened into the modules the pipeline file contains.
 *
 * A composite's children are emitted here rather than by `compositeStep`'s caller so the
 * recursion has one owner: the wrapper's text already carries its children's, which is
 * what lets a composite nest inside another without the outer one knowing.
 */
function emitSteps(
  ir: IR,
  pipeline: PipelineShape,
  steps: readonly StepShape[],
  contextType: string,
  parentPath: StepPath,
): EmittedStep[] {
  const emitted: EmittedStep[] = [];
  for (const [index, step] of steps.entries()) {
    const path = [...parentPath, String(index)];
    if (step.kind === 'emit') continue;
    if (isCompositeKind(step)) {
      emitted.push(compositeStep(ir, pipeline, step, path, contextType));
      continue;
    }
    const constant = stepConstant(pipeline, step, path);
    emitted.push({
      text: leafModule(ir, pipeline, step, path, contextType),
      constant,
      name: isBindingStep(step) ? step.as : constant,
    });
  }
  return emitted;
}

function eventLine(contextType: string, ...bodies: readonly string[]): string[] {
  const usesEvent = bodies.some((body) => body.includes('event.'));
  return usesEvent ? [`  const event = context.require('event') as ${contextType};`] : [];
}

function toolStepModule(
  ir: IR,
  pipeline: PipelineShape,
  step: ToolStep,
  path: StepPath,
  contextType: string,
): string {
  const constant = stepConstant(pipeline, step, path);
  const tool = ir.tools.find((candidate) => candidate.id === step.tool);
  const callId = `${pipeline.id}:${step.as}:${path.join(':')}`;
  const output = tool === undefined ? undefined : schemaNameFor(tool.output);
  const parseLine =
    output === undefined
      ? `  const value = JSON.parse(result.content) as unknown;`
      : `  const value = ${output}.parse(JSON.parse(result.content));`;
  const args = inputObject(step.input, '', bindingTypes(ir, pipeline));
  const callLiteral = objectLiteral(
    [
      ['id', literal(callId)],
      ['name', literal(step.tool)],
      ['arguments', args],
    ],
    '  ',
  );
  // A `tool-call` declaration is enforced here rather than in the agent loop, because a
  // pipeline `tool` step is the one tool call no agent makes. The refusal has to happen
  // before `execute`, or a guardrail would annotate a call it already ran.
  const check = `enforceGuardrail(ENGINE.checkToolCall(TOOL_CALL_GUARDRAILS, ${literal(
    step.tool,
  )}, call.arguments));`;
  const checkLines = usesStage(ir, 'tool-call')
    ? `  ${check}`.length <= 100
      ? [`  ${check}`]
      : [
          '  enforceGuardrail(',
          `    ENGINE.checkToolCall(TOOL_CALL_GUARDRAILS, ${literal(step.tool)}, call.arguments),`,
          '  );',
        ]
    : [];
  return [
    `/** \`${step.as}\`: call the \`${step.tool}\` tool. */`,
    `export const ${constant}: Step = async (context) => {`,
    '  const deps = getDeps();',
    ...eventLine(contextType, args),
    `  const call = new ToolCall(${callLiteral});`,
    ...checkLines,
    '  const result = await deps.tools.execute(call);',
    '  if (result.isError) {',
    `    throw new PipelineError(\`tool ${step.tool} failed: \${result.content}\`);`,
    '  }',
    parseLine,
    `  return context.withValues({ ${propertyKey(step.as)}: value });`,
    '};',
  ].join('\n');
}

function schemaNameFor(
  ref:
    | { kind: 'primitive'; name: string }
    | { kind: 'named'; name: string; resolved: boolean }
    | undefined,
): string | undefined {
  if (ref === undefined || ref.kind !== 'named') return undefined;
  return className(ref.name);
}

function retrieveStepModule(
  ir: IR,
  pipeline: PipelineShape,
  step: RetrieveStep,
  path: StepPath,
  contextType: string,
): string {
  void ir;
  const constant = stepConstant(pipeline, step, path);
  const query = templateToTs(step.query);
  const inline = `  const ${propertyKey(step.as)} = await deps.retriever(${literal(
    step.retriever,
  )}).retrieve(${query});`;
  const retrieveLine =
    inline.length <= 100
      ? [inline]
      : [
          `  const ${propertyKey(step.as)} = await deps`,
          `    .retriever(${literal(step.retriever)})`,
          `    .retrieve(${query});`,
        ];
  return [
    `/** \`${step.as}\`: retrieve from the \`${step.retriever}\` binding. */`,
    `export const ${constant}: Step = async (context) => {`,
    '  const deps = getDeps();',
    ...eventLine(contextType, query),
    ...retrieveLine,
    `  return context.withValues({ ${propertyKey(step.as)}: ${propertyKey(step.as)} });`,
    '};',
  ].join('\n');
}

function generateStepModule(
  ir: IR,
  pipeline: PipelineShape,
  step: GenerateStep,
  path: StepPath,
  contextType: string,
): string {
  const constant = stepConstant(pipeline, step, path);
  const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
  const types = bindingTypes(ir, pipeline);
  const variables =
    prompt?.variables.map((variable) => variable.name) ?? Object.keys(step.input).sort();
  const bindings = variables.map((name) => {
    if (step.context === name) {
      return `${propertyKey(name)}: (context.require(${literal(name)}) as RetrievalResult).context`;
    }
    const value = step.input[name];
    if (value === undefined) return `${propertyKey(name)}: context.require(${literal(name)})`;
    return `${propertyKey(name)}: ${valueExpression(value, types)}`;
  });
  const outputConstantName = outputConstant(pipeline, step, path);
  const inputCheck = usesStage(ir, 'input');
  const outputCheck = usesStage(ir, 'output');
  return [
    `/** \`${step.as}\`: render \`${step.prompt}\` and run it through the gateway. */`,
    `export const ${constant}: Step = async (context) => {`,
    '  const deps = getDeps();',
    ...eventLine(contextType, ...bindings),
    `  const rendered = deps.prompts.render(${literal(step.prompt)}, {`,
    ...bindings.map((binding) => `    ${binding},`),
    '  });',
    ...(inputCheck
      ? ['  const verdict = enforceGuardrail(ENGINE.checkInput(INPUT_GUARDRAILS, rendered.text));']
      : []),
    '  const call = async (text: string): Promise<string> => {',
    '    const result = await deps.gateway.generate(',
    `      ${literal(step.model)},`,
    '      new CompletionRequest({ messages: [Message.user(text)] }),',
    `      { fallbacks: FALLBACKS${memberAccess(step.model)} ?? [] },`,
    '    );',
    ...(outputCheck
      ? ['    return enforceGuardrail(ENGINE.checkOutput(OUTPUT_GUARDRAILS, result.text)).text;']
      : ['    return result.text;']),
    '  };',
    `  const ${propertyKey(step.as)} = await runStructured(call, ${outputConstantName}, ${
      inputCheck ? 'verdict.text' : 'rendered.text'
    });`,
    `  return context.withValues({ ${propertyKey(step.as)}: ${propertyKey(step.as)} });`,
    '};',
  ].join('\n');
}

/** The engine method one guard stage calls. `tool-call` is absent: a step names no tool. */
const GUARD_METHODS = {
  input: 'checkInput',
  output: 'checkOutput',
  retrieval: 'checkRetrieval',
} as const;

/** One step's address in the spec, which is what a plan finding points at. */
function stepAt(pipeline: PipelineShape, path: StepPath): string {
  return `pipelines.${pipeline.id}.steps.${path.join('.')}`;
}

/**
 * A rerank step: rescore the passages a retrieval binding holds, and bind the reordered
 * result.
 *
 * `rerank` returns a list of items, not a result, so the step rebuilds the
 * `RetrievalResult` around the rescored items and replaces only their order: the
 * retriever, the query and the citations the retrieval established survive, which is
 * what lets a later step still read `.context` and `.top(n)` off the binding.
 *
 * The scorer comes from `rerankerFor`, not from `new LexicalReranker()`, so a declared
 * model the runtime cannot honour fails loudly instead of being served by whatever
 * scorer happens to exist. The plan gate refuses a non-lexical model before emit; the
 * null check below is the backstop for a spec edited by hand.
 */
function rerankStepModule(
  ir: IR,
  pipeline: PipelineShape,
  step: RerankStep,
  path: StepPath,
  contextType: string,
): string {
  const constant = stepConstant(pipeline, step, path);
  const query = contextTemplate(step.query, bindingTypes(ir, pipeline));
  const as = propertyKey(step.as);
  const message = `rerank model ${step.model} did not resolve to a reranker`;
  return [
    `/** \`${step.as}\`: rescore the \`${step.over}\` passages and bind the top ${step.topN}. */`,
    `export const ${constant}: Step = async (context) => {`,
    ...eventLine(contextType, query),
    `  const query = ${query};`,
    `  const over = context.require(${literal(step.over)}) as RetrievalResult;`,
    `  const reranker = rerankerFor(new RerankSpec({ model: ${literal(step.model)}, topN: ${step.topN} }));`,
    '  if (reranker === null) {',
    `    throw new ConfigurationError(${literal(message)});`,
    '  }',
    `  const ${as} = new RetrievalResult({`,
    '    retriever: over.retriever,',
    '    query: over.query,',
    `    items: await reranker.rerank(query, over.items, { topN: ${step.topN} }),`,
    '  });',
    `  return context.withValues({ ${as}: ${as} });`,
    '};',
  ].join('\n');
}

/**
 * A guard step: run one declared guardrail at one stage, over one payload.
 *
 * It binds nothing and returns the context unchanged. A step that decides and passes the
 * context on is the whole of what a pipeline does with a `block`: the runtime raises, the
 * pipeline wraps that as a `PipelineError`, and the route answers 400. Nothing here
 * inspects the verdict, because the verdict a caller may ignore is exactly the one it
 * must not -- and a `redact` at this stage is therefore a no-op on the bindings, which is
 * why the step is emitted at all only to *refuse*.
 *
 * The step resolves the one guardrail it names through `guardrailById` rather than
 * running the stage's whole table: unlike the route-level check, a guard step is an
 * assertion about a named declaration.
 */
function guardStepModule(
  ir: IR,
  pipeline: PipelineShape,
  step: GuardStep,
  path: StepPath,
  contextType: string,
): string {
  if (step.stage === 'tool-call') {
    // The agent loop is the only caller of `checkToolCall` at plan time, so a pipeline
    // step at this stage would check a tool it does not call.
    throw new TsVercelPlanError([
      stepUnsupported('guard at the tool-call stage', stepAt(pipeline, path)),
    ]);
  }
  const constant = stepConstant(pipeline, step, path);
  const method = GUARD_METHODS[step.stage];
  // The engine's stage methods take the *table* to run, so a single named declaration is
  // handed over as a one-element table. The engine keeps only the declarations that
  // declare this stage, which is why the plan refuses a step whose guardrail does not.
  const config = `[guardrailById(${literal(step.guardrail)})]`;
  const payloadLine = guardPayload(ir, step, pipeline, path);
  return [
    `/** \`${step.guardrail}\` at the \`${step.stage}\` stage: refuse the payload, bind nothing. */`,
    `export const ${constant}: Step = async (context) => {`,
    ...eventLine(contextType, payloadLine.join('\n')),
    ...payloadLine,
    `  enforceGuardrail(ENGINE.${method}(${config}, payload));`,
    '  return context;',
    '};',
  ].join('\n');
}

/**
 * The payload a guard step hands the engine.
 *
 * At `input` and `output` it is the step's template rendered against the pipeline's
 * bindings, because the engine reads `{ text }` there. At `retrieval` it is the *strings*
 * a model would be handed -- `item.chunk.text` over the binding's items -- because that
 * stage guards what would reach the prompt, not the result object. `tool-call` never
 * reaches here; `guardStepModule` refuses it.
 */
function guardPayload(ir: IR, step: GuardStep, pipeline: PipelineShape, path: StepPath): string[] {
  if (step.stage !== 'retrieval') {
    return [`  const payload = ${contextTemplate(step.text, bindingTypes(ir, pipeline))};`];
  }
  const binding = firstReference(step.text);
  if (binding === undefined) {
    throw new TsVercelPlanError([
      problem(
        'step-invalid',
        stepAt(pipeline, path),
        `a guard step at the retrieval stage must name the retrieval binding to guard, ` +
          `and ${literal(step.text)} names none`,
      ),
    ]);
  }
  return [
    `  const over = context.require(${literal(binding)}) as RetrievalResult;`,
    '  const payload = over.items.map((item) => item.chunk.text);',
  ];
}

/**
 * An agent step: run a declared agent over the rendered text, and bind its answer.
 *
 * The runtime the step builds is the app's one agent document over the app's gateway, so
 * an agent a pipeline runs is the same agent the rest of the app declares -- tools,
 * guardrails, memory and budget all come from the spec, not from the step. The step adds
 * only the two things a pipeline knows: the text, and the principal the request carries.
 *
 * A run that stops short of `completed` -- budget exhausted, a guardrail that escalates --
 * raises rather than binding a partial answer, because an `emit` downstream cannot tell a
 * truncated answer from a finished one.
 */
function agentStepModule(
  ir: IR,
  pipeline: PipelineShape,
  step: AgentStep,
  path: StepPath,
  contextType: string,
): string {
  const constant = stepConstant(pipeline, step, path);
  const as = propertyKey(step.as);
  const text = contextTemplate(step.text, bindingTypes(ir, pipeline));
  return [
    `/** \`${step.as}\`: run the \`${step.agent}\` agent and bind its answer. */`,
    `export const ${constant}: Step = async (context) => {`,
    '  const deps = getDeps();',
    ...eventLine(contextType, text),
    `  const text = ${text};`,
    `  const outcome = await buildAgentRuntime(deps).run(${literal(step.agent)}, text, {`,
    '    principal: principalOf(context),',
    '  });',
    "  if (outcome.status !== 'completed' || outcome.answer === undefined) {",
    `    throw new PipelineError(\`agent ${step.agent} did not complete: \${outcome.status}\`);`,
    '  }',
    `  const ${as} = outcome.answer;`,
    `  return context.withValues({ ${as}: ${as} });`,
    '};',
  ].join('\n');
}

/** The runtime helpers a set of steps needs, one entry per composite kind present. */
function compositeHelpers(steps: readonly StepShape[]): string[] {
  const kinds = new Set(steps.filter(isCompositeKind).map((step) => step.kind));
  return [
    ...(kinds.has('branch') ? ['branch'] : []),
    ...(kinds.has('parallel') ? ['parallel'] : []),
    ...(kinds.has('map') ? ['mapStep'] : []),
    ...(kinds.has('reduce') ? ['reduceStep'] : []),
  ];
}

export function emitPipelineModule(ir: IR, pipeline: PipelineShape): EmittedFile {
  const contextType = eventCast(ir, pipeline);
  const steps = emitSteps(ir, pipeline, pipeline.steps, contextType, []);
  const all = [...walkSteps(ir, pipeline.steps)].map((entry) => entry.step);
  const hasStructured = all.some((step) => step.kind === 'generate');
  const hasTool = all.some((step) => step.kind === 'tool');
  const hasComposite = all.some(isCompositeKind);
  const hasRerank = all.some((step) => step.kind === 'rerank');
  const hasGuardStep = all.some((step) => step.kind === 'guard');
  const hasAgentStep = all.some((step) => step.kind === 'agent');
  // The routes check the whole stage table, so a route that generates at all runs the
  // `input` and `output` declarations; a `tool` step runs the `tool-call` ones.
  const inlineInput = hasStructured && usesStage(ir, 'input');
  const inlineOutput = hasStructured && usesStage(ir, 'output');
  const inlineToolCall = hasTool && usesStage(ir, 'tool-call');
  const guardCheck = hasGuardStep || inlineInput || inlineOutput || inlineToolCall;
  const usesRetrieved =
    all.some((step) => step.kind === 'generate' && step.context !== undefined) ||
    all.some((step) => step.kind === 'rerank') ||
    all.some((step) => step.kind === 'guard' && step.stage === 'retrieval');
  const runtimeValues = [
    ...(hasRerank ? ['ConfigurationError', 'RerankSpec', 'rerankerFor'] : []),
    ...(hasComposite ? ['MAX_STEP_DEPTH'] : []),
    ...(hasStructured ? ['CompletionRequest', 'Message'] : []),
    'Pipeline',
    ...(hasTool || hasAgentStep ? ['PipelineError'] : []),
    ...(hasRerank ? ['RetrievalResult'] : []),
    ...(hasTool ? ['ToolCall'] : []),
    ...(hasStructured ? ['runStructured', 'structuredOutput'] : []),
    ...compositeHelpers(all),
  ];
  const guardrailNames = [
    ...(guardCheck ? ['ENGINE', 'enforceGuardrail'] : []),
    ...(hasGuardStep ? ['guardrailById'] : []),
    ...(inlineInput ? [stageTable('input')] : []),
    ...(inlineOutput ? [stageTable('output')] : []),
    ...(inlineToolCall ? [stageTable('tool-call')] : []),
  ];
  const relativeImports: { specifier: string; names: ImportName[] }[] = [
    ...(hasAgentStep
      ? [
          { specifier: '../agents.js', names: [{ name: 'buildAgentRuntime', type: false }] },
          { specifier: '../control.js', names: [{ name: 'principalOf', type: false }] },
        ]
      : []),
    { specifier: '../deps.js', names: [{ name: 'getDeps', type: false }] },
    ...(hasStructured
      ? [{ specifier: '../gateway/models.js', names: [{ name: 'FALLBACKS', type: false }] }]
      : []),
    ...(guardrailNames.length === 0
      ? []
      : [
          {
            specifier: '../guardrails.js',
            names: sortedNames(guardrailNames).map((name) => ({ name, type: false })),
          },
        ]),
    { specifier: '../requests.js', names: [{ name: contextType, type: true }] },
  ].sort((a, b) => (a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0));
  const header = [
    importStatement('@aid-framework/runtime', [
      ...sortedNames([...new Set(runtimeValues)]).map((name) => ({ name, type: false })),
      ...(usesRetrieved && !hasRerank ? [{ name: 'RetrievalResult', type: true }] : []),
      { name: 'Step', type: true },
    ]),
    ...relativeImports.map((entry) => importStatement(entry.specifier, entry.names)),
    schemaImports(ir, pipeline),
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const outputDeclaration = outputConstants(ir, pipeline);

  const factory = [
    '/** The declared pipeline, in step order. */',
    `export function ${camel(pipeline.id)}Pipeline(): Pipeline {`,
    '  return new Pipeline([',
    ...steps.map((step) => `    [${literal(step.name)}, ${step.constant}],`),
    '  ]);',
    '}',
  ].join('\n');

  return generated(
    pipelinePath(toSnakeCase(pipeline.id)),
    moduleText(
      header,
      outputDeclaration,
      ...steps.map((step) => step.text).filter((text) => text.length > 0),
      factory,
    ),
  );
}

function schemaImports(ir: IR, pipeline: PipelineShape): string {
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    if (name !== undefined && !names.includes(name)) names.push(name);
  };
  for (const { step } of walkSteps(ir, pipeline.steps)) {
    if (step.kind === 'tool') {
      const tool = ir.tools.find((candidate) => candidate.id === step.tool);
      add(schemaNameFor(tool?.output));
    }
    if (step.kind === 'generate') {
      const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
      const schema = prompt?.output.schema;
      if (schema !== undefined && schema.kind === 'named') add(className(schema.name));
    }
  }
  if (names.length === 0) return '';
  return importStatement(
    '../schemas.js',
    sortedNames(names).map((name) => ({ name, type: false })),
  );
}

function outputConstants(ir: IR, pipeline: PipelineShape): string {
  const lines: string[] = [];
  const emitted = new Set<string>();
  for (const { step, path } of walkSteps(ir, pipeline.steps)) {
    if (step.kind !== 'generate') continue;
    const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
    const schema = prompt?.output.schema;
    if (schema === undefined || schema.kind !== 'named') continue;
    const constant = outputConstant(pipeline, step, path);
    if (emitted.has(constant)) continue;
    emitted.add(constant);
    lines.push(
      `const ${constant} = structuredOutput(${literal(schema.name)}, ${className(schema.name)});`,
    );
  }
  if (lines.length === 0) return '';
  return lines.join('\n');
}

export function emitPipelinesIndex(ir: IR): EmittedFile {
  const imports = ir.pipelines.map((pipeline) =>
    exportStatement(`./${toSnakeCase(pipeline.id)}.js`, [
      [`${camel(pipeline.id)}Pipeline`, `${camel(pipeline.id)}Pipeline`],
    ]),
  );
  return generated(paths.pipelinesIndex, moduleText(...imports));
}

/**
 * The structured-output class a `generate` step's reply parses to, when it declares one.
 *
 * The route reads the value the *last binding step* left, so the cast has to be derived
 * from that step rather than from the first `generate` in the file: since composites
 * exist those are no longer the same step, and a cast to the wrong class is a compile
 * error in the emitted application rather than a wrong answer at run time.
 */
/**
 * The schema the route casts the answer to, when the last binding has one.
 *
 * A `generate` step's answer is the prompt's declared output type and a `tool` step's is
 * its output type, so both are objects the route can spread into the body. Every other
 * binding -- an agent's answer is the obvious one -- is a string or a result object with
 * no declared shape, and the route wraps those under `answer` instead.
 */
function structuredAnswer(ir: IR, step: StepShape): string | undefined {
  if (step.kind === 'generate') {
    const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
    const schema = prompt?.output.schema;
    return schema !== undefined && schema.kind === 'named' ? className(schema.name) : undefined;
  }
  if (step.kind === 'tool') {
    const tool = ir.tools.find((candidate) => candidate.id === step.tool);
    return schemaNameFor(tool?.output);
  }
  return undefined;
}

/**
 * Whether a pipeline can raise a guardrail block, which is what decides the route's 400.
 *
 * A block arrives wrapped in the `PipelineError` the runtime raises around a failed step,
 * so the route cannot answer 400 without digging it out of the cause chain -- and it
 * should not pay for that in the routes that cannot block at all. An agent step counts
 * because the agent loop enforces the guardrails its declaration names.
 */
function pipelineCanBlock(ir: IR, pipeline: PipelineShape): boolean {
  const all = [...walkSteps(ir, pipeline.steps)].map((entry) => entry.step);
  return (
    all.some((step) => step.kind === 'guard') ||
    all.some((step) => step.kind === 'agent') ||
    (all.some((step) => step.kind === 'generate') &&
      (usesStage(ir, 'input') || usesStage(ir, 'output'))) ||
    (all.some((step) => step.kind === 'tool') && usesStage(ir, 'tool-call'))
  );
}

export function emitRouteModule(ir: IR, pipeline: PipelineShape): EmittedFile {
  const handler = `handle${className(pipeline.id)}`;
  const requestType = eventCast(ir, pipeline);
  const requestSchema = requestType;
  const finalStep = [...pipeline.steps].reverse().find(isBindingStep);
  const answer = finalStep === undefined ? undefined : structuredAnswer(ir, finalStep);
  const trigger =
    pipeline.trigger.kind === 'http' ? pipeline.trigger : { method: 'POST', path: '/' };
  const canBlock = pipelineCanBlock(ir, pipeline);

  const header = [
    importStatement('@aid-framework/runtime', [
      { name: 'PipelineError', type: false },
      { name: 'PipelineContext', type: true },
    ]),
    importStatement('../control.js', [{ name: 'seeded', type: false }]),
    ...(canBlock
      ? [importStatement('../guardrails.js', [{ name: 'guardrailBlock', type: false }])]
      : []),
    importStatement(`../pipelines/${toSnakeCase(pipeline.id)}.js`, [
      { name: `${camel(pipeline.id)}Pipeline`, type: false },
    ]),
    importStatement('../requests.js', [{ name: requestSchema, type: false }]),
    ...(answer === undefined
      ? []
      : [importStatement('../schemas.js', [{ name: answer, type: true }])]),
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const body = [
    '/** The method and path this handler answers, as declared in the spec. */',
    `export const ROUTE = { method: ${literal(
      trigger.method.toUpperCase(),
    )}, path: ${literal(trigger.path)} } as const;`,
    '',
    '/** The request half of the Fetch API that a route handler actually uses. */',
    'export interface RouteRequest {',
    '  readonly json: () => Promise<unknown>;',
    '}',
    '',
    'export interface RouteResponse {',
    '  readonly status: number;',
    '  readonly body: unknown;',
    '}',
    '',
    '/**',
    ' * Run the pipeline for one request. The body is validated before the pipeline runs;',
    ' * a guardrail that refuses the request is a 400, and any other pipeline failure is a',
    ' * 502 -- the request was well formed, the run was not.',
    ' */',
    `export async function ${handler}(request: RouteRequest): Promise<RouteResponse> {`,
    '  let payload: unknown;',
    '  try {',
    '    payload = await request.json();',
    '  } catch {',
    "    return { status: 400, body: { error: 'request body is not valid JSON' } };",
    '  }',
    `  const parsed = ${requestSchema}.safeParse(payload);`,
    '  if (!parsed.success) {',
    "    return { status: 400, body: { error: 'request body does not match the declared schema' } };",
    '  }',
    '  let context: PipelineContext;',
    '  try {',
    `    context = await ${camel(pipeline.id)}Pipeline().run(seeded(parsed.data));`,
    '  } catch (error) {',
    ...(canBlock
      ? [
          '    const block = guardrailBlock(error);',
          '    if (block !== undefined) {',
          '      return {',
          '        status: 400,',
          '        body: { error: block.message, guardrail: block.guardrail, stage: block.stage },',
          '      };',
          '    }',
        ]
      : []),
    '    if (error instanceof PipelineError) {',
    '      return { status: 502, body: { error: error.message } };',
    '    }',
    '    throw error;',
    '  }',
    finalStep === undefined
      ? '  return { status: 204, body: null };'
      : [
          `  const answer = context.require(${literal(finalStep.as)}) as ${answer ?? 'unknown'};`,
          answer === undefined
            ? '  return { status: 200, body: { answer } };'
            : '  return { status: 200, body: { ...answer } };',
        ].join('\n'),
    '}',
  ].join('\n');

  return generated(routePath(toSnakeCase(pipeline.id)), moduleText(header, body));
}

export function emitRoutesIndex(ir: IR): EmittedFile {
  const lines = ir.pipelines.map((pipeline) =>
    exportStatement(`./${toSnakeCase(pipeline.id)}.js`, [
      [`handle${className(pipeline.id)}`, `handle${className(pipeline.id)}`],
      ['ROUTE', `${toSnakeCase(pipeline.id).toUpperCase()}_ROUTE`],
    ]),
  );
  return generated(paths.routesIndex, moduleText(...lines));
}

export type { TypeField };
