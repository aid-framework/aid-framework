/**
 * The specs under `examples/scenarios/` are published documentation, so they are gated here with the
 * same parse, IR and gate path `aid validate` runs. A spec-language change that breaks a scenario
 * fails this suite instead of leaving a stale example in the repo.
 *
 * It lives in the CLI's suite because the capability gate is only meaningful against the real target
 * registry: `runGates` defaults to `@aid-framework/ir`'s Phase 0 declarations, which predate the
 * generators and under-declare them, so a scenario gated against that default would be refused for a
 * capability both targets do in fact ship.
 *
 * The negative cases mutate the built IR rather than the YAML: layer 1 rejects a document missing a
 * required key before an IR exists, so deleting the key from the IR is the only way to drive the
 * profile gate's own rule.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IR } from '@aid-framework/ir';
import { buildIR, runGates } from '@aid-framework/ir';
import { checkSpecText } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { targetCapabilities } from '../src/targets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(HERE, '..', '..', '..', 'examples', 'scenarios');

interface Scenario {
  readonly name: string;
  readonly ir: IR;
}

const SCENARIO_NAMES = readdirSync(SCENARIOS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function loadScenario(name: string): Scenario {
  const file = join(SCENARIOS_DIR, name, 'app', 'app.spec.yaml');
  const text = readFileSync(file, 'utf8');

  const checked = checkSpecText(text, { file });
  expect(checked.diagnostics, `${name} must parse as this spec version`).toEqual([]);
  if (!checked.ok) {
    throw new Error(`${name} did not parse`);
  }

  const built = buildIR(checked.value, { file });
  expect(built.diagnostics, `${name} must build an IR without diagnostics`).toEqual([]);

  return { name, ir: built.ir };
}

/** Runs the gates the way `aid validate` does, and reports only the codes. */
function gateCodes(ir: IR): string[] {
  return runGates(ir, { targetCapabilities: targetCapabilities() }).diagnostics.map(
    (entry) => entry.code,
  );
}

function codesAfter(mutate: (ir: IR) => void, scenario: Scenario): string[] {
  const ir = structuredClone(scenario.ir);
  mutate(ir);
  return gateCodes(ir);
}

describe('example scenarios', () => {
  it('ships at least one scenario per market segment', () => {
    const profiles = SCENARIO_NAMES.map((name) => loadScenario(name).ir.profile);

    expect(profiles).toContain('standard');
    expect(profiles).toContain('enterprise');
  });

  it.each(SCENARIO_NAMES)('%s passes every gate', (name) => {
    const scenario = loadScenario(name);
    const run = runGates(scenario.ir, { targetCapabilities: targetCapabilities() });

    expect(gateCodes(scenario.ir)).toEqual([]);
    expect(run.ok).toBe(true);
  });

  it.each(SCENARIO_NAMES)('%s ships the datasets its evals point at', (name) => {
    const scenario = loadScenario(name);

    for (const evaluation of scenario.ir.evals) {
      const uri = evaluation.dataset.uri;
      if (uri === undefined) {
        continue;
      }
      const dataset = join(SCENARIOS_DIR, name, 'app', uri);
      expect(existsSync(dataset), `${name} is missing ${uri}`).toBe(true);

      const parsed: unknown = JSON.parse(readFileSync(dataset, 'utf8'));
      expect(parsed, `${uri} must be a dataset document`).toMatchObject({
        name: evaluation.id,
      });
    }
  });
});

describe('the enterprise scenario is refused without its delivery controls', () => {
  const scenario = loadScenario('prior-auth-review');

  const deployment = (ir: IR) => {
    const found = ir.deployments[0];
    if (found === undefined) {
      throw new Error('the enterprise scenario declares no deployment');
    }
    return found;
  };

  it('is the enterprise profile', () => {
    expect(scenario.ir.profile).toBe('enterprise');
  });

  it('refuses a deployment with no audit sink', () => {
    const codes = codesAfter((ir) => {
      delete deployment(ir).audit;
    }, scenario);

    expect(codes).toContain('ir/profile-audit');
  });

  it('refuses a deployment with no identity integration', () => {
    const codes = codesAfter((ir) => {
      delete deployment(ir).identity;
    }, scenario);

    expect(codes).toContain('ir/profile-identity');
  });

  it('refuses a deployment that is not in a private network', () => {
    const codes = codesAfter((ir) => {
      delete deployment(ir).network;
    }, scenario);

    expect(codes).toContain('ir/profile-network');
  });

  it('refuses a deployment with no approval policy', () => {
    const codes = codesAfter((ir) => {
      delete deployment(ir).approvals;
    }, scenario);

    expect(codes).toContain('ir/profile-approvals');
  });

  it('refuses a document with no output guardrail', () => {
    const codes = codesAfter((ir) => {
      ir.guardrails = ir.guardrails.filter((guardrail) => !guardrail.stages.includes('output'));
    }, scenario);

    expect(codes).toContain('ir/profile-guardrail');
  });
});

describe('a scenario agent is bounded', () => {
  it.each(SCENARIO_NAMES)('%s declares a cost or token budget for every agent', (name) => {
    const scenario = loadScenario(name);

    for (const agent of scenario.ir.agents) {
      const bounded = agent.maxCostBudget !== undefined || agent.maxTokensBudget !== undefined;
      expect(bounded, `${agent.id} must declare maxCostBudget or maxTokensBudget`).toBe(true);
    }
  });

  it('refuses an agent whose budget is removed', () => {
    const scenario = loadScenario('prior-auth-review');

    const codes = codesAfter((ir) => {
      for (const agent of ir.agents) {
        delete agent.maxCostBudget;
        delete agent.maxTokensBudget;
      }
    }, scenario);

    expect(codes).toContain('ir/agents-budget');
  });
});
