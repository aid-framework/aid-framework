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
  type AgentStep,
  type BranchStep,
  type DecisionShape,
  type EmitStep,
  type EvalShape,
  evalSubject,
  type GenerateStep,
  type GuardrailShape,
  type GuardStep,
  type IR,
  isCompositeStep,
  isManagedRetriever,
  isRequiredCapability,
  type MapStep,
  type MetricShape,
  type ModelCapability,
  type ParallelStep,
  type PipelineShape,
  type PrimitiveType,
  type PromptShape,
  type ReduceStep,
  type RerankStep,
  type RetrieveStep,
  type RouteStep,
  type StepShape,
  type ToolShape,
  type ToolStep,
  type TypeRef,
  type TypeShape,
} from '@aid-framework/ir';
import { TS_VERCEL_MANIFEST, TS_VERCEL_TARGET } from './manifest.js';
import {
  ADAPTER_CAPABILITIES,
  type Capability,
  modelCapabilityMember,
  providerAdapter,
} from './names.js';
import { templatePlaceholders } from './placeholders.js';
import { nonStreamableReason } from './streaming.js';

export type PlanProblemCode =
  | 'ir-version-unsupported'
  | 'target-unsupported'
  | 'collection-unsupported'
  | 'observability-redact-unsupported'
  | 'observability-export-unsupported'
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
  | 'step-invalid'
  | 'guardrail-unsupported'
  | 'agent-unsupported'
  | 'memory-unsupported'
  | 'reference-unresolved'
  | 'trigger-unsupported'
  | 'retriever-store-unsupported'
  | 'retriever-knowledge-base-unsupported'
  | 'retriever-source-unsupported'
  | 'retriever-embedding-unresolved'
  | 'eval-target-unresolved'
  | 'eval-target-unsupported'
  | 'eval-metric-unsupported'
  | 'eval-dataset-unsupported'
  | 'streaming-unsupported'
  | 'deployment-unsupported';

export interface PlanProblem {
  readonly code: PlanProblemCode;
  readonly path: string;
  readonly message: string;
}

/**
 * The guardrail policies the TypeScript runtime implements, mirroring its `DETECTORS`
 * table one for one.
 *
 * The IR's vocabulary is wider than the engine's: `jailbreak`, `moderation` and
 * `toxicity` are declared policy kinds with no detector behind them, and an emitted app
 * that named one would raise on the first request that reached it. Refusing them here
 * rather than at run time is the same rule the rest of this file follows.
 */
const IMPLEMENTED_POLICIES: ReadonlySet<GuardrailShape['policies'][number]> = new Set<
  GuardrailShape['policies'][number]
>(['pii-detect', 'pii-redact', 'prompt-injection', 'secret-scan']);

/**
 * The policies whose firing the runtime can mask rather than only report.
 *
 * `prompt-injection` detects intent, so there is no value to strip: the runtime raises
 * instead of returning a cleaned payload, which makes `action: redact` a lie.
 */
const REDACTABLE_POLICIES: ReadonlySet<GuardrailShape['policies'][number]> = new Set<
  GuardrailShape['policies'][number]
>(['pii-detect', 'pii-redact', 'secret-scan']);

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
  'assert',
]);

