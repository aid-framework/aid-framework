/**
 * Eval coverage under `profile: enterprise` from spec 0.31.
 *
 * An endpoint no CI-gating eval covers is a warning for every other document: a partially
 * evaluated app is legitimate, a silently uncovered one is not. The enterprise profile
 * promises change control, and an endpoint nothing measures has nothing to control, so from
 * 0.31 the same situation is an error.
 *
 * The version gate is the interesting part. A 0.30 document written against the profile
 * keeps the warning it was accepted with, because a profile that promises change control
 * must be able to name when it started demanding the measurement.
 */

import { buildIR, runGates } from '@aid-framework/ir';
import { checkSpecText } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';

import { codesOf, fixtureText } from './helpers.js';

function coverage(text: string) {
  const checked = checkSpecText(text, { file: 'eval-uncovered.yaml' });
  if (!checked.ok) {
    throw new Error(checked.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
  }
  const built = buildIR(checked.value, { file: 'eval-uncovered.yaml' });
  return runGates(built.ir, {}).byGate['eval-coverage'].diagnostics;
}

const FIXTURE = fixtureText('eval-uncovered.yaml');
const at = (version: string, profile?: string) => {
  const text = FIXTURE.replace('specVersion: "0.1"', `specVersion: "${version}"`);
  return profile === undefined ? text : `${text}\nprofile: ${profile}\n`;
};

describe('an uncovered HTTP endpoint', () => {
  it('is a warning under the standard profile', () => {
    const [diagnostic] = coverage(at('0.31'));
    expect(diagnostic?.code).toBe('ir/eval-uncovered');
    expect(diagnostic?.severity).toBe('warning');
  });

  it('is an error under profile enterprise from 0.31', () => {
    const [diagnostic] = coverage(at('0.31', 'enterprise'));
    expect(diagnostic?.severity).toBe('error');
  });

  it('stays a warning for an enterprise document still on 0.30', () => {
    // The point of the version gate: a document that built yesterday does not refuse
    // today because a profile gained a requirement.
    const [diagnostic] = coverage(at('0.30', 'enterprise'));
    expect(diagnostic?.severity).toBe('warning');
  });

  it('names the profile as the reason it is now an error', () => {
    const [diagnostic] = coverage(at('0.31', 'enterprise'));
    expect(diagnostic?.message).toContain('profile enterprise');
    expect(diagnostic?.hint).toContain('profile: standard');
  });

  it('still reports the covered pipeline as covered', () => {
    expect(coverage(at('0.31', 'enterprise')).length).toBe(1);
  });

  it('names the uncovered pipeline and no other', () => {
    const [diagnostic] = coverage(at('0.31', 'enterprise'));
    expect(diagnostic?.path).toEqual(['pipelines', 'uncovered']);
  });

  it('is silent when every served endpoint is covered', () => {
    const text = at('0.31', 'enterprise').replace(
      `  uncovered:
    trigger:
      http:
        method: get
        path: /uncovered
    steps:
      - emit:
          event: Ping
`,
      '',
    );
    expect(coverage(text)).toEqual([]);
  });

  it('is the only code the gate emits for this fixture', () => {
    expect(codesOf(coverage(at('0.31', 'enterprise')))).toEqual(['ir/eval-uncovered']);
  });
});

describe('a retrieval surface with no retrieval metric', () => {
  const retrieval = (version: string) => {
    const text = fixtureText('eval-retrievers-uncovered.yaml').replace(
      'specVersion: "0.1"',
      `specVersion: "${version}"\nprofile: enterprise`,
    );
    const checked = checkSpecText(text, { file: 'eval-retrievers-uncovered.yaml' });
    if (!checked.ok) {
      throw new Error(checked.diagnostics.map((diagnostic) => diagnostic.code).join(', '));
    }
    const built = buildIR(checked.value, { file: 'eval-retrievers-uncovered.yaml' });
    const diagnostics = runGates(built.ir, {}).byGate['eval-coverage'].diagnostics;
    return diagnostics.find((diagnostic) => diagnostic.message.includes('retriever(s)'));
  };

  it('escalates to an error under profile enterprise from 0.31', () => {
    expect(retrieval('0.31')?.severity).toBe('error');
  });

  it('stays a warning for an enterprise document still on 0.30', () => {
    expect(retrieval('0.30')?.severity).toBe('warning');
  });
});
