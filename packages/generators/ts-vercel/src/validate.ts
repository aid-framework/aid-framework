/**
 * What this target refuses to emit, and why.
 *
 * The generator consumes the IR and nothing else: no spec re-reading, no reach into
 * `packages/spec`. Everything it needs to decide feasibility is already in the IR, so
 * these checks are total over the IR and run before a single byte is rendered.
 *
 * The rule is fail-closed. A construct with no emitter is a problem, not a comment in
 * the output: a generated app that boots while silently skipping a step is worse than
 * one that was never written.
 */
import {
  type BranchStep,
  type EmitStep,
  type EvalShape,
  type GenerateStep,
  type IR,
  isCompositeStep,
  isRequiredCapability,
  type MapStep,
  type MetricShape,
  type ModelCapability,
  type ParallelStep,
  type PipelineShape,
  type PrimitiveType,
  type PromptShape,
  type ReduceStep,
  type RetrieveStep,
  type StepShape,
  type ToolShape,
  type ToolStep,
  type TypeRef,
  type TypeShape,
} from '@aid/ir';
import { TS_VERCEL_MANIFEST, TS_VERCEL_TARGET } from './manifest.js';
import { type Capability, modelCapabilityMember, providerAdapter } from './names.js';
import { templatePlaceholders } from './placeholders.js';

export type PlanProblemCode =
  | 'ir-version-unsupported'
  | 'target-unsupported'
  | 'collection-unsupported'
  | 'observability-redact-unsupported'
  | 'runtime-unsupported'
  | 'type-unsupported'
  | 'named-type-unresolved'
  | 'field-unsupported'
  | 'model-provider-unsupported'
  | 'model-capability-unsupported'
  | 'model-missing-capability'
  | 'prompt-output-unsupported'
  | 'prompt-variable-unsupported'
  | 'prompt-model-unresolved'
  | 'unsupported-placeholder'
  | 'tool-handler-unsupported'
  | 'tool-auth-unsupported'
  | 'tool-confirmation-unsupported'
  | 'step-unsupported'
  | 'reference-unresolved'
  | 'trigger-unsupported'
  | 'retriever-store-unsupported'
  | 'retriever-source-unsupported'
  | 'retriever-embedding-unresolved'
  | 'retriever-filters-unsupported'
  | 'eval-target-unresolved'
  | 'eval-metric-unsupported'
  | 'eval-dataset-unsupported'
  | 'deployment-unsupported';

export interface PlanProblem {
  readonly code: PlanProblemCode;
  readonly path: string;
  readonly message: string;
}

/**
 * Collections the IR can hold but this target still drops.
 *
 * `deployments` is *not* here: the concurrency cap it declares is what the emitted
 * `control.ts` seeds into the pipeline context, so the collection is emitted even though
 * nothing else in it reaches code. See `checkDeployments` for the part that is refused.
 */
export const UNSUPPORTED_COLLECTIONS = ['agents', 'guardrails', 'memory'] as const;

/** Names a pipeline step may not bind, because the runtime already owns them. */
export const RESERVED_BINDINGS = ['context', 'deps', 'event', 'response', 'steps'] as const;

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set<PrimitiveType>([
  'string',
  'number',
  'integer',
  'boolean',
]);

/**
 * Metrics this target can emit a working module for.
 *
 * Deliberately narrower than `MetricShape['kind']`: `cost` and `latency` are budgets the
 * runtime enforces outside a metric, `tool-trace` needs a trace the runtime does not
 * record yet, and `llm-judge` is not deterministic enough for a CI threshold. Declaring
 * one would generate a module that silently scores nothing, so the plan refuses instead.
 */
const SUPPORTED_METRICS: ReadonlySet<MetricShape['kind']> = new Set<MetricShape['kind']>([
  'json-schema',
  'retrieval',
  'exact',
  'contains',
]);

function problem(code: PlanProblemCode, path: string, message: string): PlanProblem {
  return { code, path, message };
}

/** Whether a type reference can be rendered as a zod schema. */
function refRenderable(ref: TypeRef, declared: ReadonlySet<string>): boolean {
  if (ref.kind === 'primitive') return PRIMITIVE_TYPES.has(ref.name);
  return declared.has(ref.name);
}

export function checkIrVersion(ir: IR): PlanProblem[] {
  if (ir.irVersion !== TS_VERCEL_MANIFEST.irRange.replace(/^\^/, '')) {
    return [
      problem(
        'ir-version-unsupported',
        'irVersion',
        `IR ${ir.irVersion} is outside this generator's range ${TS_VERCEL_MANIFEST.irRange}`,
      ),
    ];
  }
  return [];
}

