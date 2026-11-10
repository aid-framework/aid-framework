/**
 * Everything the py-fastapi target cannot express, as a pure decision table.
 *
 * `plan()` must never guess: a declaration that would be silently dropped is a
 * promise the generated app does not keep. The rule this file applies is:
 *
 * * a declaration that affects a **safety, authorization or quality guarantee**
 *   (tool auth, confirmation, an unmappable capability, a metric the runtime
 *   cannot measure) is a *problem* -- generation stops with a precise reason;
 * * a declaration that only *describes* the IR (side-effect levels, idempotency,
 *   tool retries) is documented as not-yet-wired in the package README rather
 *   than rejected, because it changes nothing about the emitted contract.
 *
 * Every check below is a pure function of the IR, so every branch is reachable
 * from a unit test without disk, network or a spec file.
 */

import {
  type AgentShape,
  type EvalShape,
  type EvalSubject,
  type EvalSubjectResult,
  evalSubject,
  type IR,
  isLocalRetriever,
  isManagedRetriever,
  type KnowledgeBaseEngine,
  type KnowledgeBaseShape,
  type ManagedRetrieverShape,
  type ModelParams,
  type ModelShape,
  modelsUnderTest,
  type PipelineShape,
  type PromptShape,
  type RetrieverShape,
  SERVED_PROVIDERS,
  type StepInput,
  type StepShape,
  type ToolShape,
  type TypeRef,
  type TypeShape,
} from '@aid-framework/ir';

import { PY_FASTAPI_MANIFEST, supportsIrVersion } from './manifest.js';
import { isRetrievalEval, judgeAlias, mapMetric } from './metrics.js';
import { ADAPTER_CAPABILITIES, isUsableIdentifier, moduleName, providerAdapter } from './names.js';
import { scanTemplate, templatePlaceholders } from './placeholders.js';
import { streamablePipeline } from './streaming.js';

/**
 * The policies a `redact` action can mask, mirroring `_REDACTABLE` in
 * `aid_runtime.agents.guardrails`. The rest detect intent -- a jailbreak attempt has no
 * value to mask -- so the runtime raises rather than returning a cleaned payload.
 */
const REDACTABLE_POLICIES = ['pii-detect', 'pii-redact', 'secret-scan'] as const;

export type PlanProblemCode =
  | 'ambiguous-emit'
  | 'duplicate-binding'
  | 'duplicate-metric'
  | 'invalid-gate'
  | 'missing-emit'
  | 'missing-cost'
  | 'missing-input'
  | 'missing-limit'
  | 'missing-step'
  | 'unresolved-reference'
  | 'unresolved-type'
  | 'unsupported-agent'
  | 'unsupported-capability'
  | 'unsupported-collection'
  | 'unsupported-memory'
  | 'unsupported-eval-input'
  | 'unsupported-eval-target'
  | 'unsupported-examples'
  | 'unsupported-guardrail'
  | 'unsupported-handler'
  | 'unsupported-ir-version'
  | 'unsupported-metric'
  | 'unsupported-output'
  | 'unsupported-param'
  | 'unsupported-placeholder'
  | 'unsupported-provider'
  | 'batch-pipeline-without-emit'
  | 'unsupported-redact'
  | 'unsupported-retriever'
  | 'unsupported-step'
  | 'unsupported-streaming'
  | 'unsupported-target'
  | 'unsupported-tool-auth'
  | 'unsupported-tool-confirmation'
  | 'unsupported-trigger'
  | 'unsupported-type'
  | 'unusable-name'
  | 'unused-input';

export interface PlanProblem {
  readonly code: PlanProblemCode;
  /** The IR coordinate the problem is about, e.g. `pipelines.answer_ticket.steps[1]`. */
  readonly path: string;
  readonly message: string;
}

/**
 * IR collections this target has no runtime counterpart for.
 *
 * `embeddings`, `retrievers` and `stores` left this list when the target learned to emit
 * retrieval wiring: `embeddings` is IR-only (derived from the models that declare the
 * capability, so a spec never names one), and the retriever and store declarations are
 * walked through `emit/retrieval.ts`. `deployments` and `guardrails` left it in P7a, when
 * the target learned to emit the `Accept` branch and the four guardrail stages -- see
 * `./emit/sse.ts` and `./emit/guardrails.ts`. `agents` and `memory` left it in P7b, each
 * when the emitter that consumes the collection landed (`./emit/agents.ts`), never to
 * silence a gate: `checkCollections` still refuses both on request, and
 * `target-surface.test.ts` calls it with the pre-P7b list to prove so.
 */
export const UNSUPPORTED_COLLECTIONS = [] as const;

/** The binding names the generated entrypoint owns, so a step may not claim them. */
export const RESERVED_BINDINGS = ['context', 'deps', 'event', 'response', 'steps'] as const;

function problem(code: PlanProblemCode, path: string, message: string): PlanProblem {
  return { code, path, message };
}

/** Code-unit ordering, never `localeCompare`, so output is byte-identical everywhere. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sortedTypes(ir: IR): Map<string, TypeShape> {
  const byId = new Map<string, TypeShape>();
  for (const type of ir.types) byId.set(type.id, type);
  return byId;
}

/** Whether a type reference names a struct this IR declares. */
export function resolvesToStruct(ref: TypeRef, types: Map<string, TypeShape>): boolean {
  return ref.kind === 'primitive' || types.has(ref.name);
}

export function checkIrVersion(ir: IR): PlanProblem[] {
  if (supportsIrVersion(ir.irVersion)) return [];
  return [
    problem(
      'unsupported-ir-version',
      'irVersion',
      `this generator consumes ${PY_FASTAPI_MANIFEST.irRange}, got ${ir.irVersion}`,
    ),
  ];
}

export function checkTarget(ir: IR): PlanProblem[] {
  const targets = ir.project?.targets ?? [];
  if (targets.includes('py-fastapi')) return [];
  return [
    problem(
      'unsupported-target',
      'project.targets',
      `this generator is the py-fastapi target, but the project declares ${JSON.stringify(targets)}`,
    ),
  ];
}

/**
 * The collections this target refuses, overridable so the refusal itself stays testable.
 *
 * `unsupported` defaults to `UNSUPPORTED_COLLECTIONS`, which is now empty. A test passes
 * the pre-P7b list explicitly, which is what keeps "this target emits no wiring for
 * `agents`" a live code path rather than a comment about code that used to exist.
 */
export function checkCollections(
  ir: IR,
  unsupported: readonly string[] = UNSUPPORTED_COLLECTIONS,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const name of unsupported) {
    const entries = (ir as unknown as Record<string, readonly { readonly id: string }[]>)[name];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const ids = [...entries.map((entry) => entry.id)].sort(compareIds).join(', ');
    problems.push(
      problem(
        'unsupported-collection',
        name,
        `this target emits no wiring for '${name}'; remove it or use another target ` +
          `(declared: ${ids})`,
      ),
    );
  }
  return problems;
}

/**
 * The trace-redaction declaration, refused rather than documented.
 *
 * `redact` names the fields a trace must not carry. The runtime creates spans for
 * every model, tool and step but has no redaction hook, so the declaration cannot be
 * honored: generating anyway would emit an app that exports exactly the values the
 * spec forbids. That is a privacy guarantee, and this file fails closed on it.
 */
export function checkObservability(ir: IR): PlanProblem[] {
  const redact = ir.observability?.redact ?? [];
  if (redact.length === 0) return [];
  return [
    problem(
      'unsupported-redact',
      'observability.redact',
      `the runtime's tracing has no redaction hook, so traces would carry ` +
        `${[...redact].sort(compareIds).join(', ')}; remove the declaration, or use a target ` +
        'whose runtime can redact',
    ),
  ];
}

export function checkTypes(ir: IR): PlanProblem[] {
  const types = sortedTypes(ir);
  const problems: PlanProblem[] = [];
  for (const type of ir.types) {
    const path = `types.${type.id}`;
    if (type.kind !== 'struct') {
      problems.push(
        problem('unsupported-type', path, `only 'struct' types are emittable, got '${type.kind}'`),
      );
      continue;
    }
    for (const field of type.fields) {
      const fieldPath = `${path}.${field.name}`;
      if (!resolvesToStruct(field.type, types)) {
        problems.push(
          problem(
            'unresolved-type',
            fieldPath,
            `field type '${field.type.name}' is not a declared struct`,
          ),
        );
      }
      if (field.sensitive === true) {
        problems.push(
          problem(
            'unsupported-redact',
            fieldPath,
            'the field is marked sensitive, which requires trace redaction to cover it; the ' +
              "runtime's tracing has no redaction hook, so emitting would trace it verbatim",
          ),
        );
      }
    }
  }
  return problems;
}

/**
 * The model-request fields the generated code may carry, and their ranges.
 *
 * `top_p` and `seed` are not fields of the runtime's `CompletionRequest`, so a
 * declared value would be silently dropped -- a request the IR describes but the
 * provider never sees. Out-of-range temperature and token counts would raise
 * `ValidationError` on the first call instead, which is a worse place to find out.
 */
function checkParams(params: ModelParams | undefined, path: string, problems: PlanProblem[]): void {
  if (params === undefined) return;
  for (const param of ['topP', 'seed'] as const) {
    if (params[param] === undefined) continue;
    problems.push(
      problem(
        'unsupported-param',
        `${path}.${param}`,
        `CompletionRequest cannot carry '${param}', so it would be silently dropped`,
      ),
    );
  }
  const temperature = params.temperature;
  if (temperature !== undefined && !(temperature >= 0 && temperature <= 2)) {
    problems.push(
      problem(
        'unsupported-param',
        `${path}.temperature`,
        `CompletionRequest requires a temperature in [0, 2], got ${temperature}`,
      ),
    );
  }
  const maxTokens = params.maxTokens;
  if (maxTokens !== undefined && !(maxTokens > 0)) {
    problems.push(
      problem(
        'unsupported-param',
        `${path}.maxTokens`,
        `CompletionRequest requires max_output_tokens > 0, got ${maxTokens}`,
      ),
    );
  }
}

/**
 * The embedding aliases that exist only because a managed knowledge base pins them.
 *
 * A local retriever's embedder is constructed by this app, so `embedder_for` has to serve
 * it. A knowledge base embeds its corpus inside the engine: the runtime never embeds
 * anything with that alias, and the adapter capability check -- which exists to stop an
 * OpenAI-shaped POST to a vendor with no embeddings route -- does not apply to it. The
 * alias is still held to resolving, at the base's own declaration.
 */
function knowledgeBaseOnlyEmbedders(ir: IR): Set<string> {
  const local = new Set(
    ir.retrievers.filter(isLocalRetriever).map((retriever) => retriever.embedModel),
  );
  return new Set(
    ir.knowledgeBases.map((base) => base.embedModel).filter((alias) => !local.has(alias)),
  );
}

export function checkModels(ir: IR): PlanProblem[] {
  const models = new Map(ir.models.map((model) => [model.id, model]));
  const problems: PlanProblem[] = [];
  for (const model of ir.models) {
    const path = `models.${model.id}`;
    const adapter = providerAdapter(model.provider);
    if (adapter === undefined) {
      problems.push(
        problem(
          'unsupported-provider',
          `${path}.provider`,
          `no runtime adapter for provider '${model.provider}'; the shipped adapters serve ` +
            `${SERVED_PROVIDERS.join(', ')}`,
        ),
      );
    }
    // A declared model capability the runtime cannot name (`vision`, `audio`, ...) is
    // not an error: the runtime's `Capability` enum is a smaller vocabulary than the
    // IR's, and the emitted pinned spec advertises the intersection of the two. What
    // the intersection dropped is recorded in the generated capability report, so a
    // narrower vocabulary never quietly rewrites what the spec declared.
    //
    // `embeddings` is the exception, because it is the one declared capability the
    // runtime routes by *provider* rather than by the pinned spec. `embedder_for`
    // dispatches on the provider -- `bedrock` and `google` to their own adapters,
    // `gemini` to `GeminiEmbedder`, the rest to the OpenAI-compatible wire -- so a
    // model declaring it on a provider with no embeddings route would POST an
    // envelope that vendor cannot serve, from `bindings.py`, far from the declaration
    // that caused it. The other four are negotiated by `ModelGateway` against the
    // pinned capabilities, so a shortfall there already fails at the one call site
    // with a readable error.
    if (
      adapter !== undefined &&
      model.capabilities.includes('embeddings') &&
      !ADAPTER_CAPABILITIES[adapter].includes('Capability.EMBEDDINGS') &&
      // A knowledge base embeds inside the engine, so this app never hands that alias to
      // `embedder_for` and the adapter it would POST through does not matter. The alias
      // still has to resolve to a real model, which the base's own check enforces.
      !knowledgeBaseOnlyEmbedders(ir).has(model.id)
    ) {
      problems.push(
        problem(
          'unsupported-capability',
          `${path}.capabilities`,
          `model '${model.id}' declares 'embeddings', but provider '${model.provider}' is ` +
            `served by ${adapter}, which has no embeddings endpoint; no runtime adapter ` +
            'can serve that declaration',
        ),
      );
    }
    checkParams(model.params, `${path}.params`, problems);
    const contextTokens = model.limits?.contextTokens;
    if (contextTokens === undefined || !(contextTokens > 0)) {
      problems.push(
        problem(
          'missing-limit',
          `${path}.limits.contextTokens`,
          'ModelSpec.context_window must be positive, and the IR declares ' +
            (contextTokens === undefined ? 'no value' : `the non-positive ${contextTokens}`),
        ),
      );
    }
    if (model.costProfile === undefined && providerAdapter(model.provider) !== 'FakeProvider') {
      problems.push(
        problem(
          'missing-cost',
          `${path}.costProfile`,
          'ModelSpec carries a cost profile, and without one the ledger would report every call on ' +
            'a billed model as free; the IR builder resolves this from its model catalog',
        ),
      );
    }
    for (const fallback of model.fallbacks ?? []) {
      if (!models.has(fallback)) {
        problems.push(
          problem(
            'unresolved-reference',
            `${path}.fallbacks`,
            `fallback alias '${fallback}' is not a declared model`,
          ),
        );
      } else if (fallback === model.id) {
        problems.push(
          problem(
            'unresolved-reference',
            `${path}.fallbacks`,
            `model '${model.id}' lists itself as its own fallback`,
          ),
        );
      }
    }
  }
  return problems;
}

