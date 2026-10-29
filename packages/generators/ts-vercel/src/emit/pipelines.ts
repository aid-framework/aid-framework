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
} from '@aid/ir';
import { TsVercelPlanError } from '../errors.js';
import { className, literal, memberAccess, propertyKey, toSnakeCase } from '../names.js';
import { stepUnsupported } from '../validate.js';
import { type EmittedFile, generated, paths, pipelinePath, routePath } from './file.js';
import { requestTypeName } from './schemas.js';
import {
  type Entry,
  exportStatement,
  fits,
  importStatement,
  moduleText,
  objectLiteral,
  sortedNames,
} from './text.js';

/** `packages/ir`'s barrel does not re-export this one, so it is derived from the union. */
type RetrieveStep = Extract<StepShape, { kind: 'retrieve' }>;

/** Render one `StepInputValue` as a TypeScript expression. */
function valueExpression(value: StepInputValue): string {
  if (value.kind === 'literal') return literal(value.value);
  if (value.kind === 'reference') {
    const [head, ...rest] = value.path;
    if (head === undefined) return 'undefined';
    const tail = rest.map((part) => memberAccess(part)).join('');
    // `event` is the one binding that is a real local in every emitted step; every other
    // name lives in the pipeline context, so it is read back through `require` rather
    // than emitted as an identifier that would not resolve. That is also what makes a
    // composite body able to read the `item` its iteration seeded.
    return head === 'event' ? `event${tail}` : `context.require(${literal(head)})${tail}`;
  }
  return templateToTs(value.template);
}

/**
 * Turn an IR interpolation template into a TypeScript template literal.
 *
 * `{{ event.subject }}` becomes `${event.subject}`. The two forms use different
 * delimiters on purpose: the IR's spelling is language-neutral, and rewriting it at
 * emit time is the whole job of the target.
 */
export function templateToTs(template: string): string {
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
    const expression = template
      .slice(open + 2, close)
      .trim()
      .split('.')
      .map((part) => propertyKey(part))
      .join('.');
    parts.push(`\${${expression}}`);
    index = close + 2;
  }
  return `\`${parts.join('')}\``;
}

