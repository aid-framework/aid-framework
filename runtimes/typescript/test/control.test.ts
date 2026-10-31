/**
 * The composite step family, ported from `runtimes/python/tests/test_control.py`.
 *
 * These tests pin the *ordering and bound* properties the composites exist to give: a
 * fan-out never exceeds the deployment's cap, results merge in input order whatever
 * order the arms finish in, a failure surfaces the first failing arm in input order, and
 * nesting is bounded. Those properties are what the generated code relies on, so they are
 * asserted directly here rather than inferred from the emitted app.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter } from '../src/concurrency.js';
import {
  branch,
  DEPTH_KEY,
  INDEX_KEY,
  ITEM_KEY,
  LIMITER_KEY,
  MAX_STEP_DEPTH,
  mapStep,
  PRINCIPAL_KEY,
  parallel,
  REDUCED_KEY,
  RESERVED_KEYS,
  reduceStep,
} from '../src/control.js';
import { PolicyEvaluationError } from '../src/errors.js';
import { Pipeline, PipelineContext, type Step } from '../src/pipeline.js';
import {
  evaluatePolicy,
  POLICY_BUILTIN_ARITY,
  POLICY_BUILTINS,
  type PolicyNode,
  Principal,
  policySource,
} from '../src/policy.js';
import { failure } from './support.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function context(values: Readonly<Record<string, unknown>> = {}): PipelineContext {
  return new PipelineContext(values);
}

/** A step that binds `bind` to `value`, optionally after a delay. */
function step(
  bind: string,
  options: { readonly delayMs?: number; readonly value?: unknown } = {},
): Step {
  const body = async (current: PipelineContext): Promise<PipelineContext> => {
    if (options.delayMs !== undefined) await sleep(options.delayMs);
    return current.withValues({ [bind]: options.value ?? bind });
  };
  Object.defineProperty(body, 'name', { value: bind, configurable: true });
  return body;
}

function named(what: string, body: Step): Step {
  Object.defineProperty(body, 'name', { value: what, configurable: true });
  return body;
}

const IS_AUTHENTICATED: PolicyNode = { kind: 'call', name: 'isAuthenticated', args: [] };
const HAS_ROLE_ADMIN: PolicyNode = {
  kind: 'call',
  name: 'hasRole',
  args: [{ kind: 'string', value: 'admin' }],
};

function newKeys(
  values: Readonly<Record<string, unknown>>,
  baseline: Readonly<Record<string, unknown>> = {},
): string[] {
  return Object.keys(values).filter(
    (key) =>
      !Object.hasOwn(baseline, key) &&
      key !== PRINCIPAL_KEY &&
      key !== LIMITER_KEY &&
      key !== ITEM_KEY &&
      key !== INDEX_KEY &&
      key !== DEPTH_KEY &&
      key !== REDUCED_KEY &&
      key !== 'steps',
  );
}

describe('policy', () => {
  it('reads isAuthenticated from the principal', () => {
    expect(evaluatePolicy(IS_AUTHENTICATED, new Principal())).toBe(true);
    expect(evaluatePolicy(IS_AUTHENTICATED, new Principal({ authenticated: false }))).toBe(false);
  });

  it('reads hasRole from the principal roles', () => {
    expect(evaluatePolicy(HAS_ROLE_ADMIN, new Principal({ roles: ['admin'] }))).toBe(true);
    expect(evaluatePolicy(HAS_ROLE_ADMIN, new Principal({ roles: ['viewer'] }))).toBe(false);
  });

  it('agrees with the IR on the builtin set and arity', () => {
    // The runtime carries its own copy because it may not import `@aid-framework/*`; the IR owns
    // the grammar, so the two are held together here instead of diverging silently.
    const source = readFileSync(join(HERE, '../../../packages/ir/src/policy/ast.ts'), 'utf8');
    const declared = /export const POLICY_BUILTINS = \[([^\]]+)\]/
      .exec(source)?.[1]
      ?.split(',')
      .map((entry) => entry.trim().replaceAll(/^'|'$/g, ''))
      .filter((entry) => entry.length > 0);

    expect(declared).toEqual([...POLICY_BUILTINS]);
    for (const [name, arity] of Object.entries(POLICY_BUILTIN_ARITY)) {
      expect(source).toContain(`${name}: ${arity},`);
    }
  });

  it('refuses a policy whose value is not a boolean', () => {
    const notBoolean: PolicyNode = { kind: 'string', value: 'yes' };
    expect(() => evaluatePolicy(notBoolean, new Principal())).toThrow(PolicyEvaluationError);
  });

  it('renders a policy back to source, so a diagnostic names the rule', () => {
    expect(policySource(IS_AUTHENTICATED)).toBe('isAuthenticated()');
    expect(policySource(HAS_ROLE_ADMIN)).toBe('hasRole("admin")');
  });
});

