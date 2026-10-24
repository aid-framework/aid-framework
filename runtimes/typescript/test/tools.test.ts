/**
 * Tool dispatch and argument validation.
 *
 * The validator enforces a deliberate JSON-Schema subset (`type`, `required`,
 * `additionalProperties: false`) and returns *every* problem at once, so a model can
 * repair an invocation in one turn instead of one field per turn. An unknown `type`
 * keyword is treated as unconstrained rather than as a failure, because a schema written
 * for a newer draft must not reject every call.
 */

import { describe, expect, it } from 'vitest';
import type { ToolParameters } from '../src/index.js';
import {
  ConfigurationError,
  Tool,
  ToolCall,
  ToolExecutionError,
  ToolExecutor,
  ToolNotFoundError,
  validateArguments,
} from '../src/index.js';
import { at } from './support.js';

const SCHEMA: ToolParameters = {
  type: 'object',
  properties: { city: { type: 'string' }, days: { type: 'integer' } },
  required: ['city'],
  additionalProperties: false,
};

function lookup(): Tool {
  return new Tool({
    name: 'lookup',
    description: 'Look up the weather',
    parameters: SCHEMA,
    handler: (args) => ({ city: args.city, days: args.days ?? 1 }),
  });
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return new ToolCall({ id: `call-${name}`, name, arguments: args });
}

describe('validateArguments', () => {
  it('accepts a well-formed call', () => {
    expect(validateArguments(SCHEMA, { city: 'Paris' })).toEqual([]);
  });

  it('reports every problem, not just the first', () => {
    expect(validateArguments(SCHEMA, { days: 'two', extra: 1 })).toEqual([
      "missing required property 'city'",
      "unexpected property 'extra'",
      "property 'days' must be of type integer",
    ]);
  });

  it('refuses arguments that are not an object at all', () => {
    expect(validateArguments(SCHEMA, 'nope')).toEqual(['arguments must be an object']);
    expect(validateArguments(SCHEMA, null)).toEqual(['arguments must be an object']);
    expect(validateArguments(SCHEMA, ['a'])).toEqual(['arguments must be an object']);
  });

  it('distinguishes integers from numbers', () => {
    const schema: ToolParameters = {
      type: 'object',
      properties: { n: { type: 'integer' } },
    };
    expect(validateArguments(schema, { n: 2 })).toEqual([]);
    expect(validateArguments(schema, { n: 2.5 })).toEqual(["property 'n' must be of type integer"]);
  });

  it('does not accept a boolean as a number', () => {
    const schema: ToolParameters = {
      type: 'object',
      properties: { n: { type: 'number' } },
    };
    expect(validateArguments(schema, { n: true })).toEqual(["property 'n' must be of type number"]);
  });

  it('checks arrays, objects, booleans and null', () => {
    const schema: ToolParameters = {
      type: 'object',
      properties: {
        a: { type: 'array' },
        o: { type: 'object' },
        b: { type: 'boolean' },
        z: { type: 'null' },
      },
    };

    expect(validateArguments(schema, { a: [1], o: {}, b: false, z: null })).toEqual([]);
    expect(validateArguments(schema, { a: {}, o: [], b: 'no', z: 0 })).toEqual([
      "property 'a' must be of type array",
      "property 'o' must be of type object",
      "property 'b' must be of type boolean",
      "property 'z' must be of type null",
    ]);
  });

  it('treats an unknown type keyword as unconstrained', () => {
    const schema: ToolParameters = {
      type: 'object',
      properties: { when: { type: 'timestamp-from-the-future' } },
    };
    expect(validateArguments(schema, { when: 'anything' })).toEqual([]);
  });

  it('skips absent and null optional properties', () => {
    expect(validateArguments(SCHEMA, { city: 'Paris', days: null })).toEqual([]);
  });

  it('allows extra properties when the schema does not forbid them', () => {
    const open: ToolParameters = { type: 'object', properties: { city: { type: 'string' } } };
    expect(validateArguments(open, { city: 'Paris', anything: true })).toEqual([]);
  });
});

