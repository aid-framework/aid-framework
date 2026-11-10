import { describe, expect, it } from 'vitest';
import { CRON_FIELD_LIST, cronScheduleProblem, isCronSchedule } from '../src/cron.js';

/**
 * The accepted grammar is a subset of both provider dialects (`aws_scheduler_schedule`
 * and `google_cloud_scheduler_job`), and the rejection table is the contract: a value
 * this build passes through is one the apply has to accept, so anything ambiguous is
 * refused here rather than discovered by the provider.
 */
describe('the five-field cron grammar', () => {
  const accepted = [
    '* * * * *',
    '0 3 * * *',
    '*/5 * * * *',
    '30 9 * * 1-5',
    '0 0 1,15 * *',
    '0 0 1-15/2 * *',
    '59 23 31 12 7',
    '0 0 * * 0',
    '15,45 */6 * * *',
  ];

  for (const expression of accepted) {
    it(`accepts ${JSON.stringify(expression)}`, () => {
      expect(cronScheduleProblem(expression)).toBeUndefined();
      expect(isCronSchedule(expression)).toBe(true);
    });
  }

  it('accepts 7 as Sunday, the way a five-field expression reads it', () => {
    expect(isCronSchedule('0 0 * * 7')).toBe(true);
    expect(isCronSchedule('0 0 * * 0')).toBe(true);
  });

  it('trims surrounding whitespace instead of refusing it', () => {
    expect(cronScheduleProblem('  0 3 * * *  ')).toBeUndefined();
  });
});

describe('refusing what the providers would interpret differently', () => {
  it('names the field that is out of range', () => {
    expect(cronScheduleProblem('60 * * * *')).toContain('minute');
    expect(cronScheduleProblem('0 24 * * *')).toContain('hour');
    expect(cronScheduleProblem('0 0 32 * *')).toContain('day-of-month');
    expect(cronScheduleProblem('0 0 * 13 *')).toContain('month');
    expect(cronScheduleProblem('0 0 * * 8')).toContain('day-of-week');
  });

  it('reports the range a field runs over', () => {
    expect(cronScheduleProblem('0 24 * * *')).toContain('hour runs 0-23');
  });

  it('refuses a six-field expression, whose sixth field it would otherwise drop', () => {
    const problem = cronScheduleProblem('0 0 3 * * 2027');

    expect(problem).toContain('6 fields');
    expect(problem).toContain(CRON_FIELD_LIST);
  });

  it('refuses an @-macro', () => {
    expect(cronScheduleProblem('@daily')).toContain('@-macro');
    expect(cronScheduleProblem(' @hourly')).toContain('@-macro');
  });

  it('refuses the Quartz extensions the providers do not share', () => {
    for (const expression of ['0 0 ? * *', '0 0 L * *', '0 0 15W * *', '0 0 * * 5#2']) {
      expect(cronScheduleProblem(expression), expression).toContain(
        'is not one of `*`, `*/n`, a number, `a-b` or `a-b/n`',
      );
    }
  });

  it('refuses a step of zero and a backwards range', () => {
    expect(cronScheduleProblem('*/0 * * * *')).toContain('steps by 0');
    expect(cronScheduleProblem('0 0 * * 5-1')).toContain('counts backwards');
  });

  it('refuses a fractional or signed field', () => {
    expect(cronScheduleProblem('1.5 * * * *')).toContain('minute');
    expect(cronScheduleProblem('-1 * * * *')).toContain('minute');
  });

  it('refuses an empty expression and one with too few fields', () => {
    expect(cronScheduleProblem('')).toContain('empty');
    expect(cronScheduleProblem('* * * *')).toContain('4 fields');
  });
});
