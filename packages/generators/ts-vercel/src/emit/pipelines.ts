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
  GenerateStep,
  IR,
  PipelineShape,
  StepInput,
  StepInputValue,
  StepShape,
  ToolStep,
  TypeField,
} from '@aid/ir';
import { className, literal, memberAccess, propertyKey, toSnakeCase } from '../names.js';
import { type EmittedFile, generated, paths, pipelinePath, routePath } from './file.js';
import { requestTypeName } from './schemas.js';
import {
  type Entry,
  exportStatement,
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
    return [head, ...rest.map((part) => propertyKey(part))].join('.');
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

/** A step this target emits code for: everything except `emit` and the four composites. */
type FlatStep = GenerateStep | RetrieveStep | ToolStep;

function isFlatStep(step: StepShape): step is FlatStep {
  return step.kind === 'generate' || step.kind === 'retrieve' || step.kind === 'tool';
}

function inputEntries(input: StepInput): Entry[] {
  return Object.keys(input)
    .sort()
    .map((key) => [propertyKey(key), valueExpression(input[key] as StepInputValue)] as const);
}

function inputObject(input: StepInput, indent = ''): string {
  return objectLiteral(inputEntries(input), indent);
}

function stepConstant(pipeline: PipelineShape, step: FlatStep): string {
  const name = toSnakeCase(step.as);
  return `${camel(pipeline.id)}${className(name)}Step`;
}

function camel(value: string): string {
  const pascal = className(value);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

function eventCast(ir: IR, pipeline: PipelineShape): string {
  return requestTypeName(ir, pipeline.id);
}

function stepModule(
  ir: IR,
  pipeline: PipelineShape,
  step: StepShape,
  index: number,
  contextType: string,
): string {
  // An `emit` step declares which value is the answer; it emits no code, and the route
  // reads that binding directly. The validator refuses composite steps before emission
  // reaches here, so reaching this branch is a generator bug rather than a user error.
  if (step.kind === 'emit') return '';
  // Every other non-emitted kind — composite or leaf — is refused by the validator
  // first, so reaching this branch is a generator bug rather than a user error.
  if (step.kind !== 'tool' && step.kind !== 'retrieve' && step.kind !== 'generate') {
    throw new Error(`the Next.js emitter has no step emitter for ${step.kind} (L6)`);
  }
  return step.kind === 'tool'
    ? toolStepModule(ir, pipeline, step, index, contextType)
    : step.kind === 'retrieve'
      ? retrieveStepModule(ir, pipeline, step, index, contextType)
      : generateStepModule(ir, pipeline, step, index, contextType);
}

function eventLine(contextType: string, ...bodies: readonly string[]): string[] {
  const usesEvent = bodies.some((body) => body.includes('event.'));
  return usesEvent ? [`  const event = context.require('event') as ${contextType};`] : [];
}

function toolStepModule(
  ir: IR,
  pipeline: PipelineShape,
  step: ToolStep,
  index: number,
  contextType: string,
): string {
  const constant = stepConstant(pipeline, step);
  const tool = ir.tools.find((candidate) => candidate.id === step.tool);
  const callId = `${pipeline.id}:${step.as}:${index}`;
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
  _index: number,
  contextType: string,
): string {
  void ir;
  const constant = stepConstant(pipeline, step);
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
  _index: number,
  contextType: string,
): string {
  const constant = stepConstant(pipeline, step);
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
  const outputConstant = `${toSnakeCase(step.as).toUpperCase()}_OUTPUT`;
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
    `  const ${propertyKey(step.as)} = await runStructured(call, ${outputConstant}, rendered.text);`,
    `  return context.withValues({ ${propertyKey(step.as)}: ${propertyKey(step.as)} });`,
    '};',
  ].join('\n');
}

export function emitPipelineModule(ir: IR, pipeline: PipelineShape): EmittedFile {
  const contextType = eventCast(ir, pipeline);
  const steps = pipeline.steps.map((step, index) =>
    stepModule(ir, pipeline, step, index, contextType),
  );
  const names = pipeline.steps
    .filter(isFlatStep)
    .map((step) => [step.as, stepConstant(pipeline, step)] as const);

  const hasStructured = pipeline.steps.some((step) => step.kind === 'generate');
  const hasTool = pipeline.steps.some((step) => step.kind === 'tool');
  const usesRetrieved = pipeline.steps.some(
    (step) => step.kind === 'generate' && step.context !== undefined,
  );
  const runtimeValues = [
    ...(hasStructured ? ['CompletionRequest', 'Message'] : []),
    'Pipeline',
    ...(hasTool ? ['PipelineError', 'ToolCall'] : []),
    ...(hasStructured ? ['runStructured', 'structuredOutput'] : []),
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
    ...names.map(([name, constant]) => `    [${literal(name)}, ${constant}],`),
    '  ]);',
    '}',
  ].join('\n');

  return generated(
    pipelinePath(toSnakeCase(pipeline.id)),
    moduleText(header, outputDeclaration, ...steps.filter((step) => step.length > 0), factory),
  );
}

function schemaImports(ir: IR, pipeline: PipelineShape): string {
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    if (name !== undefined && !names.includes(name)) names.push(name);
  };
  for (const step of pipeline.steps) {
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
  for (const step of pipeline.steps) {
    if (step.kind !== 'generate') continue;
    const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
    const schema = prompt?.output.schema;
    if (schema === undefined || schema.kind !== 'named') continue;
    const constant = `${toSnakeCase(step.as).toUpperCase()}_OUTPUT`;
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

/** The structured answer a pipeline emits, or `undefined` when it emits none. */
export function pipelineAnswer(ir: IR, pipeline: PipelineShape): string | undefined {
  for (const step of pipeline.steps) {
    if (step.kind !== 'generate') continue;
    const prompt = ir.prompts.find((candidate) => candidate.id === step.prompt);
    const schema = prompt?.output.schema;
    if (schema !== undefined && schema.kind === 'named') return className(schema.name);
  }
  return undefined;
}

export function emitRouteModule(ir: IR, pipeline: PipelineShape): EmittedFile {
  const handler = `handle${className(pipeline.id)}`;
  const requestType = eventCast(ir, pipeline);
  const requestSchema = requestType;
  const answer = pipelineAnswer(ir, pipeline);
  const trigger =
    pipeline.trigger.kind === 'http' ? pipeline.trigger : { method: 'POST', path: '/' };
  const finalStep = [...pipeline.steps].reverse().find(isFlatStep);

  const header = [
    importStatement('@aid/runtime', [
      { name: 'PipelineError', type: false },
      { name: 'PipelineContext', type: true },
    ]),
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
    `    context = await ${camel(pipeline.id)}Pipeline().run({ event: parsed.data });`,
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
