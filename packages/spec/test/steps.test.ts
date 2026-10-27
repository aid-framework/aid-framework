import { describe, expect, it } from 'vitest';
import { checkSpecText, DIAGNOSTIC_CODES, type Diagnostic, formatPath } from '../src/index.js';

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

function messages(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.message);
}

/** A spec whose only interesting part is the pipeline body, so each case isolates one rule. */
function specWith(steps: string, deployment = true): string {
  return `specVersion: "0.2"

project:
  name: demo
  namespace: aid.demo
  targets:
    - py-fastapi

models:
  fast:
    provider: fake
    modelId: fake-deterministic-1

prompts:
  classify:
    version: 1
    model: fast
    template: "Classify: {{ text }}"
    variables:
      text:
        type: string
        required: true
    output:
      kind: text

pipelines:
  demo:
    description: Demo.
    trigger:
      http:
        method: post
        path: /demo
    steps:
${steps}
${deployment ? 'deployments:\n  api:\n    target: container\n    concurrency: 8\n    secrets: []\n' : ''}`;
}

/** Indents a step block to the pipeline body's depth. */
function steps(...lines: string[]): string {
  return lines.join('\n');
}

const seed = `      - generate:
          prompt: classify
          input:
            text: "hello"
          as: items`;

function check(text: string): Diagnostic[] {
  return checkSpecText(text, { file: 'demo.spec.yaml' }).diagnostics;
}

describe('composite step kinds', () => {
  it('accepts all four composite kinds in one pipeline', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - branch:
          when: 'hasRole("admin")'
          then:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: checked
          else:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: checked`,
          `      - parallel:
          branches:
            - - generate:
                  prompt: classify
                  input:
                    text: "{{ items }}"
                  as: left
            - - generate:
                  prompt: classify
                  input:
                    text: "{{ items }}"
                  as: right`,
          `      - map:
          over: items
          as: mapped
          step:
            generate:
              prompt: classify
              input:
                text: "{{ item }}"
              as: one`,
          `      - reduce:
          over: mapped
          prompt: classify
          as: reduced`,
        ),
      ),
    );
    expect(messages(diagnostics)).toEqual([]);
  });

  it('rejects an empty branches list', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - parallel:
          branches: []`,
        ),
      ),
    );
    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.unsupportedStep);
  });

  it('requires map to name the binding it writes', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - map:
          over: items
          step:
            generate:
              prompt: classify
              input:
                text: "{{ item }}"
              as: one`,
        ),
      ),
    );
    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.schemaViolation);
  });

  it('rejects an emit nested inside a composite', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - branch:
          when: 'hasRole("admin")'
          then:
            - emit:
                event: Answer
          else:
            - generate:
                prompt: classify
                as: checked`,
        ),
      ),
    );
    expect(codes(diagnostics)).toContain(DIAGNOSTIC_CODES.nestedEmitStep);
  });
});

describe('step nesting bound', () => {
  /** Wraps `body` in `depth` nested branches, each binding the same name in both arms. */
  function nested(depth: number): string {
    /** Places a multi-line mapping as one sequence item; continuation lines clear the `- `. */
    const item = (text: string, by: number): string => {
      const [first, ...rest] = text.split('\n');
      return [
        `${' '.repeat(by)}- ${first}`,
        ...rest.map((line) => `${' '.repeat(by + 2)}${line}`),
      ].join('\n');
    };
    let inner = `generate:\n  prompt: classify\n  input:\n    text: "{{ items }}"\n  as: leaf`;
    for (let level = 0; level < depth; level += 1) {
      inner = `branch:\n  when: 'isAuthenticated()'\n  then:\n${item(inner, 4)}\n  else:\n${item(inner, 4)}`;
    }
    return item(inner, 6);
  }

  it('accepts exactly the limit', () => {
    const diagnostics = check(specWith(steps(seed, nested(4))));
    expect(codes(diagnostics)).not.toContain(DIAGNOSTIC_CODES.stepNestingTooDeep);
  });

  it('rejects one past the limit, naming the limit', () => {
    const diagnostics = check(specWith(steps(seed, nested(5))));
    const tooDeep = diagnostics.filter(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.stepNestingTooDeep,
    );
    expect(tooDeep.length).toBeGreaterThan(0);
    expect(tooDeep[0]?.message).toContain('limit of 4');
  });
});