export function checkTarget(ir: IR): PlanProblem[] {
  if (ir.project.targets.includes(TS_VERCEL_TARGET)) return [];
  return [
    problem(
      'target-unsupported',
      'project.targets',
      `the spec does not declare ${TS_VERCEL_TARGET}; declared targets: ${ir.project.targets.join(', ') || '(none)'}`,
    ),
  ];
}

export function checkCollections(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const key of UNSUPPORTED_COLLECTIONS) {
    const count = Array.isArray(ir[key]) ? ir[key].length : 0;
    if (count > 0) {
      problems.push(
        problem(
          'collection-unsupported',
          key,
          `${key} is not implemented in Phase 1, so ${count} entr${count === 1 ? 'y' : 'ies'} would be dropped`,
        ),
      );
    }
  }
  return problems;
}

/**
 * `deployments`: only the concurrency cap is emitted, and only what the host can honour.
 *
 * The route handler this target emits answers with one buffered body, so a deployment
 * asking for streaming is refused rather than emitted as something that only looks
 * streamed. `secrets` needs no check: the adapters read a declared secret by name from
 * the environment, so the declaration is documentation, not an artifact to emit.
 */
export function checkDeployments(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const deployment of ir.deployments) {
    const at = `deployments.${deployment.id}`;
    if (deployment.streaming) {
      problems.push(
        problem(
          'deployment-unsupported',
          at,
          'streaming needs a streaming host; the emitted route answers with one buffered body',
        ),
      );
    }
    if (deployment.concurrency !== undefined && deployment.concurrency < 1) {
      problems.push(
        problem(
          'deployment-unsupported',
          `${at}.concurrency`,
          `concurrency is the cap the emitter passes to the runtime's limiter, so it must be at least 1, got ${deployment.concurrency}`,
        ),
      );
    }
  }
  return problems;
}

export function checkObservability(ir: IR): PlanProblem[] {
  if (ir.observability.redact.length === 0) return [];
  return [
    problem(
      'observability-redact-unsupported',
      'observability.redact',
      'the runtime exposes no redaction hook, so declared redaction paths would not be honoured',
    ),
  ];
}

export function checkRuntime(ir: IR): PlanProblem[] {
  if (ir.runtime.controlFlow === 'plain-async') return [];
  return [
    problem(
      'runtime-unsupported',
      'runtime.controlFlow',
      `control flow ${ir.runtime.controlFlow} has no emitter; only plain-async is supported`,
    ),
  ];
}

export function checkTypes(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const declared = new Set(ir.types.map((shape) => shape.id));
  for (const shape of ir.types) {
    problems.push(...checkTypeShape(shape, declared));
  }
  return problems;
}

function checkTypeShape(shape: TypeShape, declared: ReadonlySet<string>): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const seen = new Set<string>();
  for (const field of shape.fields) {
    const at = `types.${shape.id}.fields.${field.name}`;
    if (seen.has(field.name)) {
      problems.push(problem('field-unsupported', at, `duplicate field ${field.name}`));
    }
    seen.add(field.name);
    if (field.type.list) {
      problems.push(
        problem(
          'type-unsupported',
          at,
          'list-typed fields have no Phase 1 emitter; the source runtime does not model them',
        ),
      );
    }
    if (field.type.kind === 'primitive' && !PRIMITIVE_TYPES.has(field.type.name)) {
      problems.push(
        problem('type-unsupported', at, `primitive ${field.type.name} has no zod mapping`),
      );
    }
    if (field.type.kind === 'named' && !declared.has(field.type.name)) {
      problems.push(
        problem('named-type-unresolved', at, `type ${field.type.name} is not declared`),
      );
    }
    if (field.enum !== undefined && field.enum.length === 0) {
      problems.push(
        problem('field-unsupported', at, 'an empty enum cannot be rendered as a literal'),
      );
    }
  }
  return problems;
}

