/**
 * Leaf pipeline steps: `generate`, `retrieve`, `tool` and `emit`.
 *
 * `pipeline.ts` runs steps and `control.ts` composes them; this module is the third
 * part of the family and builds the leaves a pipeline actually reaches the outside
 * world with. Each factory returns an ordinary {@link CompositeStep}, so a leaf
 * composes with a composite by the same rule.
 *
 * Why these exist at all: a generated application inlines its steps as hand-written
 * async functions, which leaves a caller who is *not* the generator -- a test, a
 * conformance runner, a hand-built pipeline -- with no way to drive one step kind
 * without re-writing the primitive's call and its binding rule. That duplication is
 * where the two disagree. A step here is the same primitive the generator calls:
 *
 * - `retrieve` calls {@link RetrieverSeam.retrieve} and binds the `RetrievalResult`.
 * - `tool` calls {@link ToolExecutor.execute} and binds what the tool returned,
 *   refusing an error outcome and parsing the content.
 * - `generate` renders a prompt, calls {@link ModelGateway.generate}, and runs the
 *   structured path when the caller names an output type.
 * - `emit` projects the context into the event fields a caller names.
 *
 * Every factory takes its inputs **already resolved**: the query string, the argument
 * mapping, the prompt values. Interpolating a spec template against the context is the
 * *emitted step body's* job, and a second implementation of it here would be a second
 * thing to keep in step with the generator's. What is not duplicated is the part that
 * is the same for every caller: the primitive call, the error contract, the parse, and
 * the name the result is bound under.
 *
 * `emit` is the one leaf whose whole behaviour is reading the context, so
 * {@link resolveSource} lives here rather than in a caller: a field's source is a
 * binding name, optionally followed by one attribute, which is exactly the reference
 * path the generator derives for the same field.
 */

import type { CompositeStep } from './control.js';
import { PipelineError } from './errors.js';
import type { ModelGateway } from './gateway.js';
import { repr } from './internal/json.js';
import type { PipelineContext } from './pipeline.js';
import type { PromptRegistry } from './prompts.js';
import type { RetrievalResult } from './retrieval/citations.js';
import type { StructuredOutput } from './structured.js';
import { parseStructured, runStructured } from './structured.js';
import type { ToolExecutor } from './tools.js';
import { CompletionRequest, Message, ToolCall } from './types.js';

/**
 * The context key an `emit` step binds its projected payload under.
 *
 * Deliberately *not* in `RESERVED_KEYS`. That set is mirrored in the generator and
 * pinned against the runtime by a generator test, so a seventh entry would have to be
 * emitted as well -- and the generated applications do not compose their response
 * through this step yet. A generated route keeps building its event object itself;
 * adding the key here would reserve a spec name for a step the emitted apps never
 * call. {@link emitStep} takes the key as an option so the generator can adopt it
 * under its own name when it does.
 */
export const EMITTED_KEY = 'emitted';

/**
 * Name a step's callable, so a trace and {@link Pipeline.of} identify it.
 *
 * `Pipeline.of` reads `step.name`, so this is the same mechanism as Python assigning
 * `__name__` -- the two runtimes name a leaf identically rather than one of them
 * requiring an explicit name at construction.
 */
function named(step: CompositeStep, name: string | undefined): CompositeStep {
  if (name !== undefined) {
    Object.defineProperty(step, 'name', { value: name, configurable: true });
  }
  return step;
}

/**
 * One `emit` field's value: a binding, then at most one attribute below it.
 *
 * The one-segment form is the request event's or a scalar binding's whole value; the
 * two-segment form is a struct's field. Deeper paths are not accepted, because the
 * spec layer's reference paths stop at one field and this resolver exists to read
 * exactly what the generator reads.
 *
 * A missing binding is a {@link PipelineError} naming the key -- the same refusal
 * {@link PipelineContext.require} makes -- and a missing attribute is one naming both
 * the source and the field, because "the field is not there" and "the binding is not
 * there" are different mistakes and both mean the response would be wrong.
 */
export function resolveSource(context: PipelineContext, source: string): unknown {
  const dot = source.indexOf('.');
  const root = dot === -1 ? source : source.slice(0, dot);
  const attribute = dot === -1 ? '' : source.slice(dot + 1);
  const value = context.require(root);
  if (attribute === '') return value;
  if (attribute.includes('.')) {
    throw new PipelineError(
      `emit source ${repr(source)} names more than one attribute below ${repr(root)}; ` +
        'a field is read from a binding or one struct below it',
    );
  }
  // An *own* property: that is where a declared field lands both in an object parsed
  // from JSON and in a class that assigns its fields, and it keeps `toString` and
  // `constructor` from reading as fields of every struct.
  const fields = value as Record<string, unknown> | null;
  if (typeof value !== 'object' || fields === null || !Object.hasOwn(fields, attribute)) {
    throw new PipelineError(
      `emit source ${repr(source)} names the field ${repr(attribute)}, which the ` +
        `${repr(root)} binding does not carry`,
    );
  }
  return fields[attribute];
}

