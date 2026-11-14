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
 *
 * docs-claims-file: family; it names the bad codes it refuses as worked examples
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  aidFlags,
  capabilityClaims,
  codeAnnotation,
  commandsNamed,
  DIAGNOSTIC_NAMESPACES,
  diagnosticCodes,
  exactPins,
  fileCodeAnnotation,
  headingSlugs,
  isProposalPage,
  proposalStatus,
  sourceCodeAnnotation,
  targetTokens,
  withoutSourceAnnotations,
} from './docs-claims.mjs';
import { profileClaims, resolveSpecPath, specPathClaims } from './spec-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** @type {{ file: string, line: number, message: string }[]} */
const failures = [];
let claimsChecked = 0;
let linksChecked = 0;
let diagnosticCitations = 0;

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
 * Like `lineContaining`, but returns `undefined` when the text is absent. Used
 * for claims the README is allowed to omit once they no longer hold.
 *
 * @param {string} text
 * @param {string} needle
 * @returns {{ line: number; text: string } | undefined}
 */
function maybeLineContaining(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return undefined;
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

// Build output and vendored trees hold copies of READMEs and generated files,
// not claims about this repository, so they are not part of any surface.
const PRUNED = new Set([
  'node_modules',
  'dist',
  'build',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  // Tool caches. They are not tracked and not shipped, but `pnpm check` creates them next to
  // the tree it lints, so counting them would make a documented file count depend on whether
  // the linter had already run.
  '.mypy_cache',
  '.ruff_cache',
]);

// The same idea for the source walk, plus the build caches it leaves behind.
const SOURCE_PRUNED = new Set([...PRUNED, '.next', '.turbo', 'coverage']);

/**
 * The trees whose comments and string literals cite diagnostics. `examples` and
 * `site` are included because both emit prose-shaped strings that ship.
 */
const SOURCE_ROOTS = ['packages', 'runtimes', 'scripts', 'site', 'examples'];

/** Source, not data: a JSON file has no comments to drift. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.py']);

/**
 * Tests and fixtures name codes they have not registered on purpose — that is what
 * makes them tests of this check. Reading them would make every bad-fixture test a
 * build failure, so they are the one surface exempt by path rather than by marker.
 */
const SOURCE_FIXTURE =
  /(?:^|\/)(?:__tests__|__fixtures__|fixtures|test|tests)\/|\.(?:test|spec)\.[cm]?[jt]s$|(?:^|\/)conftest\.py$/;

/**
 * The command names in the CLI's `COMMANDS` table, or `undefined` when the table
 * cannot be read. Every claim about a command is compared against this list, so
 * the parse lives in one place and a malformed table fails once.
 *
 * @returns {string[] | undefined}
 */
function cliCommands() {
  const mainPath = 'packages/cli/src/main.ts';
  const mainSource = read(mainPath);
  if (mainSource === undefined) return undefined;

  const table = mainSource.match(/export const COMMANDS: readonly Command\[\] = \[([\s\S]*?)\n\];/);
  if (table === null) {
    fail(
      mainPath,
      1,
      'cannot parse the `COMMANDS` table; expected `export const COMMANDS = [...]`',
    );
    return undefined;
  }

  const commands = unique(
    [...(table[1] ?? '').matchAll(/\bname:\s*'([^']+)'/g)].map((match) => match[1] ?? ''),
  );
  if (commands.length === 0) {
    fail(mainPath, 1, 'parsed `COMMANDS` as an empty list; expected at least one command');
    return undefined;
  }
  return commands;
}

/**
 * Every flag the CLI defines, or `undefined` when the definitions cannot be read.
 *
 * Flags are declared either as a `--name` literal in a `usage` string or as a
 * `booleanFlag('name', ...)` / `valueFlag('name', ...)` call, so both spellings
 * are collected. The result is a name set: it resolves a flag the docs use, and
 * it does not care which command owns it.
 *
 * @returns {string[] | undefined}
 */
function cliFlags() {
  const sources = ['packages/cli/src/main.ts', 'packages/cli/src/args.ts'];
  /** @type {Set<string>} */
  const flags = new Set();
  let found = false;

  for (const path of sources) {
    const source = read(path);
    if (source === undefined) continue;
    found = true;
    for (const match of source.matchAll(/--([a-z0-9][a-z0-9-]*)/g)) flags.add(match[1] ?? '');
    for (const match of source.matchAll(/(?:boolean|value)Flag\(\s*'([a-z0-9-]+)'/g)) {
      flags.add(match[1] ?? '');
    }
  }

  if (!found) return undefined;
  flags.delete('');
  return [...flags].sort();
}

/**
 * Every registered target and the capabilities its manifest declares.
 *
 * The generator directories are the registry. `capabilities:` is written either
 * as an inline array or as a spread of a constant declared in the same file, and
 * both spellings are the same claim.
 *
 * @returns {{ targets: string[], capabilities: Map<string, string[]> }}
 */
function generatorCapabilities() {
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
    return { targets: [], capabilities: new Map() };
  }

  /** @type {string[]} */
  const targets = [];
  /** @type {Map<string, string[]>} */
  const capabilities = new Map();

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

    const declaration = manifest.match(/capabilities:\s*\[([\s\S]*?)\]/);
    if (declaration === null) {
      fail(manifestPath, 1, 'cannot parse `capabilities: [...]` from the manifest');
      continue;
    }

    const body = declaration[1] ?? '';
    /** @type {string[]} */
    const declaredCapabilities = [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
    for (const spread of body.matchAll(/\.\.\.([A-Za-z0-9_]+)/g)) {
      const name = spread[1] ?? '';
      const constant = manifest.match(
        new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`),
      );
      if (constant === null) {
        fail(manifestPath, 1, `cannot parse \`${name}\`, which is spread into \`capabilities\``);
        continue;
      }
      declaredCapabilities.push(
        ...[...(constant[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? ''),
      );
    }
    if (declaredCapabilities.length === 0) {
      fail(manifestPath, 1, 'parsed `capabilities` as an empty list; expected at least one entry');
      continue;
    }
    for (const target of declared) capabilities.set(target, unique(declaredCapabilities));
  }

  return { targets, capabilities };
}

const REGISTRY = generatorCapabilities();
const COMMANDS = cliCommands();
const FLAGS = cliFlags();

const readme = read(README);

if (readme !== undefined) {
  // Every implemented command must exist in COMMANDS, and every command in
  // COMMANDS must be described as implemented.
  const commands = COMMANDS;
  if (commands !== undefined) {
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

    const unimplemented = maybeLineContaining(readme, 'not implemented yet');
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
    const cliNode = lineContaining(readme, '5. CLI', README, 'the CLI node in the mermaid diagram');
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

  // Every target named in prose must exist, and every registered target must be
  // named. The generator directories are the registry.
  const targets = REGISTRY.targets;

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
 * The line containing `needle` in `text`, for reporting against a source file
 * that is parsed as data rather than read line by line.
 *
 * @param {string} text
 * @param {string} needle
 * @returns {number}
 */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index < 0 ? 1 : lineAt(text, index);
}

/**
 * Every document the site publishes, read once so each claim check walks the
 * same list.
 *
 * @returns {string[]}
 */
const documents = markdownFiles();

/**
 * Every `aid <command>` in prose is a command the CLI implements.
 *
 * A guide that documents a command the CLI does not have is a promise the tool
 * cannot keep, and it is the shape of drift that a green build hides.
 *
 * A design proposal under `docs/rfcs/` is the one document whose job is to name commands that do
 * not exist yet, so it is exempt from this comparison and from the flag one below -- and held to
 * a different one instead: it must declare its own status, so no reader mistakes it for a
 * description of the shipped CLI.
 */
if (COMMANDS !== undefined) {
  for (const file of documents) {
    const text = read(file);
    if (text === undefined) continue;
    if (isProposalPage(file)) continue;
    for (const claim of commandsNamed(text)) {
      claimsChecked += 1;
      if (!COMMANDS.includes(claim.command)) {
        fail(file, claim.line, `names \`aid ${claim.command}\`, which is not in COMMANDS`);
      }
    }
  }
}

/**
 * Every `aid ... --flag` in prose is a flag the CLI defines.
 *
 * A renamed flag is the quietest kind of drift: the command still exists, so a
 * reader follows the guide, gets a usage error, and blames the tool.
 */
if (FLAGS !== undefined) {
  for (const file of documents) {
    const text = read(file);
    if (text === undefined) continue;
    if (isProposalPage(file)) continue;
    for (const claim of aidFlags(text)) {
      claimsChecked += 1;
      if (!FLAGS.includes(claim.flag)) {
        fail(file, claim.line, `passes \`--${claim.flag}\`, which the CLI does not define`);
      }
    }
  }
}

/**
 * Every proposal page states its status.
 *
 * This is what pays for the two exemptions above. A page is exempt from naming commands the CLI
 * implements only because it says, in its own front table, that it is a draft rather than a
 * description of what ships. Without that row the exemption would be a silent hole, and a
 * proposal read as a promise is exactly the drift the rest of this script exists to catch.
 */
for (const file of documents) {
  if (!isProposalPage(file)) continue;
  const text = read(file);
  if (text === undefined) continue;
  claimsChecked += 1;
  if (proposalStatus(text) === undefined) {
    fail(file, 1, 'is under docs/rfcs/ but declares no `| Status | <draft or proposal> |` row');
  }
}

/**
 * Every `package==x.y.z` in prose is a pin the runtime metadata declares.
 *
 * The dependency is bumped in one file and quoted in another, and the sentence is
 * the copy nobody compiles, so it is the one that goes stale.
 *
 * @returns {Set<string>}
 */
function runtimePins() {
  /** @type {Set<string>} */
  const pins = new Set();
  /** @param {string} directory */
  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!PRUNED.has(entry.name)) walk(next);
      } else if (entry.isFile() && entry.name.endsWith('.toml')) {
        const text = read(next);
        if (text === undefined) continue;
        for (const match of text.matchAll(/\b([a-z][a-z0-9_.-]*==\d+\.\d+\.\d+)\b/g)) {
          pins.add(match[1] ?? '');
        }
      }
    }
  }
  walk('runtimes');
  return pins;
}

