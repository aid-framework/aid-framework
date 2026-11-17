import { describe, expect, it } from 'vitest';

import { scaffoldPythonProject, scaffoldTypeScriptProject } from '../src/index.js';
import { first } from './helpers.js';

/** The name each scaffold puts in its own dependency manifest. */
function pythonName(name: string): string {
  const pyproject = first(
    scaffoldPythonProject({ name, runtimeVersion: '0.1.200' }).filter(
      (file) => file.path === 'pyproject.toml',
    ),
  );
  const line = first(pyproject.content.split('\n').filter((row) => row.startsWith('name = ')));
  return line.slice('name = "'.length, -1);
}

function npmName(name: string): string {
  const manifest = first(
    scaffoldTypeScriptProject({ name, runtimeVersion: '0.1.200' }).filter(
      (file) => file.path === 'package.json',
    ),
  );
  return (JSON.parse(manifest.content) as { name: string }).name;
}

describe('a scaffolded project name', () => {
  it('lowercases and hyphenates, because the installers validate it rather than us', () => {
    expect(pythonName('Support_Copilot')).toBe('support-copilot');
    expect(npmName('Support_Copilot')).toBe('support-copilot');
  });

  it('drops a leading or trailing separator instead of leaving an empty segment', () => {
    expect(pythonName('-- Support Desk --')).toBe('support-desk');
    expect(pythonName('-')).toBe('aid-app');
  });

  it('collapses a long run of separators to one hyphen', () => {
    expect(pythonName(`x${' - '.repeat(5_000)}y`)).toBe('x-y');
  });

  it('falls back to a usable name when nothing in the spec survives', () => {
    expect(pythonName('!!!')).toBe('aid-app');
    expect(pythonName('   ')).toBe('aid-app');
    expect(npmName('***')).toBe('aid-app');
  });
});
