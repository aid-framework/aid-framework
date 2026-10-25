/**
 * The target registry, as the CLI sees it.
 *
 * This is the only place both generators and the registry are visible at once, so it is
 * where the cross-check lives: a target's entry has to be derived from the manifest its
 * own package declares, or `aid gen --target X` and `@aid/generator-X` disagree about
 * layout, version and capabilities. `py-fastapi` gets that check from
 * `@aid/generator-sdk`; `ts-vercel` cannot, because the SDK cannot depend on a generator
 * that depends on the SDK -- so the registry is authoritative and this test pins it.
 */

import { PY_FASTAPI_MANIFEST } from '@aid/generator-py-fastapi';
import {
  TS_VERCEL_CAPABILITIES,
  TS_VERCEL_MANIFEST,
  tsVercelGenerator,
} from '@aid/generator-ts-vercel';
import { buildIR, REQUIRED_CAPABILITIES, runGates } from '@aid/ir';
import { checkSpecText } from '@aid/spec';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TARGET,
  resolveTarget,
  TARGETS,
  targetCapabilities,
  targetNames,
  unknownTargetDiagnostic,
} from '../src/targets.js';

describe('the registry', () => {
  it('holds exactly the two Phase 1 targets, py-fastapi first', () => {
    expect(targetNames()).toEqual(['py-fastapi', 'ts-vercel']);
  });

  it('keeps py-fastapi as the default, so an unnamed target behaves as it always has', () => {
    expect(DEFAULT_TARGET).toBe('py-fastapi');
    expect(resolveTarget(undefined)?.name).toBe('py-fastapi');
    expect(resolveTarget('py-fastapi')?.name).toBe('py-fastapi');
  });

  it('resolves ts-vercel by name, and nothing else', () => {
    expect(resolveTarget('ts-vercel')?.name).toBe('ts-vercel');
    expect(resolveTarget('ts-vercel')?.manifest).toBe(TS_VERCEL_MANIFEST);
    expect(resolveTarget('ts-vercel')?.generator).toBe(tsVercelGenerator);
    expect(resolveTarget('ts-vercel')?.check).toBeTypeOf('function');
    expect(resolveTarget('typescript')).toBeUndefined();
    expect(resolveTarget('')).toBeUndefined();
  });

  it('names the known targets when a target is unknown', () => {
    const diagnostic = unknownTargetDiagnostic('go-fiber');
    expect(diagnostic.code).toBe('cli/unknown-target');
    expect(diagnostic.hint).toContain('py-fastapi, ts-vercel');
  });
});

describe('the ts-vercel entry', () => {
  const target = TARGETS.find((entry) => entry.name === 'ts-vercel');

  it('is derived from the generator package, not restated here', () => {
    expect(target?.manifest).toBe(TS_VERCEL_MANIFEST);
    expect(target?.manifest.name).toBe('@aid/generator-ts-vercel');
    expect(target?.manifest.target).toBe('ts-vercel');
  });

  it('reads its layout off the manifest, so `src/` can move a directory', () => {
    expect(target?.generatedDir).toBe('app/generated');
    expect(target?.businessDir).toBe('app/business');
    expect(target?.manifestPath).toBe('app/aid.manifest.json');
    expect(target?.specPath).toBe('app/app.spec.yaml');
    expect(target?.evalsDir).toBe('app/generated/evals');
  });

  it('runs its emitted modules on node, not on an interpreter', () => {
    expect(target?.runner).toBe('node');
    expect(target?.evalModule('classify_quality')).toBe('app.generated.evals.classify_quality');
    expect(target?.retrievalIngestModule('handbook')).toBe(
      'app.generated.retrieval.ingest.handbook',
    );
  });

  it('declares the capabilities its package declares, and no others', () => {
    const declared = targetCapabilities();
    expect(declared['ts-vercel']).toEqual([...TS_VERCEL_CAPABILITIES].sort());
    expect(declared['py-fastapi']).toEqual([...PY_FASTAPI_MANIFEST.capabilities].sort());
  });

  it('drops `streaming`, which both runtimes defer', () => {
    // Neither target may declare it: the emitted code calls `ModelGateway.stream`, which
    // raises `FeatureDeferredError` in `runtimes/python` and `runtimes/typescript` alike.
    // `py-fastapi` used to declare it and this test used to say so, which made a claim
    // about honoured behaviour that no runtime kept. L1 withdrew it from both sides, so
    // the assertion is on both targets and cannot pass by one of them being unexamined.
    expect(targetCapabilities()['ts-vercel']).not.toContain('streaming');
    expect(targetCapabilities()['py-fastapi']).not.toContain('streaming');
    expect(PY_FASTAPI_MANIFEST.capabilities).not.toContain('streaming');
    expect([...TS_VERCEL_CAPABILITIES]).not.toContain('streaming');
  });
});

