/**
 * Checks that the repository's prose still matches the code it describes.
 *
 * A documentation site is only as trustworthy as the claims it publishes, so this
 * guard parses the sources of truth (the CLI command table, the generator
 * manifests, `SUPPORTED_STEP_KINDS`, and the conformance corpus) and compares them
 * with the claims in `README.md`, `examples/README.md`, and `docs/**`. It also
 * resolves every relative Markdown link in those files.
 *
 * It reads source, not `dist`, so it works in a clean checkout without
 * `pnpm build`. When an input cannot be read or parsed, it reports that as a
 * failure instead of skipping the claim: a guard that quietly checks nothing is
 * worse than no guard.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** @type {{ file: string, line: number, message: string }[]} */
const failures = [];
let claimsChecked = 0;
let linksChecked = 0;

/**
 * @param {string} file
 * @param {number} line
 * @param {string} message
 */
function fail(file, line, message) {
  failures.push({ file, line, message });
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
 * @returns {string | undefined}
 */
function read(repositoryPath) {
  try {
    return readFileSync(join(root, repositoryPath), 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    fail(repositoryPath, 1, `cannot read input: ${message}`);
    return undefined;
  }
}

/**
 * The 1-based line number of an index into `text`.
 *
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * The single line containing `needle`, or a failure when the claim is absent.
 *
 * Claims are written on one line on purpose: wrapping a list across lines would
 * make the checker guess where the sentence ends.
 *
 * @param {string} text
 * @param {string} needle
 * @param {string} file
 * @param {string} description
 * @returns {{ line: number, text: string } | undefined}
 */
function lineContaining(text, needle, file, description) {
  const index = text.indexOf(needle);
  if (index < 0) {
    fail(file, 1, `cannot find ${description} (expected the text \`${needle}\`)`);
    return undefined;
  }
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return {
    line: lineAt(text, index),
    text: text.slice(start, end < 0 ? text.length : end),
  };
}

/**
 * @param {string} line
 * @returns {string[]}
 */
function backticked(line) {
  return [...line.matchAll(/`([^`\n]+)`/g)].map((match) => (match[1] ?? '').trim());
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values)];
}

/**
 * Compare a prose set with the set the code declares, reporting both directions.
 *
 * @param {string} file
 * @param {number} line
 * @param {string} description
 * @param {string[]} claimed
 * @param {string[]} actual
 */
function compareSets(file, line, description, claimed, actual) {
  claimsChecked += 1;
  const claimedSet = new Set(claimed);
  const actualSet = new Set(actual);
  for (const value of actualSet) {
    if (!claimedSet.has(value)) {
      fail(file, line, `${description} omits \`${value}\` (the code declares it)`);
    }
  }
  for (const value of claimedSet) {
    if (!actualSet.has(value)) {
      fail(file, line, `${description} names \`${value}\`, which the code does not declare`);
    }
  }
}

/**
 * Parse `export const NAME = [ ... ] as const;` from a TypeScript source.
 *
 * @param {string} source
 * @param {string} name
 * @param {string} file
 * @returns {string[] | undefined}
 */
function parseStringArray(source, name, file) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (match === null) {
    fail(file, 1, `cannot parse \`${name}\`; expected \`export const ${name} = [...] as const;\``);
    return undefined;
  }
  const values = [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1] ?? '');
  if (values.length === 0) {
    fail(file, 1, `parsed \`${name}\` as an empty list; expected at least one entry`);
    return undefined;
  }
  return unique(values);
}

/** Words that the prose may use for a small count. */
const NUMBER_WORDS = new Map([
  ['zero', 0],
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
]);

const README = 'README.md';
const EXAMPLES_README = 'examples/README.md';

const readme = read(README);

