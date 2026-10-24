/**
 * Structured-output enforcement with a parse-repair loop.
 *
 * This is the only place zod is used, and it is used for what it is good at: getting
 * a typed object out of an untrusted model response. Pipeline control flow is plain
 * async; zod is a validation dependency here, not an orchestration one.
 *
 * Two entry points:
 *
 * - {@link parseStructured} coerces already-received text into a typed value.
 * - {@link runStructured} drives a call-repair-retry loop, feeding the validation
 *   failure back to the model. This is the difference between "the model must be
 *   right the first time" and "the model must eventually be right", and only the
 *   second is an achievable contract.
 */

import { z } from 'zod';
import { StructuredOutputError } from './errors.js';

/** The correction turn appended after a failed parse. */
export const REPAIR_INSTRUCTION =
  'Your previous response could not be parsed. Reply with corrected JSON only, ' +
  'matching the required schema exactly. Errors: {problems}';

/**
 * A named output schema.
 *
 * The name exists because Python's reference implementation reads
 * `output_type.__name__` and every diagnostic it produces names the type. A zod
 * schema has no runtime name, so the name is carried alongside it rather than
 * inferred.
 */
export interface StructuredOutput<T> {
  readonly name: string;
  readonly schema: z.ZodType<T>;
}

/** Name a schema so diagnostics can say which type failed. */
export function structuredOutput<T>(name: string, schema: z.ZodType<T>): StructuredOutput<T> {
  if (name.length === 0) throw new RangeError('a structured output type needs a name');
  return { name, schema };
}

/** The members of a zod issue this module reads. */
interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Flatten validation issues into `location: message` strings. */
export function formatProblems(issues: readonly Issue[]): string[] {
  return issues.map((issue) => {
    const location = issue.path.map((part) => String(part)).join('.') || '<root>';
    return `${location}: ${issue.message}`;
  });
}

/**
 * Remove a ```json fence if the model wrapped its answer in one.
 *
 * Models do this constantly when asked for JSON. Treating a valid payload as invalid
 * because of presentation is a self-inflicted repair loop.
 */
function stripCodeFence(text: string): string {
  const stripped = text.trim();
  if (!stripped.startsWith('```')) return stripped;
  const lines = stripped.split('\n');
  if (lines.length < 2) return stripped;
  const body = lines.slice(1);
  const last = body.at(-1);
  if (last?.trim().startsWith('```')) body.pop();
  return body.join('\n');
}

function invalidJson(outputType: StructuredOutput<unknown>): StructuredOutputError {
  return new StructuredOutputError(`output did not validate as ${outputType.name}`, {
    attempts: 1,
    problems: ['<root>: invalid JSON'],
  });
}

/**
 * Validate `text` as `outputType`.
 *
 * Every problem is reported, not just the first: feeding one error back at a time
 * turns a two-round repair into a five-round one.
 */
export function parseStructured<T>(text: string, outputType: StructuredOutput<T>): T {
  const stripped = stripCodeFence(text).trim();
  if (stripped.length === 0) {
    throw new StructuredOutputError(`model returned empty output for ${outputType.name}`, {
      attempts: 1,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw invalidJson(outputType);
  }
  const result = outputType.schema.safeParse(parsed);
  if (!result.success) {
    throw new StructuredOutputError(`output did not validate as ${outputType.name}`, {
      attempts: 1,
      problems: formatProblems(result.error.issues),
    });
  }
  return result.data;
}

/**
 * Call, parse, and on failure ask again with the validation errors attached.
 *
 * `retries` counts *repair* attempts beyond the first call, so `retries: 2` means at
 * most three calls. Throwing after the final attempt is correct: an endpoint that
 * returns a half-valid object is worse than one that fails loudly.
 */
export async function runStructured<T>(
  call: (prompt: string) => Promise<string>,
  outputType: StructuredOutput<T>,
  prompt: string,
  options: { readonly retries?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  if (retries < 0) throw new RangeError('retries must not be negative');

  let current = prompt;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const text = await call(current);
    try {
      return parseStructured(text, outputType);
    } catch (error) {
      if (!(error instanceof StructuredOutputError)) throw error;
      problems = [...error.problems];
      if (attempt <= retries) {
        current = `${prompt}\n\n${repairPrompt(error)}`;
      }
    }
  }

  throw new StructuredOutputError(
    `${outputType.name} not produced from ${retries + 1} attempt(s)`,
    { attempts: retries + 1, problems },
  );
}

/** The corrective turn for a failed parse. */
export function repairPrompt(error: StructuredOutputError): string {
  const problems = error.problems.length > 0 ? error.problems.join('; ') : error.message;
  return REPAIR_INSTRUCTION.replace('{problems}', () => problems);
}

/** The seam a `buildAgent` caller supplies: one prompt in, one model answer out. */
export interface AgentModel {
  complete(prompt: string): Promise<string>;
}

/** A typed agent: `run` drives the repair loop and returns the parsed value. */
export class StructuredAgent<T> {
  private readonly _model: AgentModel;
  private readonly _outputType: StructuredOutput<T>;
  private readonly _systemPrompt: string | undefined;
  private readonly _retries: number;

  constructor(
    model: AgentModel,
    outputType: StructuredOutput<T>,
    options: { readonly systemPrompt?: string; readonly retries?: number } = {},
  ) {
    this._model = model;
    this._outputType = outputType;
    this._systemPrompt = options.systemPrompt;
    this._retries = options.retries ?? 2;
  }

  /** Run one prompt through the model, repairing until the schema validates. */
  async run(prompt: string): Promise<T> {
    const composed =
      this._systemPrompt === undefined ? prompt : `${this._systemPrompt}\n\n${prompt}`;
    return runStructured((current) => this._model.complete(current), this._outputType, composed, {
      retries: this._retries,
    });
  }
}

/**
 * Build a typed agent over `outputType`.
 *
 * The reference runtime delegates this to Pydantic AI's `Agent`. The TypeScript
 * runtime has no equivalent, so this is the same contract implemented against the
 * repair loop above -- typed output with retries -- rather than a new orchestration
 * layer.
 */
export function buildAgent<T>(
  model: AgentModel,
  outputType: StructuredOutput<T>,
  options: { readonly systemPrompt?: string; readonly retries?: number } = {},
): StructuredAgent<T> {
  return new StructuredAgent(model, outputType, options);
}

/** Re-export zod so generated code can declare schemas without a second dependency. */
export { z };
