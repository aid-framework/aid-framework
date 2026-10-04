import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES = new URL('./fixtures/', import.meta.url);

/** Reads a fixture directory, returning each file's name and full text. */
export function readFixtureDir(kind: 'valid' | 'invalid'): { name: string; text: string }[] {
  const directory = new URL(`${kind}/`, FIXTURES);
  return readdirSync(fileURLToPath(directory))
    .filter((name) => name.endsWith('.yaml'))
    .sort()
    .map((name) => ({ name, text: readFileSync(new URL(name, directory), 'utf8') }));
}

export function readFixture(relativePath: string): string {
  return readFileSync(new URL(relativePath, FIXTURES), 'utf8');
}
