import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { templateSpec } from '../src/templates.js';
import { aid, diagnosticsOf, project, SPEC_PATH } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch(specText?: string) {
  const made = project(specText);
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

describe('aid validate', () => {
  it('accepts the committed example without writing anything', () => {
    const made = scratch();
    const run = aid(made, ['validate']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('ok (0 errors, 0 warnings)');
    expect(made.walk()).toEqual([SPEC_PATH]);
  });

  it('defaults to app/app.spec.yaml and accepts a path instead', () => {
    const made = scratch();
    made.write('elsewhere.spec.yaml', made.read(SPEC_PATH));
    expect(aid(made, ['validate', '--json']).json<{ spec: string }>().spec).toBe(SPEC_PATH);
    expect(
      aid(made, ['validate', 'elsewhere.spec.yaml', '--json']).json<{ spec: string }>().spec,
    ).toBe('elsewhere.spec.yaml');
  });

  it('accepts an absolute path', () => {
    // An absolute path joined onto the working directory is a well-formed path to a file
    // that cannot exist, so the failure it produces ("no such file") is a lie about a file
    // that is right there.
    const made = scratch();
    const absolute = join(made.root, ...SPEC_PATH.split('/'));
    const run = aid(made, ['validate', absolute, '--json']);
    expect(run.code).toBe(0);
    expect(run.json<{ spec: string }>().spec).toBe(absolute);
  });

  it('reports a schema error with its file, line and column', () => {
    const made = scratch('specVersion: "0.1"\n\nproject:\n  name: demo\n  nope: 1\n');
    const run = aid(made, ['validate', '--json']);

    expect(run.code).toBe(1);
    const [first] = diagnosticsOf(run);
    expect(first?.severity).toBe('error');
    expect(first?.file).toBe(SPEC_PATH);
    // The position is the point: a diagnostic a reader cannot act on is a message, not a
    // diagnostic, and the schema violation is on line 5.
    expect(first?.line).toBe(5);
    expect(first?.column).toBeGreaterThan(0);
    expect(run.json<{ counts: { error: number } }>().counts.error).toBeGreaterThan(0);
  });

  it('reports a YAML syntax error rather than cascading', () => {
    const made = scratch('specVersion: "0.1"\nproject: [\n');
    const run = aid(made, ['validate', '--json']);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).length).toBeGreaterThan(0);
  });

  it('reports a missing spec as an unreadable diagnostic, not a crash', () => {
    const made = scratch();
    const run = aid(made, ['validate', 'nope.yaml', '--json']);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/spec-unreadable');
  });

  it('runs the build-time gates, not just the schema', () => {
    // This spec is schema-valid and still fails: the referential gate rejects a pipeline
    // step naming a prompt that does not exist. That is the difference between validating
    // the document and validating the app, and a `validate` that only checked the schema
    // would pass here.
    const made = scratch();
    const broken = made
      .read(SPEC_PATH)
      .replace('prompt: classify_ticket', 'prompt: missing_prompt');
    expect(broken).not.toBe(made.read(SPEC_PATH));
    made.setSpec(broken);

    const run = aid(made, ['validate', '--json']);
    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    expect(run.stdout).toContain('missing_prompt');
  });

  it('refuses a capitalised deferred cloud at the gate that names the deferral', () => {
    // The schema admits `Azure` on purpose, so that the refusal can say what it is. When
    // the pattern refused it, a reader who capitalised a cloud AID has deferred was told
    // `does not match ^[a-z][a-z0-9-]{1,30}$`, which names no cloud, no capability and no
    // fix.
    const made = scratch(templateSpec('enterprise-approvals', 'demo'));
    const capitalised = made.read(SPEC_PATH).replace('cloud: aws', 'cloud: Azure');
    expect(capitalised).not.toBe(made.read(SPEC_PATH));
    made.setSpec(capitalised);

    const run = aid(made, ['validate', '--json']);
    expect(run.code).toBe(1);
    const codes = diagnosticsOf(run).map((diagnostic) => diagnostic.code);
    expect(codes).toContain('ir/cloud-unsupported');
    expect(codes).not.toContain('spec/schema-violation');
  });

  it('offers the lower-case spelling when a served cloud is capitalised', () => {
    const made = scratch(templateSpec('enterprise-approvals', 'demo'));
    made.setSpec(made.read(SPEC_PATH).replace('cloud: aws', 'cloud: AWS'));

    const run = aid(made, ['validate', '--json']);
    expect(run.code).toBe(1);
    const refusal = diagnosticsOf(run).find(
      (diagnostic) => diagnostic.code === 'ir/deploy-target-unknown',
    );
    // Not the capability matrix: this cloud is provisioned and the spelling is the mistake.
    expect(refusal?.hint).toContain('did you mean `aws`?');
  });
});