/** The IR's declared variable names for a prompt, in declaration order. */
export function promptVariables(prompt: PromptShape): string[] {
  return prompt.variables.map((variable) => variable.name);
}

/** The flat placeholder names a prompt template interpolates, first-seen order. */
export function flatPlaceholders(prompt: PromptShape): string[] {
  const names: string[] = [];
  for (const name of templatePlaceholders(prompt.template)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The names a caller must supply to render this prompt, sorted. */
export function renderNames(prompt: PromptShape): string[] {
  return [...new Set([...promptVariables(prompt), ...flatPlaceholders(prompt)])].sort(compareIds);
}

export function checkPrompts(ir: IR): PlanProblem[] {
  const types = sortedTypes(ir);
  const problems: PlanProblem[] = [];
  for (const prompt of ir.prompts) {
    const path = `prompts.${prompt.id}`;
    if (prompt.output.kind === 'json') {
      problems.push(
        problem(
          'unsupported-output',
          `${path}.output`,
          "a 'json' output has no named schema, so no typed boundary can be generated; declare a " +
            "'structured' output with a schema, or 'text'",
        ),
      );
    }
    if (prompt.output.kind === 'structured') {
      const schema = prompt.output.schema;
      // A primitive or list schema is refused rather than emitted: the runtime's
      // structured path validates the reply into a Pydantic model, and a primitive
      // would generate a call the runtime cannot make.
      if (schema === undefined || schema.kind !== 'named' || !types.has(schema.name)) {
        problems.push(
          problem(
            schema?.kind === 'named' ? 'unresolved-type' : 'unsupported-output',
            `${path}.output.schema`,
            `structured output names '${schema?.name ?? '<none>'}', which is not a declared ` +
              'struct; the runtime parses a structured reply into a Pydantic model, so declare ' +
              'the shape as a type and name it here',
          ),
        );
      }
      const model = ir.models.find((candidate) => candidate.id === prompt.model);
      if (model === undefined) {
        problems.push(
          problem(
            'unresolved-reference',
            `${path}.model`,
            `'${prompt.model}' is not a declared model`,
          ),
        );
      } else if (!(model.capabilities ?? []).includes('json-schema')) {
        problems.push(
          problem(
            'unsupported-capability',
            `${path}.model`,
            `'${prompt.model}' does not declare the 'json-schema' capability, so asking it for a ` +
              'schema-conforming reply would rely on parsing luck; a structured prompt needs a ' +
              'model that supports structured output',
          ),
        );
      }
    }
    if ((prompt.examples ?? []).length > 0) {
      problems.push(
        problem(
          'unsupported-examples',
          `${path}.examples`,
          'Phase 0 emits no examples; dropping them would change the prompt the model sees',
        ),
      );
    }
    for (const name of templatePlaceholders(prompt.template)) {
      if (name.includes('.')) {
        problems.push(
          problem(
            'unsupported-placeholder',
            `${path}.template`,
            `'{{ ${name} }}' is a dotted placeholder; the runtime renders templates with ` +
              'str.format keywords, which cannot express attribute access. Flatten it to a ' +
              'declared variable (for example {{ name }})',
          ),
        );
      } else if (!promptVariables(prompt).includes(name)) {
        problems.push(
          problem(
            'unresolved-reference',
            `${path}.template`,
            `'{{ ${name} }}' is not a declared variable`,
          ),
        );
      }
    }
    for (const variable of prompt.variables) {
      if (!flatPlaceholders(prompt).includes(variable.name)) {
        problems.push(
          problem(
            'unused-input',
            `${path}.variables`,
            `variable '${variable.name}' never appears in the template, and the runtime rejects ` +
              'a render that supplies an unused value',
          ),
        );
      }
      if (variable.sensitive === true) {
        problems.push(
          problem(
            'unsupported-redact',
            `${path}.variables.${variable.name}`,
            'the variable is marked sensitive, which requires trace redaction to cover it; the ' +
              "runtime's tracing has no redaction hook, so emitting would trace it verbatim",
          ),
        );
      }
    }
    checkParams(prompt.params, `${path}.params`, problems);
  }
  return problems;
}

/** Tool ids some pipeline step calls, and so the ids a pipeline route executes. */
export function pipelineToolIds(ir: IR): Set<string> {
  const ids = new Set<string>();
  for (const pipeline of ir.pipelines ?? []) {
    for (const step of pipeline.steps) if (step.kind === 'tool') ids.add(step.tool);
  }
  return ids;
}

/** Tool ids some agent declares, and so the ids an agent route can call. */
export function agentToolIds(ir: IR): Set<string> {
  const ids = new Set<string>();
  for (const agent of ir.agents ?? []) for (const tool of agent.tools) ids.add(tool);
  return ids;
}

export function checkTools(ir: IR): PlanProblem[] {
  const types = sortedTypes(ir);
  const problems: PlanProblem[] = [];
  /* A `requiresConfirmation` or `auth` declaration is a guarantee *some* route keeps.
   * An agent route honours both: the loop pauses before a confirming call and evaluates
   * a tool's `auth` against the caller. A pipeline `tool` step honours neither -- it
   * executes the call inline -- so the declaration is only expressible when no pipeline
   * can reach the tool. Rejecting every flag outright (the pre-P7b rule) would be
   * stricter than the runtime and would make the agent route undeclarable. */
  const fromPipelines = pipelineToolIds(ir);
  for (const tool of ir.tools) {
    const path = `tools.${tool.id}`;
    if (tool.handler?.kind !== 'business') {
      problems.push(
        problem(
          'unsupported-handler',
          `${path}.handler`,
          `Phase 0 wires only the 'business' seam (the developer implements a generated ` +
            `Protocol); got '${tool.handler?.kind ?? '<none>'}'`,
        ),
      );
    }
    for (const [field, ref] of [
      ['input', tool.input],
      ['output', tool.output],
    ] as const) {
      if (!resolvesToStruct(ref, types)) {
        problems.push(
          problem(
            'unresolved-type',
            `${path}.${field}`,
            `type '${ref.name}' is not a declared struct`,
          ),
        );
      }
    }
    if (fromPipelines.has(tool.id)) {
      if (tool.auth !== undefined) {
        problems.push(
          problem(
            'unsupported-tool-auth',
            `${path}.auth`,
            `a pipeline 'tool' step calls this tool inline and the pipeline route has no ` +
              `authorization hook, so this predicate would not be enforced there; remove ` +
              `the declaration, drop the pipeline step, or reach the tool from an agent only`,
          ),
        );
      }
      if (tool.requiresConfirmation === true) {
        problems.push(
          problem(
            'unsupported-tool-confirmation',
            `${path}.requiresConfirmation`,
            `a pipeline 'tool' step calls this tool inline and the pipeline route has no ` +
              `confirmation flow, so this guard would not be enforced there; remove the ` +
              `declaration, drop the pipeline step, or reach the tool from an agent only`,
          ),
        );
      }
    }
  }
  return problems;
}

/** The names a step input supplies, with its unresolvable references reported. */
/**
 * Check every input value a step supplies, returning the keys it names.
 *
 * A reference is validated segment by segment against the *type* the binding holds,
 * not just its name: `{{ classification.category }}` where the binding is a plain
 * string, or where the struct has no such field, would emit an `AttributeError` in a
 * running app, and a generator that can prove it at plan time must not ship it.
 */
function checkStepInput(
  input: StepInput | undefined,
  path: string,
  bindings: readonly StepBinding[],
  types: Map<string, TypeShape>,
  problems: PlanProblem[],
): string[] {
  if (input === undefined) return [];
  const names = bindings.map((binding) => binding.name);
  const keys: string[] = [];

  const checkPath = (root: string, access: readonly string[], where: string): void => {
    const binding = bindings.find((candidate) => candidate.name === root);
    if (binding === undefined) {
      problems.push(
        problem(
          'unresolved-reference',
          where,
          `reference '${[root, ...access].join('.')}' does not start at a preceding binding ` +
            `(${names.length === 0 ? 'none' : names.join(', ')})`,
        ),
      );
      return;
    }
    if (root === 'event') {
      if (access.length !== 1) {
        problems.push(
          problem(
            'unresolved-reference',
            where,
            `'${[root, ...access].join('.')}' must name exactly one field of the request event, ` +
              "because the generated entrypoint binds only 'event' (for example 'event.field')",
          ),
        );
      }
      return;
    }
    let ref = binding.type;
    const walked = [root];
    for (const segment of access) {
      walked.push(segment);
      const struct = ref === undefined ? undefined : structFields(ref, types);
      if (struct === undefined) {
        problems.push(
          problem(
            'unresolved-reference',
            where,
            ref === undefined
              ? `'${walked.join('.')}' selects a field of '${root}', which the IR binds as a ` +
                  'plain string'
              : `'${walked.join('.')}' selects a field of '${ref.name}', which is not a struct`,
          ),
        );
        return;
      }
      const field = struct.fields.find((candidate) => candidate.name === segment);
      if (field === undefined) {
        problems.push(
          problem('unresolved-reference', where, `${struct.id} has no field '${segment}'`),
        );
        return;
      }
      ref = field.type;
    }
  };

  for (const [key, value] of Object.entries(input)) {
    keys.push(key);
    if (value.kind === 'reference') {
      const [root = '', ...rest] = value.path;
      checkPath(root, rest, `${path}.input.${key}`);
      continue;
    }
    if (value.kind === 'template') {
      for (const name of templatePlaceholders(value.template)) {
        const [root = '', ...rest] = name.split('.');
        checkPath(root, rest, `${path}.input.${key}`);
      }
    }
  }
  return keys;
}

/** The declared input field names of a struct, and which of them are required. */
function structFields(ref: TypeRef, types: Map<string, TypeShape>): TypeShape | undefined {
  return ref.kind === 'named' ? types.get(ref.name) : undefined;
}

function checkArgumentKeys(
  keys: readonly string[],
  fields: TypeShape | undefined,
  required: readonly string[],
  path: string,
  problems: PlanProblem[],
  what: string,
): void {
  if (fields === undefined) return;
  const declared = new Set(fields.fields.map((field) => field.name));
  const needed = required.filter((name) => declared.has(name));
  for (const name of keys) {
    if (!declared.has(name)) {
      problems.push(problem('unused-input', path, `${what} has no field '${name}'`));
    }
  }
  for (const name of needed) {
    if (!keys.includes(name)) {
      problems.push(problem('missing-input', path, `${what} requires field '${name}'`));
    }
  }
}

/** A name a step binds, with the type it binds (`undefined` for the request event). */
export interface StepBinding {
  readonly name: string;
  readonly type: TypeRef | undefined;
}

/** One field of the emitted event, and the reference path that fills it. */
export interface ResponseSource {
  readonly field: string;
  /** e.g. `['classification', 'category']` or `['event', 'ticket_id']`. */
  readonly path: readonly string[];
}

/**
 * The field-wise response of an emit step.
 *
 * An emit step carries no input, so nothing in the IR says which earlier value fills
 * which field of the event: the association has to be derived. Each field is resolved
 * against the preceding bindings that expose it, ranking a binding whose declared
 * type *is* the event type above another struct, and both above the request event --
 * a computed value beats raw input. A field two bindings expose at the same rank is
 * ambiguous and refused, because the IR has no syntax to say which one was meant.
 *
 * The request event is always a candidate, so a field nothing computes is read from
 * the request; a request that does not carry it is a 422 at the edge rather than a
 * silently wrong response body.
 */
export function responsePlan(
  bindings: readonly StepBinding[],
  eventType: string,
  types: Map<string, TypeShape>,
  path: string,
): { readonly sources: ResponseSource[]; readonly problems: PlanProblem[] } {
  const target = types.get(eventType);
  const sources: ResponseSource[] = [];
  const problems: PlanProblem[] = [];
  if (target === undefined) return { sources, problems };

  const candidates: { readonly rank: number; readonly path: string[] }[] = [];
  for (const binding of bindings) {
    const declared = binding.type?.kind === 'named' ? types.get(binding.type.name) : undefined;
    for (const field of target.fields) {
      if (binding.type === undefined) {
        candidates.push({ rank: 2, path: [binding.name, field.name] });
        continue;
      }
      if (declared === undefined) continue;
      if (!declared.fields.some((candidate) => candidate.name === field.name)) continue;
      candidates.push({
        rank: declared.id === eventType ? 0 : 1,
        path: [binding.name, field.name],
      });
    }
  }

  for (const field of target.fields) {
    const own = candidates.filter((candidate) => candidate.path[1] === field.name);
    if (own.length === 0) continue;
    const best = own.reduce((left, right) => (right.rank < left.rank ? right : left));
    const tied = own.filter((candidate) => candidate.rank === best.rank);
    if (tied.length > 1) {
      const names = tied.map((candidate) => candidate.path[0] ?? '').sort(compareIds);
      problems.push(
        problem(
          'ambiguous-emit',
          path,
          `'${field.name}' of ${eventType} could come from ${names.join(' or ')}; the IR cannot say ` +
            'which one was meant, so generate the response from a single binding',
        ),
      );
      continue;
    }
    sources.push({ field: field.name, path: best.path });
  }
  return { sources, problems };
}

/**
 * A templated step input is interpolated into the generated step body, so every
 * placeholder must name a binding. A placeholder naming the request event is refused:
 * the generated request model's fields are derived from whole-field references, and a
 * placeholder inside a string carries no type for it.
 */
function checkStepTemplates(step: StepShape, path: string, problems: PlanProblem[]): void {
  if (step.kind === 'branch') {
    for (const [index, nested] of step.then.entries()) {
      checkStepTemplates(nested, `${path}.branch.then[${index}]`, problems);
    }
    for (const [index, nested] of step.else.entries()) {
      checkStepTemplates(nested, `${path}.branch.else[${index}]`, problems);
    }
    return;
  }
  if (step.kind === 'parallel') {
    for (const [armIndex, arm] of step.branches.entries()) {
      for (const [index, nested] of arm.entries()) {
        checkStepTemplates(nested, `${path}.parallel.branches[${armIndex}][${index}]`, problems);
      }
    }
    return;
  }
  if (step.kind === 'map') {
    checkStepTemplates(step.step, `${path}.map.step`, problems);
    return;
  }
  if (step.kind === 'route') {
    for (const { label, arm } of routeArms(step)) {
      for (const [index, nested] of arm.entries()) {
        checkStepTemplates(nested, `${path}.route.${label}[${index}]`, problems);
      }
    }
    return;
  }
  if (
    step.kind === 'emit' ||
    step.kind === 'retrieve' ||
    step.kind === 'reduce' ||
    step.kind === 'rerank' ||
    step.kind === 'guard' ||
    step.kind === 'agent'
  ) {
    return;
  }
  for (const [key, value] of Object.entries(step.input ?? {})) {
    if (value.kind !== 'template') continue;
    const names = templatePlaceholders(value.template);
    if (!names.some((name) => name.split('.')[0] === 'event')) continue;
    problems.push(
      problem(
        'unsupported-placeholder',
        `${path}.input.${key}`,
        'a template may interpolate step bindings, but a placeholder naming the request ' +
          'event cannot be typed into the generated request model; pass the whole field instead',
      ),
    );
  }
}

/** Whether a type reference is a single string, the only thing a query may interpolate. */
function refIsString(ref: TypeRef | undefined): boolean {
  return ref !== undefined && ref.kind === 'primitive' && ref.name === 'string' && !ref.list;
}

/**
 * Every placeholder in a scalar step template, checked against what the generated step
 * can actually resolve.
 *
 * The template is interpolated at run time and the runtime's `PipelineContext.require`
 * raises for a name the step body does not hold, so a placeholder naming neither the
 * request event nor a string binding in scope would type-check, pass every byte-level
 * golden and drift test, and fail on the first request. It is refused here instead.
 *
 * All four scalar templates -- a retrieval query, a rerank query, `guard.text` and
 * `agent.text` -- reach the runtime through the same `interpolate`, so they share one
 * rule: one whole event field, or a binding that holds a string.
 */
function checkTextTemplate(
  text: string,
  field: string,
  label: string,
  path: string,
  bindings: readonly StepBinding[],
  types: Map<string, TypeShape>,
  problems: PlanProblem[],
): void {
  for (const name of templatePlaceholders(text)) {
    const [root, ...rest] = name.split('.');
    if (root === 'event') {
      if (rest.length === 1) continue;
      problems.push(
        problem(
          'unsupported-placeholder',
          `${path}.${field}`,
          `${label} interpolates one whole event field, so '${name}' has no single ` +
            'string to substitute; write the placeholder as an event field',
        ),
      );
      continue;
    }
    const binding = bindings.find((candidate) => candidate.name === root);
    if (binding === undefined) {
      problems.push(
        problem(
          'unsupported-placeholder',
          `${path}.${field}`,
          `${label} placeholder '${name}' names no binding in scope; the generated ` +
            `step would ask the pipeline context for '${root}' and raise on the first request`,
        ),
      );
      continue;
    }
    // `interpolate` hands each placeholder to the emitter, which reads `binding.field` as
    // an attribute, so one field of a binding in scope is resolvable -- and it is resolved
    // through the declared struct to check that what it holds is a string.
    const resolved =
      rest.length === 0
        ? binding.type
        : rest.length === 1 && binding.type?.kind === 'named'
          ? types.get(binding.type.name)?.fields.find((candidate) => candidate.name === rest[0])
              ?.type
          : undefined;
    if (refIsString(resolved)) continue;
    problems.push(
      problem(
        'unsupported-placeholder',
        `${path}.${field}`,
        `${label} placeholder '${name}' resolves to binding '${binding.name}', which is not a ` +
          `string${rest.length > 0 ? ` at '${rest.join('.')}'` : ''}, and this template is ` +
          'interpolated as text',
      ),
    );
  }
}

/**
 * Every placeholder in a retrieval query, checked against what the generated step can
 * actually resolve.
 */
function checkRetrieveQuery(
  step: StepShape & { kind: 'retrieve' },
  path: string,
  bindings: readonly StepBinding[],
  types: Map<string, TypeShape>,
  problems: PlanProblem[],
): void {
  checkTextTemplate(step.query, 'query', 'a retrieval query', path, bindings, types, problems);
}

/**
 * The embedder providers each managed engine can use.
 *
 * A knowledge base embeds its own corpus, with a model on its own cloud: Bedrock cannot
 * call a Vertex embedding model, and a Vertex corpus cannot be built with Titan. So the
 * alias a base pins has to resolve to a model on that cloud. Anything else applies
 * cleanly and then fails the first ingestion job, in the engine, after the corpus has
 * been uploaded.
 */
const ENGINE_EMBEDDER_PROVIDERS: Readonly<Record<KnowledgeBaseEngine, readonly string[]>> = {
  'aws-bedrock': ['bedrock'],
  'vertex-rag': ['google', 'gemini'],
};

/** The metadata key a filter expression compares on, or `undefined` if it opens with none. */
function filterKey(expression: string): string | undefined {
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(expression)?.[1];
}

/** The alias a base embeds with must be declared, and on the engine's own cloud. */
function checkKnowledgeBaseEmbedder(
  ir: IR,
  base: KnowledgeBaseShape,
  problems: PlanProblem[],
): void {
  const embedding = ir.embeddings.find((entry) => entry.id === base.embedModel);
  if (embedding === undefined) {
    problems.push(
      problem(
        'unresolved-reference',
        `knowledgeBases.${base.id}.embedModel`,
        `knowledge base '${base.id}' embeds with '${base.embedModel}', which is not ` +
          'declared; an embeddings entry exists for each model declaring the capability',
      ),
    );
    return;
  }
  const allowed = ENGINE_EMBEDDER_PROVIDERS[base.engine];
  if (!allowed.includes(embedding.provider)) {
    problems.push(
      problem(
        'unsupported-retriever',
        `knowledgeBases.${base.id}.embedModel`,
        `knowledge base '${base.id}' runs on '${base.engine}' but embeds with ` +
          `'${embedding.id}', whose provider is '${embedding.provider}'; the engine can ` +
          `only embed with ${allowed.join(' or ')}, and the mismatch would surface as a ` +
          'failed ingestion job after the corpus was already uploaded',
      ),
    );
  }
}

/**
 * Every filter has to compare on a key the base declared `filterable`.
 *
 * The expression itself is forwarded to the engine verbatim -- the two engines do not
 * share a filter language, and inventing a neutral one this compiler then translates
 * would put a translation no gate covers between the spec and the corpus. What is
 * checked here is the failure the plan calls out: a filter on a key the engine never
 * indexed matches nothing, silently, and returns an empty result set rather than the
 * unfiltered corpus the author meant.
 */
function checkManagedFilters(
  base: KnowledgeBaseShape,
  retriever: ManagedRetrieverShape,
  path: string,
  problems: PlanProblem[],
): void {
  const filterable = new Set(base.filterable);
  for (const [index, expression] of (retriever.filters ?? []).entries()) {
    const key = filterKey(expression);
    if (key === undefined) {
      problems.push(
        problem(
          'unsupported-retriever',
          `${path}.filters[${index}]`,
          `retriever '${retriever.id}' declares the filter ${JSON.stringify(expression)}, ` +
            'which does not begin with a metadata key; a managed engine matches a filter ' +
            'against document metadata, so the expression has to open with the key',
        ),
      );
      continue;
    }
    if (!filterable.has(key)) {
      problems.push(
        problem(
          'unsupported-retriever',
          `${path}.filters[${index}]`,
          `retriever '${retriever.id}' filters on '${key}', which knowledge base ` +
            `'${base.id}' does not declare in 'filterable'; a filter on a key the engine ` +
            'never indexed matches nothing rather than returning the unfiltered corpus',
        ),
      );
    }
  }
}

/**
 * One retriever bound to a managed knowledge base.
 *
 * The engine owns chunking, embedding and the index, so none of the local conditions
 * apply: there is no connector to open, no store adapter to find and no vector width to
 * reconcile. What is left is everything the *engine* is asked to do on this app's behalf,
 * because each of those fails server-side, after the corpus is already uploaded, rather
 * than in the plan.
 */
function checkManagedRetrieverDeclaration(
  ir: IR,
  retriever: ManagedRetrieverShape,
  path: string,
  problems: PlanProblem[],
): void {
  const base = ir.knowledgeBases.find((entry) => entry.id === retriever.knowledgeBase);
  if (base === undefined) {
    problems.push(
      problem(
        'unresolved-reference',
        `${path}.knowledgeBase`,
        `retriever '${retriever.id}' reads knowledge base '${retriever.knowledgeBase}', which ` +
          'is not declared',
      ),
    );
  } else {
    checkKnowledgeBaseEmbedder(ir, base, problems);
    checkManagedFilters(base, retriever, path, problems);
  }
  if (retriever.rerank !== undefined) {
    // The reranker runs in this runtime, over the chunks the engine returned, so it is
    // the same lexical matcher a local retriever gets -- and held to the same rule.
    const declared = retriever.rerank.model;
    if (!declared.toLowerCase().includes('lexical')) {
      problems.push(
        problem(
          'unsupported-retriever',
          path,
          `retriever '${retriever.id}' reranks with '${declared}', and the runtime's only ` +
            'reranker is lexical: it matches the name the spec declares, so a name that does ' +
            'not say so is refused rather than served by a reranker it never named',
        ),
      );
    }
  }
}

/**
 * One retriever declaration, refused when the runtime it binds to would refuse it.
 *
 * These conditions are checked on the *declaration* rather than on the `retrieve` step
 * that happens to use it, because a retriever no pipeline searches still gets a binding
 * and an ingest entry point: an unused retriever with a misspelled store reference, or a
 * corpus no connector can open, would still emit code that raises the first time anything
 * is indexed. Every condition here is a `ConfigurationError` or `FeatureDeferredError`
 * the runtime raises when the binding, the connector or the chunker is constructed --
 * all of them at run time, which no byte-level golden or drift test can see.
 */
function checkRetrieverDeclaration(
  ir: IR,
  retriever: RetrieverShape,
  path: string,
  problems: PlanProblem[],
): void {
  const refuse = (message: string): void => {
    problems.push(problem('unsupported-retriever', path, message));
  };
  if (isManagedRetriever(retriever)) {
    checkManagedRetrieverDeclaration(ir, retriever, path, problems);
    return;
  }
  if (retriever.source.kind !== 'file') {
    refuse(
      `retriever '${retriever.id}' indexes a '${retriever.source.kind}' source, which the ` +
        "runtime's connector does not implement; Phase 1 indexes a local 'file' source",
    );
  }
  if (retriever.chunking.strategy === 'semantic') {
    refuse(
      `retriever '${retriever.id}' chunks with 'semantic', which the runtime does not ` +
        'implement: it needs an embedding pass over the whole source at ingest, and Phase 1 ' +
        'chunks by size (fixed, recursive, code)',
    );
  }
  if (retriever.refresh.mode !== 'full') {
    refuse(
      `retriever '${retriever.id}' declares a '${retriever.refresh.mode}' refresh, and the ` +
        'runtime rebuilds the whole index on every ingest',
    );
  }
  const store = ir.stores.find((entry) => entry.id === retriever.store);
  if (store === undefined) {
    problems.push(
      problem(
        'unresolved-reference',
        `${path}.store`,
        `retriever '${retriever.id}' names store '${retriever.store}', which is not declared`,
      ),
    );
  } else if (store.kind !== 'memory' && store.kind !== 'pgvector') {
    refuse(
      `store '${store.id}' is a '${store.kind}' store, which this runtime has no adapter ` +
        "for; Phase 1 ships 'memory' and 'pgvector'",
    );
  }
  const embedding = ir.embeddings.find((entry) => entry.id === retriever.embedModel);
  if (embedding === undefined) {
    problems.push(
      problem(
        'unresolved-reference',
        `${path}.embedModel`,
        `retriever '${retriever.id}' names embedding model '${retriever.embedModel}', which is ` +
          'not declared; an embeddings entry exists for each model declaring the capability',
      ),
    );
  }
  // The generated binding carries one fixed vector width, resolved from the embedding or
  // the store. The runtime refuses a binding with neither, and refuses a store whose
  // declared width disagrees with the width the embedding pins -- both at the first
  // search, far from the declaration that caused them.
  const width = embedding?.dimensions ?? store?.dimensions;
  if (embedding !== undefined && store !== undefined) {
    if (width === undefined) {
      refuse(
        `retriever '${retriever.id}' fixes no vector width: neither embedding ` +
          `'${embedding.id}' nor store '${store.id}' declares 'dimensions', and a width ` +
          'resolved at run time would let a store accept vectors a later run cannot compare',
      );
    } else if (
      embedding.dimensions !== undefined &&
      store.dimensions !== undefined &&
      embedding.dimensions !== store.dimensions
    ) {
      refuse(
        `retriever '${retriever.id}' pins ${embedding.dimensions} dimensions via embedModel ` +
          `'${embedding.id}', but store '${store.id}' is declared ` +
          `${store.dimensions}-dimensional; the two must agree before anything is indexed`,
      );
    }
  }
  if (retriever.rerank !== undefined) {
    // The runtime's guard is `_LEXICAL_MARKER in spec.model.casefold()`, and the IR's
    // `rerank.model` is the model *alias*: `referential.ts` resolves it against the models
    // map and the generated binding carries it verbatim into `reranker_for`. So the alias
    // is the string that has to say "lexical" -- checking the resolved `modelId` instead
    // would pass a spec the runtime then refuses at the first search.
    const declared = retriever.rerank.model;
    if (!declared.toLowerCase().includes('lexical')) {
      refuse(
        `retriever '${retriever.id}' reranks with '${declared}', and the runtime's only ` +
          'reranker is lexical: it matches the name the spec declares, so a name that does ' +
          'not say so is refused rather than served by a reranker it never named',
      );
    }
  }
}

/**
 * Every declared retriever, refused once each, in declaration order.
 *
 * A retriever is wired as soon as it is declared, whether or not a pipeline searches it:
 * the binding table and the ingest entry points are emitted for all of them. So the
 * checks are per declaration, and a `retrieve` step only has to check that the retriever
 * it names exists.
 */
/**
 * The memory kinds the runtime actually serves, mirroring `IMPLEMENTED_MEMORY_KINDS` in
 * `aid_runtime.agents.memory`. The other four kinds need a summarizer, an embedding index
 * or a clock, so they are refused at plan time rather than at the first request.
 */
export const SUPPORTED_MEMORY_KINDS = ['buffer', 'window'] as const;

/**
 * Whether `agent` can end a run in `RunStatus.PAUSED`, and so whether this app needs a
 * resume route.
 *
 * Three independent sources, all verified at `runtimes/python/src/aid_runtime/agents`:
 *
 * 1. `agent.approval` -- a declared `humanInTheLoop`, consulted by `_needs_approval`;
 * 2. **any tool the agent may call with `requiresConfirmation`** -- `_needs_approval`
 *    returns `True` for these *before* it looks at `agent.approval`, so a confirming
 *    tool pauses an agent that declares no `humanInTheLoop` at all;
 * 3. **any guardrail the agent declares with `action: escalate`** -- the loop calls
 *    `_guardrail_pause` at the `input`, `output` and `tool-call` stages with no approval
 *    involved.
 *
 * Emitting the route only for source 1 would ship an app that pauses with no way to
 * resume, which is why this predicate is a union rather than a null check.
 */
export function agentCanPause(ir: IR, agent: AgentShape): boolean {
  if (agent.humanInTheLoop !== undefined) return true;
  const byId = new Map(ir.tools.map((tool) => [tool.id, tool]));
  for (const toolId of agent.tools) {
    if (byId.get(toolId)?.requiresConfirmation === true) return true;
  }
  const guardrails = new Map((ir.guardrails ?? []).map((guardrail) => [guardrail.id, guardrail]));
  for (const guardrailId of agent.guardrails) {
    if (guardrails.get(guardrailId)?.action === 'escalate') return true;
  }
  return false;
}

/**
 * The models the agent route actually reads, in declared-id order.
 *
 * `from_ir` builds a `ModelSpec` for **every** model in the document it is handed, and
 * `_model` refuses one that resolves no `costProfile` ("a budget cannot be enforced
 * against an unpriced model"). So the set matters twice over: it is what the emitted
 * document has to be narrowed to, and what `checkAgents` has to price.
 *
 * The closure is each agent's model plus everything reachable through `fallbacks`, and
 * nothing else. Fallbacks are part of it because the loop hands `fallbacks_for(alias)` to
 * *every* gateway call (`loop.py`: `gateway.call(alias, request,
 * fallbacks=self._spec.fallbacks_for(alias), ...)`), not only to a budget-degrade step, so
 * a fallback is reachable on any provider failure. Models outside the closure are never
 * named by the agent route -- the pipeline routes resolve through their own gateway config
 * -- and including them would only add declarations the runtime refuses to parse.
 */
export function agentModelClosure(ir: IR): ModelShape[] {
  const byId = new Map(ir.models.map((model) => [model.id, model]));
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const agent of ir.agents ?? []) {
    if (!reached.has(agent.model)) {
      reached.add(agent.model);
      queue.push(agent.model);
    }
  }
  while (queue.length > 0) {
    const model = byId.get(queue.shift() as string);
    if (model === undefined) continue;
    for (const fallback of model.fallbacks) {
      if (!reached.has(fallback)) {
        reached.add(fallback);
        queue.push(fallback);
      }
    }
  }
  return ir.models
    .filter((model) => reached.has(model.id))
    .sort((left, right) => compareIds(left.id, right.id));
}

/**
 * The agent declarations this target cannot express, refused rather than downgraded.
 *
 * `AgentDefinition` in `aid_runtime.agents.ir` is the whole of what the loop understands,
 * so the rule for each check below is the same: a field the runtime drops must stop
 * generation instead of being emitted and ignored.
 */
export function checkAgents(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const promptById = new Map(ir.prompts.map((prompt) => [prompt.id, prompt]));
  const toolIds = new Set(ir.tools.map((tool) => tool.id));
  const memoryIds = new Set((ir.memory ?? []).map((memory) => memory.id));
  const guardrailIds = new Set((ir.guardrails ?? []).map((guardrail) => guardrail.id));
  const modelIds = new Set(ir.models.map((model) => model.id));

  for (const agent of ir.agents ?? []) {
    const path = `agents.${agent.id}`;
    /* `AgentDefinition` has no `retrievers` field: the loop builds its messages from the
     * resolved prompt and `memory`, and never queries a retriever. Emitting the agent
     * would drop the declaration, so a spec that wants retrieval has to put it in the
     * prompt itself. */
    if (agent.retrievers.length > 0) {
      problems.push(
        problem(
          'unsupported-agent',
          `${path}.retrievers`,
          `the native agent loop has no retrieval step, so ${JSON.stringify(agent.retrievers)} ` +
            'would never run; inline the retrieved context in the prompt instead',
        ),
      );
    }
    /* No `structuredOutput` either: the loop returns the model's text as `RunResult.answer`
     * and performs no schema validation, so the declaration would be a promise nothing
     * keeps. A prompt that declares an output schema is the supported spelling. */
    if (agent.structuredOutput !== undefined) {
      problems.push(
        problem(
          'unsupported-agent',
          `${path}.structuredOutput`,
          'the native agent loop performs no structured-output validation, so this ' +
            "declaration would not be enforced; declare the schema on the agent's prompt",
        ),
      );
    }
    /* The instructions prompt becomes the system message through its *template*, verbatim:
     * `from_ir` reads `prompts[].template` and the loop never renders variables. A prompt
     * with variables would therefore reach the model as unrendered `{{name}}` text. */
    const instructions = promptById.get(agent.instructions);
    if (instructions === undefined) {
      problems.push(
        problem(
          'unresolved-reference',
          `${path}.instructions`,
          `prompt '${agent.instructions}' is not declared`,
        ),
      );
    } else if (instructions.variables.length > 0) {
      problems.push(
        problem(
          'unsupported-agent',
          `${path}.instructions`,
          `prompt '${instructions.id}' declares variables ` +
            `(${instructions.variables
              .map((variable) => variable.name)
              .sort(compareIds)
              .join(', ')}) ` +
            'that the agent loop never renders, so the model would receive the template ' +
            'verbatim; declare a variable-free prompt for an agent to use',
        ),
      );
    }
    for (const toolId of agent.tools) {
      if (!toolIds.has(toolId)) {
        problems.push(
          problem('unresolved-reference', `${path}.tools`, `tool '${toolId}' is not declared`),
        );
      }
    }
    for (const memoryId of agent.memory) {
      if (!memoryIds.has(memoryId)) {
        problems.push(
          problem('unresolved-reference', `${path}.memory`, `memory '${memoryId}' is not declared`),
        );
      }
    }
    for (const guardrailId of agent.guardrails) {
      if (!guardrailIds.has(guardrailId)) {
        problems.push(
          problem(
            'unresolved-reference',
            `${path}.guardrails`,
            `guardrail '${guardrailId}' is not declared`,
          ),
        );
      }
    }
    if (!modelIds.has(agent.model)) {
      problems.push(
        problem('unresolved-reference', `${path}.model`, `model '${agent.model}' is not declared`),
      );
    }
    /* `engine: 'deepagents'` is implemented, but by a module that imports the pinned
     * `deepagents` framework. The generated app declares no such dependency, so emitting
     * the engine would ship an app that fails at import; this is a target-dependency
     * deferral, stated rather than hidden. */
    if (agent.engine !== 'native') {
      problems.push(
        problem(
          'unsupported-agent',
          `${path}.engine`,
          `the generated app installs no '${agent.engine}' framework, so this engine ` +
            "cannot run here; use engine 'native', or add the dependency and wire " +
            '`build_runtime` to it',
        ),
      );
    }
  }
  /* A model the agent route reads must be priced. `_model` refuses an unpriced model at
   * construction, so a spec that reaches one through its agent would generate an app that
   * fails on the first request; `agentModelClosure` is exactly the set that gets emitted,
   * so this is also the set the runtime has to accept. */
  for (const model of agentModelClosure(ir)) {
    if (model.costProfile === undefined) {
      problems.push(
        problem(
          'unsupported-agent',
          `models.${model.id}.costProfile`,
          `model '${model.id}' resolves no cost profile from the pinned catalog, and the ` +
            'agent loop refuses an unpriced model because no budget can be enforced ' +
            "against one; this model is an agent's own or reached through its fallbacks, " +
            'so the route reads it -- use a catalogued `modelId`, or drop the fallback ' +
            'that reaches this one',
        ),
      );
    }
  }
  return problems;
}

/**
 * The memory declarations this target cannot honour, refused rather than approximated.
 *
 * This mirrors `check_memory_supported` exactly. That function raises
 * `FeatureDeferredError` for a kind outside `IMPLEMENTED_MEMORY_KINDS`, for
 * `summarizeModel`, for `ttl` and for a non-empty `redact`; catching those at plan time
 * turns a runtime 500 into a generation failure that names the declaration.
 */
export function checkMemory(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const supportedKinds: readonly string[] = SUPPORTED_MEMORY_KINDS;

  for (const memory of ir.memory ?? []) {
    const path = `memory.${memory.id}`;
    if (!supportedKinds.includes(memory.kind)) {
      problems.push(
        problem(
          'unsupported-memory',
          `${path}.kind`,
          `the runtime implements ${SUPPORTED_MEMORY_KINDS.join(' and ')} memory and refuses ` +
            `'${memory.kind}' by name; serve it as a buffer, or declare the kind once the ` +
            'runtime grows a summarizer or an index',
        ),
      );
    }
    if (memory.summarizeModel !== undefined) {
      problems.push(
        problem(
          'unsupported-memory',
          `${path}.summarizeModel`,
          'no summarizer is implemented, so this declaration would be ignored',
        ),
      );
    }
    if (memory.ttl !== undefined) {
      problems.push(
        problem(
          'unsupported-memory',
          `${path}.ttl`,
          'expiry enforcement is not implemented, so entries would never expire',
        ),
      );
    }
    if (memory.redact.length > 0) {
      problems.push(
        problem(
          'unsupported-memory',
          `${path}.redact`,
          'memory redaction is not implemented, so the declared fields would still be ' +
            'stored and replayed',
        ),
      );
    }
    /* `_store_for` chooses the store from `backend` alone, and a generated app registers
     * none: any backend other than the in-process default raises `ConfigurationError` on
     * the first write. Rejecting it here keeps a spec from describing a buffer this app
     * cannot serve. */
    if (memory.backend !== undefined && memory.backend !== 'in-process') {
      problems.push(
        problem(
          'unsupported-memory',
          `${path}.backend`,
          `a generated app registers no MemoryStore, so backend '${memory.backend}' cannot ` +
            "be served; omit 'backend', or set it to 'in-process'",
        ),
      );
    }
    /* `_memory` copies `store` into `MemoryDefinition.store`, which nothing consults -- the
     * store comes from `backend`. A spec that set only `store` would silently get the
     * in-process buffer, so the field is refused rather than quietly ignored. */
    if (memory.store !== undefined) {
      problems.push(
        problem(
          'unsupported-memory',
          `${path}.store`,
          "the runtime selects its store from 'backend' and never reads 'store'; set " +
            "'backend' instead",
        ),
      );
    }
    if (!Number.isInteger(memory.tokenBudget) || memory.tokenBudget < 1) {
      problems.push(
        problem(
          'missing-limit',
          `${path}.tokenBudget`,
          `the runtime needs a positive token budget, got ${memory.tokenBudget}`,
        ),
      );
    }
  }
  return problems;
}

export function checkRetrievers(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const retriever of ir.retrievers) {
    checkRetrieverDeclaration(ir, retriever, `retrievers.${retriever.id}`, problems);
  }
  return problems;
}