if (readme !== undefined) {
  // Every implemented command must exist in COMMANDS, and every command in
  // COMMANDS must be described as implemented.
  const mainPath = 'packages/cli/src/main.ts';
  const mainSource = read(mainPath);
  if (mainSource !== undefined) {
    const table = mainSource.match(
      /export const COMMANDS: readonly Command\[\] = \[([\s\S]*?)\n\];/,
    );
    if (table === null) {
      fail(
        mainPath,
        1,
        'cannot parse the `COMMANDS` table; expected `export const COMMANDS = [...]`',
      );
    } else {
      const commands = unique(
        [...(table[1] ?? '').matchAll(/\bname:\s*'([^']+)'/g)].map((match) => match[1] ?? ''),
      );
      if (commands.length === 0) {
        fail(mainPath, 1, 'parsed `COMMANDS` as an empty list; expected at least one command');
      } else {
        const implemented = lineContaining(
          readme,
          'The CLI ships',
          README,
          'the sentence listing implemented CLI commands',
        );
        if (implemented !== undefined) {
          compareSets(
            README,
            implemented.line,
            'the implemented-commands claim',
            unique(backticked(implemented.text)),
            commands,
          );
        }

        const unimplemented = lineContaining(
          readme,
          'not implemented yet',
          README,
          'the sentence listing unimplemented CLI commands',
        );
        if (unimplemented !== undefined) {
          const claimed = unique(backticked(unimplemented.text));
          claimsChecked += 1;
          for (const command of claimed) {
            if (commands.includes(command)) {
              fail(
                README,
                unimplemented.line,
                `\`${command}\` is described as unimplemented but is in COMMANDS`,
              );
            }
          }

          const countWord = unimplemented.text.match(
            /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
          );
          if (countWord === null) {
            fail(
              README,
              unimplemented.line,
              'the unimplemented-commands claim does not state a count; expected a number word',
            );
          } else {
            const claimedCount = NUMBER_WORDS.get((countWord[1] ?? '').toLowerCase());
            if (claimedCount !== claimed.length) {
              fail(
                README,
                unimplemented.line,
                `the unimplemented-commands claim says ${claimedCount} but lists ${claimed.length}`,
              );
            }
          }
        }

        // The mermaid diagram is prose too: it must name the same commands.
        const cliNode = lineContaining(
          readme,
          '5. CLI',
          README,
          'the CLI node in the mermaid diagram',
        );
        if (cliNode !== undefined) {
          const nodeText = cliNode.text.split('<br/>')[1]?.split('"]')[0] ?? '';
          const named = unique(
            nodeText
              .split('·')
              .map((part) => part.trim())
              .filter((part) => part.length > 0),
          );
          compareSets(
            README,
            cliNode.line,
            'the commands named in the mermaid CLI node',
            named,
            commands,
          );
        }
      }
    }
  }

  // Every target named in prose must exist, and every registered target must be
  // named. The generator directories are the registry.
  const generatorsRoot = 'packages/generators';
  /** @type {string[]} */
  let generatorNames = [];
  try {
    generatorNames = readdirSync(join(root, generatorsRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    fail(generatorsRoot, 1, `cannot list generator packages: ${String(cause)}`);
  }

  /** @type {string[]} */
  const targets = [];
  for (const generator of generatorNames) {
    const manifestPath = `${generatorsRoot}/${generator}/src/manifest.ts`;
    const manifest = read(manifestPath);
    if (manifest === undefined) continue;
    const declared = [...manifest.matchAll(/export const [A-Z0-9_]+_TARGET = '([^']+)'/g)].map(
      (match) => match[1] ?? '',
    );
    if (declared.length === 0) {
      fail(
        manifestPath,
        1,
        "cannot parse the target id; expected `export const <NAME>_TARGET = '...'`",
      );
      continue;
    }
    targets.push(...declared);
  }

  if (targets.length > 0) {
    const targetsClaim = lineContaining(readme, '**Targets:**', README, 'the "Targets" claim');
    if (targetsClaim !== undefined) {
      compareSets(
        README,
        targetsClaim.line,
        'the targets claim',
        unique(backticked(targetsClaim.text)),
        unique(targets),
      );
    }

    const generatorNode = lineContaining(
      readme,
      '3. Generator plugins',
      README,
      'the generator-plugins node in the mermaid diagram',
    );
    if (generatorNode !== undefined) {
      const nodeText = generatorNode.text.split('<br/>')[1]?.split('"]')[0] ?? '';
      const named = unique(nodeText.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) ?? []);
      compareSets(
        README,
        generatorNode.line,
        'the targets named in the mermaid generator node',
        named,
        unique(targets),
      );
    }
  }

  // The step kinds in prose are the ones the spec validator implements.
  const validatePath = 'packages/spec/src/validate.ts';
  const validateSource = read(validatePath);
  if (validateSource !== undefined) {
    const supported = parseStringArray(validateSource, 'SUPPORTED_STEP_KINDS', validatePath);
    if (supported !== undefined) {
      const stepKinds = lineContaining(
        readme,
        '**Pipeline step kinds:**',
        README,
        'the "Pipeline step kinds" claim',
      );
      if (stepKinds !== undefined) {
        const named = unique(
          backticked(stepKinds.text).filter((value) => value !== 'DEFERRED_STEP_KINDS'),
        );
        compareSets(README, stepKinds.line, 'the pipeline step-kind claim', named, supported);
      }
    }
  }

  // The conformance count must match the corpus it describes.
  const corpusPath = 'conformance/corpus.json';
  const corpusSource = read(corpusPath);
  if (corpusSource !== undefined) {
    let corpus;
    try {
      corpus = JSON.parse(corpusSource);
    } catch (cause) {
      fail(corpusPath, 1, `cannot parse the corpus: ${String(cause)}`);
    }
    if (corpus !== undefined) {
      const cases = corpus.cases;
      if (!Array.isArray(cases) || cases.length === 0) {
        fail(corpusPath, 1, 'cannot parse the corpus cases; expected a non-empty `cases` array');
      } else {
        const corpusClaim = lineContaining(
          readme,
          '**Conformance corpus:**',
          README,
          'the "Conformance corpus" claim',
        );
        if (corpusClaim !== undefined) {
          claimsChecked += 1;
          const count = corpusClaim.text.match(/\b(\d+)\b/);
          if (count === null) {
            fail(README, corpusClaim.line, 'the conformance claim does not state a case count');
          } else if (Number(count[1]) !== cases.length) {
            fail(
              README,
              corpusClaim.line,
              `the conformance claim says ${count[1]} cases but corpus.json has ${cases.length}`,
            );
          }
        }
      }
    }
  }
}

