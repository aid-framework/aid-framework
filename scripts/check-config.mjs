/**
 * Validates the repository's non-code corpus: every committed JSON and YAML file
 * must parse.
 *
 * JSON is parsed strictly, so a comment or trailing comma in a config file fails
 * here. Exemptions live in `EXEMPT`; markdown and code files are owned by other
 * linters.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Directories that are generated, vendored, or not part of the repository. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.venv',
  '.ruff_cache',
  '.pytest_cache',
  'node_modules',
  'dist',
  'coverage',
  'htmlcov',
  'bin',
  'obj',
  'target',
  '__pycache__',
]);

/**
 * @typedef {object} ConfigResult
 * @property {string} file
 * @property {string} [skipped]
 * @property {string} [error]
 * @property {string} [hint]
 */

/**
 * Files that are deliberately not parseable as plain config, with the reason.
 *
 * @type {{ matches: (path: string) => boolean, reason: string }[]}
 */
const EXEMPT = [
  { matches: (path) => /(^|\/)tsconfig[^/]*\.json$/.test(path), reason: 'JSONC by specification' },
  { matches: (path) => /(^|\/)pnpm-lock\.yaml$/.test(path), reason: 'generated lockfile' },
  {
    matches: (path) => /(^|\/)fixtures\/invalid\//.test(path),
    reason: 'deliberately malformed test fixture',
  },
];

/**
 * @param {string} directory
 * @returns {Generator<string, void, void>}
 */
function* walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );

  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(full);
      continue;
    }
    if (entry.isFile()) yield full;
  }
}

/**
 * @param {string} absolute
 * @returns {string}
 */
function toRepositoryPath(absolute) {
  return relative(root, absolute).split(sep).join('/');
}

/**
 * @param {string} repositoryPath
 * @param {string} absolute
 * @returns {ConfigResult}
 */
function checkJson(repositoryPath, absolute) {
  const exemption = EXEMPT.find((rule) => rule.matches(repositoryPath));
  if (exemption) return { file: repositoryPath, skipped: exemption.reason };

  const text = readFileSync(absolute, 'utf8');
  try {
    JSON.parse(text);
    return { file: repositoryPath };
  } catch (cause) {
    return {
      file: repositoryPath,
      error: cause instanceof Error ? cause.message : String(cause),
      hint: 'repository JSON config must be strict JSON: no comments, no trailing commas',
    };
  }
}

/**
 * @param {string} repositoryPath
 * @param {string} absolute
 * @returns {ConfigResult}
 */
function checkYaml(repositoryPath, absolute) {
  const exemption = EXEMPT.find((rule) => rule.matches(repositoryPath));
  if (exemption) return { file: repositoryPath, skipped: exemption.reason };

  const text = readFileSync(absolute, 'utf8');
  try {
    // Default `prettyErrors` reports a line and column.
    parseYaml(text);
    return { file: repositoryPath };
  } catch (cause) {
    return {
      file: repositoryPath,
      error: cause instanceof Error ? cause.message : String(cause),
      hint: 'the file must parse as YAML',
    };
  }
}

/** @type {ConfigResult[]} */
const results = [];
/** @type {Set<string>} */
const skipReasons = new Set();
let checked = 0;
let skipped = 0;

for (const absolute of walk(root)) {
  const repositoryPath = toRepositoryPath(absolute);
  const isJson = repositoryPath.endsWith('.json');
  const isYaml = repositoryPath.endsWith('.yml') || repositoryPath.endsWith('.yaml');
  if (!isJson && !isYaml) continue;

  const result = isJson ? checkJson(repositoryPath, absolute) : checkYaml(repositoryPath, absolute);

  if (result.skipped === undefined) {
    checked += 1;
  } else {
    skipped += 1;
    skipReasons.add(result.skipped);
  }

  results.push(result);
}

const failures = results.filter((result) => result.error !== undefined);

for (const failure of failures) {
  process.stderr.write(`${failure.file}: ${failure.error}\n`);
  if (failure.hint !== undefined) process.stderr.write(`    hint: ${failure.hint}\n`);
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} config file(s) failed to parse.\n`);
  process.exit(1);
}

const reasons = skipped > 0 ? ` (${[...skipReasons].join('; ')})` : '';
process.stdout.write(`Checked ${checked} config file(s); ${skipped} exempt${reasons}.\n`);