const PINS = runtimePins();

for (const file of documents) {
  const text = read(file);
  if (text === undefined) continue;
  for (const claim of exactPins(text)) {
    claimsChecked += 1;
    if (!PINS.has(claim.pin)) {
      fail(file, claim.line, `pins \`${claim.pin}\`, which no runtime manifest declares`);
    }
  }
}

/**
 * Every registry a document names is one the schema admits.
 *
 * The image registry is a closed set because each member has a login the release
 * workflow knows how to write. A doc that invents a fifth id describes a workflow
 * the generator refuses to emit, which is the failure a reader only finds on the
 * first tag.
 */
const SCHEMA_PATH = 'packages/spec/src/schema/spec.schema.json';
const schemaSource = read(SCHEMA_PATH);
/** @type {Set<string>} */
let REGISTRIES = new Set();
if (schemaSource === undefined) {
  fail(SCHEMA_PATH, 1, 'cannot read the spec schema');
} else {
  try {
    const schema = JSON.parse(schemaSource);
    const values = schema?.$defs?.image?.properties?.registry?.enum;
    if (Array.isArray(values)) REGISTRIES = new Set(values);
    else fail(SCHEMA_PATH, 1, 'has no `$defs.image.properties.registry.enum` to compare against');
  } catch (cause) {
    fail(SCHEMA_PATH, 1, `is not JSON: ${String(cause)}`);
  }
}