describe('branch', () => {
  it('runs then when the principal satisfies the policy', async () => {
    const pipeline = Pipeline.of(
      branch({
        when: IS_AUTHENTICATED,
        // biome-ignore lint/suspicious/noThenProperty: the branch shape names its taken arm `then`.
        then: Pipeline.of(step('took')),
        otherwise: Pipeline.of(step('skipped')),
      }),
    );

    const result = await pipeline.run(context({ [PRINCIPAL_KEY]: new Principal() }));

    expect(result.get('took')).toBe('took');
    expect(result.get('skipped')).toBeUndefined();
  });

  it('runs otherwise when the principal does not satisfy the policy', async () => {
    const pipeline = Pipeline.of(
      branch({
        when: HAS_ROLE_ADMIN,
        // biome-ignore lint/suspicious/noThenProperty: the branch shape names its taken arm `then`.
        then: Pipeline.of(step('took')),
        otherwise: Pipeline.of(step('skipped')),
      }),
    );

    const result = await pipeline.run(context({ [PRINCIPAL_KEY]: new Principal() }));

    expect(result.get('skipped')).toBe('skipped');
    expect(result.get('took')).toBeUndefined();
  });

  it('binds nothing when no alternative is declared and the policy is false', async () => {
    const pipeline = Pipeline.of(
      // biome-ignore lint/suspicious/noThenProperty: the branch shape names its taken arm `then`.
      branch({ when: HAS_ROLE_ADMIN, then: Pipeline.of(step('took')) }),
    );

    const seeded = { [PRINCIPAL_KEY]: new Principal(), kept: 1 };
    const result = await pipeline.run(context(seeded));

    expect(newKeys(result.values, seeded)).toEqual([]);
    expect(result.get('kept')).toBe(1);
  });

  it('refuses a context with no principal rather than deciding for nobody', async () => {
    const pipeline = Pipeline.of(
      // biome-ignore lint/suspicious/noThenProperty: the branch shape names its taken arm `then`.
      branch({ when: IS_AUTHENTICATED, then: Pipeline.of(step('took')) }),
    );

    const error = await failure(pipeline.run(context()));

    expect(error.message).toMatch(/needs a principal/);
    expect(error.message).toMatch(/isAuthenticated\(\)/);
  });

  it('treats an unauthenticated principal as failing isAuthenticated', async () => {
    const pipeline = Pipeline.of(
      branch({
        when: IS_AUTHENTICATED,
        // biome-ignore lint/suspicious/noThenProperty: the branch shape names its taken arm `then`.
        then: Pipeline.of(step('took')),
        otherwise: Pipeline.of(step('skipped')),
      }),
    );

    const result = await pipeline.run(
      context({ [PRINCIPAL_KEY]: new Principal({ authenticated: false }) }),
    );

    expect(result.get('skipped')).toBe('skipped');
  });
});

