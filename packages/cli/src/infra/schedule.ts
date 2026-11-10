/**
 * The AWS spelling of a five-field cron.
 *
 * `retrievers[].refresh.schedule` is one five-field expression read as UTC, and both
 * schedulers this build emits take a cron string, but EventBridge Scheduler's dialect is
 * not the standard one: its `cron(...)` carries a sixth field for the year, its
 * day-of-week runs 1-7 with **1 = Sunday**, and exactly one of the two day fields must be
 * `?` rather than `*`. Handing it the expression unchanged would silently schedule a
 * different day, so the translation happens here -- once, in TypeScript, rather than as
 * string surgery inside a generated module.
 *
 * Cloud Scheduler takes the standard five-field form, so the GCP module passes the
 * expression through untouched and nothing in this file applies to it.
 *
 * The translation covers what the spec validator accepts. A standard five-field cron ORs
 * the two day fields when both are restricted, which EventBridge Scheduler cannot express
 * at all -- it refuses an expression that names both -- so the generated module refuses
 * that shape with a `precondition` instead of collapsing it to one field.
 */

/** Numbers a day-of-week field may carry, canonicalised so `0` and `7` are both Sunday. */
const DAYS_IN_WEEK = 7;

function canonicalDay(value: number): number {
  return value % DAYS_IN_WEEK;
}

/**
 * The days a day-of-week field names, as canonical day numbers (`0` = Sunday).
 *
 * Expanded rather than translated piece by piece because a range may wrap: `5-7` is
 * Friday, Saturday and Sunday, which in the AWS numbering is `1,6-7` and not a range at
 * all. Expanding and re-compressing is total, and it is obviously the same set of days.
 */
function dayOfWeekSet(field: string): number[] {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const slash = part.indexOf('/');
    const base = slash === -1 ? part : part.slice(0, slash);
    const step = slash === -1 ? 1 : Number(part.slice(slash + 1));
    let low: number;
    let high: number;
    if (base === '*') {
      low = 0;
      high = DAYS_IN_WEEK - 1;
    } else if (base.includes('-')) {
      const [from, to] = base.split('-') as [string, string];
      low = Number(from);
      high = Number(to);
    } else {
      low = Number(base);
      // A bare number with a step counts from that number to the end of the field.
      high = slash === -1 ? Number(base) : DAYS_IN_WEEK;
    }
    for (let value = low; value <= high; value += step) days.add(canonicalDay(value));
  }
  return [...days].sort((left, right) => left - right);
}

/**
 * A day-of-week field in the AWS numbering, `1-7` with `1` = Sunday.
 *
 * Runs are re-compressed (`2-6`) so a schedule a person wrote as a range stays a range.
 */
function awsDayOfWeek(field: string): string {
  const days = dayOfWeekSet(field).map((day) => day + 1);
  const pieces: string[] = [];
  let index = 0;
  while (index < days.length) {
    let last = index;
    for (let next = index + 1; next < days.length; next += 1) {
      if ((days[next] as number) !== (days[last] as number) + 1) break;
      last = next;
    }
    pieces.push(index === last ? `${days[index]}` : `${days[index]}-${days[last]}`);
    index = last + 1;
  }
  return pieces.join(',');
}

/**
 * `expression` as an EventBridge Scheduler `cron(...)` string.
 *
 * The two day rules are the whole shape of it: whichever day field the expression leaves
 * as `*` becomes `?`, and a day-of-week field that is not `*` is renumbered.
 */
export function awsSchedulerCronExpression(expression: string): string {
  const fields = expression.trim().split(/\s+/);

  // Anything that is not the five fields the spec validator accepts has no faithful
  // translation. It is left as written so the provider rejects it, rather than this
  // emitting a schedule whose fields mean something else.
  if (fields.length !== 5) return expression;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const byWeekday = dayOfWeek !== '*';
  const awsDayOfMonth = byWeekday && dayOfMonth === '*' ? '?' : dayOfMonth;
  const awsWeekday = byWeekday ? awsDayOfWeek(dayOfWeek) : '?';
  return `cron(${minute} ${hour} ${awsDayOfMonth} ${month} ${awsWeekday} *)`;
}
