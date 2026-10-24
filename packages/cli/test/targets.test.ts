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

  it('drops `streaming`, which the TypeScript runtime defers', () => {
    // `py-fastapi` declares it and honours it; this target does not, because the emitted
    // code calls `ModelGateway.stream`, which raises `FeatureDeferredError`. Declaring it
    // would be exactly the fail-open the capability discipline forbids.
    expect(targetCapabilities()['ts-vercel']).not.toContain('streaming');
  });
});