describe('Tool', () => {
  it('exposes its definition plus the handler', async () => {
    const tool = lookup();
    expect(tool.name).toBe('lookup');
    expect(tool.definition.name).toBe('lookup');
    expect(await tool.handler({ city: 'Paris' })).toEqual({ city: 'Paris', days: 1 });
  });

  it('refuses a required parameter its own schema does not define', () => {
    expect(
      () =>
        new Tool({
          name: 'broken',
          parameters: { type: 'object', properties: {}, required: ['missing'] },
          handler: () => null,
        }),
    ).toThrow(ConfigurationError);
  });

  it('names the offending parameter in that refusal', () => {
    expect(() =>
      Tool.of({
        name: 'broken',
        parameters: { type: 'object', properties: {}, required: ['missing'] },
        handler: () => null,
      }),
    ).toThrow(/declares required parameter 'missing'/);
  });
});

describe('ToolExecutor', () => {
  it('registers, lists and reports what it has', () => {
    const executor = new ToolExecutor([lookup()]);
    expect(executor.names()).toEqual(['lookup']);
    expect(executor.has('lookup')).toBe(true);
    expect(executor.has('absent')).toBe(false);
    expect(at(executor.definitions(), 0).name).toBe('lookup');
    expect(executor.definition('lookup').description).toBe('Look up the weather');
  });

  it('orders its definitions by name', () => {
    const executor = new ToolExecutor([
      new Tool({ name: 'zebra', handler: () => null }),
      new Tool({ name: 'alpha', handler: () => null }),
    ]);
    expect(executor.names()).toEqual(['alpha', 'zebra']);
  });

  it('runs a valid call and stringifies the value', async () => {
    const executor = new ToolExecutor([lookup()]);
    const result = await executor.execute(call('lookup', { city: 'Paris' }));

    expect(result.isError).toBe(false);
    expect(result.content).toBe('{"city":"Paris","days":1}');
    expect(result.callId).toBe('call-lookup');
  });

  it('hands back an error result for bad arguments rather than throwing', async () => {
    const executor = new ToolExecutor([lookup()]);
    const result = await executor.execute(call('lookup', { days: 2 }));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("missing required property 'city'");
    // The offending arguments are echoed so the model can see what it sent.
    expect(result.content).toContain('{"days":2}');
  });

  it('throws on an unknown tool, because no retry can fix a wiring bug', async () => {
    const executor = new ToolExecutor([lookup()]);

    await expect(executor.execute(call('absent'))).rejects.toThrow(ToolNotFoundError);
    await expect(executor.execute(call('absent'))).rejects.toThrow(
      /unknown tool 'absent'; registered: lookup/,
    );
  });

  it('turns a crashing handler into an error result by default', async () => {
    const executor = new ToolExecutor([
      new Tool({
        name: 'boom',
        parameters: { type: 'object' },
        handler: () => {
          throw new TypeError('kaboom');
        },
      }),
    ]);

    const result = await executor.execute(call('boom'));
    expect(result.isError).toBe(true);
    expect(result.content).toBe('TypeError: kaboom');
  });

  it('rethrows in strict mode, for a caller that treats a crash as a bug', async () => {
    const executor = new ToolExecutor(
      [
        new Tool({
          name: 'boom',
          parameters: { type: 'object' },
          handler: () => {
            throw new TypeError('kaboom');
          },
        }),
      ],
      { strict: true },
    );

    await expect(executor.execute(call('boom'))).rejects.toThrow(ToolExecutionError);
    await expect(executor.execute(call('boom'))).rejects.toThrow(/TypeError: kaboom/);
  });

  it('awaits an asynchronous handler', async () => {
    const executor = new ToolExecutor([
      new Tool({
        name: 'later',
        parameters: { type: 'object' },
        handler: async () => 'done',
      }),
    ]);

    expect((await executor.execute(call('later'))).content).toBe('done');
  });

  it('runs a batch in order', async () => {
    const executor = new ToolExecutor([lookup()]);
    const results = await executor.executeAll([
      call('lookup', { city: 'Paris' }),
      call('lookup', { city: 'Lima' }),
    ]);

    expect(results).toHaveLength(2);
    expect(at(results, 0).content).toContain('Paris');
    expect(at(results, 1).content).toContain('Lima');
  });

  it('replaces a duplicate registration, because a registry is a map', async () => {
    const executor = new ToolExecutor([lookup()]);
    executor.register(
      new Tool({
        name: 'lookup',
        parameters: { type: 'object' },
        handler: () => 'second',
      }),
    );

    expect(executor.names()).toEqual(['lookup']);
    expect((await executor.execute(call('lookup'))).content).toBe('second');
  });

  it('starts empty when given nothing', () => {
    expect(new ToolExecutor().names()).toEqual([]);
  });
});
