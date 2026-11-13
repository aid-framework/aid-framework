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
import { BOUNDARY_CONCERNS, BOUNDARY_TABLE_METADATA } from './boundary-data.mjs';
import { boundaryPage as renderBoundaryPage } from './boundary-page.mjs';
import { closingBracket, emitSeverities } from './diagnostic-severities.mjs';
import {
  AI_INFRA,
  CAPABILITY_AXES,
  CAPABILITY_FAMILIES,
  CLOUD_REFUSALS,
  CLOUD_SERVICES,
  DECLARED_FEATURES,
  REFUSALS,
  SHIPPED_FEATURES,
} from './features-data.mjs';
import { SPEC_VERSION_CORRECTIONS, SPEC_VERSIONS } from './spec-changelog-data.mjs';
import {
  generatorDirectories as listGeneratorDirectories,
  loadSupportData,
} from './support-data.mjs';

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

/**
 * A `| Field | Type | Required | Description |` table for one object's properties.
 *
 * A field that is itself an object of named fields is marked `(fields below)`, because the
 * subsection that documents it follows this table.
 *
 * @param {Record<string, any>} properties
 * @param {Set<string>} required
 * @returns {string[]}
 */
function fieldTable(properties, required) {
  const lines = ['| Field | Type | Required | Description |', '| --- | --- | --- | --- |'];
  for (const [key, value] of Object.entries(properties)) {
    const nested =
      value !== null &&
      typeof value === 'object' &&
      value.type === 'object' &&
      value.properties !== undefined;
    const type = nested ? `${typeLabel(value)} (fields below)` : typeLabel(value);
    lines.push(
      `| \`${key}\` | ${cell(type)} | ${required.has(key) ? 'yes' : 'no'} | ${descriptionCell(value.description)} |`,
    );
  }
  return lines;
}

/** How deep the spec reference follows inlined objects. */
const MAX_NESTING = 3;

/**
 * Adapter limits that are about the wire format, not the provider's API.
 *
 * The `Refuses` line names the capability an adapter leaves out; on its own it reads as a
 * claim about the provider, which is the one thing it is not. Keyed `Adapter.MEMBER`, so a
 * note disappears the moment the adapter starts advertising the capability -- an
 * explanation that outlived its cause would be a second, quieter untruth.
 *
 * Every capability the current adapters omit is one the provider does not serve -- Anthropic
 * publishes no embeddings endpoint -- so no note is needed today. Re-add one beside the
 * capability it explains rather than letting a `Refuses` line about the adapter stand in for a
 * fact about the provider.
 */
const ADAPTER_NOTES = {};

/**
 * Emit a subsection for every field of `owner` that is an object with named fields.
 *
 * The schema inlines these objects instead of naming them in `$defs`, so a table that stopped at
 * `object` left 33 sub-shapes undocumented -- `retriever.chunking`, `model.limits`,
 * `pipeline.trigger.http` and the rest. The heading is the dotted path as written in YAML.
 *
 * @param {any} owner
 * @param {string} prefix
 * @param {number} depth
 * @param {string[]} lines
 */
function emitNested(owner, prefix, depth, lines) {
  if (depth > MAX_NESTING) return;
  const properties = owner?.properties ?? {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;
    if (value.type !== 'object' || value.properties === undefined) continue;
    const path = `${prefix}.${key}`;
    lines.push(`${'#'.repeat(depth + 2)} \`${path}\``);
    lines.push('');
    if (value.description) {
      lines.push(protectBraces(value.description));
      lines.push('');
    }
    if (Object.keys(value.properties).length === 0) {
      lines.push('An object with no named fields.');
      lines.push('');
      continue;
    }
    lines.push(...fieldTable(value.properties, new Set(value.required ?? [])));
    lines.push('');
    emitNested(value, path, depth + 1, lines);
  }
}

