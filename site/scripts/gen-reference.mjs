/**
 * Generates the reference pages from the code that actually defines them.
 *
 * Four pages are derived rather than written: the spec reference from the JSON Schema,
 * the CLI reference from the `COMMANDS` table, the target matrix from the generator
 * manifests, and the conformance index from the corpus. A hand-written reference page is
 * a second copy of a fact, and the second copy is the one that goes stale, so these pages
 * are emitted and `--check` fails CI when a committed page no longer matches its source.
 *
 * The parsers read source, not `dist`, so `docs` can be checked in a clean checkout
 * without running `pnpm build`. When a source file cannot be parsed the script exits
 * non-zero instead of emitting a page that quietly describes nothing.
 *
 * Usage:
 *   node scripts/gen-reference.mjs           write the pages
 *   node scripts/gen-reference.mjs --check   fail if the committed pages differ
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AI_INFRA,
  CAPABILITY_AXES,
  CAPABILITY_FAMILIES,
  CLOUD_REFUSALS,
  CLOUD_SERVICES,
  REFUSALS,
  SHIPPED_FEATURES,
} from './features-data.mjs';
import { loadSupportData } from './support-data.mjs';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(siteRoot, '..');
const checkOnly = process.argv.includes('--check');

/** @type {string[]} */
const failures = [];

/**
 * @param {string} repositoryPath
 * @returns {string}
 */
function readSource(repositoryPath) {
  try {
    return readFileSync(join(repoRoot, repositoryPath), 'utf8');
  } catch (cause) {
    failures.push(`cannot read ${repositoryPath}: ${String(cause)}`);
    return '';
  }
}

/**
 * @param {string} repositoryPath
 * @returns {unknown}
 */
function readJson(repositoryPath) {
  const text = readSource(repositoryPath);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch (cause) {
    failures.push(`cannot parse ${repositoryPath}: ${String(cause)}`);
    return undefined;
  }
}

/**
 * Escape the characters that would end a Markdown table cell.
 *
 * @param {string} text
 * @returns {string}
 */