/**
 * Every Markdown file whose relative links are part of the docs surface.
 *
 * @returns {string[]}
 */
function markdownFiles() {
  const files = [];
  for (const required of [README, EXAMPLES_README]) {
    if (read(required) !== undefined) files.push(required);
  }

  /** @param {string} directory */
  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
    } catch (cause) {
      fail(directory, 1, `cannot list documentation directory: ${String(cause)}`);
      return;
    }
    for (const entry of entries) {
      const next = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(next);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(next);
      }
    }
  }

  walk('docs');
  return files;
}

/**
 * @param {string} file
 */
function checkRelativeLinks(file) {
  const text = read(file);
  if (text === undefined) return;

  const absolute = join(root, file);
  let inFence = false;
  let found = 0;

  text.split('\n').forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    // A link inside an inline code span is an example, not a claim.
    const line = raw.replace(/`[^`]*`/g, '');
    const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    for (const match of line.matchAll(pattern)) {
      let destination = (match[1] ?? '').trim();
      if (destination.startsWith('<') && destination.endsWith('>')) {
        destination = destination.slice(1, -1);
      }
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(destination)) continue;

      const pathPart = (destination.split('#')[0] ?? '').split('?')[0] ?? '';
      if (pathPart.length === 0) continue;

      let decoded = pathPart;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        // Keep the raw spelling; the resolution failure will report it.
      }

      const resolved = decoded.startsWith('/')
        ? join(root, decoded)
        : resolve(dirname(absolute), decoded);

      found += 1;
      linksChecked += 1;
      try {
        statSync(resolved);
      } catch {
        fail(
          file,
          index + 1,
          `relative link \`${destination}\` does not resolve (looked for ${toRepositoryPath(resolved)})`,
        );
      }
    }
  });

  // The two index pages are expected to link into the repository. A docs page
  // may legitimately have no relative links, so only the index pages fail here.
  if (found === 0 && (file === README || file === EXAMPLES_README)) {
    fail(
      file,
      1,
      'no relative Markdown links found; expected the index page to link into the repository',
    );
  }
}

for (const file of markdownFiles()) {
  checkRelativeLinks(file);
}

if (failures.length > 0) {
  for (const failure of failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    process.stderr.write(`${failure.file}:${failure.line}: ${failure.message}\n`);
  }
  process.stderr.write(`\n${failures.length} documentation claim(s) failed.\n`);
  process.exit(1);
}

const targetCount = `, ${claimsChecked} claim comparisons, ${linksChecked} relative links`;
process.stdout.write(`Docs claims agree with the code${targetCount}.\n`);