export function checkModels(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const promptModels = new Set(ir.prompts.map((prompt) => prompt.model));
  for (const model of ir.models) {
    const at = `models.${model.id}`;
    if (providerAdapter(model.provider) === undefined) {
      problems.push(
        problem(
          'model-provider-unsupported',
          at,
          `provider ${model.provider} has no TypeScript adapter; the runtime ships fake and openai-compatible only`,
        ),
      );
    }
    for (const capability of model.capabilities) {
      if (modelCapabilityMember(capability) === undefined) {
        problems.push(
          problem(
            'model-capability-unsupported',
            at,
            `capability ${capability} has no runtime member, so the emitted ModelSpec would silently drop it`,
          ),
        );
      }
    }
    if (promptModels.has(model.id) && !model.capabilities.includes('json-schema')) {
      problems.push(
        problem(
          'model-missing-capability',
          at,
          'the model backs a prompt, but declares no json-schema capability, so a structured prompt cannot run on it',
        ),
      );
    }
    for (const fallback of model.fallbacks) {
      if (!ir.models.some((other) => other.id === fallback)) {
        problems.push(
          problem(
            'reference-unresolved',
            `${at}.fallbacks`,
            `fallback model ${fallback} is not declared`,
          ),
        );
      }
    }
  }
  return problems;
}

export function checkPrompts(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const declared = new Set(ir.types.map((shape) => shape.id));
  const models = new Set(ir.models.map((model) => model.id));
  for (const prompt of ir.prompts) {
    problems.push(...checkPromptShape(prompt, declared, models));
  }
  return problems;
}

function checkPromptShape(
  prompt: PromptShape,
  declared: ReadonlySet<string>,
  models: ReadonlySet<string>,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const at = `prompts.${prompt.id}`;
  if (!models.has(prompt.model)) {
    problems.push(problem('prompt-model-unresolved', at, `model ${prompt.model} is not declared`));
  }
  if (prompt.output.kind === 'structured') {
    const schema = prompt.output.schema;
    if (schema === undefined || !refRenderable(schema, declared)) {
      problems.push(
        problem(
          'prompt-output-unsupported',
          at,
          'a structured prompt needs a resolvable schema, or there is nothing for zod to validate',
        ),
      );
    }
  } else if (prompt.output.kind === 'json') {
    problems.push(
      problem(
        'prompt-output-unsupported',
        at,
        'json output has no schema to validate against; declare `structured` instead',
      ),
    );
  }
  for (const variable of prompt.variables) {
    if (variable.type.list) {
      problems.push(
        problem('prompt-variable-unsupported', at, `variable ${variable.name} is list-typed`),
      );
    }
  }
  problems.push(...checkPromptTemplate(prompt, at));
  return problems;
}

/**
 * The template's placeholders, checked against what the runtime can actually render.
 *
 * A generated prompt is stored as a `str.format` body, which cannot express attribute
 * access and refuses a value the template never uses. Both defects would pass every
 * byte-level golden and fail on the first request, so they are refused here instead.
 */
function checkPromptTemplate(prompt: PromptShape, at: string): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const declared = new Set(prompt.variables.map((variable) => variable.name));
  for (const name of templatePlaceholders(prompt.template)) {
    if (name.includes('.')) {
      problems.push(
        problem(
          'unsupported-placeholder',
          `${at}.template`,
          `'{{ ${name} }}' is a dotted placeholder; the runtime renders with str.format ` +
            'keywords, which cannot express attribute access. Flatten it to a declared variable',
        ),
      );
      continue;
    }
    if (!declared.has(name)) {
      problems.push(
        problem(
          'unsupported-placeholder',
          `${at}.template`,
          `'{{ ${name} }}' is not a declared variable, so the generated render call ` +
            'would ask the registry for a value nothing supplies',
        ),
      );
    }
  }
  return problems;
}

export function checkTools(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const declared = new Set(ir.types.map((shape) => shape.id));
  for (const tool of ir.tools) {
    problems.push(...checkToolShape(tool, declared));
  }
  return problems;
}

function checkToolShape(tool: ToolShape, declared: ReadonlySet<string>): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const at = `tools.${tool.id}`;
  if (tool.handler.kind === 'mcp') {
    problems.push(
      problem(
        'tool-handler-unsupported',
        at,
        'MCP tool handlers are a Phase 2 concern; no adapter is emitted',
      ),
    );
  }
  if (tool.auth !== undefined) {
    problems.push(
      problem(
        'tool-auth-unsupported',
        at,
        'the runtime has no authorization hook, so a declared policy would not be enforced',
      ),
    );
  }
  /* `requiresConfirmation` is honoured by the agent loop, and this target emits no agent
   * route: a pipeline step calls a tool directly, with nothing in between to ask a
   * question. Emitting the flag would be a promise no route keeps. */
  if (tool.requiresConfirmation) {
    problems.push(
      problem(
        'tool-confirmation-unsupported',
        at,
        'this target emits no agent route, and a pipeline step has no confirmation step, ' +
          'so the flag would not be honoured',
      ),
    );
  }
  if (!refRenderable(tool.input, declared) || !refRenderable(tool.output, declared)) {
    problems.push(
      problem('type-unsupported', at, 'a tool input or output schema is not renderable'),
    );
  }
  if (tool.handler.kind === 'business' && tool.handler.symbol === undefined) {
    problems.push(
      problem('tool-handler-unsupported', at, 'a business handler needs a symbol to seed'),
    );
  }
  return problems;
}