describe('parallel', () => {
  it('never exceeds the cap while running every arm', async () => {
    let active = 0;
    let peak = 0;
    const arms = Array.from({ length: 12 }, (_, index) =>
      named(`arm${index}`, async (current) => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(20);
        active -= 1;
        return current.withValues({ [`arm${index}`]: index });
      }),
    );

    const pipeline = Pipeline.of(parallel({ branches: arms.map((arm) => Pipeline.of(arm)) }));
    const result = await pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(3) }));

    expect(peak).toBe(3);
    expect(newKeys(result.values)).toHaveLength(12);
  });

  it('keeps input order when arms finish in reverse', async () => {
    const finished: string[] = [];
    const arm = (name: string, delayMs: number) =>
      named(name, async (current) => {
        await sleep(delayMs);
        finished.push(name);
        return current.withValues({ [name]: delayMs });
      });
    const arms = [
      Pipeline.of(arm('alpha', 30)),
      Pipeline.of(arm('beta', 15)),
      Pipeline.of(arm('gamma', 0)),
    ];

    const pipeline = Pipeline.of(parallel({ branches: arms }));
    const result = await pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(3) }));

    expect(finished).toEqual(['gamma', 'beta', 'alpha']);
    expect(newKeys(result.values)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('refuses two arms binding the same name', async () => {
    const pipeline = Pipeline.of(
      parallel({ branches: [Pipeline.of(step('shared')), Pipeline.of(step('shared'))] }),
    );

    const error = await failure(
      pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(2) })),
    );

    expect(error.message).toMatch(/parallel arms both bind 'shared'/);
  });

  it('fails the run when one arm fails', async () => {
    const pipeline = Pipeline.of(
      parallel({
        branches: [
          Pipeline.of(step('fine')),
          Pipeline.of(
            named('boom', () => {
              throw new Error('arm exploded');
            }),
          ),
        ],
      }),
    );

    const error = await failure(
      pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(2) })),
    );

    expect(error.message).toMatch(/arm exploded/);
  });

  it('raises the first failing arm in input order, not the first to finish', async () => {
    const failing = (name: string, delayMs: number) =>
      named(name, async () => {
        await sleep(delayMs);
        throw new Error(`${name} failed`);
      });
    const pipeline = Pipeline.of(
      parallel({
        branches: [Pipeline.of(failing('slow', 30)), Pipeline.of(failing('fast', 0))],
      }),
    );

    const error = await failure(
      pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(2) })),
    );

    expect(error.message).toMatch(/slow failed/);
  });

  it('binds nothing and needs no limiter with no arms', async () => {
    const pipeline = Pipeline.of(parallel({ branches: [] }));

    const seeded = { kept: 1 };
    const result = await pipeline.run(context(seeded));

    expect(newKeys(result.values, seeded)).toEqual([]);
    expect(result.get('kept')).toBe(1);
  });

  it('runs a single arm', async () => {
    const pipeline = Pipeline.of(parallel({ branches: [Pipeline.of(step('only'))] }));

    const result = await pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(1) }));

    expect(result.get('only')).toBe('only');
  });

  it('refuses a fan-out with no limiter rather than running unbounded', async () => {
    const pipeline = Pipeline.of(parallel({ branches: [Pipeline.of(step('one'))] }));

    const error = await failure(pipeline.run(context()));

    expect(error.message).toMatch(/no concurrency limiter/);
  });

  it('does not deadlock when a leaf acquires inside a slot it already holds', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const arms = Array.from({ length: 3 }, (_, index) =>
      named(`arm${index}`, async (current) => {
        // A leaf model or tool call acquires the same limiter the fan-out already holds.
        await limiter.run(() => sleep(10));
        return current.withValues({ [`arm${index}`]: index });
      }),
    );

    const pipeline = Pipeline.of(parallel({ branches: arms.map((arm) => Pipeline.of(arm)) }));
    const result = await pipeline.run(context({ [LIMITER_KEY]: limiter }));

    expect(newKeys(result.values)).toEqual(['arm0', 'arm1', 'arm2']);
    expect(limiter.inFlight).toBe(0);
  });
});