if (REGISTRIES.size > 0) {
  for (const file of documents) {
    const text = read(file);
    if (text === undefined) continue;
    text.split('\n').forEach((line, index) => {
      const marker = /\bregistry\s*:/.exec(line);
      if (marker === null) return;
      // Only the value is a registry claim; a dotted token before the colon is
      // the path to the field (`deployments[].image.registry`) or a due version.
      const value = line.slice(marker.index + marker[0].length).split('#')[0] ?? '';
      for (const match of value.matchAll(/['"]?([a-z0-9-]+(?:\.[a-z0-9-]+)+)['"]?/g)) {
        const registry = match[1] ?? '';
        claimsChecked += 1;
        if (!REGISTRIES.has(registry)) {
          fail(file, index + 1, `names \`${registry}\` as a registry the schema does not admit`);
        }
      }
    });
  }
}

/**
 * Every operating profile a document names is one the schema admits, and every
 * dotted path in backticks is a field the schema declares.
 *
 * These are the two claims a reader acts on without checking: `profile:` decides
 * which gates apply, and a backticked path is read as "this field exists". Both
 * were written from memory until now -- `observability.feedback.redact` is one
 * level short of the real `observability.feedback.pii.redact`, and a reader who
 * follows it edits a spec the gate then refuses differently than promised.
 *
 * The path rule is deliberately narrow: only backticked tokens whose first segment
 * is a top-level property are claims about the spec, so `app/business/x.py`,
 * `pnpm check` and `resume.token` are never compared against the schema. Map
 * members resolve through `additionalProperties`, so `deployments.api` is valid
 * without the schema naming every customer's deployment.
 */
const schemaObject = (() => {
  if (schemaSource === undefined) return undefined;
  try {
    return JSON.parse(schemaSource);
  } catch (cause) {
    fail(SCHEMA_PATH, 1, `is not JSON: ${String(cause)}`);
    return undefined;
  }
})();

/** @type {Set<string>} */
let PROFILES = new Set();
let TOP_LEVEL = new Set();
if (schemaObject !== undefined) {
  const profileValues = schemaObject?.properties?.profile?.enum;
  if (Array.isArray(profileValues)) PROFILES = new Set(profileValues);
  else fail(SCHEMA_PATH, 1, 'has no `properties.profile.enum` to compare against');
  TOP_LEVEL = new Set(Object.keys(schemaObject.properties ?? {}));
}

let profileClaimsChecked = 0;
let specPathClaimsChecked = 0;
for (const file of documents) {
  // An RFC records what was proposed at a moment in time; it is not a claim about
  // the current spec, so a path it invented is not a documentation defect.
  if (isProposalPage(file)) continue;
  const text = read(file);
  if (text === undefined) continue;

  for (const claim of profileClaims(text)) {
    profileClaimsChecked += 1;
    if (!PROFILES.has(claim.token)) {
      const admitted = [...PROFILES]
        .sort()
        .map((name) => `\`${name}\``)
        .join(' or ');
      fail(
        file,
        claim.line,
        `names \`${claim.token}\` as an operating profile; the schema admits ${admitted}`,
      );
    }
  }

  for (const claim of specPathClaims(text, (name) => TOP_LEVEL.has(name))) {
    specPathClaimsChecked += 1;
    if (schemaObject === undefined) continue;
    const verdict = resolveSpecPath(schemaObject, claim.token);
    if (verdict.ok) continue;
    const owner = verdict.at.split('.').slice(0, -1).join('.');
    const field = verdict.at.split('.').at(-1) ?? verdict.at;
    const where = owner === '' ? 'the document root' : `\`${owner}\``;
    const available =
      verdict.available.length === 0
        ? 'which declares no fields'
        : `whose fields are ${verdict.available.map((key) => `\`${key}\``).join(', ')}`;
    fail(
      file,
      claim.line,
      `cites \`${claim.token}\`, which the spec schema does not admit: \`${field}\` is not a field of ${where}, ${available}`,
    );
  }
}

/**
 * Every object the schema inlines is sectioned in the generated spec reference.
 *
 * `retriever.source`, `metric`'s per-variant fields and the rest of the sub-shapes are
 * written inline under their parent rather than named in `$defs`. The renderer used to stop
 * at `object`, so the page named a field's type and never its keys -- and read `metric`'s
 * const-marker branches as the marker alone, printing "no other keys" for ten variants that
 * each take one to four more. The renderer now walks both idioms; this rule refuses a schema
 * addition the page does not section, so the gap cannot reopen quietly.
 */