/**
 * One `retrieve` step: its query placeholders, and the retriever it names.
 *
 * The retriever's own declaration is checked by {@link checkRetrievers}, so what is left
 * here is what only the step can get wrong.
 */
function checkRetrieveStep(
  ir: IR,
  step: StepShape & { kind: 'retrieve' },
  path: string,
  bindings: readonly StepBinding[],
  types: Map<string, TypeShape>,
  problems: PlanProblem[],
): void {
  checkRetrieveQuery(step, path, bindings, types, problems);
  if (!ir.retrievers.some((entry) => entry.id === step.retriever)) {
    problems.push(
      problem(
        'unresolved-reference',
        `${path}.retriever`,
        `retriever '${step.retriever}' is not declared`,
      ),
    );
  }
}

/**
 * The prompt variable a pipeline's retrieve step feeds, if any.
 *
 * A generate step names the binding whose retrieved items are inlined into the prompt,
 * and the IR requires the prompt variable fed by it to carry the same name. An eval over
 * such a pipeline supplies that variable empty: the model half of an eval measures the
 * prompt, and the retrieved items are measured by a retrieval metric.
 */
export function evalContextVariable(
  ir: IR,
  evaluation: EvalShape,
  prompt: PromptShape,
): string | undefined {
  if (evaluation.target.kind !== 'pipeline') return undefined;
  const pipeline = ir.pipelines.find((entry) => entry.id === evaluation.target.id);
  for (const step of pipeline?.steps ?? []) {
    if (step.kind === 'generate' && step.prompt === prompt.id && step.context !== undefined) {
      return step.context;
    }
  }
  return undefined;
}

