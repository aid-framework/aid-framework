import { describe, expect, it } from 'vitest';

import {
  GENERATOR_DIAGNOSTIC_CODES,
  type GeneratedFile,
  isRecord,
  type Plan,
  validatePlan,
} from '../src/index.js';
import { codes, hasCode, messages } from './helpers.js';

const options = { generatedDir: 'app/generated', businessDir: 'app/business' };

function generated(path: string, content = 'x = 1\n'): GeneratedFile {
  return { path, content, owner: 'generated' };
}

function business(path: string, content = '# mine\n'): GeneratedFile {
  return { path, content, owner: 'business' };
}

describe('validatePlan', () => {
  it('accepts a plan with one file per tier', () => {
    const plan: Plan = {
      files: [generated('app/generated/main.py'), business('app/business/handlers.py')],
    };
    expect(validatePlan(plan, options)).toEqual([]);
  });

  it('accepts an empty capability-free plan shape with a single generated file', () => {
    expect(validatePlan({ files: [generated('app/generated/main.py')] }, options)).toEqual([]);
  });

  it('rejects a non-object plan', () => {
    expect(codes(validatePlan('nope', options))).toEqual([
      GENERATOR_DIAGNOSTIC_CODES.planNotAMapping,
    ]);
    expect(codes(validatePlan({ files: 'nope' }, options))).toEqual([
      GENERATOR_DIAGNOSTIC_CODES.planNotAMapping,
    ]);
  });

  it('rejects an empty plan', () => {
    expect(codes(validatePlan({ files: [] }, options))).toEqual([
      GENERATOR_DIAGNOSTIC_CODES.planEmpty,
    ]);
  });

  it('rejects a non-object file entry', () => {
    expect(codes(validatePlan({ files: ['x'] }, options))).toContain(
      GENERATOR_DIAGNOSTIC_CODES.planInvalidPath,
    );
  });

  it('rejects a non-string path', () => {
    expect(
      codes(validatePlan({ files: [{ content: 'x', owner: 'generated' }] }, options)),
    ).toContain(GENERATOR_DIAGNOSTIC_CODES.planInvalidPath);
  });

  it('rejects an absolute path', () => {
    const diagnostics = validatePlan({ files: [generated('C:/app/generated/main.py')] }, options);
    expect(messages(diagnostics).join(' ')).toContain('is absolute');
  });

  it('rejects a path that escapes the root', () => {
    const diagnostics = validatePlan(
      { files: [generated('app/generated/../../secrets')] },
      options,
    );
    expect(messages(diagnostics).join(' ')).toContain('escapes the repository root');
  });

  it('rejects a path with no owner', () => {
    const diagnostics = validatePlan({ files: [generated('app/other/main.py')] }, options);
    expect(codes(diagnostics)).toContain(GENERATOR_DIAGNOSTIC_CODES.planOwnerMismatch);
    expect(messages(diagnostics).join(' ')).toContain('no owner');
  });

  it('rejects an owner that contradicts the path', () => {
    const diagnostics = validatePlan(
      { files: [{ path: 'app/generated/main.py', content: 'x', owner: 'business' }] },
      options,
    );
    expect(hasCode(diagnostics, GENERATOR_DIAGNOSTIC_CODES.planOwnerMismatch)).toBe(true);
    expect(messages(diagnostics).join(' ')).toContain('is a generated path');
  });

  it('rejects a non-string content', () => {
    expect(
      codes(
        validatePlan(
          { files: [{ path: 'app/generated/a.py', content: 1, owner: 'generated' }] },
          options,
        ),
      ),
    ).toContain(GENERATOR_DIAGNOSTIC_CODES.planInvalidPath);
  });

  it('rejects the manifest itself as a planned artifact', () => {
    const diagnostics = validatePlan(
      { files: [{ path: 'aid.manifest.json', content: 'x', owner: 'generated' }] },
      options,
    );
    expect(messages(diagnostics).join(' ')).toContain('reserved');
  });

  it('rejects a manifest path the owning generator already claims', () => {
    const diagnostics = validatePlan(
      {
        files: [{ path: 'app/aid.manifest.json', content: 'x', owner: 'generated' }],
      },
      { ...options, manifestFilename: 'app/aid.manifest.json' },
    );
    expect(messages(diagnostics).join(' ')).toContain('reserved');
  });

  it('rejects a rejection sidecar as a planned artifact', () => {
    const diagnostics = validatePlan(
      { files: [generated('app/generated/main.py.aid-rej')] },
      options,
    );
    expect(messages(diagnostics).join(' ')).toContain('reserved');
  });

  it('rejects a duplicate path, naming the first occurrence', () => {
    const diagnostics = validatePlan(
      { files: [generated('app/generated/a.py'), generated('app/generated/a.py', 'y = 2\n')] },
      options,
    );
    expect(codes(diagnostics)).toContain(GENERATOR_DIAGNOSTIC_CODES.planDuplicatePath);
    expect(messages(diagnostics).join(' ')).toContain('plan.files[0]');
  });

  it('reports every problem in one pass rather than stopping at the first', () => {
    const diagnostics = validatePlan(
      {
        files: [
          generated('app/generated/a.py'),
          generated('app/generated/a.py'),
          generated('app/other/b.py'),
        ],
      },
      options,
    );
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
  });
});

describe('isRecord', () => {
  it('accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });
});