const SPEC_REFERENCE = 'docs/reference/spec.md';
const specReference = read(SPEC_REFERENCE);
if (schemaSource !== undefined && specReference !== undefined) {
  try {
    const schema = JSON.parse(schemaSource);
    /** @type {string[]} */
    const inlined = [];
    /** @param {any} owner @param {string} prefix */
    const walkInlined = (owner, prefix) => {
      for (const [key, value] of Object.entries(owner?.properties ?? {})) {
        if (value?.type !== 'object' || value.properties === undefined) continue;
        inlined.push(`${prefix}.${key}`);
        walkInlined(value, `${prefix}.${key}`);
      }
    };
    for (const [name, def] of Object.entries(schema.$defs ?? {})) {
      if (!Array.isArray(def.oneOf)) {
        walkInlined(def, name);
        continue;
      }
      for (const branch of def.oneOf) {
        const keys = Object.keys(branch.properties ?? {});
        const discriminator = keys[0] ?? '';
        const marker = branch.properties?.[discriminator] ?? {};
        // The const-marker idiom keeps the body beside the marker; the single-key idiom
        // nests it under the discriminator.
        const tagged = marker.const !== undefined;
        walkInlined(tagged ? branch : marker, `${name}.${tagged ? marker.const : discriminator}`);
      }
    }
    for (const path of inlined) {
      claimsChecked += 1;
      const heading = new RegExp(`^#{2,} \`${path.replaceAll('.', '\\.')}\`$`, 'm');
      if (!heading.test(specReference)) {
        fail(SPEC_REFERENCE, 1, `has no section for the inlined object \`${path}\``);
      }
    }
  } catch (cause) {
    fail(SPEC_REFERENCE, 1, `could not verify the inlined objects: ${String(cause)}`);
  }
}

/**
 * Every target id in prose is a registered generator, and every capability a
 * sentence attributes to a target is one that target's manifest declares.
 *
 * The target shape is derived from the registry rather than hard-coded, so a
 * target added under a new prefix is covered the day it lands.
 */ const knownTargets = new Set(REGISTRY.targets);
const targetPrefixes = unique(
  REGISTRY.targets.map((target) => target.split('-')[0] ?? '').filter((prefix) => prefix !== ''),
);
const targetShape =
  targetPrefixes.length === 0
    ? undefined
    : new RegExp(`^(?:${targetPrefixes.join('|')})-[a-z0-9]+(?:-[a-z0-9]+)*$`);
const knownCapabilities = new Set([...REGISTRY.capabilities.values()].flat());

for (const file of documents) {
  const text = read(file);
  if (text === undefined) continue;

  if (targetShape !== undefined) {
    for (const claim of targetTokens(text, targetShape)) {
      claimsChecked += 1;
      if (!knownTargets.has(claim.token)) {
        fail(file, claim.line, `names \`${claim.token}\`, which is not a registered target`);
      }
    }
  }

  for (const claim of capabilityClaims(
    text,
    (token) => knownTargets.has(token),
    knownCapabilities,
  )) {
    for (const target of claim.targets) {
      const declared = REGISTRY.capabilities.get(target) ?? [];
      for (const capability of claim.capabilities) {
        claimsChecked += 1;
        if (!declared.includes(capability)) {
          fail(
            file,
            claim.line,
            `says \`${target}\` declares \`${capability}\`, which its manifest does not`,
          );
        }
      }
    }
  }
}

/**
 * The `/features` page's own claims: every link points at a heading that exists,
 * every id is unique so an anchor stays stable, and every command a feature says
 * turns it on is a command the CLI has.
 */
const FEATURES_DATA = 'site/scripts/features-data.mjs';
const featuresSource = read(FEATURES_DATA);

/**
 * The version the released CLI declares, so a `since` marker cannot name a
 * release that has not happened yet. The root manifest is a private workspace
 * with `0.0.0`; every released package shares one stamped version.
 *
 * @returns {string | undefined}
 */
