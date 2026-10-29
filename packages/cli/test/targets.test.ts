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

  it('drops `streaming` from ts-vercel and keeps it on py-fastapi, whose runtime streams', () => {
    // The claim is now asymmetric, and that asymmetry is the point: the Python runtime
    // implements `ModelGateway.stream()` and the py-fastapi generator emits the
    // `Accept: text/event-stream` branch, while `runtimes/typescript` still raises
    // `FeatureDeferredError`. So one target may declare it and the other may not --
    // asserted on both, so neither side can pass by being unexamined.
    expect(targetCapabilities()['ts-vercel']).not.toContain('streaming');
    expect(targetCapabilities()['py-fastapi']).toContain('streaming');
    expect(PY_FASTAPI_MANIFEST.capabilities).toContain('streaming');
    expect([...TS_VERCEL_CAPABILITIES]).not.toContain('streaming');
  });
});

/**
 * The staging claim, made executable.
 *
 * L1 promoted `agents` and `guardrails` to supported spec sections and derived both as
 * required capabilities, but deliberately taught neither target to declare them: the
 * agent runtime is L2 (`py-fastapi`) and L6 (`ts-vercel`). P7a has since taught
 * `py-fastapi` to declare and honour `guardrails`, so the remaining gap this file pins is
 * `agents` on both targets plus `guardrails` on `ts-vercel`. The gap between "the spec
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
  it('builds the spec for both targets, which now declare both capabilities', () => {
    const ir = lowerAgentSpec();
    const gated = runGates(ir, { targetCapabilities: targetCapabilities() });

    expect(gated.ok).toBe(true);
    expect(gated.diagnostics.filter((entry) => entry.code === 'ir/capability-missing')).toEqual([]);
  });

  it('declares them per target, which is what the empty rejection above rests on', () => {
    // The claim is per target, not symmetric, and both directions are asserted: a
    // capability that silently moved between targets would keep "somebody declares it"
    // green, so each target's own list is what this pins.
    const declared = targetCapabilities();

    expect(declared['py-fastapi']).toContain('agents');
    expect(declared['py-fastapi']).toContain('guardrails');
    expect(declared['ts-vercel']).toContain('agents');
    expect(declared['ts-vercel']).toContain('guardrails');
  });

  it('rejects by name when a target withholds them, two for two', () => {
    // Withholding them from the override map is how the refusal stays attributable now
    // that both real targets declare both: the gate, the message and the count are the
    // same code path a real gap would take, and the count is asserted rather than the
    // target so a third rejection cannot hide inside a passing test.
    const ir = lowerAgentSpec();
    const granted = targetCapabilities();
    const withheld = {
      ...granted,
      'ts-vercel': (granted['ts-vercel'] ?? []).filter(
        (capability) => capability !== 'agents' && capability !== 'guardrails',
      ),
    };

    const gated = runGates(ir, { targetCapabilities: withheld });

    expect(gated.ok).toBe(false);
    const rejections = gated.diagnostics.filter((entry) => entry.code === 'ir/capability-missing');
    expect(rejections).toHaveLength(2);
    expect(rejections.map((entry) => entry.message)).toEqual([
      'the capability gate rejected target "ts-vercel": the IR requires "agents", which this target does not declare',
      'the capability gate rejected target "ts-vercel": the IR requires "guardrails", which this target does not declare',
    ]);
    expect(rejections.every((entry) => entry.severity === 'error')).toBe(true);
    // `ok` is false because one target of the set refused, so `aid gen --target
    // py-fastapi` is the only way to emit this spec under that map; the diagnostic names
    // the target so the refusal is attributable rather than a blanket "cannot build".
    expect(rejections.every((entry) => entry.message.includes('ts-vercel'))).toBe(true);
  });

  it('flips to ok when the withholding target declares both, and one short is one rejection', () => {
    // The positive control. If the gate refused for any reason other than the missing
    // declaration, granting the declaration would not flip the result -- and if the gate
    // were quietly a no-op, this control would be indistinguishable from the refusal.
    const ir = lowerAgentSpec();
    const granted = targetCapabilities();
    const withoutBoth = (granted['ts-vercel'] ?? []).filter(
      (capability) => capability !== 'agents' && capability !== 'guardrails',
    );

    const partial = runGates(ir, {
      targetCapabilities: {
        ...granted,
        'ts-vercel': [...withoutBoth, 'guardrails'],
      },
    });
    expect(partial.diagnostics.filter((entry) => entry.code === 'ir/capability-missing')).toEqual([
      expect.objectContaining({
        message:
          'the capability gate rejected target "ts-vercel": the IR requires "agents", which this target does not declare',
      }),
    ]);

    const full = runGates(ir, {
      targetCapabilities: { ...granted, 'ts-vercel': [...withoutBoth, 'agents', 'guardrails'] },
    });
    expect(full.ok).toBe(true);
    expect(full.diagnostics.filter((entry) => entry.code === 'ir/capability-missing')).toEqual([]);
  });
});