export function problem(code: PlanProblemCode, path: string, message: string): PlanProblem {
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

/**
 * `deployments`: only the concurrency cap is emitted, and only what the host can honour.
 *
 * `secrets` needs no check: the adapters read a declared secret by name from the
 * environment, so the declaration is documentation, not an artifact to emit.
 *
 * A `batch` target is refused because it runs to completion rather than answering a
 * request. Whether streaming is possible is a property of the pipelines, not of the
 * deployment that asks for it, so `checkStreaming` owns that question.
 */
export function checkDeployments(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const deployment of ir.deployments) {
    const at = `deployments.${deployment.id}`;
    if (deployment.target === 'batch') {
      problems.push(
        problem(
          'deployment-unsupported',
          `${at}.target`,
          'a batch job runs to completion, and this target deploys a request/response ' +
            'function; use the py-fastapi target for a batch deployment',
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

/**
 * `deployments[].streaming`: the document asks for SSE, so every HTTP pipeline must be
 * able to serve it.
 *
 * The shape rule is `./streaming.ts`'s, deliberately not restated here: a stream carries
 * exactly one `generate` step's output, so a pipeline with no single top-level `generate`,
 * or with a step after it that is not `emit`, has work a stream cannot represent. Emitting
 * the route anyway would run that work on the JSON path and skip it on the streaming path
 * -- the same request answered differently depending on what the caller's `Accept` header
 * said. Refused by name instead, because a route that quietly drops a step is worse than
 * one that will not generate.
 *
 * An `output` guardrail is refused for the same reason from the other direction: nothing
 * inspects the finished text on a stream, so the declaration would be enforced for one
 * media type and not the other.
 */
export function checkStreaming(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const models = new Map(ir.models.map((model) => [model.id, model]));
  const asking = ir.deployments.filter(
    (deployment) => deployment.streaming && deployment.target !== 'batch',
  );
  if (asking.length === 0) return problems;

  const output = ir.guardrails.filter((guardrail) => guardrail.stages.includes('output'));
  if (output.length > 0) {
    problems.push(
      problem(
        'streaming-unsupported',
        `deployments.${asking[0]?.id ?? ''}`,
        "streaming sends the model's text as it is produced, so an `output`-stage guardrail " +
          `would never run; '${output[0]?.id ?? ''}' is declared, so either drop it or drop streaming`,
      ),
    );
  }

  for (const pipeline of ir.pipelines) {
    if (pipeline.trigger.kind !== 'http') continue;
    const reason = nonStreamableReason(pipeline);
    if (reason !== undefined) {
      problems.push(problem('streaming-unsupported', `pipelines.${pipeline.id}`, reason));
      continue;
    }
    // `nonStreamableReason` asks whether a stream could carry this pipeline's shape. This
    // asks whether the model it generates with can produce one: the emitted route calls
    // `gateway.stream()` on that alias, which requires the adapter to serve `streaming`,
    // and a pinned model advertising a member its adapter lacks is refused separately --
    // but a spec that only sets `deployments[].streaming` declares no model capability at
    // all, so nothing tied the two together.
    const step = pipeline.steps.find((candidate) => candidate.kind === 'generate');
    const model = step === undefined ? undefined : models.get(step.model);
    const adapter = model === undefined ? undefined : providerAdapter(model.provider);
    if (model === undefined || adapter === undefined) continue;
    if (ADAPTER_CAPABILITIES[adapter].has('streaming')) continue;
    problems.push(
      problem(
        'streaming-unsupported',
        `pipelines.${pipeline.id}`,
        `pipeline '${pipeline.id}' generates with model '${model.id}' (${model.modelId}), which ` +
          `provider '${model.provider}' serves through ${adapter}; that adapter does not serve ` +
          "`streaming`, so the emitted route's `gateway.stream()` would raise on the first " +
          'request instead of streaming. Pin a model whose adapter streams, or drop `streaming`',
      ),
    );
  }
  return problems;
}

export function checkObservability(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  // `otel` on this target means spans are recorded against the GenAI attribute schema,
  // which `runtimes/typescript/src/tracing.ts` does. It never meant they leave the
  // process: that module is API-only by design. `export: otlp` asks for the leaving half,
  // so accepting it here would emit a deployment that declares a collector it never
  // sends a span to -- a silent gap over exactly the traffic an operator was trying to
  // see. py-fastapi wires this through `aid_runtime.telemetry.configure_export`, so the
  // fix is named rather than implied.
  if (ir.observability.export === 'otlp') {
    problems.push(
      problem(
        'observability-export-unsupported',
        'observability.export',
        'this target records spans but installs no exporter, so `otlp` would name a collector nothing is sent to; generate this document with py-fastapi to export, or declare `export: none` to keep spans in the process',
      ),
    );
  }
  if (ir.observability.redact.length === 0) return problems;
  problems.push(
    problem(
      'observability-redact-unsupported',
      'observability.redact',
      'the runtime exposes no redaction hook, so declared redaction paths would not be honoured',
    ),
  );
  return problems;
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
    const adapter = providerAdapter(model.provider);
    if (adapter === undefined) {
      problems.push(
        problem(
          'model-provider-unsupported',
          at,
          `provider ${model.provider} has no TypeScript adapter; the runtime ships fake, openai-compatible, anthropic and bedrock adapters`,
        ),
      );
    }
    for (const capability of model.capabilities) {
      const member = modelCapabilityMember(capability);
      if (member === undefined) {
        problems.push(
          problem(
            'model-capability-unsupported',
            at,
            `capability ${capability} has no runtime member, so the emitted ModelSpec would silently drop it`,
          ),
        );
      } else if (adapter !== undefined && !ADAPTER_CAPABILITIES[adapter].has(member)) {
        // The adapter table is what an emitted app can actually negotiate. Refusing here
        // keeps the pinned spec from advertising a capability only the call would discover.
        problems.push(
          problem(
            'model-capability-unsupported',
            at,
            `capability ${capability} is not served by ${adapter}, so the emitted ModelSpec would silently drop it`,
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
    if (isManagedRetriever(retriever)) {
      // A managed knowledge base is a server-side retrieve call the runtime reaches
      // through a cloud SDK. This target has no such client and runs where those
      // credentials are not available, so it refuses rather than emitting a binding
      // that cannot search. `target: py-fastapi` is the shipped alternative.
      problems.push(
        problem(
          'retriever-knowledge-base-unsupported',
          at,
          `retriever "${retriever.id}" reads managed knowledge base "${retriever.knowledgeBase}", which this target has no runtime client for; use target: py-fastapi`,
        ),
      );
      continue;
    }
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
    if (retriever.source.kind === 'db' || retriever.source.kind === 'mcp') {
      problems.push(
        problem(
          'retriever-source-unsupported',
          at,
          `source kind ${retriever.source.kind} is still reserved; s3 and http shipped in spec 0.21`,
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
  const declarations: StepDeclarations = {
    tools: new Set(ir.tools.map((tool) => tool.id)),
    prompts: new Map(ir.prompts.map((prompt) => [prompt.id, prompt])),
    retrievers: new Set(ir.retrievers.map((retriever) => retriever.id)),
    guardrails: new Map(ir.guardrails.map((guardrail) => [guardrail.id, guardrail])),
    agents: new Set(ir.agents.map((agent) => agent.id)),
    decisions: new Map(ir.decisions.map((decision) => [decision.id, decision])),
  };
  for (const pipeline of ir.pipelines) {
    if (pipeline.trigger?.kind !== 'http') {
      problems.push(
        problem(
          'deployment-unsupported',
          `pipelines.${pipeline.id}.trigger`,
          'this target emits one HTTP route per pipeline, so a manual trigger would be ' +
            'declared and never emitted; use the py-fastapi target for a batch job',
        ),
      );
    }
    problems.push(...checkPipelineShape(pipeline, declarations));
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
  readonly guardrails: ReadonlyMap<string, GuardrailShape>;
  readonly agents: ReadonlySet<string>;
  readonly decisions: ReadonlyMap<string, DecisionShape>;
}

function checkPipelineShape(
  pipeline: PipelineShape,
  declarations: StepDeclarations,
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
      if (step.kind === 'route') {
        const checked = checkRouteStep(step, stepAt, declarations, bound);
        problems.push(...checked.problems);
        for (const name of [...checked.alwaysBound, ...(step.as === undefined ? [] : [step.as])]) {
          bind(name, stepAt);
        }
        continue;
      }
      problems.push(...checkComposite(step, stepAt, declarations, bound));
      // `map` and `reduce` bind their result; `branch` and `parallel` bind only inside an
      // arm, and which arm ran is not knowable at generation time, so a later step may
      // not read those. Not adding them is what makes that a refusal rather than a
      // reference the emitted route resolves to `undefined`.
      if (step.kind === 'map' || step.kind === 'reduce') bind(step.as, stepAt);
      continue;
    }
    // `rerank`, `guard` and `agent` are leaves with their own emitters. Each is checked
    // against what its emitted call actually does rather than refused wholesale, because
    // a refusal here would now be a refusal of something the runtime can run.
    if (step.kind === 'rerank') {
      problems.push(...checkRerankStep(step, stepAt, bound));
      bind(step.as, stepAt);
      continue;
    }
    if (step.kind === 'guard') {
      problems.push(...checkGuardStep(step, stepAt, declarations, bound));
      // A `guard` binds nothing -- there is no `as` -- so only the shapes above bind.
      continue;
    }
    if (step.kind === 'agent') {
      problems.push(...checkAgentStep(step, stepAt, declarations, bound));
      bind(step.as, stepAt);
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
 * The labels a decision can answer.
 *
 * A `choice` decision keeps its criteria as an object map in the spec and as a record or
 * a list in the IR, so both spellings are read rather than assuming one.
 */
function decisionLabels(decision: DecisionShape): string[] {
  if (decision.criteria === undefined) return [];
  return Array.isArray(decision.criteria) ? [...decision.criteria] : Object.keys(decision.criteria);
}

/**
 * A `route`, checked against the decision it asks and the arms it declares.
 *
 * The rule a route adds is that an answer must always have an arm: every label the
 * decision can return is mapped, or a `default` catches the ones that are not. That is
 * refused here rather than at run time because the runtime can only report an unmapped
 * answer as a failed request, and the spec author is the one who can fix it.
 *
 * `alwaysBound` is what a later step may read: an arm starts from the bindings that exist
 * before the route, and exactly one arm runs, so only a name every arm bound is sound
 * afterwards.
 */
function checkRouteStep(
  step: RouteStep,
  at: string,
  declarations: StepDeclarations,
  bound: ReadonlySet<string>,
): { readonly problems: PlanProblem[]; readonly alwaysBound: readonly string[] } {
  const problems: PlanProblem[] = [];
  const decision = declarations.decisions.get(step.decision);
  if (decision === undefined) {
    problems.push(problem('reference-unresolved', at, `decision ${step.decision} is not declared`));
    return { problems, alwaysBound: [] };
  }
  if (decision.type !== 'choice') {
    problems.push(
      problem(
        'step-unsupported',
        at,
        `decision ${step.decision} is a ${decision.type} decision; a route asks which arm to run, so it needs a choice decision`,
      ),
    );
    return { problems, alwaysBound: [] };
  }
  for (const name of unboundNames(step.input, bound)) {
    problems.push(
      problem(
        'reference-unresolved',
        `${at}.input`,
        `the route input names ${name}, which is not bound at this step`,
      ),
    );
  }
  const labels = decisionLabels(decision);
  const mapped = Object.keys(step.on);
  for (const label of mapped) {
    if (!labels.includes(label)) {
      problems.push(
        problem(
          'reference-unresolved',
          `${at}.on.${label}`,
          `decision ${step.decision} has no label ${label}; its labels are ${labels.join(', ') || 'none'}`,
        ),
      );
    }
  }
  const uncovered = labels.filter((label) => !mapped.includes(label));
  if (step.default === undefined && uncovered.length > 0) {
    problems.push(
      problem(
        'step-unsupported',
        at,
        `the route maps ${mapped.join(', ') || 'no label'}, but decision ${step.decision} can also answer ${uncovered.join(', ')}; map every label or add a default`,
      ),
    );
  }
  if (step.default !== undefined && uncovered.length === 0) {
    problems.push(
      problem(
        'step-unsupported',
        at,
        'the route declares a default, but every label is already mapped, so the arm can never run',
      ),
    );
  }
  const arms: (readonly [string, readonly StepShape[], string])[] = mapped.map((label) => [
    label,
    step.on[label] as readonly StepShape[],
    `${at}.on.${label}`,
  ]);
  if (step.default !== undefined) arms.push(['default', step.default, `${at}.default`]);
  const additions: (readonly string[])[] = [];
  for (const [, steps, path] of arms) {
    const armBound = new Set(bound);
    problems.push(...checkSteps(steps, path, declarations, armBound));
    additions.push([...armBound].filter((name) => !bound.has(name)));
  }
  const alwaysBound =
    additions.length === 0
      ? []
      : (additions[0] ?? []).filter((name) => additions.every((added) => added.includes(name)));
  return { problems, alwaysBound };
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
 * The placeholders in a rendered template that name nothing the step can read.
 *
 * `event` is the one name a step may read without binding it: the route seeds the request
 * into the pipeline context, which is how a `generate` step already reads it.
 */
function unboundNames(template: string, bound: ReadonlySet<string>): string[] {
  // A placeholder is `root.member...` and the emitted code reads it as
  // `context.require('root').member`, so the root is what must be bound. Comparing the
  // whole dotted name would refuse `{{ handbook.context }}` -- a property of a binding
  // that *is* bound -- and would also miss `event`, which no step binds.
  const roots = templatePlaceholders(template).map((name) => name.split('.')[0] ?? name);
  return [...new Set(roots)].filter((name) => name !== 'event' && !bound.has(name));
}

/**
 * A `rerank` step, checked against the one reranker the runtime implements.
 *
 * `rerankerFor` resolves an alias by looking for `lexical` in the model name and throws
 * `FeatureDeferredError` for anything else, so a spec naming a cross-encoder would emit an
 * app that fails on its first request. The plan refuses it with the same reason.
 */
function checkRerankStep(step: RerankStep, at: string, bound: ReadonlySet<string>): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (!bound.has(step.over)) {
    problems.push(
      problem(
        'reference-unresolved',
        at,
        `rerank reads binding ${step.over}, which is not bound at this step`,
      ),
    );
  }
  for (const name of unboundNames(step.query, bound)) {
    problems.push(
      problem('reference-unresolved', `${at}.query`, `binding ${name} is not bound at this step`),
    );
  }
  if (!step.model.toLowerCase().includes('lexical')) {
    problems.push(
      problem(
        'step-unsupported',
        at,
        `the runtime resolves only a lexical reranker, so model ${step.model} would throw FeatureDeferredError on the first request; name a lexical model`,
      ),
    );
  }
  if (!Number.isInteger(step.topN) || step.topN < 1) {
    problems.push(problem('step-invalid', at, `topN must be a positive integer, got ${step.topN}`));
  }
  return problems;
}

/**
 * A `guard` step: the guardrail it names, the stage it runs at, and its operand.
 *
 * The stage is the load-bearing part. `input` and `output` take a rendered payload and
 * `retrieval` takes one binding's passages -- exactly what the emitted call passes to
 * `checkRetrieval`. `tool-call` is refused, because the only thing that can hand the engine
 * a call's arguments is the call site: the emitted `tool` step checks its own call inline,
 * and a `guard` step standing beside it has no call to inspect.
 *
 * `retrieval` additionally requires the payload to name exactly one binding, because that
 * binding is the result the step guards; naming two would silently guard the first.
 */
function checkGuardStep(
  step: GuardStep,
  at: string,
  declarations: StepDeclarations,
  bound: ReadonlySet<string>,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const guardrail = declarations.guardrails.get(step.guardrail);
  if (guardrail === undefined) {
    problems.push(
      problem('reference-unresolved', at, `guardrail ${step.guardrail} is not declared`),
    );
  } else if (!guardrail.stages.includes(step.stage)) {
    problems.push(
      problem(
        'step-invalid',
        at,
        `guardrail ${step.guardrail} does not declare the ${step.stage} stage (declared: ${guardrail.stages.join(', ')}), so this step would enforce nothing`,
      ),
    );
  }
  if (guardrail?.decision !== undefined) {
    // A guard step is emitted as a synchronous check, and a decision-backed guardrail
    // needs a network round trip, so the step would pass the payload on without ever
    // asking. The agent loop asks asynchronously; a pipeline step cannot.
    problems.push(
      problem(
        'guardrail-unsupported',
        `${at}.guardrail`,
        `guardrail '${guardrail.id}' is answered by decision '${guardrail.decision}', which a ` +
          'pipeline step cannot ask: the step check is synchronous and the answer is a network call',
      ),
    );
  }
  if (step.stage === 'tool-call') {
    problems.push(
      problem(
        'step-unsupported',
        at,
        'a guard step cannot check the tool-call stage: a call’s arguments exist only at the call site, so the emitted tool step checks its own call',
      ),
    );
    return problems;
  }
  const names = unboundNames(step.text, bound);
  if (step.stage === 'retrieval') {
    const referenced = [
      ...new Set(templatePlaceholders(step.text).map((name) => name.split('.')[0] ?? name)),
    ];
    if (referenced.length !== 1) {
      problems.push(
        problem(
          'step-invalid',
          `${at}.text`,
          `a retrieval guard inspects exactly one retrieval binding, but this text names ${referenced.length}`,
        ),
      );
    }
  }
  for (const name of names) {
    problems.push(
      problem('reference-unresolved', `${at}.text`, `binding ${name} is not bound at this step`),
    );
  }
  return problems;
}

/** An `agent` step: the agent it names, and the bindings its text reads. */
function checkAgentStep(
  step: AgentStep,
  at: string,
  declarations: StepDeclarations,
  bound: ReadonlySet<string>,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (!declarations.agents.has(step.agent)) {
    problems.push(problem('reference-unresolved', at, `agent ${step.agent} is not declared`));
  }
  for (const name of unboundNames(step.text, bound)) {
    problems.push(
      problem('reference-unresolved', `${at}.text`, `binding ${name} is not bound at this step`),
    );
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
    // The module pins one model alias in its `GatewayRunner`; a target that renders two
    // prompts, or one prompt under two aliases, has no single alias to pin. Refused here
    // rather than emitted with whichever pair happened to come first.
    if (!evaluation.metrics.some((metric) => metric.kind === 'retrieval')) {
      const subject = evalSubject(ir, evaluation);
      if (!subject.ok) {
        problems.push(
          problem(
            subject.code === 'unresolved-reference'
              ? 'eval-target-unresolved'
              : 'eval-target-unsupported',
            at,
            subject.message,
          ),
        );
      } else if (subject.subject.kind === 'agent') {
        // `ir/eval-trajectory` refuses this too, by the `agent-evals` capability this target
        // does not declare. Repeated here because this check also runs without the gates, and
        // a module pinned to one model alias cannot express a run whose steps it never saw.
        problems.push(
          problem(
            'eval-target-unsupported',
            at,
            `'${evaluation.target.qualified}' runs an agent, and this target emits no offline ` +
              'agent evaluator: its eval module pins one model alias and samples one response, ' +
              'while an agent run makes calls the module would have to record; target the prompt ' +
              'the agent renders, or use a target that declares "agent-evals"',
          ),
        );
      }
    }
  }
  return problems;
}

/**
 * The guardrail declarations this target cannot honour.
 *
 * The IR layer has already refused an unknown policy, an empty stage list and a `tools`
 * entry that names nothing, so what is left is the part only a *target* knows: which
 * policies its engine can evaluate, which actions its routes can carry out, and which
 * fields its stages actually see.
 */
export function checkGuardrails(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const guardrail of ir.guardrails) {
    const at = `guardrails.${guardrail.id}`;
    if (guardrail.engine !== 'builtin') {
      // A managed guardrail is evaluated by a cloud service over HTTP, and this target's
      // engine is synchronous and ships no client for it -- the check would never run.
      problems.push(
        problem(
          'guardrail-unsupported',
          `${at}.engine`,
          `guardrail '${guardrail.id}' is evaluated by '${guardrail.engine}', which this target ` +
            'cannot call; managed guardrails are implemented by the Python target',
        ),
      );
      continue;
    }
    if (guardrail.decision !== undefined && guardrail.action === 'redact') {
      // A decision answers with a verdict, not a masked payload, so there is nothing for
      // `redact` to rewrite. The spec layer refuses this pair too; this is the target's
      // own backstop, kept so the emitter never has to decide what a maskless redact means.
      problems.push(
        problem(
          'guardrail-unsupported',
          `${at}.action`,
          `'${guardrail.id}' is answered by a decision, which returns a verdict rather than a ` +
            'masked payload, so action: redact has nothing to rewrite; map the decision with ' +
            'onDecision and use block, flag or escalate',
        ),
      );
    }
    for (const policy of guardrail.policies) {
      if (IMPLEMENTED_POLICIES.has(policy)) continue;
      problems.push(
        problem(
          'guardrail-unsupported',
          `${at}.policies`,
          `the TypeScript guardrail engine implements ${[...IMPLEMENTED_POLICIES].join(', ')} and would raise ConfigurationError on '${policy}'; use an implemented policy`,
        ),
      );
    }
    if (guardrail.action === 'escalate') {
      // Escalation is a question put to a human, answered by resuming a paused run. The
      // emitted app has no resume route (see the agents module), so an escalated request
      // would stop with nobody to answer -- which is a block wearing a different name.
      problems.push(
        problem(
          'guardrail-unsupported',
          `${at}.action`,
          "escalation needs a resume route, and this target emits none; use action 'block' to refuse the request or 'flag' to record it and continue",
        ),
      );
    }
    if (guardrail.action !== 'redact') continue;
    for (const policy of guardrail.policies) {
      if (!IMPLEMENTED_POLICIES.has(policy) || REDACTABLE_POLICIES.has(policy)) continue;
      problems.push(
        problem(
          'guardrail-unsupported',
          `${at}.policies`,
          `'${guardrail.id}' redacts, but policy '${policy}' detects intent rather than a maskable value, so the runtime raises instead of returning a cleaned payload; redact with ${[...REDACTABLE_POLICIES].join(', ')}, or use action 'block'`,
        ),
      );
    }
    if (guardrail.stages.includes('tool-call')) {
      // The emitted tool step checks its call and lets the verdict stand; it does not
      // re-bind the arguments, so a redaction here would be recorded and then ignored.
      problems.push(
        problem(
          'guardrail-unsupported',
          `${at}.stages`,
          "a redact guardrail at the tool-call stage would be checked but never applied -- the emitted tool step does not re-bind a call's arguments; use action 'block', or redact at input, output or retrieval",
        ),
      );
    }
    for (const name of guardrail.redact) {
      if (name === 'text') continue;
      problems.push(
        problem(
          'guardrail-unsupported',
          `${at}.redact`,
          `'${guardrail.id}' redacts field '${name}', but the input, output and retrieval payloads this target builds are exactly { text }, which is the only name that has anything to mask`,
        ),
      );
    }
  }
  return problems;
}

/**
 * The agent declarations this target cannot honour.
 *
 * The emitted `agents.ts` turns the whole collection into one `AgentRuntime` document, so
 * every agent a pipeline step can name has to be one the runtime can build. Most of these
 * are the runtime's own `fromIr` refusals moved to plan time; the rest are the two things
 * an emitted app cannot offer an agent -- a pause a route could resume, and a harness
 * dependency it does not install.
 */
export function checkAgents(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const promptById = new Map(ir.prompts.map((prompt) => [prompt.id, prompt]));
  const toolIds = new Set(ir.tools.map((tool) => tool.id));
  const memoryIds = new Set(ir.memory.map((memory) => memory.id));
  const guardrailIds = new Set(ir.guardrails.map((guardrail) => guardrail.id));
  const modelIds = new Set(ir.models.map((model) => model.id));

  for (const agent of ir.agents) {
    const at = `agents.${agent.id}`;
    // `AgentDefinition` has no retrievers: the loop builds its messages from the resolved
    // prompt and `memory` and never queries one, so the declaration would be dropped.
    if (agent.retrievers.length > 0) {
      problems.push(
        problem(
          'agent-unsupported',
          `${at}.retrievers`,
          `the agent loop has no retrieval step, so ${agent.retrievers.join(', ')} would never run; inline the retrieved context in the prompt instead`,
        ),
      );
    }
    // The loop returns the model's text as `answer` and validates no schema, so a declared
    // structured output would be a promise nothing keeps.
    if (agent.structuredOutput !== undefined) {
      problems.push(
        problem(
          'agent-unsupported',
          `${at}.structuredOutput`,
          "the agent loop performs no structured-output validation, so this declaration would not be enforced; declare the schema on the agent's prompt",
        ),
      );
    }
    // The instructions prompt becomes the system message through its *template*, verbatim:
    // `fromIr` reads it and the loop never renders variables, so a prompt with variables
    // would reach the model as unrendered `{{name}}` text.
    const instructions = promptById.get(agent.instructions);
    if (instructions === undefined) {
      problems.push(
        problem(
          'reference-unresolved',
          `${at}.instructions`,
          `prompt ${agent.instructions} is not declared`,
        ),
      );
    } else if (instructions.variables.length > 0) {
      problems.push(
        problem(
          'agent-unsupported',
          `${at}.instructions`,
          `prompt ${instructions.id} declares variables (${instructions.variables
            .map((variable) => variable.name)
            .join(
              ', ',
            )}) that the agent loop never renders, so the model would receive the template verbatim; give the agent a variable-free prompt`,
        ),
      );
    }
    for (const toolId of agent.tools) {
      if (!toolIds.has(toolId)) {
        problems.push(
          problem('reference-unresolved', `${at}.tools`, `tool ${toolId} is not declared`),
        );
      }
    }
    for (const memoryId of agent.memory) {
      if (!memoryIds.has(memoryId)) {
        problems.push(
          problem('reference-unresolved', `${at}.memory`, `memory ${memoryId} is not declared`),
        );
      }
    }
    for (const guardrailId of agent.guardrails) {
      if (!guardrailIds.has(guardrailId)) {
        problems.push(
          problem(
            'reference-unresolved',
            `${at}.guardrails`,
            `guardrail ${guardrailId} is not declared`,
          ),
        );
      }
    }
    if (!modelIds.has(agent.model)) {
      problems.push(
        problem('reference-unresolved', `${at}.model`, `model ${agent.model} is not declared`),
      );
    }
    // The runtime refuses every other engine, so naming one here would make the module's
    // first `run` throw. `native` is the one engine whose harness this app installs.
    if (agent.engine !== 'native') {
      problems.push(
        problem(
          'agent-unsupported',
          `${at}.engine`,
          `the emitted app installs no '${agent.engine}' harness, so this engine would raise on the first run; use engine 'native'`,
        ),
      );
    }
    // A pause is a question put to a human, answered by resuming the run. Nothing in an
    // emitted app can resume one: there is no `/resume` route, and the pipeline step that
    // runs an agent raises rather than binding a paused outcome.
    if (agent.humanInTheLoop !== undefined) {
      problems.push(
        problem(
          'agent-unsupported',
          `${at}.humanInTheLoop`,
          'a paused run needs a resume route, and this target emits none; remove the human-in-the-loop gate or run the agent outside the pipeline',
        ),
      );
    }
  }
  // A model the emitted document reaches must be priced: `modelDefinition` throws on an
  // unpriced model because no budget can be enforced against one, and it is reached for
  // exactly the agents' own models plus their fallback closure -- the same set emitted.
  const models = new Map(ir.models.map((model) => [model.id, model]));
  for (const alias of reachableAliases(ir)) {
    const model = models.get(alias);
    if (model === undefined || model.costProfile !== undefined) continue;
    problems.push(
      problem(
        'agent-unsupported',
        `models.${model.id}.costProfile`,
        `model ${model.id} resolves no cost profile, and the agent loop refuses an unpriced model because no budget can be enforced against one; this model is an agent's own or reached through its fallbacks, so the emitted document needs it -- use a catalogued modelId, or drop the fallback that reaches this one`,
      ),
    );
  }
  return problems;
}

/**
 * Every model alias the emitted agent document resolves, following fallbacks.
 *
 * Mirrors the runtime's `reachableModels`: a fallback's own fallbacks are reachable too, so
 * a walk that stopped at one hop would miss the model the runtime actually builds.
 */
function reachableAliases(ir: IR): ReadonlySet<string> {
  const fallbacks = new Map(ir.models.map((model) => [model.id, model.fallbacks]));
  const reachable = new Set<string>();
  const queue = ir.agents.map((agent) => agent.model);
  while (queue.length > 0) {
    const alias = queue.pop() as string;
    if (reachable.has(alias)) continue;
    reachable.add(alias);
    queue.push(...(fallbacks.get(alias) ?? []));
  }
  return reachable;
}

/**
 * The memory declarations this target cannot honour, refused rather than approximated.
 *
 * This mirrors the runtime's `checkMemorySupported` plus the two fields its
 * `memoryDefinition` and `#storeFor` refuse. The runtime raises on all of them, so a plan
 * that emitted one would produce an app that fails on the first request; catching them here
 * turns that into a generation failure that names the declaration.
 */
export function checkMemory(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const memory of ir.memory) {
    const at = `memory.${memory.id}`;
    if (memory.kind !== 'buffer' && memory.kind !== 'window') {
      problems.push(
        problem(
          'memory-unsupported',
          `${at}.kind`,
          `the runtime implements buffer and window memory and refuses '${memory.kind}' by name; serve it as a buffer, or declare the kind once the runtime grows a summarizer or an index`,
        ),
      );
    }
    if (memory.summarizeModel !== undefined) {
      problems.push(
        problem(
          'memory-unsupported',
          `${at}.summarizeModel`,
          'no summarizer is implemented, so this declaration would be ignored',
        ),
      );
    }
    if (memory.ttl !== undefined) {
      problems.push(
        problem(
          'memory-unsupported',
          `${at}.ttl`,
          'expiry enforcement is not implemented, so entries would never expire',
        ),
      );
    }
    if (memory.redact.length > 0) {
      problems.push(
        problem(
          'memory-unsupported',
          `${at}.redact`,
          'memory redaction is not implemented, so the declared fields would still be stored and replayed',
        ),
      );
    }
    if (memory.backend !== undefined && memory.backend !== 'in-process') {
      problems.push(
        problem(
          'memory-unsupported',
          `${at}.backend`,
          `the emitted app registers no MemoryStore, so backend '${memory.backend}' would raise ConfigurationError on the first write; omit 'backend', or set it to 'in-process'`,
        ),
      );
    }
    if (memory.store !== undefined) {
      problems.push(
        problem(
          'memory-unsupported',
          `${at}.store`,
          "the runtime selects its store from 'backend' and never reads 'store'; set 'backend' instead",
        ),
      );
    }
    if (!Number.isInteger(memory.tokenBudget) || memory.tokenBudget < 1) {
      problems.push(
        problem(
          'memory-unsupported',
          `${at}.tokenBudget`,
          `the runtime needs a positive integer token budget, got ${memory.tokenBudget}`,
        ),
      );
    }
  }
  return problems;
}

/** Every check, in a fixed order so a failing run reports the same problems twice. */
export function checkPlan(ir: IR): PlanProblem[] {
  return [
    ...checkIrVersion(ir),
    ...checkTarget(ir),
    ...checkDeployments(ir),
    ...checkStreaming(ir),
    ...checkObservability(ir),
    ...checkRuntime(ir),
    ...checkTypes(ir),
    ...checkModels(ir),
    ...checkPrompts(ir),
    ...checkTools(ir),
    ...checkGuardrails(ir),
    ...checkAgents(ir),
    ...checkMemory(ir),
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