describe('fan-out needs a declared cap', () => {
  it('rejects a fan-out with no concurrency anywhere', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - map:
          over: items
          as: mapped
          step:
            generate:
              prompt: classify
              input:
                text: "{{ item }}"
              as: one`,
        ),
        false,
      ),
    );
    const problem = diagnostics.find(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.fanoutWithoutConcurrency,
    );
    expect(problem).toBeDefined();
    expect(problem?.hint).toContain('deployments.api.concurrency');
  });

  it('accepts a fan-out once a deployment declares a cap', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - map:
          over: items
          as: mapped
          step:
            generate:
              prompt: classify
              input:
                text: "{{ item }}"
              as: one`,
        ),
        true,
      ),
    );
    expect(codes(diagnostics)).not.toContain(DIAGNOSTIC_CODES.fanoutWithoutConcurrency);
  });
});

describe('branch arm bindings', () => {
  const asymmetric = steps(
    seed,
    `      - branch:
          when: 'isAuthenticated()'
          then:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: only_then
          else:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: only_else`,
  );

  it('rejects reading a name bound by only one arm, naming both arms', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          asymmetric,
          `      - generate:
          prompt: classify
          input:
            text: "{{ only_then }}"
          as: downstream`,
        ),
      ),
    );
    const problem = diagnostics.filter(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.branchArmBindingMismatch,
    );
    expect(problem).toHaveLength(1);
    expect(problem[0]?.message).toContain("'only_then'");
    expect(problem[0]?.message).toContain("'then'");
    expect(problem[0]?.message).toContain("'else'");
  });

  it('accepts a name both arms bind', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - branch:
          when: 'isAuthenticated()'
          then:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: shared
          else:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: shared`,
          `      - generate:
          prompt: classify
          input:
            text: "{{ shared }}"
          as: downstream`,
        ),
      ),
    );
    expect(codes(diagnostics)).not.toContain(DIAGNOSTIC_CODES.branchArmBindingMismatch);
  });

  it('accepts an asymmetric name nothing downstream reads', () => {
    const diagnostics = check(specWith(asymmetric));
    expect(codes(diagnostics)).not.toContain(DIAGNOSTIC_CODES.branchArmBindingMismatch);
  });

  it('accepts reading the asymmetric name inside the arm that binds it', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - branch:
          when: 'isAuthenticated()'
          then:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: only_then
            - generate:
                prompt: classify
                input:
                  text: "{{ only_then }}"
                as: later_then
          else:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: only_else`,
        ),
      ),
    );
    expect(codes(diagnostics)).not.toContain(DIAGNOSTIC_CODES.branchArmBindingMismatch);
  });
});

describe('parallel bindings', () => {
  it('rejects one name bound by two arms, because the merge order would decide it', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - parallel:
          branches:
            - - generate:
                  prompt: classify
                  input:
                    text: "{{ items }}"
                  as: same
            - - generate:
                  prompt: classify
                  input:
                    text: "{{ items }}"
                  as: same`,
        ),
      ),
    );
    const problem = diagnostics.filter(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.duplicateBinding,
    );
    expect(problem.length).toBeGreaterThan(0);
    expect(problem[0]?.message).toContain("'same'");
  });

  it('keeps a map body binding local to one iteration', () => {
    const diagnostics = check(
      specWith(
        steps(
          seed,
          `      - map:
          over: items
          as: mapped
          step:
            generate:
              prompt: classify
              input:
                text: "{{ item }}"
              as: one`,
          `      - generate:
          prompt: classify
          input:
            text: "{{ items }}"
          as: one`,
        ),
      ),
    );
    // `one` is bound per item inside the map and again at top level: not a duplicate,
    // because the map body's binding never escapes its iteration.
    expect(codes(diagnostics)).not.toContain(DIAGNOSTIC_CODES.duplicateBinding);
  });
});

describe('diagnostic paths', () => {
  it('points at the failing arm', () => {
    const result = checkSpecText(
      specWith(
        steps(
          seed,
          `      - branch:
          when: 'isAuthenticated()'
          then:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: only_then
          else:
            - generate:
                prompt: classify
                input:
                  text: "{{ items }}"
                as: only_else`,
          `      - generate:
          prompt: classify
          input:
            text: "{{ only_then }}"
          as: downstream`,
        ),
      ),
      { file: 'demo.spec.yaml' },
    );
    const problem = result.diagnostics.find(
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.branchArmBindingMismatch,
    );
    expect(problem === undefined ? undefined : formatPath(problem.path)).toBe(
      'pipelines.demo.steps[1].branch.then',
    );
  });
});