/**
 * The staging claim, made executable.
 *
 * L1 promoted `agents` and `guardrails` to supported spec sections and derived both as
 * required capabilities, but deliberately taught neither target to declare them: the
 * agent runtime is L2 (`py-fastapi`) and L6 (`ts-vercel`). The gap between "the spec
 * accepts it" and "a target can build it" has to be a rejection, not a hope, so this is
 * the whole journey in one test file -- spec validation, IR build, capability gate --
 * with the positive control that proves the gate is what refused.
 *
 * This lives in `packages/cli` because it is the only package that can see both
 * generators at once; inside `py-fastapi` the claim about `ts-vercel` would be untestable
 * and the test would quietly cover one target instead of every target.
 */
const AGENT_SPEC = `specVersion: "0.2"
project:
  name: agent-desk
  namespace: acme.agents
  targets: [py-fastapi, ts-vercel]
types:
  Reply:
    kind: struct
    fields:
      body:
        type: string
        required: true
models:
  triage:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema, tools]
    apiKeyEnv: OPENAI_API_KEY
prompts:
  support_instructions:
    version: 1
    model: triage
    template: "You are a support agent."
    output:
      kind: text
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: Blocked.
      log: true
agents:
  support:
    instructions: support_instructions
    model: triage
    maxSteps: 2
    maxTokensBudget: 1024
    guardrails: [inbound]
    engine: native
`;

/** The spec-plus-IR half of the journey: everything before target negotiation. */
function lowerAgentSpec() {
  const checked = checkSpecText(AGENT_SPEC, { file: 'agent-desk/app.spec.yaml' });
  expect(checked.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  expect(checked.ok).toBe(true);
  if (checked.value === undefined) throw new Error('the spec did not lower');

  const built = buildIR(checked.value, { file: 'agent-desk/app.spec.yaml' });
  expect(built.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  return built.ir;
}

describe('the agent sections, before any target sees them', () => {
  it('derives `agents` and `guardrails` as required capabilities', () => {
    const ir = lowerAgentSpec();
    expect(ir.agents).toHaveLength(1);
    expect(ir.guardrails).toHaveLength(1);
    expect(ir.requiredCapabilities).toContain('agents');
    expect(ir.requiredCapabilities).toContain('guardrails');
  });

  it('needs them to be real vocabulary members, or the gate below could not name them', () => {
    // Without this the rejection test could pass by the capability being ignored.
    expect([...REQUIRED_CAPABILITIES]).toContain('agents');
    expect([...REQUIRED_CAPABILITIES]).toContain('guardrails');
  });
});

describe('the agent sections, when a target is asked to build them', () => {
  it('rejects every target, naming the capability it lacks', () => {
    const ir = lowerAgentSpec();
    const gated = runGates(ir, { targetCapabilities: targetCapabilities() });

    expect(gated.ok).toBe(false);
    const rejections = gated.diagnostics.filter((entry) => entry.code === 'ir/capability-missing');
    expect(rejections).toHaveLength(4);
    expect(rejections.map((entry) => entry.message)).toEqual([
      'the capability gate rejected target "py-fastapi": the IR requires "agents", which this target does not declare',
      'the capability gate rejected target "py-fastapi": the IR requires "guardrails", which this target does not declare',
      'the capability gate rejected target "ts-vercel": the IR requires "agents", which this target does not declare',
      'the capability gate rejected target "ts-vercel": the IR requires "guardrails", which this target does not declare',
    ]);
    // Every rejection is a hard error at the target boundary, so `aid gen` cannot emit.
    expect(rejections.every((entry) => entry.severity === 'error')).toBe(true);
  });

  it('rejects them because neither target declares them, not for some other reason', () => {
    const declared = targetCapabilities();
    for (const target of targetNames()) {
      expect(declared[target]).not.toContain('agents');
      expect(declared[target]).not.toContain('guardrails');
    }
  });

  it('accepts the spec once a target does declare them, and still holds the other back', () => {
    // The positive control. If the gate refused for any reason other than the missing
    // declaration, granting the declaration would not flip the result -- and if the gate
    // were quietly a no-op, this control would be indistinguishable from the rejection.
    const ir = lowerAgentSpec();
    const granted = targetCapabilities();
    const gated = runGates(ir, {
      targetCapabilities: {
        ...granted,
        'py-fastapi': [...(granted['py-fastapi'] ?? []), 'agents', 'guardrails'],
      },
    });

    expect(gated.ok).toBe(false);
    expect(gated.diagnostics.map((entry) => entry.message)).toEqual([
      'the capability gate rejected target "ts-vercel": the IR requires "agents", which this target does not declare',
      'the capability gate rejected target "ts-vercel": the IR requires "guardrails", which this target does not declare',
    ]);
  });
});