/**
 * The retriever a `retrieval` metric measures, or `undefined` when the spec does not say.
 *
 * The IR carries `expectDocs` and `k` but no retriever id: `expectDocs` are source paths
 * relative to *the* retriever's uri, so the declaration reads as one written with a single
 * retriever in view. This resolves the one it means -- from the target pipeline's own
 * retrieve steps first, since that is the narrowest statement the spec can make, and then
 * from the spec itself when exactly one retriever is declared -- and reports `undefined`
 * rather than guessing when neither narrows to one, because a wrong guess generates a gate
 * that measures a retriever whose expected documents nobody declared.
 */
export function retrievalEvalRetriever(ir: IR, evaluation: EvalShape): string | undefined {
  const pipeline = ir.pipelines.find((entry) => entry.id === evaluation.target.id);
  const used = [
    ...new Set(
      (pipeline?.steps ?? []).flatMap((step) => (step.kind === 'retrieve' ? [step.retriever] : [])),
    ),
  ];
  if (used.length === 1) return used[0];
  return ir.retrievers.length === 1 ? ir.retrievers[0]?.id : undefined;
}

/** One field of the generated request model. */
export interface RequestField {
  readonly name: string;
  readonly type: TypeRef;
}

export interface RequestPlan {
  readonly fields: readonly RequestField[];
  readonly problems: readonly PlanProblem[];
}

