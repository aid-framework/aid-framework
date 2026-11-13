/**
 * The principal an agent route runs as.
 *
 * `Principal.authenticated` used to default to `True`, so a route that passed no principal
 * ran `isAuthenticated()` as true for every caller -- the weakest policy the security gate
 * accepts on a mutating tool. The pipeline path never had the bug: `control.py` seeds an
 * explicitly unauthenticated principal. The agent path did, because its handlers simply
 * never mentioned one.
 *
 * A route that forgets the principal again would fail closed at the tool boundary rather
 * than open (the runtime default is now `Principal.unauthenticated()`), but it would fail
 * *everything* closed, which is a defect too. So the two claims pinned here are the pair:
 * the route takes the principal as a dependency, and the dependency returns the anonymous
 * one, which is the contract a developer replaces with their own verifier.
 */

import { describe, expect, it } from 'vitest';

import { examplePlan, fileMap } from './helpers.js';

const AGENTS_PATH = 'app/generated/agents.py';

function agentsModule(): string {
  const file = fileMap(examplePlan().files).get(AGENTS_PATH);
  if (file === undefined) throw new Error(`the plan does not emit ${AGENTS_PATH}`);
  return file;
}

/** `source` without its comment lines, since prose is allowed to name what code may not. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('the principal an agent route runs as', () => {
  it('is seeded from a dependency, not from the runtime default', () => {
    const module = agentsModule();

    // Both routes, because a resume continues a run the run route started: a resume that
    // lost the caller would silently re-evaluate every policy against whoever asked.
    expect(
      module.match(/principal: Annotated\[Principal, Depends\(current_principal\)\]/g),
    ).toHaveLength(2);
    expect(module).toContain('def current_principal() -> Principal:');
    expect(module).toContain('"current_principal",');
  });

  it('is passed into the runtime, which cannot see the request', () => {
    const module = agentsModule();

    expect(module).toContain('principal=principal, memory_key=event.memory_key');
    expect(module).toContain(
      'await runtime.resume(checkpoint, event.decision, principal=principal)',
    );
  });

  it('is anonymous, so a tool with no verifier behind it is refused', () => {
    const module = agentsModule();

    expect(module).toContain('ANONYMOUS_PRINCIPAL = Principal.unauthenticated()');
    expect(module).toContain('return ANONYMOUS_PRINCIPAL');
    // The fail-open form. It is also the reason the runtime default was changed: even a
    // forgotten argument must not authenticate anybody.
    expect(code(module)).not.toMatch(/Principal\(\s*\)/);
  });

  it('is the only bare-principal construction in the whole plan', () => {
    // A second emitter written with the default would reintroduce the bug this test exists
    // for, and it would do so in a file no agent test looks at.
    for (const file of examplePlan().files) {
      expect(code(file.content), file.path).not.toMatch(/Principal\(\s*\)/);
    }
  });
});