function currentVersion() {
  const manifest = read('packages/cli/package.json');
  if (manifest === undefined) return undefined;
  try {
    const version = JSON.parse(manifest).version;
    return typeof version === 'string' ? version : undefined;
  } catch (cause) {
    fail('packages/cli/package.json', 1, `cannot parse the version: ${String(cause)}`);
    return undefined;
  }
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const CURRENT_VERSION = currentVersion();

if (featuresSource !== undefined) {
  /** @type {Record<string, unknown>} */
  let data;
  try {
    data = await import(pathToFileURL(join(root, FEATURES_DATA)).href);
  } catch (cause) {
    fail(FEATURES_DATA, 1, `cannot import the feature data: ${String(cause)}`);
    data = {};
  }

  /** @type {Map<string, string>} */
  const seenIds = new Map();
  const bands = ['SHIPPED_FEATURES', 'REFUSALS', 'AI_INFRA', 'CLOUD_REFUSALS'];

  for (const band of bands) {
    const list = data[band];
    if (!Array.isArray(list) || list.length === 0) {
      fail(FEATURES_DATA, 1, `\`${band}\` is not a non-empty array`);
      continue;
    }

    for (const entry of list) {
      const label = `\`${band}\` entry \`${entry.id ?? entry.title ?? entry.target ?? '?'}\``;

      if (typeof entry.id === 'string') {
        claimsChecked += 1;
        if (seenIds.has(entry.id)) {
          fail(FEATURES_DATA, 1, `${label} repeats the id \`${entry.id}\``);
        } else {
          seenIds.set(entry.id, band);
        }
      }

      if (typeof entry.href === 'string') {
        claimsChecked += 1;
        const [path, fragment] = entry.href.split('#');
        const target = join('docs', (path ?? '').replace(/^\.\//, ''));
        const repositoryPath = relative(root, target).split(sep).join('/');
        const document = read(repositoryPath);
        if (
          document !== undefined &&
          fragment !== undefined &&
          fragment.length > 0 &&
          !headingSlugs(document).has(fragment)
        ) {
          fail(
            FEATURES_DATA,
            lineOf(featuresSource, `href: '${entry.href}'`),
            `${label} links \`${entry.href}\`, whose fragment names no heading in \`${repositoryPath}\``,
          );
        }
      }

      if (typeof entry.declaredBy === 'string' && COMMANDS !== undefined) {
        for (const match of entry.declaredBy.matchAll(/\baid\s+([a-z][a-z0-9-]*)\b/g)) {
          const command = match[1] ?? '';
          claimsChecked += 1;
          if (!COMMANDS.includes(command)) {
            fail(
              FEATURES_DATA,
              lineOf(featuresSource, `declaredBy: '${entry.declaredBy}'`),
              `${label} says \`aid ${command}\` turns it on, which is not in COMMANDS`,
            );
          }
        }
        if (FLAGS !== undefined) {
          for (const match of entry.declaredBy.matchAll(/--([a-z0-9][a-z0-9-]*)/g)) {
            const flag = match[1] ?? '';
            claimsChecked += 1;
            if (!FLAGS.includes(flag)) {
              fail(
                FEATURES_DATA,
                lineOf(featuresSource, `declaredBy: '${entry.declaredBy}'`),
                `${label} says \`--${flag}\` turns it on, which the CLI does not define`,
              );
            }
          }
        }
      }

      if (typeof entry.since === 'string') {
        claimsChecked += 1;
        if (!/^\d+\.\d+\.\d+$/.test(entry.since)) {
          fail(
            FEATURES_DATA,
            lineOf(featuresSource, `since: '${entry.since}'`),
            `${label} names \`${entry.since}\` as a release, which is not a version`,
          );
        } else if (
          CURRENT_VERSION !== undefined &&
          compareVersions(entry.since, CURRENT_VERSION) > 0
        ) {
          fail(
            FEATURES_DATA,
            lineOf(featuresSource, `since: '${entry.since}'`),
            `${label} says \`${entry.since}\` shipped it, but the project is at \`${CURRENT_VERSION}\``,
          );
        }
      }
    }
  }
}

/**
 * The generated-tree page's counts are measured, not remembered.
 *
 * A hand-maintained count is a claim with no gate behind it: the example grows a
 * test, the table still says the old number, and nothing goes red. Two rows, two
 * independent ways to prove them:
 *
 * - `examples/support-copilot` is committed, so its row is counted from disk and
 *   from the manifest that `aid gen` writes beside it.
 * - the tutorial's tree exists only after following the walkthrough, so its row
 *   is counted from the labelled tree block on the same page. That does not
 *   prove the tree, but it does prove the two claims agree, which is the way a
 *   hand-edited table usually drifts.
 */
const GENERATED_TREE = 'docs/guide/generated-tree.md';
const GENERATED_TREE_EXAMPLE = 'examples/support-copilot';
const generatedTree = read(GENERATED_TREE);

/**
 * @param {string} directory
 * @returns {number}
 */
function countTreeFiles(directory) {
  let total = 0;
  /** @param {string} current */
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(join(root, current), { withFileTypes: true });
    } catch (cause) {
      fail(current, 1, `cannot list \`${current}\`: ${String(cause)}`);
      return;
    }
    for (const entry of entries) {
      const next = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!PRUNED.has(entry.name)) walk(next);
      } else if (entry.isFile()) {
        total += 1;
      }
    }
  }
  walk(directory);
  return total;
}

/**
 * The tutorial's counts, read from the `text` block that lists its tree. A line
 * labelled `generated` or `business` is in the manifest; a line whose label
 * carries a `when` clause describes a file the tutorial does not emit.
 *
 * @param {string} text
 * @returns {{ files: number, managed: number } | undefined}
 */
function labelledTreeCounts(text) {
  const block = /```text\n(app\/[\s\S]*?)```/.exec(text);
  if (block === null || block[1] === undefined) return undefined;
  let files = 0;
  let managed = 0;
  for (const line of block[1].split('\n')) {
    const labelled = /^\s+(\S.*?)\s{2,}(\S.*)$/.exec(line);
    if (labelled === null || labelled[2] === undefined) continue;
    const label = labelled[2];
    if (/\bwhen\b/.test(label)) continue;
    files += 1;
    if (/^(?:generated|business)\b/.test(label)) managed += 1;
  }
  return { files, managed };
}

if (generatedTree !== undefined) {
  const rows = [
    ...generatedTree.matchAll(
      /^\|\s*(?<tree>[^|]+?)\s*\|\s*(?<files>\d+)\s*\|\s*(?<managed>\d+)\s*\|\s*$/gm,
    ),
  ].map((match) => ({
    text: match[0],
    tree: match.groups?.tree ?? '',
    files: Number(match.groups?.files ?? NaN),
    managed: Number(match.groups?.managed ?? NaN),
  }));

  const exampleRow = rows.find((row) => row.tree.includes(`\`${GENERATED_TREE_EXAMPLE}\``));
  if (exampleRow === undefined) {
    fail(GENERATED_TREE, 1, `has no counted row for \`${GENERATED_TREE_EXAMPLE}\``);
  } else {
    const manifest = read(`${GENERATED_TREE_EXAMPLE}/app/aid.manifest.json`);
    /** @type {unknown[]} */
    let entries = [];
    if (manifest === undefined) {
      fail(GENERATED_TREE, 1, `cannot read the manifest of \`${GENERATED_TREE_EXAMPLE}\``);
    } else {
      try {
        const parsed = JSON.parse(manifest);
        if (Array.isArray(parsed?.files)) entries = parsed.files;
        else fail(GENERATED_TREE, 1, `the manifest of \`${GENERATED_TREE_EXAMPLE}\` has no files`);
      } catch (cause) {
        fail(
          GENERATED_TREE,
          1,
          `the manifest of \`${GENERATED_TREE_EXAMPLE}\` is not JSON: ${String(cause)}`,
        );
      }
    }

    const files = countTreeFiles(GENERATED_TREE_EXAMPLE);
    claimsChecked += 1;
    if (exampleRow.files !== files) {
      fail(
        GENERATED_TREE,
        lineOf(generatedTree, exampleRow.text),
        `says \`${GENERATED_TREE_EXAMPLE}\` ships ${exampleRow.files} files; it has ${files}`,
      );
    }

    claimsChecked += 1;
    if (exampleRow.managed !== entries.length) {
      fail(
        GENERATED_TREE,
        lineOf(generatedTree, exampleRow.text),
        `says \`${GENERATED_TREE_EXAMPLE}\` has ${exampleRow.managed} manifest entries; it has ${entries.length}`,
      );
    }
  }

  const tutorialRow = rows.find((row) => !row.tree.includes(`\`${GENERATED_TREE_EXAMPLE}\``));
  const tutorialTree = labelledTreeCounts(generatedTree);
  if (tutorialRow === undefined) {
    fail(GENERATED_TREE, 1, 'has no counted row for the tutorial tree');
  } else if (tutorialTree === undefined) {
    fail(GENERATED_TREE, 1, 'has no labelled `text` block for the tutorial tree');
  } else {
    claimsChecked += 2;
    if (tutorialRow.files !== tutorialTree.files) {
      fail(
        GENERATED_TREE,
        lineOf(generatedTree, tutorialRow.text),
        `says the tutorial ships ${tutorialRow.files} files; its tree block lists ${tutorialTree.files}`,
      );
    }
    if (tutorialRow.managed !== tutorialTree.managed) {
      fail(
        GENERATED_TREE,
        lineOf(generatedTree, tutorialRow.text),
        `says the tutorial has ${tutorialRow.managed} manifest entries; its tree block labels ${tutorialTree.managed}`,
      );
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
        if (!PRUNED.has(entry.name)) walk(next);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(next);
      }
    }
  }

  // `packages/*/README.md` documents install commands and per-target behaviour,
  // so a stale flag there is the same false promise as one in `docs/`.
  for (const directory of ['docs', 'packages', 'runtimes', 'examples']) {
    walk(directory);
  }
  return files;
}