/** `undefined` when the two references cannot describe the same Python field. */
function sameType(left: TypeRef, right: TypeRef): boolean {
  return left.kind === right.kind && left.name === right.name && left.list === right.list;
}

/**
 * The generated request model's fields, derived from the pipeline's uses of `event`.
 *
 * The IR declares no request body. `event` is a free root, and the only places a type
 * is given for one of its fields are the prompt variable, the tool argument, or the
 * emitted event field that the reference fills. Each use therefore contributes both
 * the field and its type. Two uses that disagree are refused rather than resolved by
 * step order, because the request model must not depend on it.
 */
export function requestPlan(ir: IR, pipeline: PipelineShape): RequestPlan {
  const types = sortedTypes(ir);
  const prompts = new Map(ir.prompts.map((prompt) => [prompt.id, prompt]));
  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));
  const fields = new Map<string, TypeRef>();
  const problems: PlanProblem[] = [];
  const base = `pipelines.${pipeline.id}`;

  const add = (name: string, inferred: TypeRef, where: string): void => {
    const seen = fields.get(name);
    if (seen === undefined) {
      fields.set(name, inferred);
      return;
    }
    if (sameType(seen, inferred)) return;
    problems.push(
      problem(
        'ambiguous-emit',
        where,
        `request field '${name}' would be both ${seen.name} and ${inferred.name}; the ` +
          'generated request model cannot depend on which step reads the field first',
      ),
    );
  };

  const bindings: StepBinding[] = [{ name: 'event', type: undefined }];
  const steps: readonly StepShape[] = pipeline.steps ?? [];
  const walkSteps = (list: readonly StepShape[], at: string, bindings: StepBinding[]): void => {
    list.forEach((step, index) => {
      const path = `${at}[${index}]`;
      if (step.kind === 'branch') {
        const thenScope: StepBinding[] = [...bindings];
        const elseScope: StepBinding[] = [...bindings];
        walkSteps(step.then, `${path}.branch.then`, thenScope);
        walkSteps(step.else, `${path}.branch.else`, elseScope);
        const elseNames = new Set(elseScope.slice(bindings.length).map((entry) => entry.name));
        for (const entry of thenScope.slice(bindings.length)) {
          if (elseNames.has(entry.name)) bindings.push({ name: entry.name, type: undefined });
        }
        return;
      }
      if (step.kind === 'parallel') {
        const merged = new Map<string, StepBinding>();
        step.branches.forEach((arm, armIndex) => {
          const armScope: StepBinding[] = [...bindings];
          walkSteps(arm, `${path}.parallel.branches[${armIndex}]`, armScope);
          for (const entry of armScope.slice(bindings.length)) {
            if (!merged.has(entry.name)) merged.set(entry.name, entry);
          }
        });
        bindings.push(...merged.values());
        return;
      }
      if (step.kind === 'map') {
        const inner: StepBinding[] = [
          ...bindings,
          { name: ITERATION_ITEM, type: undefined },
          { name: ITERATION_INDEX, type: undefined },
        ];
        walkSteps([step.step], `${path}.map.step`, inner);
        bindings.push({ name: step.as, type: undefined });
        return;
      }
      if (step.kind === 'reduce') {
        bindings.push({ name: step.as, type: undefined });
        return;
      }
      if (step.kind === 'route') {
        // A route's state is text, so an `event.<field>` placeholder in it fixes that
        // field as a string, exactly as a retrieval query does.
        for (const name of templatePlaceholders(step.input)) {
          const [root, field, ...rest] = name.split('.');
          if (root !== 'event' || field === undefined || rest.length > 0) continue;
          add(field, { kind: 'primitive', name: 'string', list: false }, `${path}.input`);
        }
        const scopes = routeArms(step).map(({ label, arm }) => {
          const scope: StepBinding[] = [...bindings];
          walkSteps(arm, `${path}.route.${label}`, scope);
          return scope;
        });
        const first = scopes[0];
        if (first !== undefined) {
          for (const entry of first.slice(bindings.length)) {
            const everywhere = scopes.every((scope) =>
              scope.slice(bindings.length).some((candidate) => candidate.name === entry.name),
            );
            if (everywhere) bindings.push({ name: entry.name, type: entry.type });
          }
        }
        if (step.as !== undefined) bindings.push({ name: step.as, type: undefined });
        return;
      }
      if (step.kind === 'emit') {
        const target = types.get(step.event);
        if (target === undefined) return;
        for (const source of responsePlan(bindings, step.event, types, path).sources) {
          const [root, name] = source.path;
          if (root !== 'event' || name === undefined) continue;
          const field = target.fields.find((candidate) => candidate.name === name);
          if (field !== undefined) add(name, field.type, `${path}.event.${name}`);
        }
        return;
      }

      // A retrieval query is interpolated per request, so an `event.<field>` placeholder in
      // it is a request field whose type the query itself fixes: a query is text, so the
      // field is a string. `checkRetrieveQuery` refuses every other root, which is why this
      // branch only ever reads whole event fields.
      if (step.kind === 'retrieve') {
        for (const name of templatePlaceholders(step.query)) {
          const [root, field, ...rest] = name.split('.');
          if (root !== 'event' || field === undefined || rest.length > 0) continue;
          add(field, { kind: 'primitive', name: 'string', list: false }, `${path}.query`);
        }
        bindings.push({ name: step.as, type: undefined });
        return;
      }

      // The wiring leaves carry a scalar template rather than an `input` map. A whole
      // `event.<field>` placeholder in one is a request field whose type the template fixes:
      // it is interpolated as text, so the field is a string. A `guard` at the retrieval
      // stage carries a binding reference rather than a template, so it contributes nothing.
      if (step.kind === 'rerank' || step.kind === 'agent' || step.kind === 'guard') {
        const templates =
          step.kind === 'rerank'
            ? [step.query]
            : step.kind === 'agent'
              ? [step.text]
              : step.stage === 'retrieval'
                ? []
                : [step.text];
        for (const template of templates) {
          for (const name of templatePlaceholders(template)) {
            const [root, head, ...rest] = name.split('.');
            if (root !== 'event' || head === undefined || rest.length > 0) continue;
            add(head, { kind: 'primitive', name: 'string', list: false }, `${path}.text`);
          }
        }
        // A guard binds nothing: `flag` is observability only.
        if (step.kind !== 'guard') bindings.push({ name: step.as, type: undefined });
        return;
      }

      const wanted = new Map<string, TypeRef>();
      if (step.kind === 'generate') {
        const prompt = prompts.get(step.prompt);
        for (const variable of prompt?.variables ?? []) wanted.set(variable.name, variable.type);
      } else if (step.kind === 'tool') {
        const tool = tools.get(step.tool);
        const input = tool === undefined ? undefined : structFields(tool.input, types);
        for (const field of input?.fields ?? []) wanted.set(field.name, field.type);
      }
      for (const [key, value] of Object.entries(step.input ?? {})) {
        if (value.kind !== 'reference') continue;
        const [root, name, ...rest] = value.path;
        if (root !== 'event' || name === undefined || rest.length > 0) continue;
        const inferred = wanted.get(key);
        if (inferred !== undefined) add(name, inferred, `${path}.input.${key}`);
      }
      if (step.kind === 'generate') {
        const declared = prompts.get(step.prompt)?.output;
        const schema = declared?.kind === 'structured' ? declared.schema : undefined;
        // `checkPrompts` refuses a structured output that names no declared struct, so a
        // missing schema here is unreachable; the fallback keeps the type honest.
        const output: TypeRef = schema ?? { kind: 'primitive', name: 'string', list: false };
        bindings.push({ name: step.as, type: output });
        return;
      }
      const tool = tools.get(step.tool);
      bindings.push({ name: step.as, type: tool?.output });
    });
  };

  walkSteps(steps, `${base}.steps`, bindings);

  return {
    fields: [...fields.entries()]
      .map(([name, type]) => ({ name, type }))
      .sort((left, right) => compareIds(left.name, right.name)),
    problems,
  };
}