function cell(text) {
  return protectBraces(text)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A description cell that is never empty.
 *
 * markdownlint's table-column-style rule reads `|  |` as a pipe with extra space and fails
 * the page, so an absent description is written as an em dash instead of nothing.
 *
 * @param {string | undefined} text
 * @returns {string}
 */
function descriptionCell(text) {
  return text ? cell(text) : '—';
}

/**
 * Keep literal `{{ }}` out of Vue's interpolation parser.
 *
 * A schema description may contain a placeholder such as `{{variable}}`, and VitePress compiles
 * pages as Vue templates, so an unescaped pair aborts the build. Entities render as the braces
 * themselves while the compiler sees nothing to interpolate.
 *
 * @param {string} text
 * @returns {string}
 */
function protectBraces(text) {
  return text.replace(/\{\{/g, '&#123;&#123;').replace(/\}\}/g, '&#125;&#125;');
}

/**
 * A short, plain-text description of a schema value, for a table cell.
 *
 * @param {any} value
 * @returns {string}
 */
function typeLabel(value) {
  if (value === undefined || value === null) return 'any';
  if (value.$ref !== undefined) return `\`${value.$ref.split('/').pop()}\``;
  if (value.const !== undefined) return `\`${JSON.stringify(value.const)}\``;
  if (Array.isArray(value.enum)) return value.enum.map((entry) => `\`${entry}\``).join(', ');
  if (Array.isArray(value.oneOf)) return `one of ${value.oneOf.length}`;
  if (Array.isArray(value.anyOf)) return 'one of the listed forms';
  if (value.type === 'array') return `array of ${typeLabel(value.items)}`;
  if (Array.isArray(value.type)) return value.type.map((entry) => `\`${entry}\``).join(' or ');
  if (value.type === 'object') {
    return value.additionalProperties && typeof value.additionalProperties === 'object'
      ? `map of ${typeLabel(value.additionalProperties)}`
      : 'object';
  }
  if (value.type !== undefined) return `\`${value.type}\``;
  return 'any';
}

/** @param {string} kind */
function headingId(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const GENERATED_NOTE =
  'This page is generated from the source by `site/scripts/gen-reference.mjs`. Do not edit it by hand: run `pnpm --filter @aid-framework/docs gen` and commit the result.';

// ---------------------------------------------------------------------------
// Spec reference
// ---------------------------------------------------------------------------

/** Top-level keys, in the order the schema declares them. */
function specPage() {
  const schema = readJson('packages/spec/src/schema/spec.schema.json');
  if (schema === undefined) return '';

  const properties = schema.properties ?? {};
  const defs = schema.$defs ?? {};
  const lines = [];

  lines.push('# Spec reference');
  lines.push('');
  lines.push(
    'Every key, type, and constraint below is read from `packages/spec/src/schema/spec.schema.json`, the schema `aid validate` enforces. A `required` column of `yes` means `aid validate` rejects a spec that omits the key.',
  );
  lines.push('');
  lines.push(`Spec schema title: *${cell(schema.title ?? 'untitled')}*.`);
  lines.push('');
  lines.push(
    `**Required at the top level:** ${(schema.required ?? []).map((key) => `\`${key}\``).join(', ')}.`,
  );
  lines.push('');
  lines.push('## Top-level keys');
  lines.push('');
  lines.push('| Key | Type | Description |');
  lines.push('| --- | --- | --- |');
  for (const [key, value] of Object.entries(properties)) {
    lines.push(
      `| \`${key}\` | ${cell(typeLabel(value))} | ${descriptionCell(value.description)} |`,
    );
  }
  lines.push('');

  const order = Object.keys(defs).filter((name) => {
    const def = defs[name];
    return def && (def.properties !== undefined || def.oneOf !== undefined);
  });

  for (const name of order) {
    const def = defs[name];
    lines.push(`## \`${name}\``);
    lines.push('');
    if (def.description) {
      lines.push(protectBraces(def.description));
      lines.push('');
    }

    if (def.oneOf !== undefined) {
      lines.push(
        `A \`${name}\` is exactly one of the ${def.oneOf.length} forms below; each form is recognised by its discriminating key.`,
      );
      lines.push('');
      for (const branch of def.oneOf) {
        const inner = branch.properties ?? {};
        const keys = Object.keys(inner);
        const discriminator = keys[0] ?? 'unknown';
        const body = branch.description ? [protectBraces(branch.description)] : [];
        const innerDef = inner[discriminator] ?? {};
        const formLabel =
          innerDef.const === undefined
            ? `\`${discriminator}\``
            : `\`${discriminator}\` = \`${innerDef.const}\``;
        lines.push(`### ${formLabel}`);
        lines.push('');
        if (innerDef.description) {
          lines.push(protectBraces(innerDef.description));
          lines.push('');
        }
        for (const paragraph of body) {
          lines.push(paragraph);
          lines.push('');
        }
        const bodyProperties = innerDef.properties ?? {};
        const required = new Set(innerDef.required ?? []);
        if (Object.keys(bodyProperties).length === 0) {
          lines.push(
            `Takes the value \`${JSON.stringify(innerDef.const ?? '')}\` and no other keys.`,
          );
          lines.push('');
          continue;
        }
        lines.push('| Field | Type | Required | Description |');
        lines.push('| --- | --- | --- | --- |');
        for (const [key, value] of Object.entries(bodyProperties)) {
          lines.push(
            `| \`${key}\` | ${cell(typeLabel(value))} | ${required.has(key) ? 'yes' : 'no'} | ${descriptionCell(value.description)} |`,
          );
        }
        lines.push('');
      }
      continue;
    }

    const required = new Set(def.required ?? []);
    const entries = Object.entries(def.properties ?? {});
    if (entries.length === 0) {
      lines.push('A string with no additional structure.');
      lines.push('');
      continue;
    }
    lines.push('| Field | Type | Required | Description |');
    lines.push('| --- | --- | --- | --- |');
    for (const [key, value] of entries) {
      lines.push(
        `| \`${key}\` | ${cell(typeLabel(value))} | ${required.has(key) ? 'yes' : 'no'} | ${descriptionCell(value.description)} |`,
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(GENERATED_NOTE);
  lines.push('');
  lines.push(
    'Next: [write a spec](../guide/writing-a-spec.md) or read the [CLI reference](./cli.md).',
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI reference
// ---------------------------------------------------------------------------

/** Registered target ids, discovered the same way the CLI discovers them. */
function targetIds() {
  const root = 'packages/generators';
  let names = [];
  try {
    names = readdirSync(join(repoRoot, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    failures.push(`cannot list ${root}: ${String(cause)}`);
    return [];
  }
  /** @type {string[]} */
  const ids = [];
  for (const name of names) {
    const manifest = readSource(`${root}/${name}/src/manifest.ts`);
    const found = [...manifest.matchAll(/export const [A-Z0-9_]+_TARGET = '([^']+)'/g)].map(
      (match) => match[1] ?? '',
    );
    if (found.length === 0) {
      failures.push(`cannot parse the target id from ${root}/${name}/src/manifest.ts`);
    }
    ids.push(...found);
  }
  return ids;
}

/** The flag constants `main.ts` refers to by name rather than constructs inline. */
function flagConstants() {
  /** @type {Map<string, { name: string, kind: string, value?: string, summary: string }>} */
  const constants = new Map();

  const args = readSource('packages/cli/src/args.ts');
  const json = args.match(
    /export const JSON_FLAG = booleanFlag\(\s*'([^']+)',\s*'([^']*)'\s*,?\s*\)/,
  );
  if (json === null) {
    failures.push('cannot parse `JSON_FLAG` from packages/cli/src/args.ts');
  } else {
    constants.set('JSON_FLAG', {
      name: json[1] ?? '',
      kind: 'boolean',
      summary: json[2] ?? '',
    });
  }

  const main = readSource('packages/cli/src/main.ts');
  const target = main.match(
    /const TARGET_FLAG = valueFlag\(\s*'([^']+)',\s*'([^']+)',\s*`([^`]*)`\s*,?\s*\);/,
  );
  if (target === null) {
    failures.push('cannot parse `TARGET_FLAG` from packages/cli/src/main.ts');
  } else {
    const ids = targetIds();
    constants.set('TARGET_FLAG', {
      name: target[1] ?? '',
      kind: 'value',
      value: target[2] ?? 'value',
      summary: (target[3] ?? '').replace(/\$\{targetNames\(\)\.join\(', '\)\}/g, ids.join(', ')),
    });
  }

  return constants;
}

function cliPage() {
  const main = readSource('packages/cli/src/main.ts');
  if (main.length === 0) return '';

  const table = main.match(/export const COMMANDS: readonly Command\[\] = \[([\s\S]*?)\n\];/);
  if (table === null) {
    failures.push('cannot parse the `COMMANDS` table from packages/cli/src/main.ts');
    return '';
  }

  const constants = flagConstants();
  // `usage` may be wrapped onto its own line, and a command may declare
  // `maxPositionals` between `usage` and `flags`; tolerate both rather than
  // silently dropping such a command from the page.
  const blockPattern =
    /\{\s*\n\s*name: '([^']+)',\s*\n\s*summary: '([^']*)',\s*\n\s*usage:\s*'([^']*)',[\s\S]*?flags: \[([^\]]*)\]/g;

  /** @type {{ name: string, summary: string, usage: string, flags: { label: string, summary: string }[] }[]} */
  const commands = [];
  for (const match of (table[1] ?? '').matchAll(blockPattern)) {
    const [, name = '', summary = '', usage = '', flagsBody = ''] = match;
    /** @type {{ label: string, summary: string }[]} */
    const flags = [];
    const flagPattern =
      /(valueFlag|booleanFlag)\(\s*'([^']+)',\s*(?:'([^']+)',\s*)?'([^']*)'\s*,?\s*\)|\b(TARGET_FLAG|JSON_FLAG)\b/g;
    for (const flagMatch of flagsBody.matchAll(flagPattern)) {
      const constant = flagMatch[5];
      if (constant !== undefined) {
        const resolved = constants.get(constant);
        if (resolved === undefined) {
          failures.push(`cannot resolve the flag constant \`${constant}\` in \`${name}\``);
          continue;
        }
        const label =
          resolved.kind === 'value'
            ? `--${resolved.name} <${resolved.value ?? 'value'}>`
            : `--${resolved.name}`;
        flags.push({ label, summary: resolved.summary });
        continue;
      }
      const [, kind = '', flagName = '', value = '', flagSummary = ''] = flagMatch;
      const label = kind === 'valueFlag' ? `--${flagName} <${value}>` : `--${flagName}`;
      // A table cell cannot hold an unescaped pipe, and a value such as
      // `tofu|cdk` is exactly the shape that needs one. Backslashes go first so
      // an escape the input already contains is not read as escaping the pipe.
      flags.push({
        label: label.replace(/\\/g, '\\\\').replace(/\|/g, '\\|'),
        summary: flagSummary,
      });
    }
    if (flags.length === 0) {
      failures.push(`parsed no flags for the \`${name}\` command; expected at least one`);
    }
    commands.push({ name, summary, usage, flags });
  }

  if (commands.length === 0) {
    failures.push('parsed no commands from the `COMMANDS` table');
    return '';
  }

  // A command whose entry does not match the block pattern would otherwise be
  // dropped from the page without a word, so compare against the table itself.
  const declared = [...(table[1] ?? '').matchAll(/\bname: '([^']+)'/g)].map(
    (match) => match[1] ?? '',
  );
  const parsed = new Set(commands.map((command) => command.name));
  for (const name of declared) {
    if (!parsed.has(name)) {
      failures.push(`cannot parse the \`${name}\` command from the \`COMMANDS\` table`);
    }
  }

  const lines = [];
  lines.push('# CLI reference');
  lines.push('');
  lines.push(
    'The `aid` command, generated from the `COMMANDS` table in `packages/cli/src/main.ts`. The table is also what the parser enforces and what `aid --help` prints, so this page cannot list a flag the CLI does not accept.',
  );
  lines.push('');
  lines.push('```sh');
  lines.push('npx @aid-framework/cli --help');
  lines.push('```');
  lines.push('');
  // Most commands report a finished run, and a single JSON document describes one. The
  // exceptions are the commands that hold the terminal -- a server or a stream -- so the
  // sentence names them from the flags rather than claiming `--json` everywhere and being
  // wrong the moment such a command ships.
  const withoutJson = commands
    .filter((command) => !command.flags.some((flag) => flag.label === '--json'))
    .map((command) => `\`${command.name}\``);
  const jsonSentence =
    withoutJson.length === 0
      ? 'Every command accepts `-h` / `--help` for its own usage, and `--json` for one JSON document on stdout.'
      : `Every command accepts \`-h\` / \`--help\` for its own usage. All except ${withoutJson.join(', ')} accept \`--json\` for one JSON document on stdout; a running server or stream is not a finished run.`;
  lines.push(
    `${jsonSentence} Human-readable text and progress go to stderr, so \`aid validate --json | jq\` needs no filtering.`,
  );
  lines.push('');
  lines.push('## Commands at a glance');
  lines.push('');
  lines.push('| Command | What it does |');
  lines.push('| --- | --- |');
  for (const command of commands) {
    lines.push(`| [\`${command.name}\`](#${headingId(command.name)}) | ${cell(command.summary)} |`);
  }
  lines.push('');

  for (const command of commands) {
    lines.push(`## \`${command.name}\``);
    lines.push('');
    lines.push(cell(command.summary));
    lines.push('');
    lines.push('```sh');
    lines.push(`aid ${command.usage}`);
    lines.push('```');
    lines.push('');
    lines.push('| Option | Description |');
    lines.push('| --- | --- |');
    for (const flag of command.flags) {
      lines.push(`| \`${flag.label}\` | ${cell(flag.summary)} |`);
    }
    lines.push(`| \`-h\`, \`--help\` | print this command's usage |`);
    lines.push('');
  }

  lines.push('## Exit codes');
  lines.push('');
  lines.push(
    'The exit code is the contract CI reads, so the three values are distinct on purpose.',
  );
  lines.push('');
  lines.push('| Code | Meaning |');
  lines.push('| --- | --- |');
  lines.push('| `0` | The project is in the shape the command asked for |');
  lines.push('| `1` | The spec, a gate, the target, or the working tree said no |');
  lines.push('| `2` | The invocation was wrong, or the CLI failed internally |');
  lines.push('');
  lines.push(
    'A red build caused by `1` is fixed in the spec; a red build caused by `2` is fixed in the invocation or is a bug. Collapsing them sends people to the wrong file.',
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(GENERATED_NOTE);
  lines.push('');
  lines.push(
    'Next: [the spec reference](./spec.md) or [getting started](../guide/getting-started.md).',
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Target matrix
// ---------------------------------------------------------------------------

function targetsPage() {
  const ids = targetIds();
  if (ids.length === 0) return '';

  /** @type {{ target: string, name: string, version: string, irRange: string, capabilities: string[], emitsAgainst: Record<string, string>, output: Record<string, string> }[]} */
  const manifests = [];
  for (const id of ids) {
    const directory = readdirSync(join(repoRoot, 'packages/generators'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .find((name) => {
        const source = readSource(`packages/generators/${name}/src/manifest.ts`);
        return source.includes(`= '${id}'`);
      });
    if (directory === undefined) {
      failures.push(`cannot find the generator package that declares \`${id}\``);
      continue;
    }
    const source = readSource(`packages/generators/${directory}/src/manifest.ts`);
    const body = source.match(
      /export const [A-Z0-9_]+_MANIFEST_INPUT: GeneratorManifestInput = \{([\s\S]*?)\n\};/,
    );
    if (body === null) {
      failures.push(`cannot parse the manifest input in packages/generators/${directory}`);
      continue;
    }
    const text = body[1] ?? '';
    const literal = (key) => {
      const found = text.match(new RegExp(`\\b${key}:\\s*'([^']*)'`));
      return found?.[1] ?? '';
    };
    /** `key: 'value'` pairs inside one named object literal. */
    const pairsIn = (key) => {
      const block = text.match(new RegExp(`\\b${key}:\\s*\\{([\\s\\S]*?)\\}`));
      if (block === null) return {};
      return Object.fromEntries(
        [...(block[1] ?? '').matchAll(/(\w+):\s*'([^']*)'/g)].map((match) => [
          match[1] ?? '',
          match[2] ?? '',
        ]),
      );
    };
    const capabilities = [
      ...(text.match(/capabilities:\s*\[([\s\S]*?)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g),
    ].map((match) => match[1] ?? '');
    // A manifest may spread a named constant instead of listing capabilities inline.
    const capabilitiesConstant = text.match(/capabilities:\s*\[\.\.\.([A-Z0-9_]+)\]/);
    if (capabilitiesConstant !== null) {
      const constant = capabilitiesConstant[1] ?? '';
      const declared = source.match(
        new RegExp(`export const ${constant} = \\[([\\s\\S]*?)\\] as const;`),
      );
      capabilities.length = 0;
      capabilities.push(
        ...[...(declared?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? ''),
      );
    }
    const capabilities_ = capabilities;
    // `irRange` is a template literal interpolating `IR_VERSION`, so resolve the constant
    // rather than printing the interpolation.
    const irRangeMatch = text.match(/irRange:\s*`([^`]*)`/);
    const irVersion = readSource('packages/ir/src/shapes.ts').match(
      /export const IR_VERSION = '([^']+)'/,
    )?.[1];
    if (irVersion === undefined) {
      failures.push('cannot parse `IR_VERSION` from packages/ir/src/shapes.ts');
    }
    const irRange = (irRangeMatch?.[1] ?? '').replace(/\$\{IR_VERSION\}/g, irVersion ?? '');
    if (capabilities_.length === 0) {
      failures.push(`parsed no capabilities for \`${id}\``);
    }
    manifests.push({
      target: id,
      name: literal('name'),
      version: literal('version'),
      irRange,
      capabilities: capabilities_,
      emitsAgainst: pairsIn('emitsAgainst'),
      output: pairsIn('output'),
    });
  }

  const all = [...new Set(manifests.flatMap((manifest) => manifest.capabilities))].sort();

  const lines = [];
  lines.push('# Targets');
  lines.push('');
  lines.push(
    "A target is a generator plugin. A spec declares the targets it is for; `aid gen` emits one target at a time. Each row below is read from the generator's own manifest, which a test checks against the declaration the IR capability gate consumes.",
  );
  lines.push('');
  lines.push('## Capability matrix');
  lines.push('');
  lines.push(
    "A declared capability is a promise: there is an emitter for it, the target's runtime implements it, and a committed example exercises it. A capability that is absent is one the generator rejects at plan time rather than silently drops.",
  );
  lines.push('');
  lines.push(
    `| Capability | ${manifests.map((manifest) => `\`${manifest.target}\``).join(' | ')} |`,
  );
  lines.push(`| --- | ${manifests.map(() => '---').join(' | ')} |`);
  for (const capability of all) {
    const marks = manifests.map((manifest) =>
      manifest.capabilities.includes(capability) ? 'yes' : 'no',
    );
    lines.push(`| \`${capability}\` | ${marks.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Manifests');
  lines.push('');
  for (const manifest of manifests) {
    lines.push(`### \`${manifest.target}\``);
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Package | \`${manifest.name}\` |`);
    lines.push(`| Manifest version | \`${manifest.version}\` |`);
    lines.push(`| IR range | \`${manifest.irRange}\` |`);
    lines.push(
      `| Capabilities | ${manifest.capabilities.map((entry) => `\`${entry}\``).join(', ')} |`,
    );
    const emits = Object.entries(manifest.emitsAgainst);
    if (emits.length > 0) {
      lines.push(
        `| Emits against | ${emits.map(([key, value]) => `\`${key}\`: \`${value}\``).join('; ')} |`,
      );
    }
    const outputEntries = manifest.output;
    if (Object.keys(outputEntries).length > 0) {
      lines.push(`| Output root | \`${outputEntries.root ?? ''}\` |`);
      lines.push(
        `| Generated directory | \`${outputEntries.root ?? ''}/${outputEntries.generatedDir ?? ''}\` |`,
      );
      lines.push(
        `| Business directory | \`${outputEntries.root ?? ''}/${outputEntries.businessDir ?? ''}\` |`,
      );
    }
    lines.push('');
  }

  lines.push('## What a declaration does not promise');
  lines.push('');
  lines.push(
    'Each generator also rejects the parts of a declared collection its runtime cannot honour. A target claiming `agents` is not a claim that every agent field is expressible; `aid validate` reports the specific rejection with the field path. The [spec reference](./spec.md) is the full key list.',
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(GENERATED_NOTE);
  lines.push('');
  lines.push('Next: [the spec reference](./spec.md) or [the CLI reference](./cli.md).');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Conformance index
// ---------------------------------------------------------------------------

function conformancePage() {
  const corpus = readJson('conformance/corpus.json');
  if (corpus === undefined || !Array.isArray(corpus.cases)) {
    failures.push('cannot parse `cases` from conformance/corpus.json');
    return '';
  }

  const cases = corpus.cases;
  /** @type {Map<string, { id: string, description: string }[]>} */
  const byOp = new Map();
  for (const entry of cases) {
    const op = entry.op ?? 'unclassified';
    const list = byOp.get(op) ?? [];
    list.push({ id: entry.id ?? '', description: entry.description ?? '' });
    byOp.set(op, list);
  }

  const lines = [];
  lines.push('# Conformance');
  lines.push('');
  lines.push(
    `The conformance corpus is a set of language-neutral behaviours that both runtimes must reproduce. It currently holds **${cases.length} cases** across **${byOp.size} operations**. The list below is generated from \`conformance/corpus.json\`.`,
  );
  lines.push('');
  lines.push(
    'A case names a behaviour, not an implementation: `id` identifies it, `op` selects the operation, `input` is the fixture and `expect` is the observable outcome. Neither runtime is named anywhere in a case, so each runner maps the same fixture onto its own types. Each case is a test in both `runtimes/python` and `runtimes/typescript`; a case that applies to only one runtime carries a `runtimes` scope and a `reason`, and the other runner reports it as `scoped-out` rather than skipping it silently.',
  );
  lines.push('');
  lines.push('## Cases per operation');
  lines.push('');
  lines.push('| Operation | Cases |');
  lines.push('| --- | --- |');
  for (const [op, list] of [...byOp].sort()) {
    lines.push(`| [\`${op}\`](#${headingId(op)}) | ${list.length} |`);
  }
  lines.push('');
  for (const [op, list] of [...byOp].sort()) {
    lines.push(`## \`${op}\` {#${headingId(op)}}`);
    lines.push('');
    for (const entry of list) {
      lines.push(`- \`${entry.id}\` — ${cell(entry.description)}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(GENERATED_NOTE);
  lines.push('');
  lines.push('Next: [the target matrix](./targets.md) or [the eval metrics](./eval-metrics.md).');
  lines.push('');
  // The counts come from the corpus just read, so the description cannot disagree with
  // the page it describes.
  return withDescription(
    `The language-neutral conformance corpus both runtimes must reproduce: ${cases.length} cases across ${byOp.size} operations.`,
    lines.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Write or check
// ---------------------------------------------------------------------------

/**
 * A generated page carries its own description in the file, because the whole file is
 * derived: VitePress reads the frontmatter, and a hand edit to the output would be reverted
 * by the next `gen`. A page with no description falls back to the site tagline, which
 * describes the project rather than the page it is on, and `check-head.mjs` rejects that on
 * every page except the homepage.
 *
 * @param {string} description
 * @param {string} body
 * @returns {string}
 */
// ---------------------------------------------------------------------------
// Support matrix
// ---------------------------------------------------------------------------

/**
 * Providers × clouds × targets, read from the declarations that enforce them.
 *
 * The page exists so the marketing surface can link to a matrix instead of
 * restating one: `SERVED_PROVIDERS` is what the normalize gate accepts, and
 * `CLOUD_TARGETS` is what the infra planner refuses outside of. A hand-written
 * matrix is a second copy that goes stale the day a cloud or provider ships.
 */
function supportPage() {
  const data = loadSupportData();
  const providers = data.providers;
  const clouds = new Map(data.clouds.map((entry) => [entry.cloud, entry.targets]));
  const latestVersion = data.latestSpecVersion;
  const cases = data.corpus.cases;
  const operations = data.corpus.operations;

  const allTargets = [...new Set([...clouds.values()].flat())].sort();
  const generatedTargets = data.targets;

  const lines = [];
  lines.push('# Support');
  lines.push('');
  lines.push(
    'This page is read from the declarations the compiler enforces, not maintained by hand: the provider set is `SERVED_PROVIDERS` (what the normalize gate accepts) and the cloud matrix is `CLOUD_TARGETS` (what the infra planner refuses outside of). If a provider or cloud is missing here, a spec that names it is rejected at plan time rather than quietly generated.',
  );
  lines.push('');

  lines.push('## Model providers');
  lines.push('');
  lines.push(
    `Every provider below is served by ${generatedTargets.map((id) => `\`${id}\``).join(' and ')} and is accepted by the normalize gate.`,
  );
  lines.push('');
  lines.push(`| Provider | Served by |`);
  lines.push('| --- | --- |');
  for (const provider of providers) {
    lines.push(`| \`${provider}\` | ${generatedTargets.map((id) => `\`${id}\``).join(', ')} |`);
  }
  lines.push('');

  lines.push('## Clouds and deployment targets');
  lines.push('');
  lines.push(
    'A `yes` means the infra planner emits a module for that target on that cloud. A dash means it refuses the plan with a named diagnostic; it does not emit unvalidated HCL. Every emitted module is byte-asserted against a committed fixture and validated with `tofu validate` in CI.',
  );
  lines.push('');
  lines.push(`| Target | ${[...clouds.keys()].map((cloud) => `\`${cloud}\``).join(' | ')} |`);
  lines.push(`| --- | ${[...clouds.keys()].map(() => '---').join(' | ')} |`);
  for (const target of allTargets) {
    const cells = [...clouds.values()].map((targets) => (targets.includes(target) ? 'yes' : '—'));
    lines.push(`| \`${target}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push(
    'The emitted infrastructure is OpenTofu. A plan targets one cloud at a time, because two providers in one state is a blast radius rather than a feature.',
  );
  lines.push('');

  lines.push('## Spec language');
  lines.push('');
  lines.push(`The current spec language version is \`${latestVersion}\`.`);
  lines.push(
    'A construct that needs a later version is reported as `spec/not-supported`, naming the version it needs, instead of being ignored.',
  );
  lines.push('');

  lines.push('## Conformance');
  lines.push('');
  lines.push(
    `The corpus holds ${cases} cases over ${operations} operations, run against every target. A case that a target cannot satisfy is a declared capability boundary, not a skipped test.`,
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    'Next: [the generator targets](./targets.md), [the CLI reference](./cli.md), or [the conformance index](./conformance.md).',
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * The marketing surface: what ships, which cloud runs it, and what is refused.
 *
 * The provider and cloud lists come from `loadSupportData()`, so they cannot
 * disagree with the gates. The registries in `features-data.mjs` supply the part
 * no declaration states (the service behind a target, the release that first
 * shipped a feature), and `features-page.test.mjs` holds them to the tree.
 */
function featuresPage() {
  const data = loadSupportData();
  const pageClouds = data.clouds.map((entry) => entry.cloud);
  const targets = [...new Set(data.clouds.flatMap((entry) => entry.targets))];

  const lines = [];
  lines.push('# Features');
  lines.push('');
  lines.push(
    `The provider and cloud lists are read from the declarations the compiler enforces, not maintained by hand. Everything else is a registry that a test holds to those declarations and to the release that first shipped each entry. The spec language is at \`${data.latestSpecVersion}\`.`,
  );
  lines.push('');

  lines.push('## Deployment targets');
  lines.push('');
  lines.push(
    'A deployment names one target, and the generated infrastructure runs it on one cloud. Each bullet names the managed service the emitted OpenTofu configures. A cloud that cannot run the target is a refusal with a named diagnostic, not a target that is still to come.',
  );
  lines.push('');
  for (const target of targets) {
    lines.push(`### \`${target}\``);
    lines.push('');
    for (const cloud of pageClouds) {
      const service = CLOUD_SERVICES[cloud]?.[target];
      if (service !== undefined) {
        lines.push(`- **\`${cloud}\`:** ${cell(service)}`);
        continue;
      }
      const refusal = CLOUD_REFUSALS.find(
        (entry) => entry.cloud === cloud && entry.target === target,
      );
      lines.push(
        refusal === undefined
          ? `- **\`${cloud}\`:** no module — \`${target}\` has no module on ${cloud}.`
          : `- **\`${cloud}\`:** refused with \`${refusal.code}\` — ${cell(refusal.reason)}`,
      );
    }
    lines.push('');
  }

  lines.push('## Model providers');
  lines.push('');
  lines.push(
    "Every provider in `SERVED_PROVIDERS` has a section. The capabilities it advertises are the ones the spec's `capabilities` enum may declare; a spec that names one the adapter does not advertise is refused with `ir/model-capability-missing`, because the provider's API has no such endpoint.",
  );
  lines.push('');
  for (const provider of data.providers) {
    const adapter = data.providerAdapters[provider] ?? '';
    const advertised = data.adapterCapabilities[adapter] ?? [];
    const yes = CAPABILITY_AXES.filter((axis) => advertised.includes(axis.member));
    const no = CAPABILITY_AXES.filter((axis) => !advertised.includes(axis.member));
    const catalog = data.providerCatalog[provider];
    lines.push(`### \`${provider}\``);
    lines.push('');
    lines.push(
      `- **Adapter:** ${adapter === '' ? 'none — no adapter is generated.' : `\`${adapter}\``}`,
    );
    lines.push(
      `- **Advertises:** ${yes.length === 0 ? 'none' : yes.map((axis) => axis.label.toLowerCase()).join(', ')}`,
    );
    if (no.length > 0) {
      lines.push(
        `- **Refuses:** ${no
          .map(
            (axis) =>
              `${axis.label.toLowerCase()} (\`${adapter}\` does not advertise \`${axis.member}\`)`,
          )
          .join(', ')}.`,
      );
    }
    lines.push(
      catalog === undefined
        ? '- **Catalog:** none — no pinned model or cost profile is published for this provider, so the spec must give an explicit `modelId` and the call prices as unknown.'
        : `- **Catalog:** ${catalog.models} model${catalog.models === 1 ? '' : 's'}, ${catalog.priced} priced`,
    );
    lines.push('');
  }

  lines.push('## Cloud AI infrastructure');
  lines.push('');
  lines.push(
    'The generated infrastructure does not only run the service; it grants the service the cloud identity it needs to call a managed model. Where a cloud needs extra configuration to reach its model platform, the module sets that too.',
  );
  lines.push('');
  for (const entry of AI_INFRA) {
    lines.push(`### ${entry.title}`);
    lines.push('');
    lines.push(`- **Declared by:** \`${entry.declares}\``);
    lines.push(`- **Emitted:** ${cell(entry.emits)}`);
    lines.push(`- **Runtime credential:** ${cell(entry.credential)}`);
    lines.push(`- **Since:** \`${entry.since}\``);
    lines.push('');
  }

  lines.push('## Out of the box');
  lines.push('');
  lines.push(
    'Each section is behaviour the generator writes for you, the spec key or command that turns it on, and the release that first shipped it. A construct that needs a later spec version is refused by name rather than ignored.',
  );
  lines.push('');
  for (const feature of SHIPPED_FEATURES) {
    const section =
      feature.href.split('#')[0]?.split('/').pop()?.replace(/\.md$/, '') ?? 'reference';
    lines.push(`### ${feature.title}`);
    lines.push('');
    lines.push(cell(feature.detail));
    lines.push('');
    lines.push(`- **Turned on by:** \`${feature.declaredBy}\``);
    lines.push(`- **Reference:** [${section}](${feature.href})`);
    lines.push(`- **Since:** \`${feature.since}\``);
    lines.push('');
  }

  lines.push('## Refused, on purpose');
  lines.push('');
  lines.push(
    'An absent capability is stated once, here, with the diagnostic that enforces it, instead of being discovered during an apply or debugged in production.',
  );
  lines.push('');
  for (const refusal of REFUSALS) {
    lines.push(`### ${refusal.title}`);
    lines.push('');
    lines.push(cell(refusal.reason));
    lines.push('');
    lines.push(`- **Enforced by:** \`${refusal.code}\``);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push(
    'Next: [the full support matrix](./reference/support.md), [the generator targets](./reference/targets.md), or [the spec reference](./reference/spec.md).',
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Run a page builder, reporting a parse failure as a message instead of a stack trace.
 *
 * A builder that reads the tree throws a sentence naming the declaration that
 * stopped matching. Without this the script dies before it can say which one.
 *
 * @param {() => string} builder
 * @returns {string}
 */
function attempt(builder) {
  try {
    return builder();
  } catch (cause) {
    failures.push(cause instanceof Error ? cause.message : String(cause));
    return '';
  }
}

function withDescription(description, body) {
  return `---\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`;
}

/** The markers the generated capability band lives between on the homepage. */
const HOMEPAGE_BAND_START = '<!-- capability-band:start -->';
const HOMEPAGE_BAND_END = '<!-- capability-band:end -->';

/**
 * The capability band, rendered from `CAPABILITY_FAMILIES`.
 *
 * The band exists to answer one question above the fold -- how much of a service is
 * already written -- without repeating the inventory on `/features`. Every count comes
 * from the registry, so the band cannot claim a family wider than what actually shipped.
 */
function capabilityBand() {
  const registered = new Set([...SHIPPED_FEATURES, ...AI_INFRA].map((entry) => entry.id));
  const lines = [
    '| Capability | Declared by | What it covers | Shipped |',
    '| --- | --- | --- | --- |',
  ];
  for (const family of CAPABILITY_FAMILIES) {
    const shipped = family.featureIds.filter((id) => registered.has(id)).length;
    lines.push(
      `| **[${family.title}](${family.href})** | \`${family.declaredBy}\` | ${family.pitch} | ${shipped} |`,
    );
  }
  return lines.join('\n');
}

/**
 * The homepage with its capability band regenerated.
 *
 * The homepage is hand-written prose, so this is a generated *region* rather than a
 * generated page: only the bytes between the markers are replaced, and the argument
 * around them stays editable. `--check` compares the whole file, so a stale band fails
 * exactly like a stale reference page.
 *
 * @returns {string}
 */
function homepagePage() {
  const existing = readFileSync(join(repoRoot, 'docs', 'index.md'), 'utf8');
  const start = existing.indexOf(HOMEPAGE_BAND_START);
  const end = existing.indexOf(HOMEPAGE_BAND_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'docs/index.md is missing the `capability-band` markers the generated band replaces',
    );
  }
  return (
    `${existing.slice(0, start + HOMEPAGE_BAND_START.length)}\n\n` +
    `${capabilityBand()}\n\n${existing.slice(end)}`
  );
}

/** @type {[string, string][]} */
const pages = [
  [
    'docs/reference/spec.md',
    withDescription(
      'Every spec key, type and constraint, generated from the JSON Schema that aid validate enforces.',
      specPage(),
    ),
  ],
  [
    'docs/reference/cli.md',
    withDescription(
      'The aid command reference, generated from the CLI command table so it cannot list a flag the parser rejects.',
      cliPage(),
    ),
  ],
  [
    'docs/reference/targets.md',
    withDescription(
      'The generator targets and their capability matrix, read from each generator manifest and checked against the IR capability gate.',
      targetsPage(),
    ),
  ],
  [
    'docs/reference/support.md',
    attempt(() =>
      withDescription(
        'The shipped provider, cloud and target matrix, generated from the declarations the compiler enforces.',
        supportPage(),
      ),
    ),
  ],
  [
    'docs/features.md',
    attempt(() =>
      withDescription(
        'What ships out of the box, which cloud runs each deployment target, and what the compiler refuses, with the release that first shipped each feature.',
        featuresPage(),
      ),
    ),
  ],
  // The homepage is prose, so only the region between the capability-band markers is
  // generated; everything else on the page stays hand-written and reviewable.
  ['docs/index.md', attempt(homepagePage)],
  // `conformancePage` applies its own description, because the counts in it are read
  // from the corpus it just parsed.
  ['docs/reference/conformance.md', conformancePage()],
];

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`gen-reference: ${failure}\n`);
  process.stderr.write('\ngen-reference: refusing to emit a page that describes nothing.\n');
  process.exit(1);
}

let drifted = 0;
for (const [repositoryPath, content] of pages) {
  const absolute = join(repoRoot, repositoryPath);
  if (checkOnly) {
    let existing = '';
    try {
      existing = readFileSync(absolute, 'utf8');
    } catch {
      process.stderr.write(`gen-reference: ${repositoryPath} is missing; run \`gen\`\n`);
      drifted += 1;
      continue;
    }
    if (existing !== content) {
      process.stderr.write(
        `gen-reference: ${repositoryPath} differs from its source; run \`gen\` and commit the result\n`,
      );
      drifted += 1;
    }
    continue;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  process.stdout.write(`wrote ${repositoryPath}\n`);
}

if (drifted > 0) {
  process.stderr.write(`\ngen-reference: ${drifted} reference page(s) out of date.\n`);
  process.exit(1);
}

if (checkOnly) {
  process.stdout.write(`Reference pages match their sources (${pages.length} pages).\n`);
}