/**
 * One form of a `oneOf`, normalised for rendering.
 *
 * Three idioms appear in the schema. The branch's only key names the body
 * (`step.generate`); the first key is a const marker and the remaining keys are the body
 * (`metric.kind = exact` plus `field`); or the branch carries a `title`, which is how a
 * value union is written -- `overridableRule` is `true` or one bounded object, has no
 * discriminating key, and the branch itself is the body.
 *
 * @param {any} branch
 * @param {any} [outer] The def declaring the forms, used to resolve a `true` marker.
 * @returns {{
 *   titled: boolean, tagged: boolean, label: string, path: string, description: string,
 *   properties: Record<string, any>, required: Set<string>, body: any, value?: any,
 * }}
 */
function branchForm(branch, outer) {
  const inner = branch.properties ?? {};
  const keys = Object.keys(inner);
  const discriminator = keys[0];
  const declared = inner[discriminator];
  const marker = declared === true ? (outer?.properties?.[discriminator] ?? {}) : declared;
  if (branch.title !== undefined) {
    const label = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(branch.title)
      ? `\`${branch.title}\``
      : branch.title;
    return {
      titled: true,
      tagged: false,
      label,
      path: `${branch.title}`,
      description: branch.description ?? '',
      properties: inner,
      required: new Set(branch.required ?? []),
      body: branch,
    };
  }
  // Reading an untagged marker's absent `properties` as the body is what reported
  // "no other keys" for every `metric` form, so the marker is only a body when tagged.
  const tagged = marker?.const !== undefined;
  const body = tagged ? branch : (marker ?? {});
  const properties = tagged
    ? Object.fromEntries(Object.entries(inner).filter(([key]) => key !== discriminator))
    : (marker?.properties ?? {});
  const required = new Set(body.required ?? []);
  required.delete(discriminator);
  return {
    titled: false,
    tagged,
    label: tagged ? `\`${discriminator}\` = \`${marker.const}\`` : `\`${discriminator}\``,
    path: `${tagged ? marker.const : discriminator}`,
    description: marker?.description ?? branch.description ?? '',
    properties,
    required,
    body,
    value: marker?.const,
  };
}

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
    // `specVersion` is the one enum whose entries are a release history rather than a value
    // domain: rendering all 24 versions fills a table cell, so the changelog page names them.
    const type = key === 'specVersion' ? '`string`' : typeLabel(value);
    lines.push(`| \`${key}\` | ${cell(type)} | ${descriptionCell(value.description)} |`);
  }
  lines.push('');
  lines.push(
    '`specVersion` must be one of the versions in the [spec version changelog](./spec-changelog.md), which lists what each version adds.',
  );
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
      const forms = def.oneOf.map((branch) => branchForm(branch, def));
      const discriminated = forms.some((form) => !form.titled);
      const article = /^[aeiou]/i.test(name) ? 'An' : 'A';
      lines.push(
        discriminated
          ? `${article} \`${name}\` is exactly one of the ${forms.length} forms below; each form is recognised by its discriminating key.`
          : `${article} \`${name}\` is exactly one of the ${forms.length} forms below.`,
      );
      lines.push('');
      for (const form of forms) {
        lines.push(`### ${form.label}`);
        lines.push('');
        if (form.description) {
          lines.push(protectBraces(form.description));
          lines.push('');
        }
        if (Object.keys(form.properties).length === 0) {
          if (form.tagged) {
            lines.push(
              `Takes the value \`${JSON.stringify(form.value ?? '')}\` and no other keys.`,
            );
            lines.push('');
          } else if (!form.titled) {
            // The one-key form: the branch's single key names the value it holds.
            lines.push(`Takes the single key \`${form.path}\`, holding ${typeLabel(form.body)}.`);
            lines.push('');
          }
          continue;
        }
        lines.push(...fieldTable(form.properties, form.required));
        lines.push('');
        emitNested(form.body, `${name}.${form.path}`, 1, lines);
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
    lines.push(...fieldTable(def.properties, required));
    lines.push('');
    emitNested(def, name, 1, lines);
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

/**
 * The generator packages, read through the support-data reader so both pages discover
 * targets identically.
 */
function generatorDirectories() {
  try {
    return listGeneratorDirectories();
  } catch (cause) {
    failures.push(String(cause instanceof Error ? cause.message : cause));
    return [];
  }
}

/** Registered target ids, discovered the same way the CLI discovers them. */
function targetIds() {
  const root = 'packages/generators';
  const names = generatorDirectories();
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
  // `summary` and `usage` may be wrapped onto their own line once the formatter
  // breaks a long string, and a command may declare `maxPositionals` between
  // `usage` and `flags`; tolerate all three rather than silently dropping such a
  // command from the page.
  const blockPattern =
    /\{\s*\n\s*name: '([^']+)',\s*\n\s*summary:\s*'([^']*)',\s*\n\s*usage:\s*'([^']*)',[\s\S]*?flags: \[([^\]]*)\]/g;

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

  lines.push('## Maturity and versioning');
  lines.push('');
  lines.push(
    'The framework is pre-1.0: a minor release may still change an interface. The spec language is versioned separately, and `specVersion` decides which constructs a spec may use — asking for a construct newer than the declared version is refused with `spec/not-supported`, naming the version that introduced it.',
  );
  lines.push('');
  lines.push(
    'A command, flag or construct that is specified but not built is recorded here as not built rather than implied to work. This page is generated from the `COMMANDS` table and the [features page](../features.md) from the source, so neither can list a capability the compiler does not generate, test and gate.',
  );
  lines.push('');
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
    const directory = generatorDirectories().find((name) => {
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
    // A manifest's `capabilities` array carries comments beside its entries, and an apostrophe
    // in that prose would otherwise pair with an entry's opening quote and capture the words
    // between them as a capability name. Strip line comments first, then refuse anything that
    // is not a capability identifier, so a corrupt parse fails the build instead of publishing
    // a garbage table row.
    const withoutComments = (fragment) => fragment.replace(/\/\/[^\n]*/g, '');
    const quoted = (fragment) =>
      [...withoutComments(fragment).matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
    const capabilities = quoted(text.match(/capabilities:\s*\[([\s\S]*?)\]/)?.[1] ?? '');
    // A manifest may spread a named constant instead of listing capabilities inline.
    const capabilitiesConstant = text.match(/capabilities:\s*\[\.\.\.([A-Z0-9_]+)\]/);
    if (capabilitiesConstant !== null) {
      const constant = capabilitiesConstant[1] ?? '';
      const declared = source.match(
        new RegExp(`export const ${constant} = \\[([\\s\\S]*?)\\] as const;`),
      );
      capabilities.length = 0;
      capabilities.push(...quoted(declared?.[1] ?? ''));
    }
    const capabilities_ = capabilities;
    const malformed = capabilities_.filter((entry) => !/^[a-z][a-z0-9-]*$/.test(entry));
    if (malformed.length > 0) {
      failures.push(
        `parsed a malformed capability from packages/generators/${directory}/src/manifest.ts: ` +
          malformed.map((entry) => JSON.stringify(entry)).join(', '),
      );
    }
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
  lines.push(
    'Azure and Kubernetes are deferred by decision, and deferred means refused: `cloud: azure`, `cloud: kubernetes` or `cloud: k8s` is refused by `ir/cloud-unsupported`, which names the supported set and points here. The schema admits those names on purpose, so the refusal reads as a decision with a fix rather than a mistyped enum entry; a name that is not a cloud at all (`awz`) is `ir/deploy-target-unknown` instead. A cloud enters this table by way of a module set per target, byte-asserted fixtures and `tofu validate` in CI, so the trigger to reopen it is the first customer requirement that cannot be served on `aws` or `gcp` -- not a preference for a different vendor.',
  );
  lines.push('');

  const declaring = Object.entries(data.targetCapabilities);
  const publishing = declaring.filter(([, caps]) => caps.includes('metrics')).map(([id]) => id);
  const silent = declaring.filter(([, caps]) => !caps.includes('metrics')).map(([id]) => id);
  lines.push('## Alerts and the target you choose');
  lines.push('');
  lines.push(
    '`observability.alerts` is the one observability declaration that can be wrong without failing: an alarm over a series nothing records reports no data forever, which reads as healthy. The series it watches are published only by a target whose manifest declares the `metrics` capability, so the compiler checks the pair rather than generating an alarm that can never fire.',
  );
  lines.push('');
  if (silent.length === 0) {
    lines.push(
      `Every registered target declares \`metrics\` (${publishing.map((id) => `\`${id}\``).join(', ')}), so any target may carry an alerts block.`,
    );
  } else {
    lines.push(
      `${publishing.length === 1 ? 'Only' : 'Of the registered targets, only'} ${publishing.map((id) => `\`${id}\``).join(' and ')} ${publishing.length === 1 ? 'publishes' : 'publish'} them, so a document that asks for an alert and generates for ${silent.map((id) => `\`${id}\``).join(' or ')} is refused with \`ir/alerts-unproduced\`, naming the metric and the target that would have written nothing.`,
    );
  }
  lines.push('');
  lines.push(
    "Publishing takes two steps, and declaring the export is only the first: the series appear when the application entrypoint calls `metrics_export_status()`, and the entrypoint is the developer's own file, so no gate can require that call. `aid doctor` reports it as `cli/metrics-uninstalled` instead of leaving an alarm to watch an empty series.",
  );
  lines.push('');

  lines.push('## Spec language');
  lines.push('');
  lines.push(`The current spec language version is \`${latestVersion}\`.`);
  lines.push(
    'A construct that needs a later version is reported as `spec/not-supported`, naming the version it needs, instead of being ignored.',
  );
  lines.push('');

  const floors = data.versionFloors;
  const originalVersion = data.specVersions[0] ?? '';
  // A strategy's floor is the version its gate demands, and the three size cutters
  // are the original surface. A strategy the schema gains without either stops the
  // build instead of rendering a guessed version.
  const CHUNKING_FLOORS = {
    semantic: floors.RETRIEVAL_SEMANTIC_CHUNKING_MIN_VERSION ?? '',
  };
  const ORIGINAL_CHUNKING_STRATEGIES = ['fixed', 'recursive', 'code'];

  lines.push('Retriever chunking strategies are all implemented in both runtimes:');
  lines.push('');
  lines.push('| `chunking.strategy` | Python | TypeScript | Since |');
  lines.push('| --- | --- | --- | --- |');
  for (const strategy of data.chunkingStrategies) {
    const floor = CHUNKING_FLOORS[strategy] ?? originalVersion;
    if (
      CHUNKING_FLOORS[strategy] === undefined &&
      !ORIGINAL_CHUNKING_STRATEGIES.includes(strategy)
    ) {
      throw new Error(
        `chunking strategy \`${strategy}\` has no version floor: name its \`*_MIN_VERSION\` in supportPage()`,
      );
    }
    lines.push(`| \`${strategy}\` | yes | yes | ${floor} |`);
  }
  lines.push('');

  const scheduleFloor = floors.REFRESH_SCHEDULE_MIN_VERSION ?? '';
  lines.push(
    `A retriever the application ingests itself can declare \`refresh.schedule\` since ${scheduleFloor}: a five-field cron read as UTC, which the plan turns into a scheduler rather than a second ingestion path. A retriever bound to a managed knowledge base still refuses \`refresh\` entirely, because the managed engine owns ingestion.`,
  );
  lines.push('');
  lines.push('| `refresh.schedule` | `aws` | `gcp` |');
  lines.push('| --- | --- | --- |');
  lines.push('| Scheduler | `aws_scheduler_schedule` | `google_cloud_scheduler_job` |');
  lines.push('| Run it starts | `aws_batch_job_definition` | `google_cloud_run_v2_job` |');
  lines.push('| Cron dialect | EventBridge `cron(...)`, UTC | five-field cron, `Etc/UTC` |');
  lines.push(
    '| Also required | a `target: batch` deployment that ingests the retriever | the same |',
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
  lines.push(
    'The **Catalog** count is not coverage of the provider. `models[]` requires only `provider` and `modelId`, and `modelId` is an open string, so any id the provider serves can be pinned. A catalog entry exists to supply default `limits` and a verified price: an id with no entry builds from the `limits` and `costProfile` the spec declares, and is refused with `ir/cost-profile-unknown` if an eval declares a budget that cannot be priced. The table is offline and deterministic by design, so it never learns about a model the provider launches until someone verifies its rates by hand.',
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
      for (const axis of no) {
        const note = ADAPTER_NOTES[`${adapter}.${axis.member}`];
        if (note !== undefined) lines.push(`- **Why:** ${note}`);
      }
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

  lines.push('## Declared and gated, not generated');
  lines.push('');
  lines.push(
    'These constructs are in the spec language and a gate enforces them, but no generator emits the behaviour they name, so they are listed apart from the inventory above and are not counted on the homepage. The declaration is what a reviewer reads before an apply; the last bullet is the part still to write.',
  );
  lines.push('');
  for (const feature of DECLARED_FEATURES) {
    const section =
      feature.href.split('#')[0]?.split('/').pop()?.replace(/\.md$/, '') ?? 'reference';
    lines.push(`### ${feature.title}`);
    lines.push('');
    lines.push(`- **Declared by:** \`${feature.declares}\``);
    lines.push(`- **Enforced by:** \`${feature.enforces}\``);
    lines.push(`- **Not yet generated:** ${cell(feature.missing)}`);
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

const DIAGNOSTIC_REGISTRIES = [
  {
    id: 'IR_DIAGNOSTIC_CODES',
    metadata: 'IR_DIAGNOSTIC_METADATA',
    path: 'packages/ir/src/diagnostics.ts',
  },
  {
    id: 'CLI_DIAGNOSTIC_CODES',
    metadata: 'CLI_DIAGNOSTIC_METADATA',
    path: 'packages/cli/src/diagnostics.ts',
  },
];

/** Directories under `packages` that hold built output or other people's code. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.venv', '__pycache__']);

/** Every author-written TypeScript source in `packages`, for the emit-site scan. */
function typescriptSources() {
  /** @type {string[]} */
  const paths = [];
  const walk = (directory) => {
    for (const entry of readdirSync(join(repoRoot, directory), { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(child);
        continue;
      }
      const isSource =
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts');
      if (isSource) paths.push(child);
    }
  };
  walk('packages');
  return paths.map((path) => ({ path, text: readSource(path) }));
}

/**
 * The registries, read from source: every code, and the metadata each published code carries.
 *
 * `codes` holds every registered code, whether or not a page publishes it, because a count a
 * page states -- "the N parse errors it can report" -- is a fact about the registry, not about
 * the subset that has been written up. `published` holds only the codes with metadata.
 *
 * @returns {{ codes: Map<string, { registry: string, key: string }>, published: Map<string, { registry: string, key: string, condition: string, escalation?: string }> }}
 */
function diagnosticRegistries() {
  /** @type {Map<string, { registry: string, key: string }>} */
  const codes = new Map();
  /** @type {Map<string, { registry: string, key: string, condition: string, escalation?: string }>} */
  const published = new Map();
  for (const registry of DIAGNOSTIC_REGISTRIES) {
    const source = readSource(registry.path);
    if (source === '') continue;
    const table = source.match(
      new RegExp(`export const ${registry.id} = \\{([\\s\\S]*?)\\n\\} as const;`),
    );
    if (table === null) {
      failures.push(`${registry.path}: cannot find the ${registry.id} table`);
      continue;
    }
    for (const entry of table[1].matchAll(/(\w+):\s*'([^']+)'/g)) {
      codes.set(entry[2], { registry: registry.id, key: entry[1] });
    }
    const metadataAt = source.indexOf(`export const ${registry.metadata} = {`);
    if (metadataAt === -1) {
      failures.push(`${registry.path}: cannot find the ${registry.metadata} table`);
      continue;
    }
    for (const entry of source.slice(metadataAt).matchAll(/'([a-z-]+\/[a-z0-9-]+)':\s*\{/g)) {
      const code = entry[1];
      const known = codes.get(code);
      if (known === undefined) {
        failures.push(
          `${registry.path}: ${registry.metadata} describes "${code}", which ${registry.id} does not register`,
        );
        continue;
      }
      const open = metadataAt + entry.index + entry[0].length - 1;
      const body = source.slice(open + 1, closingBracket(source, open));
      const condition = body.match(/condition:\s*'([^']*)'/)?.[1];
      if (condition === undefined) {
        failures.push(`${registry.path}: ${code} has no condition, so no page can describe it`);
        continue;
      }
      const escalation = body.match(/escalation:\s*'([^']*)'/)?.[1];
      published.set(code, {
        ...known,
        condition,
        ...(escalation === undefined ? {} : { escalation }),
      });
    }
  }
  return { codes, published };
}

/**
 * The published spec-version constants, so a page can name the version the code gates on
 * without a second copy of the number. Keyed by constant name.
 *
 * @returns {Map<string, string>}
 */
function versionConstants() {
  /** @type {Map<string, string>} */
  const versions = new Map();
  for (const file of typescriptSources()) {
    for (const entry of file.text.matchAll(/export const ([A-Z0-9_]*_VERSION) = '([^']+)'/g)) {
      versions.set(entry[1], entry[2]);
    }
  }
  return versions;
}

/**
 * The boundary page's inputs: the registries, the emit-site severities, and the published
 * constants a row may cite by name. The reading happens here; the decisions live in
 * `boundary-page.mjs`, so a test can drive them with a registry of its own.
 *
 * @returns {Parameters<typeof renderBoundaryPage>[1]}
 */
function boundaryInputs() {
  const registries = diagnosticRegistries();
  const values = new Map();
  for (const [name, version] of versionConstants()) values.set(`const:${name}`, version);
  return {
    concerns: BOUNDARY_CONCERNS,
    metadata: BOUNDARY_TABLE_METADATA,
    codes: registries.codes,
    published: registries.published,
    severities: emitSeverities({
      files: typescriptSources(),
      registries: DIAGNOSTIC_REGISTRIES.map((registry) => registry.id),
      only: new Set(
        [...registries.published.values()].map((meta) => `${meta.registry}.${meta.key}`),
      ),
    }),
    values,
    fail: (/** @type {string} */ message) => failures.push(message),
  };
}

/**
 * `docs/guide/boundary.md` with its table region regenerated.
 *
 * @returns {string}
 */
function boundaryPage() {
  return renderBoundaryPage(
    readFileSync(join(repoRoot, 'docs', 'guide', 'boundary.md'), 'utf8'),
    boundaryInputs(),
  );
}

/**
 * The versions `specVersion` accepts, one row each, with the history that used to crowd the
 * `specVersion` row on the spec reference.
 *
 * @returns {string}
 */
function specChangelogPage() {
  const schema = readJson('packages/spec/src/schema/spec.schema.json');
  if (schema === undefined) return '';

  const versions = schema?.properties?.specVersion?.enum ?? [];
  const current = versions[versions.length - 1] ?? '';
  const lines = [];

  lines.push('# Spec version changelog');
  lines.push('');
  lines.push(
    `A spec declares its language version with \`specVersion\`. The current version is \`${current}\`, and each row below lists what that version adds.`,
  );
  lines.push('');
  for (const [index, correction] of SPEC_VERSION_CORRECTIONS.entries()) {
    if (index > 0) {
      lines.push('>');
    }
    lines.push(`> **${correction.lead}.** ${correction.body}`);
  }
  lines.push('');
  lines.push('| Version | What it adds |');
  lines.push('| --- | --- |');
  // Newest first so the current version is the first row, not something to scroll past every
  // older version to find. `SPEC_VERSIONS` stays ascending to mirror the schema enum.
  for (const entry of [...SPEC_VERSIONS].reverse()) {
    lines.push(`| \`${entry.version}\` | ${cell(entry.adds)} |`);
  }
  lines.push('');
  lines.push(
    'A section or construct that needs a later version is reported as `spec/not-supported` with the version it needs, rather than as an unknown key.',
  );
  lines.push('');
  return lines.join('\n');
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
    'docs/reference/spec-changelog.md',
    withDescription(
      'What each spec language version adds, from the original surface through the current version.',
      specChangelogPage(),
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
  ['docs/guide/boundary.md', attempt(boundaryPage)],
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