describe('map', () => {
  it('runs the body once per item in input order', async () => {
    const seen: unknown[] = [];
    const body = named('work', async (current) => {
      seen.push(current.get(ITEM_KEY));
      await sleep(10);
      return current.withValues({ doubled: (current.require(ITEM_KEY) as number) * 2 });
    });

    const pipeline = Pipeline.of(
      mapStep({ over: 'items', as: 'results', step: Pipeline.of(body) }),
    );
    const result = await pipeline.run(
      context({ items: [1, 2, 3], [LIMITER_KEY]: new ConcurrencyLimiter(3) }),
    );

    expect(result.get('results')).toEqual([{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }]);
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('binds an empty list over an empty input', async () => {
    const pipeline = Pipeline.of(
      mapStep({ over: 'items', as: 'results', step: Pipeline.of(step('at')) }),
    );

    const result = await pipeline.run(
      context({ items: [], [LIMITER_KEY]: new ConcurrencyLimiter(2) }),
    );

    expect(result.get('results')).toEqual([]);
  });

  it('binds one mapping over a single item', async () => {
    const body = named('work', async (current) =>
      current.withValues({ where: current.require(INDEX_KEY) }),
    );
    const pipeline = Pipeline.of(
      mapStep({ over: 'items', as: 'results', step: Pipeline.of(body) }),
    );

    const result = await pipeline.run(
      context({ items: ['only'], [LIMITER_KEY]: new ConcurrencyLimiter(2) }),
    );

    expect(result.get('results')).toEqual([{ where: 0 }]);
  });

  it('does not leak its iteration keys to a sibling', async () => {
    const sibling = named('after', (current) => current.withValues({ after: true }));
    const pipeline = Pipeline.of(
      mapStep({ over: 'items', as: 'results', step: Pipeline.of(step('at')) }),
      sibling,
    );

    const result = await pipeline.run(
      context({ items: [1, 2], [LIMITER_KEY]: new ConcurrencyLimiter(2) }),
    );

    for (const key of [ITEM_KEY, INDEX_KEY, DEPTH_KEY]) {
      expect(result.values).not.toHaveProperty(key);
    }
    expect(result.get('after')).toBe(true);
  });

  it('refuses a non-list input', async () => {
    const pipeline = Pipeline.of(
      mapStep({ over: 'items', as: 'results', step: Pipeline.of(step('at')) }),
    );

    const error = await failure(
      pipeline.run(context({ items: 7, [LIMITER_KEY]: new ConcurrencyLimiter(2) })),
    );

    expect(error.message).toMatch(/needs a list, got int/);
  });

  it('refuses a string, which is a sequence but not a list', async () => {
    const pipeline = Pipeline.of(
      mapStep({ over: 'items', as: 'results', step: Pipeline.of(step('at')) }),
    );

    const error = await failure(
      pipeline.run(context({ items: 'abc', [LIMITER_KEY]: new ConcurrencyLimiter(2) })),
    );

    expect(error.message).toMatch(/needs a list, got str/);
  });
});

describe('reduce', () => {
  it('collects per-item results in input order', async () => {
    const finished: unknown[] = [];
    const body = named('summarise', async (current) => {
      await sleep(30 - (current.require(INDEX_KEY) as number) * 10);
      finished.push(current.get(ITEM_KEY));
      return current.withValues({ [REDUCED_KEY]: `note:${String(current.require(ITEM_KEY))}` });
    });

    const pipeline = Pipeline.of(
      reduceStep({ over: 'items', as: 'notes', step: Pipeline.of(body) }),
    );
    const result = await pipeline.run(
      context({ items: ['alpha', 'beta', 'gamma'], [LIMITER_KEY]: new ConcurrencyLimiter(3) }),
    );

    expect(finished).toEqual(['gamma', 'beta', 'alpha']);
    expect(result.get('notes')).toEqual(['note:alpha', 'note:beta', 'note:gamma']);
  });

  it('binds an empty list over an empty input', async () => {
    const pipeline = Pipeline.of(
      reduceStep({ over: 'items', as: 'notes', step: Pipeline.of(step(REDUCED_KEY)) }),
    );

    const result = await pipeline.run(
      context({ items: [], [LIMITER_KEY]: new ConcurrencyLimiter(2) }),
    );

    expect(result.get('notes')).toEqual([]);
  });

  it('refuses a body that binds no reduced value', async () => {
    const pipeline = Pipeline.of(
      reduceStep({ over: 'items', as: 'notes', step: Pipeline.of(step('unrelated')) }),
    );

    const error = await failure(
      pipeline.run(context({ items: ['alpha'], [LIMITER_KEY]: new ConcurrencyLimiter(2) })),
    );

    expect(error.message).toMatch(/produced no 'reduced' binding for item 0/);
  });
});

describe('nesting', () => {
  const nested = (levels: number): Step => {
    if (levels === 0) return step('leaf');
    return parallel({ branches: [Pipeline.of(nested(levels - 1))] });
  };

  it('allows nesting up to the bound', async () => {
    const pipeline = Pipeline.of(nested(MAX_STEP_DEPTH));
    const result = await pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(2) }));

    expect(result.get('leaf')).toBe('leaf');
  });

  it('refuses nesting past the bound, naming the reason', async () => {
    const pipeline = Pipeline.of(nested(MAX_STEP_DEPTH + 1));

    const error = await failure(
      pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(2) })),
    );

    expect(error.message).toMatch(new RegExp(`nested deeper than ${MAX_STEP_DEPTH} levels`));
    expect(error.message).toMatch(/bounded so a self-similar spec cannot recurse/);
  });

  it('leaves no depth behind once a composite returns', async () => {
    const pipeline = Pipeline.of(
      parallel({ branches: [Pipeline.of(step('inner'))] }),
      named('after', (current) => current.withValues({ after: true })),
    );

    const result = await pipeline.run(context({ [LIMITER_KEY]: new ConcurrencyLimiter(2) }));

    expect(result.values).not.toHaveProperty(DEPTH_KEY);
    expect(result.get('after')).toBe(true);
  });
});