/**
 * Every source file whose comments and strings can cite a diagnostic.
 *
 * @returns {string[]}
 */
function sourceFiles() {
  /** @type {string[]} */
  const files = [];

  /** @param {string} directory */
  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      );
    } catch (cause) {
      fail(directory, 1, `cannot list source directory: ${String(cause)}`);
      return;
    }
    for (const entry of entries) {
      const next = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SOURCE_PRUNED.has(entry.name)) walk(next);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extname(entry.name)) &&
        !SOURCE_FIXTURE.test(next)
      ) {
        files.push(next);
      }
    }
  }

  for (const directory of SOURCE_ROOTS) walk(directory);
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

for (const file of documents) {
  checkRelativeLinks(file);
}

const HOMEPAGE = 'docs/index.md';

/**
 * The homepage prints a spec, and a spec names the language version it is written against.
 *
 * A visitor copies what the homepage shows, so a version the compiler has retired makes the
 * example fail `aid validate` on the first command they run. The page is edited by hand and
 * the version moves with every release, which is why this is a rule rather than a habit: the
 * version shown has to be the newest one the schema admits.
 */
function checkHomepageSpecVersion() {
  const text = read(HOMEPAGE);
  if (text === undefined || schemaSource === undefined) return;

  let latest;
  try {
    const versions = JSON.parse(schemaSource)?.properties?.specVersion?.enum;
    if (!Array.isArray(versions) || versions.length === 0) {
      fail(HOMEPAGE, 1, `cannot read \`properties.specVersion.enum\` from ${SCHEMA_PATH}`);
      return;
    }
    latest = String(versions[versions.length - 1]);
  } catch (cause) {
    fail(HOMEPAGE, 1, `cannot read ${SCHEMA_PATH}: ${String(cause)}`);
    return;
  }

  let shown = 0;
  text.split('\n').forEach((line, index) => {
    const match = /^\s*specVersion:\s*["']?([0-9]+(?:\.[0-9]+)*)["']?\s*$/.exec(line);
    if (match === null) return;
    shown += 1;
    claimsChecked += 1;
    if (match[1] !== latest) {
      fail(
        HOMEPAGE,
        index + 1,
        `shows \`specVersion: "${match[1]}"\`, but the newest version the compiler admits is "${latest}"`,
      );
    }
  });

  if (shown === 0) fail(HOMEPAGE, 1, 'shows no `specVersion`, which no legal spec may omit');
}

checkHomepageSpecVersion();

/**
 * The packages that register diagnostic codes, each exporting one or more
 * `*_DIAGNOSTIC_CODES` objects whose values are the codes themselves.
 *
 * `overlay` is the exception that proves the rule about reading rather than
 * importing: its codes live beside the overlay loader in `overlay.ts`, not in a
 * `diagnostics.ts`, which is why the loader searches any `*_DIAGNOSTIC_CODES`
 * table in the file rather than one exported name.
 */
const DIAGNOSTIC_REGISTRIES = [
  'packages/ir/src/diagnostics.ts',
  'packages/spec/src/diagnostics.ts',
  'packages/spec/src/overlay.ts',
  'packages/cli/src/diagnostics.ts',
  'packages/generator-sdk/src/diagnostics.ts',
];

/**
 * Every registered diagnostic code, mapped to the file that registers it.
 *
 * Read from source rather than imported so the check runs before anything is
 * built, and so a registry that stops parsing is itself a failure instead of
 * silently shrinking the set of legal codes.
 *
 * @returns {Map<string, string>}
 */
function registeredDiagnosticCodes() {
  /** @type {Map<string, string>} */
  const codes = new Map();
  for (const path of DIAGNOSTIC_REGISTRIES) {
    const source = read(path);
    if (source === undefined) continue;
    let tables = 0;
    for (const table of source.matchAll(
      /export const [A-Z0-9_]*DIAGNOSTIC_CODES = \{([\s\S]*?)\n\} as const;/g,
    )) {
      tables += 1;
      for (const code of (table[1] ?? '').matchAll(/'([a-z]+\/[a-z0-9-]+)'/g)) {
        const value = code[1] ?? '';
        if (!DIAGNOSTIC_NAMESPACES.includes(value.slice(0, value.indexOf('/')))) continue;
        codes.set(value, path);
      }
    }
    if (tables === 0)
      fail(path, 1, 'declares no `*_DIAGNOSTIC_CODES` table for this check to read');
  }

  for (const namespace of DIAGNOSTIC_NAMESPACES) {
    if ([...codes.keys()].some((code) => code.startsWith(`${namespace}/`))) continue;
    fail(
      'scripts/check-docs-claims.mjs',
      1,
      `found no registered \`${namespace}/\` diagnostic codes`,
    );
  }
  return codes;
}

/**
 * The number of single-character edits that turn one code into another, used to
 * suggest the nearest registered code for a token that does not resolve.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/**
 * The closest registered codes to a token, preferring the token's own namespace
 * so a misspelt `ir/` code does not suggest a `cli/` one.
 *
 * @param {string} token
 * @param {Iterable<string>} codes
 * @param {number} [limit]
 * @returns {string}
 */
function nearestCodes(token, codes, limit = 3) {
  const namespace = token.slice(0, token.indexOf('/'));
  return [...codes]
    .map((code) => ({
      code,
      distance: editDistance(token, code),
      foreign: code.startsWith(`${namespace}/`) ? 0 : 1,
    }))
    .sort(
      (a, b) => a.distance - b.distance || a.foreign - b.foreign || a.code.localeCompare(b.code),
    )
    .slice(0, limit)
    .map((entry) => `\`${entry.code}\``)
    .join(', ');
}

/**
 * A marker is only a spelling of an exemption if it says why. A bare marker would
 * be a silent allow-list entry with extra steps.
 *
 * @param {string} file
 * @param {number} line
 * @param {{ kind: string, reason: string } | undefined} annotation
 * @param {string} required
 * @returns {boolean}
 */
function annotatedFor(file, line, annotation, required) {
  if (annotation === undefined) return false;
  if (annotation.kind !== required) {
    fail(
      file,
      line,
      `is marked \`docs-claims: ${annotation.kind}\`, but this citation needs \`${required}\``,
    );
    return true;
  }
  if (annotation.reason.length < 12) {
    fail(
      file,
      line,
      `is marked \`docs-claims: ${required}\` without a reason; say why in 12 characters or more`,
    );
    return true;
  }
  return true;
}

/**
 * Every code-shaped token resolves to a registered code, or is marked as something else.
 *
 * One implementation serves both surfaces, because a published page and a source comment
 * make the same claim — "this gate exists" — and drifted in the same way. Only the
 * marker's comment syntax and the tallies differ, so those are parameters.
 *
 * @param {object} options
 * @param {string} options.file
 * @param {{ line: number, token: string, wildcard: boolean }[]} options.citations
 * @param {Map<string, string>} options.registered
 * @param {(line: number) => { kind: string, reason: string } | undefined} options.annotationAt
 * @param {{ family: string, retired: string }} options.markers
 *   how the marker is written on this surface, quoted in the failure message
 * @param {boolean} [options.exempt] a design proposal may name codes it proposes
 * @param {(code: string) => void} [options.onRegistered]
 * @returns {{ claims: number, citations: number }} `claims` counts every citation that
 *   was resolved or excused, `citations` only those named a registered code outright
 */
function resolveDiagnosticCitations({
  file,
  citations,
  registered,
  annotationAt,
  markers,
  exempt = false,
  onRegistered,
}) {
  let claims = 0;
  let confirmed = 0;

  for (const citation of citations) {
    const { token, wildcard } = citation;
    const line = citation.line;
    const annotation = annotationAt(line);

    if (wildcard) {
      const prefix = token.slice(0, -1);
      const family = [...registered.keys()].filter((code) => code.startsWith(prefix));
      if (family.length === 0) {
        fail(
          file,
          line,
          `cites the family \`${token}\`, which covers no registered code; nearest registered: ${nearestCodes(
            `${prefix}x`,
            registered.keys(),
          )}`,
        );
        continue;
      }
      claims += 1;
      if (exempt || annotatedFor(file, line, annotation, 'family')) continue;
      fail(
        file,
        line,
        `cites the wildcard \`${token}\`, which names no registered code on its own (${family.length} codes match, for example \`${family[0]}\`); name the codes or mark the line \`${markers.family}\``,
      );
      continue;
    }

    if (registered.has(token)) {
      onRegistered?.(token);
      claims += 1;
      confirmed += 1;
      continue;
    }

    if (exempt) continue;
    if (annotatedFor(file, line, annotation, 'retired')) {
      claims += 1;
      continue;
    }
    fail(
      file,
      line,
      `cites \`${token}\`, which no diagnostic registry declares; nearest registered: ${nearestCodes(
        token,
        registered.keys(),
      )}. If the code was retired, mark the line \`${markers.retired}\``,
    );
  }

  return { claims, citations: confirmed };
}

/**
 * Every diagnostic code a document cites is a code the build actually registers.
 *
 * This is the class of error the rest of this file could not see. A page naming
 * `ir/eval-coverage` reads exactly like a page naming `ir/eval-uncovered`: both are
 * plausible, one refuses nothing. The registry is the only source of truth for
 * which gates exist, so prose is compared against it rather than trusted.
 *
 * A design proposal under `docs/rfcs/` may name codes it is proposing, so the
 * existing proposal exemption applies here too.
 *
 * @param {Map<string, string>} registered
 * @returns {Set<string>} every code cited somewhere
 */
function checkDiagnosticCodes(registered) {
  /** @type {Set<string>} */
  const cited = new Set();

  for (const file of documents) {
    const text = read(file);
    if (text === undefined) continue;
    const lines = text.split('\n');

    const tally = resolveDiagnosticCitations({
      file,
      citations: diagnosticCodes(text),
      registered,
      annotationAt: (line) => codeAnnotation(lines[line - 1] ?? ''),
      markers: {
        family: '<!-- docs-claims: family; why -->',
        retired: '<!-- docs-claims: retired; why -->',
      },
      exempt: isProposalPage(file),
      onRegistered: (code) => cited.add(code),
    });
    claimsChecked += tally.claims;
    diagnosticCitations += tally.citations;
  }

  return cited;
}

/**
 * Every diagnostic code a source comment or string literal cites is one the build
 * actually registers.
 *
 * The same failure as the page check, one surface further in, and not a hypothetical
 * one: `packages/ir/src/gates/resume.ts` documented a gate under a name no registry
 * declares, and the page check could not see it because the claim was a docstring. The
 * code that emits a diagnostic and the comment describing it are two halves a reader
 * trusts equally, and only one of them was ever checked.
 *
 * Tests and fixtures are exempt by path, because naming an unregistered code is exactly
 * what they exist to do.
 *
 * @param {Map<string, string>} registered
 * @returns {{ citations: number, exemptions: string[] }}
 */
function checkSourceDiagnosticCodes(registered) {
  let citations = 0;
  /** @type {string[]} */
  const exemptions = [];

  for (const file of sourceFiles()) {
    const text = read(file);
    if (text === undefined) continue;

    const fileAnnotation = fileCodeAnnotation(text);
    if (fileAnnotation !== undefined) {
      if (fileAnnotation.reason === '') {
        fail(
          file,
          fileAnnotation.line,
          `carries a \`docs-claims-file\` marker of kind \`${fileAnnotation.kind}\` with no reason; write one, because it is the only thing a reviewer reads`,
        );
        continue;
      }
      exemptions.push(`${file} (${fileAnnotation.kind}: ${fileAnnotation.reason})`);
      continue;
    }

    const lines = text.split('\n');
    const tally = resolveDiagnosticCitations({
      file,
      citations: diagnosticCodes(lines.map(withoutSourceAnnotations).join('\n')),
      registered,
      annotationAt: (line) => sourceCodeAnnotation(lines[line - 1] ?? ''),
      markers: {
        family: '// docs-claims: family; why',
        retired: '// docs-claims: retired; why',
      },
    });
    citations += tally.citations;
  }

  return { citations, exemptions };
}

const registeredDiagnostics = registeredDiagnosticCodes();
const citedDiagnostics = checkDiagnosticCodes(registeredDiagnostics);
const sourceDiagnostics = checkSourceDiagnosticCodes(registeredDiagnostics);

/**
 * Registered codes no document mentions.
 *
 * Reported, never failed: an undocumented code is a gap in the docs, not a broken
 * claim, and failing on it would mean every new diagnostic has to be documented in
 * the same commit as the gate that raises it. The names are printed only when
 * asked for, because the list is long and `pnpm check` output is read by people.
 *
 * @param {Map<string, string>} registered
 * @param {Set<string>} cited
 */
function reportUncitedDiagnostics(registered, cited) {
  /** @type {Map<string, string[]>} */
  const uncited = new Map();
  for (const code of registered.keys()) {
    if (cited.has(code)) continue;
    const namespace = code.slice(0, code.indexOf('/'));
    uncited.set(namespace, [...(uncited.get(namespace) ?? []), code]);
  }
  const total = [...uncited.values()].reduce((sum, list) => sum + list.length, 0);
  if (total === 0) return;

  const verbose = process.argv.includes('--uncited');
  process.stdout.write(
    `\n${total} of ${registered.size} registered diagnostic codes are cited in no document`,
  );
  process.stdout.write(verbose ? ':\n' : ' (pass --uncited for the list):\n');
  for (const [namespace, list] of [...uncited].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!verbose) {
      process.stdout.write(`  ${namespace}: ${list.length}\n`);
      continue;
    }
    process.stdout.write(`  ${namespace}: ${[...list].sort().join(', ')}\n`);
  }
}

