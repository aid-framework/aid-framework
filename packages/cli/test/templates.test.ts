/**
 * The two golden-path templates are specs this repository ships, so `aid init --template`
 * must not become the one command that writes something the gates have never seen. Each
 * template is scaffolded here, then validated and generated in the tree it produced.
 *
 * The last test is the one that matters most: a template that only *validates* can still
 * declare something the target silently drops, so the enterprise template is generated and
 * its agent route checked. `lowerSpec` runs the gates, but the target's own refusals --
 * unmappable metrics, a pipeline step that would need a checkpoint -- only fire in `gen`.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { projectNameFor } from '../src/index.js';
import { TEMPLATE_NAMES, TEMPLATE_SUMMARIES, templateSpec } from '../src/templates.js';
import { aid, diagnosticsOf, emptyProject } from './helpers.js';

const created: ReturnType<typeof emptyProject>[] = [];

function scratch() {
  const made = emptyProject();
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

describe('aid init --template', () => {
  for (const name of TEMPLATE_NAMES) {
    it(`scaffolds ${name} into a project that validates and generates`, () => {
      const made = scratch();
      expect(aid(made, ['init', '.', '--template', name]).code).toBe(0);
      expect(made.exists('app/app.spec.yaml')).toBe(true);
      expect(made.exists('README.md')).toBe(true);

      const spec = made.read('app/app.spec.yaml');
      expect(spec).toContain('specVersion: "0.29"');
      // A template is the base half of the overlay workflow, so it has to declare the
      // contract an overlay is checked against.
      expect(spec).toContain('overridable:');
      // The project name is derived from the directory, not shipped in the template.
      expect(spec).toContain(`name: ${projectNameFor(made.root)}`);

      const validated = aid(made, ['validate', '--json']);
      expect(diagnosticsOf(validated).filter((one) => one.severity === 'error')).toEqual([]);
      expect(validated.code).toBe(0);

      expect(aid(made, ['gen']).code).toBe(0);
      expect(made.exists('app/generated')).toBe(true);
    });
  }

  it('gives each template the profile it is named for', () => {
    expect(templateSpec('support-copilot', 'demo')).toContain('profile: standard');
    expect(templateSpec('enterprise-approvals', 'demo')).toContain('profile: enterprise');
  });

  it('ships the identity, audit and network controls the enterprise profile requires', () => {
    const spec = templateSpec('enterprise-approvals', 'demo');
    for (const control of ['identity:', 'audit:', 'network:', 'approvals:', 'humanInTheLoop:']) {
      expect(spec).toContain(control);
    }
  });

  it('refuses a template it does not ship, and lists the ones it does', () => {
    const made = scratch();
    const run = aid(made, ['init', '.', '--template', 'nope', '--json']);
    expect(run.code).toBe(2);
    const [first] = diagnosticsOf(run);
    expect(first?.code).toBe('cli/init-template-unknown');
    for (const name of TEMPLATE_NAMES) expect(first?.hint).toContain(name);
    expect(made.exists('app/app.spec.yaml')).toBe(false);
  });

  it('refuses --from and --template together rather than picking one', () => {
    const made = scratch();
    const run = aid(made, [
      'init',
      '.',
      '--template',
      'support-copilot',
      '--from',
      'x.yaml',
      '--json',
    ]);
    expect(run.code).toBe(2);
    expect(diagnosticsOf(run)[0]?.code).toBe('cli/init-template-conflict');
    expect(made.exists('app/app.spec.yaml')).toBe(false);
  });

  it('replaces a spec it wrote when asked with --force, and keeps the README', () => {
    const made = scratch();
    aid(made, ['init', '.', '--template', 'support-copilot']);
    const readme = made.read('README.md');
    expect(aid(made, ['init', '.', '--template', 'enterprise-approvals', '--force']).code).toBe(0);
    expect(made.read('app/app.spec.yaml')).toContain('profile: enterprise');
    expect(made.read('README.md')).toBe(readme);
    expect(aid(made, ['validate', '--json']).code).toBe(0);
  });

  it('summarises every shipped template', () => {
    expect(TEMPLATE_SUMMARIES.map((one) => one.name)).toEqual([...TEMPLATE_NAMES]);
    for (const one of TEMPLATE_SUMMARIES) expect(one.summary.length).toBeGreaterThan(20);
  });
});