describe('the reserved names', () => {
  it('are exactly the six the reference runtime reserves', () => {
    expect([...RESERVED_KEYS].sort()).toEqual([
      'depth',
      'index',
      'item',
      'limiter',
      'principal',
      'reduced',
    ]);
  });

  it('agree with the spec layer, which refuses a binding on one of them', () => {
    // The two runtimes each carry their own copy -- neither may import `@aid-framework/*` -- so
    // the spec constant and the runtime constant are held together here instead.
    const source = readFileSync(join(HERE, '../../../packages/spec/src/validate.ts'), 'utf8');
    const match = /export const MAX_STEP_DEPTH = (\d+);/.exec(source);
    expect(match, 'MAX_STEP_DEPTH not found in packages/spec/src/validate.ts').not.toBeNull();
    expect(MAX_STEP_DEPTH).toBe(Number(match?.[1]));
  });

  it('agree with the Python runtime, which reserves the same six at the same depth', () => {
    // Both runtimes carry the set themselves -- the TypeScript one may not import the
    // Python package and vice versa -- so a seventh key added on one side would
    // otherwise surface as a generated app whose `map` silently overwrites a binding.
    const source = readFileSync(
      join(HERE, '../../../runtimes/python/src/aid_runtime/control.py'),
      'utf8',
    );

    const names = new Map<string, string>();
    for (const [, constant, value] of source.matchAll(/^([A-Z_]+_KEY) = "([^"]+)"$/gm)) {
      names.set(constant as string, value as string);
    }
    const reserved = /^RESERVED_KEYS = frozenset\(\{([^}]+)\}\)$/m
      .exec(source)?.[1]
      ?.split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((constant) => names.get(constant));

    expect(
      reserved,
      'RESERVED_KEYS not found in runtimes/python/src/aid_runtime/control.py',
    ).toBeDefined();
    expect(reserved?.sort()).toEqual([...RESERVED_KEYS].sort());
    expect(source).toContain(`MAX_STEP_DEPTH = ${MAX_STEP_DEPTH}`);
  });
});
