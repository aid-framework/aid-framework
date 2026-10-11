import { describe, expect, it } from 'vitest';

import { booleanFlag, parseArguments, valueFlag } from '../src/index.js';

const FLAGS = [
  booleanFlag('dry-run', 'dry run'),
  valueFlag('target', 'name', 'target'),
  valueFlag('suite', 'id', 'suite'),
];

function ok(argv: readonly string[]) {
  const parsed = parseArguments(argv, FLAGS);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.message}`);
  return parsed.args;
}

describe('parseArguments', () => {
  it('collects positionals, booleans and values', () => {
    const args = ok(['spec.yaml', '--dry-run', '--target', 'py-fastapi']);
    expect(args.positionals).toEqual(['spec.yaml']);
    expect([...args.booleans]).toEqual(['dry-run']);
    expect(args.values.get('target')).toBe('py-fastapi');
  });

  it('accepts --flag=value as well as --flag value', () => {
    expect(ok(['--target=py-fastapi']).values.get('target')).toBe('py-fastapi');
    expect(ok(['--suite=a']).values.get('suite')).toBe('a');
  });

  it('takes the next argument as the value even when it looks like a flag', () => {
    // `--suite --json` is a value of `--json`, not a flag: guessing otherwise means a
    // missing argument silently becomes a flag, which is how a typo turns into a behaviour
    // change.
    expect(ok(['--suite', '--json']).values.get('suite')).toBe('--json');
  });

  it('rejects a value for a boolean flag', () => {
    const parsed = parseArguments(['--dry-run=yes'], FLAGS);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain('does not take a value');
  });

  it('rejects an unknown long option', () => {
    const parsed = parseArguments(['--nope'], FLAGS);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain('unknown option `--nope`');
  });

  it('rejects an unknown short option other than -h', () => {
    const parsed = parseArguments(['-x'], FLAGS);
    expect(parsed.ok).toBe(false);
  });

  it('reports a missing value', () => {
    const parsed = parseArguments(['--target'], FLAGS);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain('needs a value');
  });

  it('treats everything after -- as a positional', () => {
    const args = ok(['--dry-run', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['--not-a-flag']);
    expect(args.booleans.has('dry-run')).toBe(true);
  });

  it('recognises -h and --help through one flag', () => {
    expect(ok(['-h']).help).toBe(true);
    expect(ok(['--help']).help).toBe(true);
    expect(ok([]).help).toBe(false);
  });
});