if (failures.length > 0) {
  for (const failure of failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    process.stderr.write(`${failure.file}:${failure.line}: ${failure.message}\n`);
  }
  process.stderr.write(`\n${failures.length} documentation claim(s) failed.\n`);
  process.exit(1);
}

reportUncitedDiagnostics(registeredDiagnostics, citedDiagnostics);

const targetCount = `, ${claimsChecked} claim comparisons, ${linksChecked} relative links`;
process.stdout.write(`Docs claims agree with the code${targetCount}.\n`);
process.stdout.write(
  `${diagnosticCitations} diagnostic-code citations resolve to a registered code.\n`,
);
process.stdout.write(
  `${specPathClaimsChecked} spec field-path citations resolve against the schema, and ${profileClaimsChecked} operating-profile names match its enum.\n`,
);
process.stdout.write(
  `${sourceDiagnostics.citations} diagnostic-code citations in source comments and strings resolve to a registered code.\n`,
);
if (sourceDiagnostics.exemptions.length > 0) {
  process.stdout.write(
    `${sourceDiagnostics.exemptions.length} source file(s) opt out of that check, each with a stated reason:\n`,
  );
  for (const exemption of sourceDiagnostics.exemptions) {
    process.stdout.write(`  ${exemption}\n`);
  }
}