export function checkRetrievers(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const embeddings = new Set(ir.embeddings.map((shape) => shape.id));
  const stores = new Map(ir.stores.map((shape) => [shape.id, shape]));
  const models = new Map(ir.models.map((shape) => [shape.id, shape]));
  for (const retriever of ir.retrievers) {
    const at = `retrievers.${retriever.id}`;
    const store = stores.get(retriever.store);
    if (store === undefined) {
      problems.push(
        problem('retriever-store-unsupported', at, `store ${retriever.store} is not declared`),
      );
    } else if (store.kind !== 'memory' && store.kind !== 'pgvector') {
      problems.push(
        problem(
          'retriever-store-unsupported',
          at,
          `store kind ${store.kind} has no runtime adapter; memory and pgvector do`,
        ),
      );
    }
    if (!embeddings.has(retriever.embedModel)) {
      problems.push(
        problem(
          'retriever-embedding-unresolved',
          at,
          `embedModel ${retriever.embedModel} is not an embeddings entry`,
        ),
      );
    }
    if (retriever.source.kind !== 'file') {
      problems.push(
        problem(
          'retriever-source-unsupported',
          at,
          `source kind ${retriever.source.kind} is not wired; the runtime ships a file connector only`,
        ),
      );
    }
    if (retriever.filters !== undefined && retriever.filters.length > 0) {
      problems.push(
        problem(
          'retriever-filters-unsupported',
          at,
          'filters would have to be pushed into every store adapter, which spec v0.1 does not do',
        ),
      );
    }
    if (retriever.rerank !== undefined) {
      const model = models.get(retriever.rerank.model);
      if (model === undefined) {
        problems.push(
          problem(
            'reference-unresolved',
            `${at}.rerank`,
            `rerank model ${retriever.rerank.model} is not declared`,
          ),
        );
      }
    }
  }
  return problems;
}

export function checkPipelines(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const tools = new Set(ir.tools.map((tool) => tool.id));
  const prompts = new Map(ir.prompts.map((prompt) => [prompt.id, prompt]));
  const retrievers = new Set(ir.retrievers.map((retriever) => retriever.id));
  for (const pipeline of ir.pipelines) {
    problems.push(...checkPipelineShape(pipeline, tools, prompts, retrievers));
  }
  return problems;
}

/**
 * One reason for every kind this target cannot emit, so the gap is named in one place.
 *
 * Exported because the emitter raises the identical diagnostic when it is reached without
 * the validator having run -- see D-4. The message names the target rather than a layer,
 * so a CLI can print it without the reader knowing the roadmap.
 */
export function stepUnsupported(kind: string, at: string): PlanProblem {
  return problem(
    'step-unsupported',
    at,
    `the Next.js target has no emitter for step kind ${kind}; remove the step or generate the Python target`,
  );
}

/** The declarations a step list is checked against, passed down into nested lists. */
interface StepDeclarations {
  readonly tools: ReadonlySet<string>;
  readonly prompts: ReadonlyMap<string, PromptShape>;
  readonly retrievers: ReadonlySet<string>;
}

function checkPipelineShape(
  pipeline: PipelineShape,
  tools: ReadonlySet<string>,
  prompts: ReadonlyMap<string, PromptShape>,
  retrievers: ReadonlySet<string>,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const at = `pipelines.${pipeline.id}`;
  if (pipeline.trigger.kind !== 'http') {
    problems.push(
      problem(
        'trigger-unsupported',
        `${at}.trigger`,
        `trigger kind ${pipeline.trigger.kind} has no Next.js host; only an http trigger is served`,
      ),
    );
  }
  const declarations = { tools, prompts, retrievers };
  problems.push(...checkSteps(pipeline.steps, `${at}.steps`, declarations, new Set<string>()));
  return problems;
}

