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
  type EvalShape,
  type IR,
  type ModelParams,
  PHASE_0_PROVIDERS,
  type PipelineShape,
  type PromptShape,
  type StepInput,
  type StepShape,
  type TypeRef,
  type TypeShape,
} from '@aid/ir';

import { PY_FASTAPI_MANIFEST, supportsIrVersion } from './manifest.js';
import { judgeAlias, mapMetric } from './metrics.js';
import { isUsableIdentifier, moduleName, providerAdapter } from './names.js';
import { templatePlaceholders } from './placeholders.js';

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
  | 'unsupported-capability'
  | 'unsupported-collection'
  | 'unsupported-eval-input'
  | 'unsupported-eval-target'
  | 'unsupported-examples'
  | 'unsupported-handler'
  | 'unsupported-ir-version'
  | 'unsupported-metric'
  | 'unsupported-output'
  | 'unsupported-param'
  | 'unsupported-placeholder'
  | 'unsupported-provider'
  | 'unsupported-redact'
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

/** IR collections this target has no runtime counterpart for in Phase 0. */
export const UNSUPPORTED_COLLECTIONS = [
  'agents',
  'deployments',
  'embeddings',
  'guardrails',
  'memory',
  'retrievers',
  'stores',
] as const;

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

export function checkCollections(ir: IR): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const name of UNSUPPORTED_COLLECTIONS) {
    const entries = ir[name] as readonly { readonly id: string }[] | undefined;
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const ids = [...entries.map((entry) => entry.id)].sort(compareIds).join(', ');
    problems.push(
      problem(
        'unsupported-collection',
        name,
        `Phase 0 emits no wiring for '${name}'; remove it or use another target (declared: ${ids})`,
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
          `no runtime adapter for provider '${model.provider}'; Phase 0 wires ` +
            `${PHASE_0_PROVIDERS.join(', ')}`,
        ),
      );
    }
    // A declared model capability the runtime cannot name (`vision`, `audio`, ...) is
    // not an error: the runtime's `Capability` enum is a smaller vocabulary than the
    // IR's, and the emitted pinned spec advertises the intersection of the two. What
    // the intersection dropped is recorded in the generated capability report, so a
    // narrower vocabulary never quietly rewrites what the spec declared.
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
    if ((prompt.guardrails ?? []).length > 0) {
      problems.push(
        problem(
          'unsupported-collection',
          `${path}.guardrails`,
          'Phase 0 emits no guardrail middleware',
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

export function checkTools(ir: IR): PlanProblem[] {
  const types = sortedTypes(ir);
  const problems: PlanProblem[] = [];
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
    if (tool.auth !== undefined) {
      problems.push(
        problem(
          'unsupported-tool-auth',
          `${path}.auth`,
          'the runtime has no authorization hook, so this predicate would not be enforced; ' +
            'enforce it in the business handler until the runtime grows one',
        ),
      );
    }
    if (tool.requiresConfirmation === true) {
      problems.push(
        problem(
          'unsupported-tool-confirmation',
          `${path}.requiresConfirmation`,
          'the runtime has no confirmation flow, so this guard would not be enforced',
        ),
      );
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
  if (step.kind === 'emit') return;
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
  steps.forEach((step, index) => {
    const path = `${base}.steps[${index}]`;
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

    const wanted = new Map<string, TypeRef>();
    if (step.kind === 'generate') {
      const prompt = prompts.get(step.prompt);
      for (const variable of prompt?.variables ?? []) wanted.set(variable.name, variable.type);
    } else {
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

  return {
    fields: [...fields.entries()]
      .map(([name, type]) => ({ name, type }))
      .sort((left, right) => compareIds(left.name, right.name)),
    problems,
  };
}

/** The binding name a step introduces, or `undefined` for the terminal emit. */
export function bindingOf(step: StepShape): string | undefined {
  return step.kind === 'emit' ? undefined : step.as;
}

export function checkPipelines(ir: IR): PlanProblem[] {
  const types = sortedTypes(ir);
  const prompts = new Map(ir.prompts.map((prompt) => [prompt.id, prompt]));
  const tools = new Map(ir.tools.map((tool) => [tool.id, tool]));
  const models = new Set(ir.models.map((model) => model.id));
  const problems: PlanProblem[] = [];

  for (const pipeline of ir.pipelines) {
    const base = `pipelines.${pipeline.id}`;
    if (pipeline.trigger?.kind !== 'http') {
      problems.push(
        problem(
          'unsupported-trigger',
          `${base}.trigger`,
          `Phase 0 wires only an 'http' trigger to a FastAPI route; got ` +
            `'${pipeline.trigger?.kind ?? '<none>'}'`,
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
    steps.forEach((step, index) => {
      const path = `${base}.steps[${index}]`;
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
      if (step.kind === 'emit') {
        if (index !== steps.length - 1) {
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
            problem('unresolved-reference', `${path}.tool`, `tool '${step.tool}' is not declared`),
          );
          return;
        }
        const keys = checkStepInput(step.input, path, bindings, types, problems);
        const fields = structFields(tool.input, types);
        const required = fields?.fields.filter((field) => field.required).map((f) => f.name) ?? [];
        checkArgumentKeys(keys, fields, required, `${path}.input`, problems, `tool '${tool.id}'`);
        bindings.push({ name: step.as, type: tool.output });
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
      for (const name of wanted) {
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
  }
  return problems;
}

/**
 * The model aliases a prompt is rendered against, sorted.
 *
 * Neither the IR's `EvalShape` nor its `PromptShape` carries a model, so the model
 * under test is read from the steps that call the prompt. That is also the honest
 * measurement: the eval exercises the prompt where the app actually renders it, against
 * the model the app actually pins.
 */
export function modelsUnderTest(ir: IR, promptId: string): string[] {
  const aliases = new Set<string>();
  for (const pipeline of ir.pipelines) {
    for (const step of pipeline.steps) {
      if (step.kind === 'generate' && step.prompt === promptId) aliases.add(step.model);
    }
  }
  return [...aliases].sort(compareIds);
}

/** The prompt an eval measures, and the one model it is measured against. */
export interface EvalSubject {
  /** The prompt the eval renders, and whose single variable a dataset row fills. */
  readonly prompt: PromptShape;
  /** The model alias the app pins for that prompt, which is what the eval samples. */
  readonly model: string;
}

/** Either the subject of an eval, or the single reason it has none. */
export type EvalSubjectResult =
  | { readonly ok: true; readonly subject: EvalSubject }
  | { readonly ok: false; readonly code: PlanProblemCode; readonly message: string };

/** `prompt@model`, deduplicated and sorted, so a repeated step is one subject. */
function distinctSubjects(
  ir: IR,
  target: EvalShape['target'],
): { prompt: string; model: string }[] {
  const pairs: { prompt: string; model: string }[] = [];
  if (target.kind === 'prompt') {
    for (const model of modelsUnderTest(ir, target.id)) pairs.push({ prompt: target.id, model });
  } else {
    const pipeline = ir.pipelines.find((item) => item.id === target.id);
    for (const step of pipeline?.steps ?? []) {
      if (step.kind === 'generate') pairs.push({ prompt: step.prompt, model: step.model });
    }
  }
  const seen = new Set<string>();
  const distinct: { prompt: string; model: string }[] = [];
  for (const pair of pairs) {
    const key = `${pair.prompt}\u0000${pair.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(pair);
  }
  return distinct.sort(
    (left, right) => compareIds(left.prompt, right.prompt) || compareIds(left.model, right.model),
  );
}

/**
 * The prompt and model an eval measures, or why it measures none.
 *
 * The spec language can only name a pipeline (`evals.<id>.target` is validated against
 * `pipeline:<id>` by `@aid/spec`), while the IR can also name a prompt directly, so both
 * forms have to resolve here -- and both resolve to the same thing, because an eval
 * measures a prompt through the step that renders it.
 *
 * `Phase 0` gates one prompt against one model per eval. A pipeline that renders two
 * prompts, or one prompt against two models, is a pipeline whose score is a blend of two
 * measurements: the failures of either half would be reported against the other's id, so
 * the target is refused rather than averaged.
 *
 * A pure function of the IR on purpose: every rejection below is a branch a unit test can
 * reach without a spec file, a model or a filesystem.
 */
export function evalSubject(ir: IR, evaluation: EvalShape): EvalSubjectResult {
  const target = evaluation.target;
  if (target === undefined || !target.valid) {
    return {
      ok: false,
      code: 'unsupported-eval-target',
      message:
        `Phase 0 evaluates a 'pipeline:' or 'prompt:' target, and ` +
        `'${target?.qualified ?? '<none>'}' is neither`,
    };
  }
  const declared =
    target.kind === 'prompt'
      ? ir.prompts.some((prompt) => prompt.id === target.id)
      : ir.pipelines.some((pipeline) => pipeline.id === target.id);
  if (!declared) {
    return {
      ok: false,
      code: 'unresolved-reference',
      message: `${target.kind} '${target.id}' is not declared`,
    };
  }
  const subjects = distinctSubjects(ir, target);
  if (subjects.length > 1) {
    const rendered = subjects.map((pair) => `${pair.prompt} on ${pair.model}`).join(', ');
    return {
      ok: false,
      code: 'unsupported-eval-target',
      message:
        `'${target.qualified}' renders ${subjects.length} prompts (${rendered}), and Phase 0 gates ` +
        'one prompt on one model per eval; declare a separate eval per prompt',
    };
  }
  const only = subjects[0];
  if (only === undefined) {
    return {
      ok: false,
      code: 'unresolved-reference',
      message:
        `'${target.qualified}' renders no prompt, so there is nothing to measure: an eval reads ` +
        "the dataset's input as the one variable the prompt renders",
    };
  }
  const prompt = ir.prompts.find((item) => item.id === only.prompt);
  if (prompt === undefined) {
    return {
      ok: false,
      code: 'unresolved-reference',
      message: `prompt '${only.prompt}' is not declared`,
    };
  }
  return { ok: true, subject: { prompt, model: only.model } };
}

/**
 * Whether a dataset URI is a safe path under `app/evals/`.
 *
 * The generated loader resolves the URI against the app directory, so a traversal or an
 * absolute path would let the spec read a file the app does not own, and a URI outside
 * `evals/` would put a dataset somewhere the design says the developer owns nothing.
 * Checked by scanning rather than by an anchored regex: `docs/design.md` §12 and layer
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
      const names = renderNames(prompt);
      if (names.length !== 1) {
        problems.push(
          problem(
            'unsupported-eval-input',
            `${base}.target`,
            `prompt '${prompt.id}' renders ${names.length} values ` +
              `(${names.join(', ') || '<none>'}), and Phase 0 maps a dataset row to exactly one ` +
              'prompt variable',
          ),
        );
      }
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
    ...checkObservability(ir),
    ...checkTypes(ir),
    ...checkModels(ir),
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