function escapeLiteral(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * A step this target emits as its own `Step` function.
 *
 * `emit` is not one: it declares which value the answer is and the route reads that
 * binding, so it renders no code. The composite kinds are emitted, but not by the three
 * leaf emitters below -- they wrap the runtime's helpers and are built by
 * `compositeStepModule`.
 */
type LeafStep = GenerateStep | RetrieveStep | ToolStep;

function isLeafStep(step: StepShape): step is LeafStep {
  return step.kind === 'generate' || step.kind === 'retrieve' || step.kind === 'tool';
}

/**
 * A step that binds a value a later step or the route can read.
 *
 * This is what "the answer" means to the route: the last step that adds a binding. The
 * composites are the reason the question has to be asked of the shape rather than of the
 * kind -- `map` and `reduce` bind, `branch`, `parallel` and `guard` bind nothing, and a
 * `branch` whose arms end in a `generate` binds only what that arm bound.
 */
type BindingStep = LeafStep | MapStep | ReduceStep | RerankStep | AgentStep;

function isBindingStep(step: StepShape): step is BindingStep {
  return (
    isLeafStep(step) ||
    step.kind === 'map' ||
    step.kind === 'reduce' ||
    step.kind === 'rerank' ||
    step.kind === 'agent'
  );
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

function inputEntries(input: StepInput): Entry[] {
  return Object.keys(input)
    .sort()
    .map((key) => [propertyKey(key), valueExpression(input[key] as StepInputValue)] as const);
}

function inputObject(input: StepInput, indent = ''): string {
  return objectLiteral(inputEntries(input), indent);
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
    default:
      throw new TsVercelPlanError([
        stepUnsupported(step.kind, `pipelines.${pipeline.id}.steps.${path.join('.')}`),
      ]);
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
    ...entries.map(([key, value]) => `    ${key}: ${value},`),
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
  const args = inputObject(step.input);
  const callLiteral = objectLiteral(
    [
      ['id', literal(callId)],
      ['name', literal(step.tool)],
      ['arguments', args],
    ],
    '  ',
  );
  return [
    `/** \`${step.as}\`: call the \`${step.tool}\` tool. */`,
    `export const ${constant}: Step = async (context) => {`,
    '  const deps = getDeps();',
    ...eventLine(contextType, args),
    `  const call = new ToolCall(${callLiteral});`,
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
  const variables =
    prompt?.variables.map((variable) => variable.name) ?? Object.keys(step.input).sort();
  const bindings = variables.map((name) => {
    if (step.context === name) {
      return `${propertyKey(name)}: (context.require(${literal(name)}) as RetrievalResult).context`;
    }
    const value = step.input[name];
    if (value === undefined) return `${propertyKey(name)}: context.require(${literal(name)})`;
    return `${propertyKey(name)}: ${valueExpression(value)}`;
  });
  const outputConstantName = outputConstant(pipeline, step, path);
  return [
    `/** \`${step.as}\`: render \`${step.prompt}\` and run it through the gateway. */`,
    `export const ${constant}: Step = async (context) => {`,
    '  const deps = getDeps();',
    ...eventLine(contextType, ...bindings),
    `  const rendered = deps.prompts.render(${literal(step.prompt)}, {`,
    ...bindings.map((binding) => `    ${binding},`),
    '  });',
    '  const call = async (text: string): Promise<string> => {',
    '    const result = await deps.gateway.generate(',
    `      ${literal(step.model)},`,
    '      new CompletionRequest({ messages: [Message.user(text)] }),',
    `      { fallbacks: FALLBACKS${memberAccess(step.model)} ?? [] },`,
    '    );',
    '    return result.text;',
    '  };',
    `  const ${propertyKey(step.as)} = await runStructured(call, ${outputConstantName}, rendered.text);`,
    `  return context.withValues({ ${propertyKey(step.as)}: ${propertyKey(step.as)} });`,
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
  const usesRetrieved = all.some((step) => step.kind === 'generate' && step.context !== undefined);
  const runtimeValues = [
    ...(hasComposite ? ['MAX_STEP_DEPTH'] : []),
    ...(hasStructured ? ['CompletionRequest', 'Message'] : []),
    'Pipeline',
    ...(hasTool ? ['PipelineError', 'ToolCall'] : []),
    ...(hasStructured ? ['runStructured', 'structuredOutput'] : []),
    ...compositeHelpers(all),
  ];
  const relativeImports = [
    { specifier: '../deps.js', name: 'getDeps', type: false },
    ...(hasStructured
      ? [{ specifier: '../gateway/models.js', name: 'FALLBACKS', type: false }]
      : []),
    { specifier: '../requests.js', name: contextType, type: true },
  ].sort((a, b) => (a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0));
  const header = [
    importStatement('@aid/runtime', [
      ...sortedNames(runtimeValues).map((name) => ({ name, type: false })),
      ...(usesRetrieved ? [{ name: 'RetrievalResult', type: true }] : []),
      { name: 'Step', type: true },
    ]),
    ...relativeImports.map((entry) =>
      importStatement(entry.specifier, [{ name: entry.name, type: entry.type }]),
    ),
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
function structuredAnswer(ir: IR, step: StepShape): string | undefined {
  if (step.kind !== 'generate') return undefined;
  const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
  const schema = prompt?.output.schema;
  return schema !== undefined && schema.kind === 'named' ? className(schema.name) : undefined;
}

export function emitRouteModule(ir: IR, pipeline: PipelineShape): EmittedFile {
  const handler = `handle${className(pipeline.id)}`;
  const requestType = eventCast(ir, pipeline);
  const requestSchema = requestType;
  const finalStep = [...pipeline.steps].reverse().find(isBindingStep);
  const answer = finalStep === undefined ? undefined : structuredAnswer(ir, finalStep);
  const trigger =
    pipeline.trigger.kind === 'http' ? pipeline.trigger : { method: 'POST', path: '/' };

  const header = [
    importStatement('@aid/runtime', [
      { name: 'PipelineError', type: false },
      { name: 'PipelineContext', type: true },
    ]),
    importStatement('../control.js', [{ name: 'seeded', type: false }]),
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
    ' * Run the pipeline for one request. The body is validated before the pipeline runs,',
    ' * and a pipeline failure is a 502: the request was well formed, the run was not.',
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
    '    if (error instanceof PipelineError) {',
    '      return { status: 502, body: { error: error.message } };',
    '    }',
    '    throw error;',
    '  }',
    finalStep === undefined
      ? '  return { status: 204, body: null };'
      : [
          `  const answer = context.require(${literal(finalStep.as)}) as ${answer ?? 'unknown'};`,
          '  return { status: 200, body: { ...answer } };',
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