/**
 * One step list, checked end to end, recursing into the composites.
 *
 * `at` is the path of the list (not of the step), so a nested list extends the same shape
 * the emitter uses: `pipelines.<id>.steps.2.then.0` names the first step of the third
 * step's `then` arm both here and in the emitted diagnostic.
 */
function checkSteps(
  steps: readonly StepShape[],
  at: string,
  declarations: StepDeclarations,
  bound: Set<string>,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const bind = (name: string, stepAt: string): void => {
    if ((RESERVED_BINDINGS as readonly string[]).includes(name)) {
      problems.push(
        problem('reference-unresolved', stepAt, `binding ${name} collides with a runtime name`),
      );
    }
    if (bound.has(name)) {
      problems.push(problem('reference-unresolved', stepAt, `binding ${name} is already bound`));
    }
    bound.add(name);
  };
  for (const [index, step] of steps.entries()) {
    const stepAt = `${at}.${index}`;
    if (isCompositeStep(step)) {
      problems.push(...checkComposite(step, stepAt, declarations, bound));
      // `map` and `reduce` bind their result; `branch` and `parallel` bind only inside an
      // arm, and which arm ran is not knowable at generation time, so a later step may
      // not read those. Not adding them is what makes that a refusal rather than a
      // reference the emitted route resolves to `undefined`.
      if (step.kind === 'map' || step.kind === 'reduce') bind(step.as, stepAt);
      continue;
    }
    // `rerank`, `guard` and `agent` are leaves, not composites, but they are just as
    // unemitted: the Python target generates them and this one refuses them with the same
    // reason, so the gap is named rather than silently emitted as nothing.
    if (step.kind === 'rerank' || step.kind === 'guard' || step.kind === 'agent') {
      problems.push(stepUnsupported(step.kind, stepAt));
      continue;
    }
    problems.push(...checkStepShape(step, stepAt, declarations, bound));
    if (step.kind !== 'emit') bind(step.as, stepAt);
  }
  return problems;
}

/**
 * A composite's arms, each checked against the bindings that exist *before* the composite.
 *
 * The fresh `Set` per arm is what keeps a `branch` from letting its `then` arm see what its
 * `else` arm bound: at run time exactly one of them executes, so a spec that depends on
 * both is a bug the generator can see and the runtime could not.
 */
function checkComposite(
  step: BranchStep | ParallelStep | MapStep | ReduceStep,
  at: string,
  declarations: StepDeclarations,
  bound: ReadonlySet<string>,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (step.kind === 'branch') {
    problems.push(...checkSteps(step.then, `${at}.then`, declarations, new Set(bound)));
    problems.push(...checkSteps(step.else, `${at}.else`, declarations, new Set(bound)));
  } else if (step.kind === 'parallel') {
    for (const [arm, steps] of step.branches.entries()) {
      problems.push(...checkSteps(steps, `${at}.arm.${arm}`, declarations, new Set(bound)));
    }
  } else if (step.kind === 'map') {
    problems.push(...checkSteps([step.step], `${at}.step`, declarations, new Set(bound)));
  } else {
    const prompt = declarations.prompts.get(step.prompt);
    if (prompt !== undefined && prompt.variables.length > 1) {
      problems.push(
        problem(
          'step-unsupported',
          at,
          `a reduce prompt takes exactly one variable -- the iteration item -- but ${step.prompt} declares ${prompt.variables.length}`,
        ),
      );
    }
    problems.push(...checkSteps([reduceBody(step)], `${at}.item`, declarations, new Set(bound)));
  }
  return problems;
}

/**
 * The `generate` a `reduce` body is checked as, mirrored from the emitter.
 *
 * Duplicated rather than shared for the same reason `retrievalEvalHasRetriever` is: the
 * validator has to refuse what the emitter could only render wrongly, so it cannot call
 * the code it is guarding. A drift here shows up as a `reduce` whose body prompt is
 * missing a variable, which is refused rather than emitted with an unbound input.
 */
function reduceBody(step: ReduceStep): GenerateStep {
  return {
    kind: 'generate',
    prompt: step.prompt,
    model: step.model,
    as: 'reduced',
    input: { item: { kind: 'reference', path: ['item'] } },
  };
}

