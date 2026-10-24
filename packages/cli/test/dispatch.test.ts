import { afterAll, describe, expect, it } from 'vitest';

import { aid, diagnosticsOf, project } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

function scratch(specText?: string) {
  const made = project(specText);
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

describe('dispatch', () => {
  it('prints the command list and exits 2 when asked for nothing', () => {
    const run = aid(scratch(), []);
    expect(run.code).toBe(2);
    expect(run.stdout).toContain('Usage: aid <command>');
    expect(run.stdout).toContain('init');
    // The listing goes to stdout: a caller redirecting `aid 2>/dev/null` still gets it,
    // and the ingest row is asserted with its summary because the pre-L4 CLI mentioned
    // the word `ingest` in its unknown-command error and nothing else.
    expect(run.stderr).toBe('');
    expect(run.stdout).toMatch(/^\s*ingest\s{2,}index a retriever corpus/m);
  });

  it('exits 0 when help was asked for explicitly', () => {
    const run = aid(scratch(), ['--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: aid <command>');
  });

  it('rejects an unknown command with exit 2', () => {
    const run = aid(scratch(), ['frobnicate']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown command `frobnicate`');
  });

  it('exits 0 for a command help request and lists only that command', () => {
    const run = aid(scratch(), ['gen', '--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: aid gen');
    expect(run.stdout).toContain('--dry-run');
    expect(run.stdout).not.toContain('Usage: aid <command>');
  });

  it('rejects an unknown option with exit 2 and the command usage', () => {
    const run = aid(scratch(), ['gen', '--nope']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown option `--nope`');
    expect(run.stderr).toContain('Usage: aid gen');
  });

  it('rejects more than one path with exit 2', () => {
    const run = aid(scratch(), ['gen', 'a.yaml', 'b.yaml']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('at most one path');
  });

  it('rejects an unknown target with exit 2 and a hint naming the known ones', () => {
    const run = aid(scratch(), ['gen', '--target', 'nope', '--json']);
    expect(run.code).toBe(2);
    const [diagnostic] = diagnosticsOf(run);
    expect(diagnostic?.code).toBe('cli/unknown-target');
    // The named target goes in the hint, which is the line `formatDiagnostic` renders
    // directly under the message; a caller reading the terminal sees both.
    expect(diagnostic?.hint).toContain('py-fastapi');
  });

  it('puts exactly one JSON document on stdout, with diagnostics on stderr too', () => {
    const run = aid(scratch(), ['validate', 'missing.yaml', '--json']);
    expect(run.code).toBe(1);
    expect(() => run.json()).not.toThrow();
    // stdout is one document and nothing else, so `aid ... --json | jq` is always well
    // formed, while a human watching the terminal still sees the diagnostic.
    expect(run.stderr).toContain('cli/spec-unreadable');
    expect(run.json<{ ok: boolean }>().ok).toBe(false);
  });

  it('names the command in every JSON report', () => {
    const made = scratch();
    for (const command of ['validate', 'gen']) {
      expect(aid(made, [command, '--json']).json<{ command: string }>().command).toBe(command);
    }
  });
});