/** The binding name a step introduces, or `undefined` when the step introduces none. */
export function bindingOf(step: StepShape): string | undefined {
  return step.kind === 'emit' ||
    step.kind === 'guard' ||
    step.kind === 'branch' ||
    step.kind === 'parallel'
    ? undefined
    : step.as;
}

/** The arms a `route` can take, in declaration order, with `default` last. */
export function routeArms(
  step: Extract<StepShape, { kind: 'route' }>,
): { label: string; arm: readonly StepShape[] }[] {
  return [
    ...Object.entries(step.on).map(([label, arm]) => ({ label, arm })),
    ...(step.default === undefined ? [] : [{ label: 'default', arm: step.default }]),
  ];
}

/** The names a `map` iteration exposes to its body. */
export const ITERATION_ITEM = 'item';
export const ITERATION_INDEX = 'index';

export function checkPipelines(ir: IR): PlanProblem[] {
  const types = sortedTypes(ir);
  const prompts = new Map(ir.prompts.map((prompt) => [prompt.id, prompt]));
  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));
  const models = new Set(ir.models.map((model) => model.id));
  const agents = new Map((ir.agents ?? []).map((agent) => [agent.id, agent]));
  const guardrails = new Map((ir.guardrails ?? []).map((guardrail) => [guardrail.id, guardrail]));
  const decisions = new Map((ir.decisions ?? []).map((decision) => [decision.id, decision]));
  const batchPipelines = new Set(
    ir.deployments
      .filter((deployment) => deployment.target === 'batch')
      .flatMap((deployment) => (deployment.pipeline === undefined ? [] : [deployment.pipeline])),
  );
  const problems: PlanProblem[] = [];

  for (const pipeline of ir.pipelines) {
    const base = `pipelines.${pipeline.id}`;
    const kind = pipeline.trigger?.kind;
    if (kind === 'manual') {
      if (!batchPipelines.has(pipeline.id)) {
        problems.push(
          problem(
            'unsupported-trigger',
            `${base}.trigger`,
            `'${pipeline.id}' is manual, but no \`target: batch\` deployment names it, so ` +
              'nothing would ever run it: a manual trigger is the batch job entrypoint, not ' +
              'a second way to reach a route',
          ),
        );
      } else if (!pipeline.steps.some((step) => step.kind === 'emit')) {
        problems.push(
          problem(
            'batch-pipeline-without-emit',
            `${base}.steps`,
            'a batch job writes the model its `emit` step produces to stdout as one JSON ' +
              'object; without an emit step there is no answer to write and no non-zero ' +
              'exit that tells a failed run from a successful one',
          ),
        );
      }
    } else if (kind !== 'http') {
      problems.push(
        problem(
          'unsupported-trigger',
          `${base}.trigger`,
          `Phase 0 wires an 'http' trigger to a FastAPI route and a 'manual' one to a batch ` +
            `job; got '${kind ?? '<none>'}'`,
        ),
      );
    }
    const redact = pipeline.observability?.redact ?? [];
    if (redact.length > 0) {
      problems.push(
        problem(
          'unsupported-redact',
          `${base}.observability.redact`,
          `the runtime's tracing has no redaction hook, so traces would carry ` +
            `${[...redact].sort(compareIds).join(', ')}`,
        ),
      );
    }
    const route = pipeline.trigger?.kind === 'http' ? pipeline.trigger.path : '';
    if (route.includes('{') || route.includes('}')) {
      problems.push(
        problem(
          'unsupported-trigger',
          `${base}.trigger.path`,
          'a path parameter has no declared type in the IR, so Phase 0 emits one request ' +
            'body model per pipeline; declare the value as a field of the request instead',
        ),
      );
    }
    problems.push(...requestPlan(ir, pipeline).problems);
    const policy = pipeline.errorPolicy;
    if (
      policy !== undefined &&
      (policy.retries > 0 || policy.fallback !== undefined || policy.deadLetter !== undefined)
    ) {
      problems.push(
        problem(
          'unsupported-param',
          `${base}.errorPolicy`,
          'the runtime Pipeline retries nothing in Phase 0, so a retry, fallback or ' +
            'dead-letter policy would be silently dropped; declare `retries: 0` and neither',
        ),
      );
    }
    const bindings: StepBinding[] = [{ name: 'event', type: undefined }];
    const steps: readonly StepShape[] = pipeline.steps ?? [];
    // The bindings that hold retrieved items, so a generate step's `context` name can be
    // checked against the kind of binding that can fill it rather than only its presence.
    // A `rerank` reorders a retrieval result and binds one, so it joins the set: a later
    // `rerank` or a `generate.context` may name it.
    const retrieved = new Set<string>(
      steps.flatMap((step) =>
        step.kind === 'retrieve' || step.kind === 'rerank' ? [step.as] : [],
      ),
    );
    if (steps.length === 0) {
      problems.push(problem('missing-emit', `${base}.steps`, 'a pipeline needs at least one step'));
    }
    // The runtime's `Pipeline` refuses an empty step list, so a pipeline that only
    // emits would generate a factory that raises on every request.
    if (steps.length > 0 && !steps.some((step) => step.kind !== 'emit')) {
      problems.push(
        problem(
          'missing-step',
          `${base}.steps`,
          'the runtime refuses a pipeline with no steps, so a pipeline needs at least one ' +
            'generate or tool step before the step that emits',
        ),
      );
    }
    // A composite nests step lists, so the walk recurses. `at` is the path prefix the
    // list index is appended to, which keeps a nested problem addressable.
    const walkSteps = (list: readonly StepShape[], at: string, bindings: StepBinding[]): void => {
      list.forEach((step, index) => {
        const path = `${at}[${index}]`;
        const names = bindings.map((binding) => binding.name);
        const bound = bindingOf(step);
        checkStepTemplates(step, path, problems);
        if (bound !== undefined) {
          if (names.includes(bound)) {
            problems.push(
              problem(
                'duplicate-binding',
                path,
                `binding '${bound}' is reused, which makes every reference to it ambiguous`,
              ),
            );
          }
          if ((RESERVED_BINDINGS as readonly string[]).includes(bound)) {
            problems.push(
              problem('duplicate-binding', path, `'${bound}' is owned by the generated entrypoint`),
            );
          }
          // A binding is passed through the pipeline context as a Python keyword
          // argument, so a name that is not an identifier could not be bound at all.
          if (!isUsableIdentifier(bound)) {
            problems.push(
              problem(
                'unusable-name',
                path,
                `binding '${bound}' is not a usable Python identifier; each binding becomes a ` +
                  'keyword argument carried through `PipelineContext`',
              ),
            );
          }
          // The generated step body owns every local whose name starts with an
          // underscore, so a binding spelled that way would shadow one of them.
          if (bound.startsWith('_')) {
            problems.push(
              problem(
                'unusable-name',
                path,
                `binding '${bound}' starts with an underscore, which the generated step body ` +
                  'reserves for its own locals; rename it',
              ),
            );
          }
          // A binding is read back inside the step body as a local, so two bindings
          // that differ only in where the generated snake-casing puts underscores
          // would be the same Python name.
          const key = moduleName(bound);
          if (names.some((name) => moduleName(name) === key)) {
            problems.push(
              problem(
                'duplicate-binding',
                path,
                `binding '${bound}' becomes '${key}' in the generated step, which an earlier ` +
                  'binding already became; rename one of them',
              ),
            );
          }
        }
        if (step.kind === 'branch') {
          const thenScope: StepBinding[] = [...bindings];
          const elseScope: StepBinding[] = [...bindings];
          walkSteps(step.then, `${path}.branch.then`, thenScope);
          walkSteps(step.else, `${path}.branch.else`, elseScope);
          // A branch binds only the names both arms bind. A name one arm omits would resolve
          // or raise depending on which arm ran, so it is not a binding of the branch at all;
          // with no `else` one arm is empty and the branch therefore binds nothing.
          const elseNames = new Set(elseScope.slice(bindings.length).map((entry) => entry.name));
          for (const entry of thenScope.slice(bindings.length)) {
            if (elseNames.has(entry.name)) bindings.push({ name: entry.name, type: undefined });
          }
          return;
        }
        if (step.kind === 'parallel') {
          const merged = new Map<string, StepBinding>();
          step.branches.forEach((arm, armIndex) => {
            const armScope: StepBinding[] = [...bindings];
            walkSteps(arm, `${path}.parallel.branches[${armIndex}]`, armScope);
            for (const entry of armScope.slice(bindings.length)) {
              if (merged.has(entry.name)) {
                problems.push(
                  problem(
                    'duplicate-binding',
                    `${path}.parallel.branches[${armIndex}]`,
                    `parallel arms both bind '${entry.name}', so the merged context would ` +
                      'depend on which arm finished last',
                  ),
                );
                continue;
              }
              merged.set(entry.name, entry);
            }
          });
          bindings.push(...merged.values());
          return;
        }
        if (step.kind === 'map') {
          if (!names.includes(step.over)) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.map.over`,
                `'${step.over}' is not bound at this step, so the map has no list to iterate`,
              ),
            );
          }
          // The body sees the iteration's own names; its bindings are per-item and never
          // escape, so it walks a copy of the scope.
          const inner: StepBinding[] = [
            ...bindings,
            { name: ITERATION_ITEM, type: undefined },
            { name: ITERATION_INDEX, type: undefined },
          ];
          walkSteps([step.step], `${path}.map.step`, inner);
          bindings.push({ name: step.as, type: undefined });
          return;
        }
        if (step.kind === 'reduce') {
          if (!names.includes(step.over)) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.reduce.over`,
                `'${step.over}' is not bound at this step, so the reduce has no list to iterate`,
              ),
            );
          }
          if (!prompts.has(step.prompt)) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.reduce.prompt`,
                `prompt '${step.prompt}' is not declared`,
              ),
            );
          }
          if (!models.has(step.model)) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.reduce.model`,
                `model alias '${step.model}' is not declared`,
              ),
            );
          }
          bindings.push({ name: step.as, type: undefined });
          return;
        }
        if (step.kind === 'route') {
          const decision = decisions.get(step.decision);
          if (decision === undefined) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.decision`,
                `decision '${step.decision}' is not declared`,
              ),
            );
          } else if (decision.type !== 'choice') {
            // A `score` answer is a position on a rubric and a `noul` answer a probability;
            // neither names one of the arms, so neither can select one.
            problems.push(
              problem(
                'unsupported-param',
                `${path}.decision`,
                `decision '${decision.id}' is a '${decision.type}' question, and a route runs ` +
                  "the arm a 'choice' answer names; only a choice answer carries a label",
              ),
            );
          }
          checkTextTemplate(step.input, 'input', 'a route input', path, bindings, types, problems);
          const scopes = routeArms(step).map(({ label, arm }) => {
            const scope: StepBinding[] = [...bindings];
            walkSteps(arm, `${path}.route.${label}`, scope);
            return scope;
          });
          // Exactly one arm runs, so a name only some arms bind is not a binding of the
          // route at all: it would resolve or raise depending on which arm answered.
          const first = scopes[0];
          if (first !== undefined) {
            for (const entry of first.slice(bindings.length)) {
              const everywhere = scopes.every((scope) =>
                scope.slice(bindings.length).some((candidate) => candidate.name === entry.name),
              );
              if (everywhere) bindings.push({ name: entry.name, type: entry.type });
            }
          }
          // The chosen label is the one value a route can hand on; it is text by definition.
          if (step.as !== undefined) {
            bindings.push({
              name: step.as,
              type: { kind: 'primitive', name: 'string', list: false },
            });
          }
          return;
        }
        if (step.kind === 'emit') {
          if (index !== list.length - 1) {
            problems.push(
              problem('missing-emit', path, 'only the final step may emit the HTTP response'),
            );
          }
          if (!types.has(step.event)) {
            problems.push(
              problem(
                'unresolved-type',
                `${path}.event`,
                `event '${step.event}' is not a declared struct`,
              ),
            );
            return;
          }
          problems.push(...responsePlan(bindings, step.event, types, path).problems);
          return;
        }
        if (step.kind === 'tool') {
          const tool = tools.get(step.tool);
          if (tool === undefined) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.tool`,
                `tool '${step.tool}' is not declared`,
              ),
            );
            return;
          }
          const keys = checkStepInput(step.input, path, bindings, types, problems);
          const fields = structFields(tool.input, types);
          const required =
            fields?.fields.filter((field) => field.required).map((f) => f.name) ?? [];
          checkArgumentKeys(keys, fields, required, `${path}.input`, problems, `tool '${tool.id}'`);
          bindings.push({ name: step.as, type: tool.output });
          return;
        }
        if (step.kind === 'retrieve') {
          checkRetrieveStep(ir, step, path, bindings, types, problems);
          // The binding stays untyped on purpose: a retrieval step yields items and a
          // rendered context, not a struct, so `emit/ir.ts` reports no type for it and the
          // generated call is the only thing that reads it.
          bindings.push({ name: step.as, type: undefined });
          return;
        }
        if (step.kind === 'rerank') {
          // The runtime's interface is `rerank(query, items, *, top_n)`, so the operand has
          // two halves and the design's single `input` could only have named one of them.
          if (!retrieved.has(step.over)) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.over`,
                `'${step.over}' is not a retrieval binding; a rerank reorders the items a ` +
                  "'retrieve' -- or an earlier 'rerank' -- step binds, and takes nothing else",
              ),
            );
          }
          checkTextTemplate(step.query, 'query', 'a rerank query', path, bindings, types, problems);
          // `reranker_for` raises `FeatureDeferredError` for any alias whose name does not
          // say it is lexical, and the generated binding carries the alias verbatim, so a
          // name that cannot be served is refused here rather than at the first request --
          // the rule `checkRetrieverDeclaration` already applies to `retriever.rerank.model`.
          if (!step.model.toLowerCase().includes('lexical')) {
            problems.push(
              problem(
                'unsupported-param',
                `${path}.model`,
                `the runtime's only reranker is lexical, so '${step.model}' cannot be served; ` +
                  "name it 'lexical' until another reranker ships",
              ),
            );
          }
          // Unannotated on purpose, like a retrieval binding: a rerank yields ranked items
          // and a rendered context, not a struct, so nothing reads it as a declared type.
          bindings.push({ name: step.as, type: undefined });
          return;
        }
        if (step.kind === 'guard') {
          const guardrail = guardrails.get(step.guardrail);
          if (guardrail === undefined) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.guardrail`,
                `guardrail '${step.guardrail}' is not declared`,
              ),
            );
            return;
          }
          if (!guardrail.stages.includes(step.stage)) {
            problems.push(
              problem(
                'unsupported-guardrail',
                `${path}.guardrail`,
                `guardrail '${guardrail.id}' declares no '${step.stage}' stage, so the step ` +
                  'would run it against a stage the spec never named for it',
              ),
            );
          }
          // A pipeline step is emitted as a synchronous call, and a decision-backed
          // guardrail needs an HTTP round trip, so the step would silently pass the
          // payload on without ever asking. Refuse rather than skip the check.
          if (guardrail.decision !== undefined) {
            problems.push(
              problem(
                'unsupported-guardrail',
                `${path}.guardrail`,
                `guardrail '${guardrail.id}' is answered by decision '${guardrail.decision}', ` +
                  'which a pipeline step cannot ask: the step check is synchronous and the ' +
                  'answer is a network call',
              ),
            );
          }
          // A pipeline step has three observable outcomes and no fourth: carry on, raise, or
          // say nothing. `escalate` needs a checkpoint a step cannot return (and would make a
          // pipeline a second pause mechanism beside `agents[].humanInTheLoop`); `redact`
          // rewrites a payload the step binds nothing back to. Both are refused rather than
          // downgraded to `flag`.
          if (guardrail.action === 'escalate' || guardrail.action === 'redact') {
            problems.push(
              problem(
                'unsupported-param',
                `${path}.guardrail`,
                `guardrail '${guardrail.id}' acts with '${guardrail.action}', which a pipeline ` +
                  "step cannot serve: 'escalate' needs a checkpoint, and 'redact' has no " +
                  'binding to write the masked payload back to',
              ),
            );
          }
          if (step.stage === 'tool-call') {
            problems.push(
              problem(
                'unsupported-param',
                `${path}.stage`,
                "a guard step names the payload it inspects, and the 'tool-call' stage has " +
                  'none to name: gate the call in an agent, whose loop owns the calls',
              ),
            );
          } else if (step.stage === 'retrieval') {
            // `check_retrieval` takes the chunk passages, so the operand is a projection of a
            // retrieval binding rather than a template: the text has to be that binding, alone,
            // because anything else is author text the emitted projection would silently drop.
            const parts = scanTemplate(step.text);
            const named =
              parts.length === 1 && parts[0]?.kind === 'placeholder' ? parts[0] : undefined;
            if (named === undefined || !retrieved.has(named.name)) {
              problems.push(
                problem(
                  'unsupported-param',
                  `${path}.text`,
                  "a 'retrieval' guard inspects the chunk passages of exactly one retrieval " +
                    `binding, so its text is just {{ ${named?.name ?? 'that binding'} }}; ` +
                    `got '${step.text}'`,
                ),
              );
            }
          } else {
            checkTextTemplate(step.text, 'text', 'guard text', path, bindings, types, problems);
          }
          // A guard binds nothing: `flag` is observability only, and the two actions that
          // could change the payload are refused above.
          return;
        }
        if (step.kind === 'agent') {
          const target = agents.get(step.agent);
          if (target === undefined) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.agent`,
                `agent '${step.agent}' is not declared`,
              ),
            );
            return;
          }
          // `AgentRuntime.run` returns `PAUSED` with a checkpoint its caller has to carry,
          // and a step's result is a value in the pipeline context, not a route. Every
          // source of a pause is refused here (`agentCanPause` names all three), so a
          // pipeline never stops for a reason it cannot report.
          if (agentCanPause(ir, target)) {
            problems.push(
              problem(
                'unsupported-param',
                `${path}.agent`,
                `agent '${target.id}' can end a run in PAUSED -- it declares a ` +
                  '`humanInTheLoop`, calls a tool that requires confirmation, or carries an ' +
                  'escalating guardrail -- and a step has no checkpoint to return; run it ' +
                  'through `/agents/{agent_id}/run` instead',
              ),
            );
          }
          // `run` keys memory by `memory_key or agent.id` and a step passes neither, so a
          // memory-bearing target would share one thread across every request.
          if (target.memory.length > 0) {
            problems.push(
              problem(
                'unsupported-param',
                `${path}.agent`,
                `agent '${target.id}' declares memory, and a step opens no thread: the runtime ` +
                  "would key it by the agent's own id, so every request would read the one " +
                  'before it',
              ),
            );
          }
          checkTextTemplate(step.text, 'text', 'agent text', path, bindings, types, problems);
          // The run's answer is the whole of what crosses back, so the binding is a string.
          bindings.push({
            name: step.as,
            type: { kind: 'primitive', name: 'string', list: false },
          });
          return;
        }
        const prompt = prompts.get(step.prompt);
        if (prompt === undefined) {
          problems.push(
            problem(
              'unresolved-reference',
              `${path}.prompt`,
              `prompt '${step.prompt}' is not declared`,
            ),
          );
          return;
        }
        if (!models.has(step.model)) {
          problems.push(
            problem(
              'unresolved-reference',
              `${path}.model`,
              `model alias '${step.model}' is not declared`,
            ),
          );
        }
        const keys = checkStepInput(step.input, path, bindings, types, problems);
        const wanted = renderNames(prompt);
        for (const name of keys) {
          if (!wanted.includes(name)) {
            problems.push(
              problem(
                'unused-input',
                `${path}.input`,
                `prompt '${prompt.id}' declares no variable '${name}'`,
              ),
            );
          }
        }
        // A retrieved context reaches the prompt through `step.context`, which the runtime
        // refuses when the template does not use it, so both halves are checked here: the
        // name has to be one the rendered template accepts, and it has to name a binding
        // that actually holds retrieved items.
        if (step.context !== undefined) {
          if (!retrieved.has(step.context)) {
            problems.push(
              problem(
                'unresolved-reference',
                `${path}.context`,
                `'${step.context}' is not a retrieval binding; the generated call inlines the ` +
                  "items of a 'retrieve' step, and only that step declares one",
              ),
            );
          }
          const accepted = new Set([
            ...flatPlaceholders(prompt),
            ...prompt.variables.filter((variable) => variable.required).map((v) => v.name),
          ]);
          if (!accepted.has(step.context)) {
            problems.push(
              problem(
                'unused-input',
                `${path}.context`,
                `the runtime rejects a prompt value the template does not use: prompt ` +
                  `'${prompt.id}' neither interpolates '${step.context}' nor declares it ` +
                  'required, so the rendered call would raise',
              ),
            );
          }
        }
        for (const name of wanted) {
          // The context variable is supplied by `step.context` rather than by an input key,
          // so it is the one variable that is legitimately absent from the step's inputs.
          if (name === step.context) continue;
          if (!keys.includes(name)) {
            problems.push(
              problem('missing-input', `${path}.input`, `prompt '${prompt.id}' requires '${name}'`),
            );
          }
        }
        const schema = prompt.output.kind === 'structured' ? prompt.output.schema : undefined;
        const output: TypeRef = schema ?? { kind: 'primitive', name: 'string', list: false };
        bindings.push({ name: step.as, type: output });
      });
    };

    walkSteps(steps, `${base}.steps`, bindings);
  }
  return problems;
}