function checkStepShape(
  step: GenerateStep | RetrieveStep | ToolStep | EmitStep,
  at: string,
  declarations: StepDeclarations,
  bound: ReadonlySet<string>,
): PlanProblem[] {
  const { tools, prompts, retrievers } = declarations;
  const problems: PlanProblem[] = [];
  if (step.kind === 'tool') {
    if (!tools.has(step.tool)) {
      problems.push(problem('reference-unresolved', at, `tool ${step.tool} is not declared`));
    }
  }
  if (step.kind === 'retrieve' && !retrievers.has(step.retriever)) {
    problems.push(
      problem('reference-unresolved', at, `retriever ${step.retriever} is not declared`),
    );
  }
  if (step.kind === 'generate') {
    const prompt = prompts.get(step.prompt);
    if (prompt === undefined) {
      problems.push(problem('reference-unresolved', at, `prompt ${step.prompt} is not declared`));
    } else if (prompt.output.kind !== 'structured') {
      problems.push(
        problem(
          'step-unsupported',
          at,
          `prompt ${step.prompt} emits text, but this target emits structured answers only`,
        ),
      );
    }
    if (step.context !== undefined && !bound.has(step.context)) {
      problems.push(
        problem(
          'reference-unresolved',
          at,
          `context binding ${step.context} is not bound at this step`,
        ),
      );
    }
  }
  if (step.kind === 'emit') {
    // The terminal `emit` names the event the pipeline hands back. There is no event bus
    // in Phase 1, and the route reads the bound value directly, so the step needs no
    // emitted binding -- but it is part of the spec language and must not be refused.
    return problems;
  }
  return problems;
}

/**
 * The retriever a retrieval eval samples, resolved the same way the emitter resolves it.
 *
 * Duplicated on purpose: the validator must refuse a plan the emitter could only render
 * as an empty id, so it cannot delegate the question to the code it is guarding.
 */
function retrievalEvalHasRetriever(ir: IR, evaluation: EvalShape): boolean {
  if (evaluation.target.kind === 'pipeline') {
    const pipeline = ir.pipelines.find((candidate) => candidate.id === evaluation.target.id);
    if (pipeline?.steps.some((step) => step.kind === 'retrieve')) return true;
  }
  return ir.retrievers.length === 1;
}

export function checkEvals(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const pipelines = new Set(ir.pipelines.map((pipeline) => pipeline.id));
  const prompts = new Set(ir.prompts.map((prompt) => prompt.id));
  for (const evaluation of ir.evals) {
    const at = `evals.${evaluation.id}`;
    if (evaluation.target.kind === 'pipeline' && !pipelines.has(evaluation.target.id)) {
      problems.push(
        problem('eval-target-unresolved', at, `pipeline ${evaluation.target.id} is not declared`),
      );
    }
    if (evaluation.target.kind === 'prompt' && !prompts.has(evaluation.target.id)) {
      problems.push(
        problem('eval-target-unresolved', at, `prompt ${evaluation.target.id} is not declared`),
      );
    }
    if (evaluation.dataset.source === 'synthetic') {
      problems.push(
        problem('eval-dataset-unsupported', at, 'a synthetic dataset has no file to load'),
      );
    }
    for (const metric of evaluation.metrics) {
      if (metric.kind === 'retrieval' && !retrievalEvalHasRetriever(ir, evaluation)) {
        problems.push(
          problem(
            'eval-target-unresolved',
            at,
            'a retrieval eval needs a retriever: name one through a pipeline target or declare exactly one',
          ),
        );
      }
      if (!SUPPORTED_METRICS.has(metric.kind)) {
        problems.push(
          problem(
            'eval-metric-unsupported',
            at,
            `metric ${metric.kind} has no emitted binding; supported: ${[...SUPPORTED_METRICS].join(', ')}`,
          ),
        );
      }
    }
  }
  return problems;
}

/** Every check, in a fixed order so a failing run reports the same problems twice. */
export function checkPlan(ir: IR): PlanProblem[] {
  return [
    ...checkIrVersion(ir),
    ...checkTarget(ir),
    ...checkCollections(ir),
    ...checkDeployments(ir),
    ...checkObservability(ir),
    ...checkRuntime(ir),
    ...checkTypes(ir),
    ...checkModels(ir),
    ...checkPrompts(ir),
    ...checkTools(ir),
    ...checkRetrievers(ir),
    ...checkPipelines(ir),
    ...checkEvals(ir),
  ];
}

/**
 * The capabilities the IR actually requires, by name. Kept here because the generator
 * is the side that knows what it will honour; the CLI's gate is fed the manifest's
 * declaration and the two are compared in a test.
 */
export function declaredCapabilities(): readonly string[] {
  return TS_VERCEL_MANIFEST.capabilities.filter((capability) => isRequiredCapability(capability));
}

export type { Capability, ModelCapability };
