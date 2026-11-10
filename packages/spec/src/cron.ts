/**
 * Strict five-field cron, checked in-house.
 *
 * The compiler emits real scheduler resources for `retrievers[].refresh.schedule`
 * (`aws_scheduler_schedule`, `google_cloud_scheduler_job`) and both take a cron string,
 * so the expression has to be known good before it reaches infrastructure: a value the
 * provider rejects fails the Terraform apply, not the spec check. A cron parser is not a
 * dependency of this build and adding one would mean a new runtime dependency for one
 * field, so the accepted grammar is spelled out here instead, and it is deliberately a
 * subset of the provider grammars it feeds: `*`, a star with a step, `a`, `a-b`, a range
 * with a step, and comma lists of those. Six-field expressions, `@daily`-style macros and
 * the Quartz extensions `?`, `L`, `W` and `#` are refused rather than passed through on
 * the assumption that the provider would interpret them the same way.
 *
 * Both emitted schedulers read the expression as UTC, which is what the docs say and
 * what this validator assumes; the expression carries no zone of its own.
 */

interface CronField {
  /** How the diagnostic names the field, e.g. `minute`. */
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const CRON_FIELDS: readonly CronField[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  // 0 and 7 both name Sunday, the way every five-field implementation reads it.
  { name: 'day-of-week', min: 0, max: 7 },
];

/** The field order, for the diagnostics and the docs that describe the grammar. */
export const CRON_FIELD_LIST = 'minute hour day-of-month month day-of-week';

/** The accepted grammar, in one phrase. Reused by the diagnostics that point at it. */
export const CRON_SYNTAX =
  'each field is `*`, `*/n`, a number, `a-b`, `a-b/n`, or a comma list of those';

const NUMBER = /^\d+$/;
const RANGE = /^(\d+)-(\d+)$/;
const STEPPED = /^(?:\*|\d+|(?:\d+-\d+))\/(\d+)$/;

function outOfRange(field: CronField, part: string, value: number): string {
  return `the ${field.name} field ${JSON.stringify(part)} is ${value}, and ${field.name} runs ${field.min}-${field.max}`;
}

/**
 * Checks one comma-separated component of one field. `undefined` means it parses.
 *
 * The order matters for the diagnostics: a value that is out of range is named as such
 * rather than as unparseable, because "the hour field is 24, and hour runs 0-23" tells
 * the reader what to write and "not a valid hour field" does not.
 */
function componentProblem(field: CronField, part: string): string | undefined {
  const stepped = STEPPED.exec(part);
  if (stepped !== null) {
    const step = Number(stepped[1]);
    if (step < 1) {
      return `the ${field.name} field ${JSON.stringify(part)} steps by 0, and a step is at least 1`;
    }
    return componentProblem(field, part.slice(0, part.lastIndexOf('/')));
  }
  if (part === '*') return undefined;

  const range = RANGE.exec(part);
  if (range !== null) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (low < field.min || low > field.max) return outOfRange(field, part, low);
    if (high < field.min || high > field.max) return outOfRange(field, part, high);
    if (low > high) {
      return `the ${field.name} field ${JSON.stringify(part)} counts backwards from ${low} to ${high}`;
    }
    return undefined;
  }

  if (NUMBER.test(part)) {
    const value = Number(part);
    if (value < field.min || value > field.max) return outOfRange(field, part, value);
    return undefined;
  }

  return `the ${field.name} field ${JSON.stringify(part)} is not one of \`*\`, \`*/n\`, a number, \`a-b\` or \`a-b/n\``;
}

/**
 * Validates `expression` as a five-field cron in UTC.
 *
 * Returns `undefined` when the expression is well formed, or one sentence naming the
 * offending field when it is not. The sentence is written to be dropped straight into a
 * diagnostic after a colon.
 */
export function cronScheduleProblem(expression: string): string | undefined {
  const trimmed = expression.trim();
  if (trimmed === '') {
    return `it is empty, and a schedule is the five fields ${CRON_FIELD_LIST}`;
  }
  if (trimmed.startsWith('@')) {
    return `${JSON.stringify(trimmed)} is an @-macro, and this compiler takes the five fields ${CRON_FIELD_LIST}`;
  }

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    const unit = fields.length === 1 ? 'field' : 'fields';
    return `it has ${fields.length} ${unit}, and a schedule is exactly the five fields ${CRON_FIELD_LIST}`;
  }

  for (let index = 0; index < CRON_FIELDS.length; index += 1) {
    const field = CRON_FIELDS[index] as CronField;
    for (const part of (fields[index] as string).split(',')) {
      const problem = componentProblem(field, part);
      if (problem !== undefined) return problem;
    }
  }

  return undefined;
}

/** True when `expression` is a five-field cron this build emits unchanged. */
export function isCronSchedule(expression: string): boolean {
  return cronScheduleProblem(expression) === undefined;
}