/**
 * Build the event payload from the context, field by field.
 *
 * `fields` maps each event field to its source, in the order the caller declared
 * them: an insertion-ordered mapping keeps the payload's own order stable, so a
 * projection that reorders its fields is observable rather than invisible. Each source
 * is a binding name or a `binding.attribute` path, which is the shape the generator
 * derives for the same field via `responsePlan`.
 *
 * The step **binds** its payload and does not stop the pipeline. Stopping would lose
 * it: both runtimes carry the *pre-step* context out of a stop, so a stopping step
 * cannot bind anything. A generated route does not stop at its emit either -- it runs
 * every step and only then builds the response object -- so a later step still runs
 * after this one, which is the behaviour a pipeline that composed it would see.
 */
export function emitStep(
  fields: Readonly<Record<string, string>>,
  options: { readonly key?: string; readonly name?: string } = {},
): CompositeStep {
  const key = options.key ?? EMITTED_KEY;
  const ordered = Object.entries(fields);
  return named(async (context: PipelineContext): Promise<PipelineContext> => {
    const payload: Record<string, unknown> = {};
    for (const [field, source] of ordered) payload[field] = resolveSource(context, source);
    return context.withValues({ [key]: payload });
  }, options.name);
}

/**
 * The one method a `retrieve` step needs.
 *
 * `Retriever` satisfies it, which is what a generated application passes. Stated as a
 * seam rather than as the concrete class so a caller that does not own a retriever -- a
 * test, a conformance runner -- can drive the step without building an embedding model
 * and a vector store it will never search. The step duplicates no part of the search:
 * it decides the query, the ceiling and the name, and binding the result is all it adds.
 */
export interface RetrieverSeam {
  retrieve(query: string, options?: { readonly topK?: number | null }): Promise<RetrievalResult>;
}

/**
 * Search `retriever` and bind the cited passages under `binding`.
 *
 * `topK` is passed through rather than resolved here, so `undefined` keeps meaning
 * "the binding's own ceiling" exactly as `Retriever.retrieve` defines it.
 */
export function retrieveStep(
  retriever: RetrieverSeam,
  options: {
    readonly binding: string;
    readonly query: string;
    readonly topK?: number;
    readonly name?: string;
  },
): CompositeStep {
  return named(async (context: PipelineContext): Promise<PipelineContext> => {
    const found: RetrievalResult = await retriever.retrieve(options.query, {
      topK: options.topK,
    });
    return context.withValues({ [options.binding]: found });
  }, options.name);
}

/**
 * Call `tool` and bind what it returned, refusing an error outcome.
 *
 * The call id is the binding name, which makes a trace of a tool step name the value
 * it produced. An error outcome throws rather than binding a message: a tool the model
 * called and that failed is not a value the next step can meaningfully read, and the
 * generator's own step throws for the same reason.
 *
 * `output` is the struct to parse the content into when the spec declared a named
 * output; without one the content is bound as parsed JSON, so a tool declaring
 * `string` binds the string it returned rather than a re-encoded copy.
 */
export function toolStep(
  tools: ToolExecutor,
  options: {
    readonly binding: string;
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly output?: StructuredOutput<unknown>;
    readonly name?: string;
  },
): CompositeStep {
  return named(async (context: PipelineContext): Promise<PipelineContext> => {
    const outcome = await tools.execute(
      new ToolCall({
        id: options.binding,
        name: options.tool,
        arguments: { ...options.arguments },
      }),
    );
    if (outcome.isError) {
      throw new PipelineError(`tool ${options.tool} failed: ${outcome.content}`);
    }
    const value =
      options.output === undefined
        ? JSON.parse(outcome.content)
        : parseStructured(outcome.content, options.output);
    return context.withValues({ [options.binding]: value });
  }, options.name);
}

/**
 * Render `prompt`, ask `model` for one completion, and bind the answer.
 *
 * The call is built once and handed to the structured path as its `call`, so a repair
 * round re-sends an already-rendered prompt instead of rendering again -- the same
 * closure the generated step emits, and the reason a retry cannot silently re-read a
 * binding that changed underneath it.
 *
 * `values` are the prompt's own values and are passed to the registry unrendered:
 * {@link PromptRegistry.render} is the one place a template becomes text. With
 * `structured` the answer is parsed into that type, and a parse failure throws after
 * the repair rounds rather than binding a half-valid object.
 */
export function generateStep(
  gateway: ModelGateway,
  prompts: PromptRegistry,
  options: {
    readonly binding: string;
    readonly prompt: string;
    readonly model: string;
    readonly values?: Readonly<Record<string, unknown>>;
    readonly version?: string;
    readonly structured?: StructuredOutput<unknown>;
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
    readonly fallbacks?: readonly string[];
    readonly name?: string;
  },
): CompositeStep {
  return named(async (context: PipelineContext): Promise<PipelineContext> => {
    const rendered = prompts.render(options.prompt, options.values ?? {}, options.version);

    const call = async (text: string): Promise<string> => {
      const request =
        options.temperature === undefined && options.maxOutputTokens === undefined
          ? CompletionRequest.prompt(text)
          : new CompletionRequest({
              messages: [Message.user(text)],
              temperature: options.temperature,
              maxOutputTokens: options.maxOutputTokens,
            });
      const response = await gateway.generate(options.model, request, {
        fallbacks: options.fallbacks ?? [],
      });
      return response.text;
    };

    const value =
      options.structured === undefined
        ? await call(rendered.text)
        : await runStructured(call, options.structured, rendered.text);
    return context.withValues({ [options.binding]: value });
  }, options.name);
}
