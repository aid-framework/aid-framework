/**
 * Holds generator discovery to the manifests.
 *
 * The support and reference pages both enumerate `packages/generators` and then read
 * `<package>/src/manifest.ts` as a target. Deciding membership by "is a directory" made a
 * `node_modules` directory -- which vitest recreates on every run -- fail both generators
 * instead of being skipped, so membership is asserted here against a stray directory that
 * looks exactly like the one that broke them.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generatorDirectories,
  loadSupportData,
  parsePlanProblemCodes,
  planProblemCodes,
  repoRoot,
  targetIds,
} from './support-data.mjs';

const generatorsRoot = join(repoRoot, 'packages', 'generators');

describe('generator discovery', () => {
  it('lists only directories that declare a manifest', () => {
    const directories = generatorDirectories();

    expect(directories.length).toBeGreaterThan(0);
    for (const name of directories) {
      expect(existsSync(join(generatorsRoot, name, 'src', 'manifest.ts'))).toBe(true);
    }
  });

  it('ignores a directory with no manifest, as vitest leaves behind', () => {
    const stray = join(generatorsRoot, 'node_modules');
    const probe = join(stray, '.vite-probe');
    const preExisted = existsSync(stray);
    const before = targetIds();
    try {
      mkdirSync(probe, { recursive: true });
      writeFileSync(join(probe, 'package.json'), '{"name":"stray"}\n', 'utf8');

      expect(generatorDirectories()).not.toContain('node_modules');
      expect(targetIds()).toEqual(before);
    } finally {
      rmSync(probe, { recursive: true, force: true });
      if (!preExisted) rmSync(stray, { recursive: true, force: true });
    }
  });
});

/**
 * A plan-time refusal the features page cites has to exist in the union its target reports.
 *
 * Round 6 shipped `unsupported-streaming` on the features page while no table the page reads
 * defined it, so the page named a gate and the site's own suite could not tell whether the
 * gate was there. The unions are the registry now.
 */
describe('the plan-time codes a target reports', () => {
  it('reads the members of the union rather than a hand-kept list', () => {
    const codes = planProblemCodes();

    expect(codes).toContain('unsupported-guardrail');
    expect(codes).toContain('streaming-unsupported');
  });

  it('offers them to the page checker beside every registered table', () => {
    const data = loadSupportData();

    expect(data.diagnostics).toContain('streaming-unsupported');
    expect(data.diagnostics).toContain('unsupported-guardrail');
  });

  it('fails rather than reporting nothing when the union cannot be read', () => {
    expect(() => parsePlanProblemCodes('export type PlanProblemCode = never;')).toThrow(
      /cannot parse a plan problem code union/,
    );
  });
});