export type { EvalSubject, EvalSubjectResult };
/**
 * The model aliases a prompt is rendered against, sorted, and the prompt and model an
 * eval measures. Both are pure functions of the IR, so `@aid-framework/ir` owns them and
 * every generator asks the same question; they are re-exported here because callers
 * import them from the validator that used to define them.
 */
export { evalSubject, modelsUnderTest };

/**
 * Whether a dataset URI is a safe path under `app/evals/`.
 *
 * The generated loader resolves the URI against the app directory, so a traversal or an
 * absolute path would let the spec read a file the app does not own, and a URI outside
 * `evals/` would put a dataset somewhere the design says the developer owns nothing.
 * Checked by scanning rather than by an anchored regex: `docs/design.md` Â§12 and layer
 * 3's CodeQL findings both say an anchored quantifier over path characters is a
 * denial-of-service bug.
 */
export function safeDatasetUri(uri: string): boolean {
  if (!uri.startsWith('evals/')) return false;
  if (uri.startsWith('/') || uri.startsWith('\\')) return false;
  if (uri.length > 1 && uri[1] === ':') return false;
  for (const segment of uri.split(/[\\/]/)) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

export function checkEvals(ir: IR): PlanProblem[] {
  const types = sortedTypes(ir);
  const models = new Set(ir.models.map((model) => model.id));
  const problems: PlanProblem[] = [];

  for (const evaluation of ir.evals) {
    const base = `evals.${evaluation.id}`;
    const subject = evalSubject(ir, evaluation);
    if (!subject.ok) {
      problems.push(problem(subject.code, `${base}.target`, subject.message));
    }
    const prompt = subject.ok ? subject.subject.prompt : undefined;
    const dataset = evaluation.dataset;
    if (dataset?.source !== 'file' || (dataset.uri ?? '') === '') {
      problems.push(
        problem(
          'unsupported-eval-input',
          `${base}.dataset`,
          `Phase 0 loads a dataset from a file, resolved under app/evals/; a ` +
            `'${dataset?.source ?? '<none>'}' dataset carries no cases in the IR`,
        ),
      );
    }
    if (
      dataset?.source === 'file' &&
      (dataset.uri ?? '') !== '' &&
      !safeDatasetUri(dataset.uri ?? '')
    ) {
      problems.push(
        problem(
          'unsupported-eval-input',
          `${base}.dataset.uri`,
          `dataset path '${dataset.uri}' must be a relative path under app/evals/ with no ` +
            'traversal, so the generated loader cannot read a file the app does not own',
        ),
      );
    }
    const seen = new Set<string>();
    let deterministic = 0;
    // The retrieval harness drives `RetrievalGate` over a ranked retrieved set, which does
    // not compose with the prediction-per-case run `run_evaluation` performs, and this
    // target emits one module per eval. Refusing is the honest outcome: an eval that
    // declared both would generate a module that measures one and silently drops the other.
    if (
      evaluation.metrics.some((metric) => metric.kind === 'retrieval') &&
      !isRetrievalEval(evaluation)
    ) {
      problems.push(
        problem(
          'unsupported-metric',
          `${base}.metrics`,
          'a retrieval metric is measured by RetrievalGate over a ranked retrieved set, and a ' +
            'generated eval measures one prediction per case; this target emits one harness per ' +
            'eval, so declare the retrieval metric in an eval of its own',
        ),
      );
    }
    if (isRetrievalEval(evaluation) && retrievalEvalRetriever(ir, evaluation) === undefined) {
      problems.push(
        problem(
          'unresolved-reference',
          `${base}.metrics`,
          'a retrieval metric names no retriever, and this spec declares more than one, so the ' +
            'expected documents have no documented uri to resolve against; retrieve from it in ' +
            "the eval's target pipeline, or declare one retriever",
        ),
      );
    }
    for (const [index, metric] of evaluation.metrics.entries()) {
      const path = `${base}.metrics[${index}]`;
      const mapping = mapMetric(metric);
      if (!mapping.measured) {
        problems.push(
          problem(
            'unsupported-metric',
            path,
            `metric '${metric.kind}' cannot be measured: ${mapping.reason}`,
          ),
        );
        continue;
      }
      if (mapping.deterministic) deterministic += 1;
      if (seen.has(mapping.name)) {
        problems.push(
          problem(
            'duplicate-metric',
            path,
            `metric '${metric.kind}' maps to runtime metric '${mapping.name}', which this eval ` +
              'already declares',
          ),
        );
      }
      seen.add(mapping.name);
      if (metric.kind === 'json-schema' && !resolvesToStruct(metric.schema, types)) {
        problems.push(
          problem(
            'unresolved-type',
            `${path}.schema`,
            `schema '${metric.schema.name}' is not a declared struct`,
          ),
        );
      }
      if (metric.kind === 'llm-judge') {
        const judge = judgeAlias(evaluation);
        if (judge === undefined) {
          problems.push(
            problem(
              'unsupported-metric',
              path,
              'an llm-judge metric must name the judge model in `model`: Phase 0 has no default ' +
                'judge, and scoring with the model under test is not a measurement',
            ),
          );
        } else if (!models.has(judge)) {
          problems.push(
            problem(
              'unresolved-reference',
              `${path}.model`,
              `judge alias '${judge}' is not declared`,
            ),
          );
        }
      }
      if (metric.kind === 'decision') {
        const decision = ir.decisions.find((entry) => entry.id === metric.decision);
        if (decision === undefined) {
          problems.push(
            problem(
              'unresolved-reference',
              `${path}.decision`,
              `decision '${metric.decision}' is not declared`,
            ),
          );
        } else if (decision.type !== 'score') {
          problems.push(
            problem(
              'unsupported-metric',
              `${path}.decision`,
              `decision '${metric.decision}' is a '${decision.type}' decision, and only a 'score' ` +
                'decision can be measured: its ordered criteria give the answer a position, ' +
                "which a choice's labels and a noul's confidence do not",
            ),
          );
        } else if (!Array.isArray(decision.criteria) || decision.criteria.length < 2) {
          problems.push(
            problem(
              'invalid-gate',
              `${path}.decision`,
              `decision '${metric.decision}' must declare at least two ordered criteria, because ` +
                'the metric is the position of the answer among them',
            ),
          );
        }
      }
    }
    if (deterministic === 0) {
      problems.push(
        problem(
          'invalid-gate',
          `${base}.metrics`,
          'the gate needs at least one threshold, and the runtime refuses to threshold on a ' +
            'model-backed metric, so this eval declares no metric the gate could measure',
        ),
      );
    }
    const samples = evaluation.gate?.samples ?? 0;
    if (!Number.isInteger(samples) || samples < 1) {
      problems.push(
        problem(
          'invalid-gate',
          `${base}.gate.samples`,
          `samples must be a positive integer, got ${samples}`,
        ),
      );
    }
    const regression = evaluation.gate?.maxRegression ?? 0;
    if (!(regression >= 0 && regression <= 1)) {
      problems.push(
        problem(
          'invalid-gate',
          `${base}.gate.maxRegression`,
          `maxRegression is the largest tolerated drop in a mean score, in [0, 1] (the runtime's ` +
            `Threshold.max_regression); got ${regression}`,
        ),
      );
    }
    if (prompt !== undefined) {
      // The variable a retrieve step feeds is supplied empty rather than by the dataset:
      // the dataset row is one string, and it fills the variable the eval measures.
      const context = evalContextVariable(ir, evaluation, prompt);
      const names = renderNames(prompt).filter((name) => name !== context);
      if (names.length !== 1) {
        problems.push(
          problem(
            'unsupported-eval-input',
            `${base}.target`,
            `prompt '${prompt.id}' renders ${names.length} values ` +
              `(${names.join(', ') || '<none>'}), and this target maps a dataset row to ` +
              'exactly one prompt variable',
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
 * actions it can carry out and which fields its stages actually see.
 */
function checkGuardrails(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const types = sortedTypes(ir);
  for (const guardrail of ir.guardrails) {
    const path = `guardrails.${guardrail.id}`;
    if (guardrail.action === 'escalate') {
      // Escalation is a question put to a human and resumed from a checkpoint. The agent
      // loop owns that checkpoint; a pipeline route has none, so an escalated pipeline
      // run would stop with nobody to answer -- which is a block wearing a different name.
      //
      // Which guardrails a pipeline route *can* run is therefore the whole question, and
      // it is not "all of them". The generated route enforces exactly one stage table,
      // `INPUT_GUARDRAILS`, which is every guardrail in the document whose `stages`
      // contains `input` -- so an escalate guardrail that never declares `input` is
      // unreachable from a pipeline route and reachable only from an agent that names it.
      // Rejecting that one would be refusing the single useful shape of escalation, and
      // leaving the agent loop's `_guardrail_pause` with no way to ever be reached.
      const pipelineReachable = guardrail.stages.includes('input');
      if (pipelineReachable) {
        problems.push(
          problem(
            'unsupported-guardrail',
            `${path}.action`,
            `'${guardrail.id}' escalates at the input stage, but escalation needs the agent ` +
              "loop's checkpoint and resume, and the generate route -- which enforces every " +
              'input-stage guardrail in the document -- has neither. Use action: block to ' +
              'refuse the request, action: flag to record it and continue, or drop the input ' +
              'stage so only the agent route runs it',
          ),
        );
      }
    }
    if (guardrail.decision !== undefined && guardrail.action === 'redact') {
      problems.push(
        problem(
          'unsupported-guardrail',
          `${path}.action`,
          `'${guardrail.id}' is answered by a decision, which returns a verdict rather than a ` +
            'masked payload, so action: redact has nothing to rewrite; map the decision with ' +
            'onDecision and use block, flag or escalate',
        ),
      );
    }
    if (guardrail.action !== 'redact') continue;
    for (const policy of guardrail.policies) {
      if (REDACTABLE_POLICIES.some((entry) => entry === policy)) continue;
      problems.push(
        problem(
          'unsupported-redact',
          `${path}.policies`,
          `'${guardrail.id}' redacts, but policy '${policy}' detects intent rather than a ` +
            `maskable value, so the runtime raises instead of returning a cleaned payload. ` +
            `Redact with ${REDACTABLE_POLICIES.join(', ')}, or use action: block`,
        ),
      );
    }
    for (const name of guardrail.redact) {
      for (const stage of guardrail.stages) {
        if (stage !== 'tool-call') {
          // The runtime builds the input, output and retrieval payloads itself, always as
          // `{"text": ...}`. A name that is not `text` is a redaction that can never run,
          // and the runtime's own fail-closed re-check would then block every firing.
          if (stage === 'input' || stage === 'output' || stage === 'retrieval') {
            if (name === 'text') continue;
            problems.push(
              problem(
                'unsupported-redact',
                `${path}.redact`,
                `'${guardrail.id}' redacts field '${name}' at the '${stage}' stage, but that ` +
                  "stage's payload is exactly {'text': ...}; name 'text' or the redaction " +
                  'has nothing to mask',
              ),
            );
          }
          continue;
        }
        for (const tool of coveredTools(ir, guardrail.tools)) {
          if (toolArgumentNames(tool, types).includes(name)) continue;
          problems.push(
            problem(
              'unsupported-redact',
              `${path}.redact`,
              `'${guardrail.id}' redacts '${name}' from tool '${tool.id}', but that tool takes ` +
                `(${toolArgumentNames(tool, types).join(', ') || '<no arguments>'}); a ` +
                'redaction naming another field cannot mask what reaches the tool',
            ),
          );
        }
      }
    }
  }
  return problems;
}

/** The tools a `tool-call` guardrail applies to; an empty list means every tool. */
function coveredTools(ir: IR, tools: readonly string[]): ToolShape[] {
  return tools.length === 0
    ? ir.tools
    : ir.tools.filter((tool) => tools.some((id) => id === tool.id));
}

/** The argument names a tool's declaration gives it. */
function toolArgumentNames(tool: ToolShape, types: Map<string, TypeShape>): string[] {
  const shape = tool.input.kind === 'named' ? types.get(tool.input.name) : undefined;
  return (shape?.fields ?? []).map((field) => field.name);
}

/**
 * The deployments this target cannot serve.
 *
 * `streaming` and `pipeline` are the only deployment fields that reach generated code --
 * everything else describes the platform the app is put on, which the app neither reads
 * nor implements. So a deployment that asks to stream, or to run a pipeline, is checked
 * against what the generated entrypoints can actually do. An `edge` deployment reads
 * neither field: it serves whichever HTTP routes the app has, so it is refused when
 * there are none.
 */
function checkDeployments(ir: IR): PlanProblem[] {
  const pipelines = new Map(ir.pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const problems: PlanProblem[] = [];
  for (const deployment of ir.deployments) {
    const path = `deployments.${deployment.id}`;
    if (deployment.target === 'batch') {
      const named = deployment.pipeline;
      if (named === undefined) {
        problems.push(
          problem(
            'unsupported-target',
            `${path}.pipeline`,
            `'${deployment.id}' targets 'batch' but names no pipeline, so the job would have ` +
              'nothing to run; a batch deployment exists to run exactly one pipeline once',
          ),
        );
      } else {
        const pipeline = pipelines.get(named);
        if (pipeline === undefined) {
          problems.push(
            problem(
              'unsupported-target',
              `${path}.pipeline`,
              `'${deployment.id}' names pipeline '${named}', which this IR does not declare`,
            ),
          );
        } else if (pipeline.trigger?.kind !== 'manual') {
          problems.push(
            problem(
              'unsupported-trigger',
              `pipelines.${named}.trigger`,
              `'${deployment.id}' runs pipeline '${named}', but that pipeline is also an ` +
                'http route; a batch job and an HTTP route are different entrypoints, so ' +
                "the pipeline must declare a 'manual' trigger",
            ),
          );
        }
      }
    }
    if (
      deployment.target === 'edge' &&
      !ir.pipelines.some((pipeline) => pipeline.trigger?.kind === 'http')
    ) {
      problems.push(
        problem(
          'unsupported-target',
          `${path}.target`,
          `'${deployment.id}' targets 'edge' but this IR declares no HTTP pipeline, so the ` +
            'association would have no route to serve; an edge deployment serves the app ' +
            'HTTP routes',
        ),
      );
    }
    if (!deployment.streaming) continue;
    if (deployment.target === 'batch' || deployment.target === 'edge') {
      const kind = deployment.target === 'batch' ? 'a batch' : 'an edge';
      problems.push(
        problem(
          'unsupported-streaming',
          `${path}.target`,
          `'${deployment.id}' streams, but ${kind} deployment returns one complete body, ` +
            'so there is no stream to forward. Use a serverless or container target',
        ),
      );
    }
    const guarded = ir.guardrails.filter((guardrail) => guardrail.stages.includes('output'));
    for (const guardrail of guarded) {
      // A stream is the reply leaving before the reply exists, so there is nothing to
      // inspect: buffering it to satisfy the guardrail is the behaviour streaming removes.
      problems.push(
        problem(
          'unsupported-streaming',
          `${path}.streaming`,
          `'${deployment.id}' streams, but '${guardrail.id}' inspects the 'output' stage. ` +
            'A guardrail cannot see a reply that has already been sent, and buffering the ' +
            'stream to check it first would not be a stream',
        ),
      );
    }
    for (const pipeline of ir.pipelines) {
      if (pipeline.trigger?.kind !== 'http') continue;
      if (streamablePipeline(pipeline)) continue;
      problems.push(
        problem(
          'unsupported-streaming',
          `pipelines.${pipeline.id}.steps`,
          `'${deployment.id}' streams, but pipeline '${pipeline.id}' cannot: a stream carries ` +
            "the model's text as it arrives, so exactly one step may generate and every " +
            'step after it may only project the response -- an emit step. A second `generate` ' +
            'step, or a later step that performs an effect, would be skipped on the ' +
            'streaming path while the JSON path still performed it',
        ),
      );
    }
  }
  return problems;
}

/** Every problem that stops the py-fastapi target, sorted for stable output. */
export function checkPlan(ir: IR): PlanProblem[] {
  const problems = [
    ...checkIrVersion(ir),
    ...checkTarget(ir),
    ...checkCollections(ir),
    ...checkAgents(ir),
    ...checkMemory(ir),
    ...checkGuardrails(ir),
    ...checkDeployments(ir),
    ...checkObservability(ir),
    ...checkTypes(ir),
    ...checkModels(ir),
    ...checkRetrievers(ir),
    ...checkPrompts(ir),
    ...checkTools(ir),
    ...checkPipelines(ir),
    ...checkEvals(ir),
  ];
  return problems.sort(
    (a, b) =>
      compareIds(a.path, b.path) || compareIds(a.code, b.code) || compareIds(a.message, b.message),
  );
}
