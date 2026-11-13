/**
 * Holds `/features` to the tree it describes.
 *
 * The page is generated, so the bands that come from `loadSupportData()` cannot drift. What
 * can drift is everything the tree does not declare: the managed service behind a target,
 * the release that first shipped a feature, the spec key that turns it on, and the
 * diagnostic named beside a refusal. Each of those is a claim a reader makes a decision on,
 * so each is asserted here against the declaration that would have to change with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
import { currentVersion } from './site-version.mjs';
import { loadSupportData, repoRoot } from './support-data.mjs';

const data = loadSupportData();
const page = readFileSync(join(repoRoot, 'docs', 'features.md'), 'utf8');
const homepage = readFileSync(join(repoRoot, 'docs', 'index.md'), 'utf8');
const config = readFileSync(join(repoRoot, 'site', '.vitepress', 'config.mts'), 'utf8');

/**
 * @param {string} repositoryPath
 * @returns {string}
 */
function read(repositoryPath) {
  return readFileSync(join(repoRoot, ...repositoryPath.split('/')), 'utf8');
}

/**
 * The id VitePress gives a heading, so a fragment can be checked without a build.
 *
 * @param {string} heading
 * @returns {string}
 */
function headingId(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Every id a page exposes: the slugs of its headings plus any explicit `{#id}`.
 *
 * @param {string} markdown
 * @returns {Set<string>}
 */
function anchorIds(markdown) {
  const ids = new Set();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1] ?? '';
    const explicit = /\{#([^}]+)\}/.exec(heading);
    ids.add(
      explicit === null ? headingId(heading.replace(/\{#[^}]+\}/g, '')) : (explicit[1] ?? ''),
    );
    if (explicit === null) continue;
    ids.add(headingId(heading.replace(/\{#[^}]+\}/g, '')));
  }
  return ids;
}

/**
 * @param {string} version
 * @returns {number[]}
 */
function versionTuple(version) {
  return version.split('.').map((part) => Number(part));
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} true when `a` is not newer than `b`
 */
function atOrBefore(a, b) {
  const left = versionTuple(a);
  const right = versionTuple(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? 0;
    const other = right[index] ?? 0;
    if (one !== other) return one < other;
  }
  return true;
}

/**
 * Names a page declares, in the form the compiler compares them by.
 *
 * @returns {Set<string>} every property name, enum value and `const` the schema defines
 */
function schemaVocabulary() {
  const schema = /** @type {any} */ (JSON.parse(read('packages/spec/src/schema/spec.schema.json')));
  const vocabulary = new Set();
  /** @param {unknown} node */
  function walk(node) {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const name of Object.keys(value)) vocabulary.add(name);
      }
      if (key === 'enum' && Array.isArray(value)) {
        for (const entry of value) if (typeof entry === 'string') vocabulary.add(entry);
      }
      if (key === 'const' && typeof value === 'string') vocabulary.add(value);
      walk(value);
    }
  }
  walk(schema);
  return vocabulary;
}

describe('the features page data', () => {
  it('renders every provider row the normalize gate accepts', () => {
    const section = page.slice(
      page.indexOf('## Model providers'),
      page.indexOf('## Cloud AI infrastructure'),
    );
    expect(section, 'the model provider section is missing').not.toBe('');
    const rendered = [...section.matchAll(/^### `([a-z-]+)`$/gm)].map((match) => match[1]);
    expect(rendered.sort()).toEqual([...data.providers].sort());
    for (const provider of data.providers) {
      const adapter = data.providerAdapters[provider] ?? '';
      if (adapter === '') continue;
      expect(section, `\`${provider}\` does not name the adapter it is generated from`).toContain(
        `- **Adapter:** \`${adapter}\``,
      );
    }
  });

  it('names a service for every target a cloud has, and a refusal for every target it lacks', () => {
    const allTargets = [...new Set(data.clouds.flatMap((entry) => entry.targets))];
    for (const cloud of Object.keys(CLOUD_SERVICES)) {
      const declared = data.clouds.find((entry) => entry.cloud === cloud);
      expect(declared, `\`${cloud}\` is not a cloud the infra planner knows`).toBeDefined();
      expect(
        Object.keys(CLOUD_SERVICES[cloud] ?? {}).sort(),
        `the cells for \`${cloud}\` name a service the planner has no module for, or omit one it has`,
      ).toEqual([...(declared?.targets ?? [])].sort());
    }
    // A dash in the rendered matrix is a refusal the page explains, never an unstated gap.
    for (const cloud of data.clouds.map((entry) => entry.cloud)) {
      const served = Object.keys(CLOUD_SERVICES[cloud] ?? {});
      const missing = allTargets.filter((target) => !served.includes(target));
      const refused = CLOUD_REFUSALS.filter((entry) => entry.cloud === cloud).map(
        (entry) => entry.target,
      );
      expect(refused.sort(), `the dashes for \`${cloud}\` are not each explained`).toEqual(
        missing.sort(),
      );
    }
    for (const entry of CLOUD_REFUSALS) {
      expect(allTargets, `\`${entry.target}\` is not a deployment target`).toContain(entry.target);
      expect(
        entry.reason.length,
        `\`${entry.target}\` on \`${entry.cloud}\` states no reason`,
      ).toBeGreaterThan(0);
    }
  });

  it('publishes exactly the capabilities the spec enum lets a model declare', () => {
    const spec = data.specCapabilities.map((entry) => entry.spec).sort();
    const axes = CAPABILITY_AXES.map((axis) => axis.spec).sort();
    expect(axes).toEqual(spec);
  });

  it('names a diagnostic that exists beside every refusal', () => {
    for (const entry of [...REFUSALS, ...CLOUD_REFUSALS]) {
      expect(
        data.diagnostics,
        `\`${entry.code}\` is named as the enforcement of "${entry.id}", but no diagnostic table defines it`,
      ).toContain(entry.code);
      expect(page).toContain(`\`${entry.code}\``);
    }
  });

  it('dates every feature to a release that shipped it, not a future one', () => {
    const shipped = (currentVersion() ?? '').replace(/^v/, '');
    expect(shipped).toMatch(/^\d+\.\d+\.\d+/);
    for (const entry of [...SHIPPED_FEATURES, ...AI_INFRA, ...DECLARED_FEATURES]) {
      expect(entry.since, `"${entry.title ?? entry.id}" has no version`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(
        atOrBefore(entry.since, shipped),
        `"${entry.title ?? entry.id}" claims ${entry.since}, which is newer than the shipped ${shipped}`,
      ).toBe(true);
    }
  });

  it('resolves every declaration to a spec key or a CLI command that exists', () => {
    const vocabulary = schemaVocabulary();
    const cli = read('docs/reference/cli.md');
    const declarations = [
      ...SHIPPED_FEATURES.map((entry) => [entry.id, entry.declaredBy]),
      ...AI_INFRA.map((entry) => [entry.id, entry.declares]),
      ...DECLARED_FEATURES.map((entry) => [entry.id, entry.declares]),
    ];
    for (const [id, declaredBy] of declarations) {
      if (declaredBy.startsWith('aid ')) {
        const command = declaredBy.split(' ')[1];
        expect(
          cli,
          `"${id}" turns on \`${declaredBy}\`, which the CLI reference does not document`,
        ).toMatch(new RegExp(`^## \`${command}\`$`, 'm'));
        continue;
      }
      // Enum values are hyphenated identifiers (`aws-bedrock`, `vertex-rag`), and the
      // vocabulary contains them whole, so a token keeps its hyphens.
      const tokens = [...declaredBy.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)].map((m) => m[0]);
      const missing = tokens.filter((token) => !vocabulary.has(token));
      expect(
        missing,
        `"${id}" names \`${declaredBy}\`; not in the schema: ${missing.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('links every feature to a heading that exists', () => {
    for (const entry of [...SHIPPED_FEATURES, ...DECLARED_FEATURES]) {
      expect(
        entry.href,
        `"${entry.id}" must be a relative \`.md\` link with a fragment, or the docs-claims and link checks resolve different paths`,
      ).toMatch(/^\.\/reference\/[a-z]+\.md#[a-z0-9-]+$/);
      const [path, fragment] = entry.href
        .replace(/^\.\/reference\//, '')
        .replace(/\.md(#|$)/, '$1')
        .split('#');
      const source = read(`docs/reference/${path}.md`);
      expect(
        anchorIds(source).has(fragment ?? ''),
        `"${entry.id}" links to \`${entry.href}\`, which is not a heading`,
      ).toBe(true);
    }
  });

  it('is reachable from the nav and from the homepage', () => {
    expect(config).toContain("link: '/features'");
    expect(homepage).toContain('](features.md)');
    expect(page.startsWith('---\ndescription: ')).toBe(true);
  });

  it('ships every registry row onto the page', () => {
    for (const entry of [...SHIPPED_FEATURES, ...AI_INFRA, ...DECLARED_FEATURES]) {
      expect(page, `"${entry.title}" is registered but not rendered`).toContain(
        `### ${entry.title}`,
      );
    }
  });

  it('lists a declared-but-ungenerated construct below the generated inventory', () => {
    const declaredHeading = page.indexOf('## Declared and gated, not generated');
    expect(declaredHeading, 'the page has no section for declared-only constructs').toBeGreaterThan(
      -1,
    );
    const refusedHeading = page.indexOf('## Refused, on purpose');
    expect(refusedHeading).toBeGreaterThan(declaredHeading);
    for (const entry of DECLARED_FEATURES) {
      const at = page.indexOf(`### ${entry.title}`);
      expect(
        at,
        `"${entry.title}" is declared and gated but the page does not say so`,
      ).toBeGreaterThan(declaredHeading);
      expect(at, `"${entry.title}" is listed among the generated features`).toBeLessThan(
        refusedHeading,
      );
      expect(page.slice(at, at + 1200)).toContain('**Not yet generated:**');
      expect(page.slice(at, at + 1200)).toContain(entry.enforces.split(',')[0]?.trim() ?? '');
    }
  });
});

/**
 * The band is the homepage's claim that a service is already mostly written. It is
 * generated, so the risk is not a stale count -- it is a family that quietly stops
 * describing the inventory: an id that no registry declares, a registered capability no
 * family sells, or a link to an anchor that no page has.
 */
describe('homepage capability band', () => {
  const registered = [...SHIPPED_FEATURES, ...AI_INFRA];
  const registeredIds = new Set(registered.map((entry) => entry.id));
  const declaredIds = new Set(DECLARED_FEATURES.map((entry) => entry.id));
  const claimableIds = new Set([...registeredIds, ...declaredIds]);
  const bandStart = homepage.indexOf('<!-- capability-band:start -->');
  const bandEnd = homepage.indexOf('<!-- capability-band:end -->');
  const band = homepage.slice(bandStart, bandEnd);

  it('partitions the inventory with no gap and no overlap', () => {
    const claimed = CAPABILITY_FAMILIES.flatMap((family) => family.featureIds);
    expect(new Set(claimed).size, 'a feature is claimed by two families').toBe(claimed.length);
    for (const id of claimed) {
      expect(claimableIds.has(id), `"${id}" is claimed but no registry declares it`).toBe(true);
    }
    for (const id of claimableIds) {
      expect(claimed, `"${id}" is registered but no family sells it`).toContain(id);
    }
  });

  it('renders a row per family with the count it can back', () => {
    expect(bandStart, 'the generated band has no start marker').toBeGreaterThan(-1);
    expect(bandEnd, 'the generated band has no end marker').toBeGreaterThan(bandStart);
    for (const family of CAPABILITY_FAMILIES) {
      const shipped = family.featureIds.filter((id) => registeredIds.has(id)).length;
      expect(shipped, `"${family.id}" claims nothing that shipped`).toBeGreaterThan(0);
      expect(band).toContain(`**[${family.title}](${family.href})**`);
      expect(band).toContain(`| ${shipped} |`);
    }
  });

  it('counts a declared-only construct nowhere on the band', () => {
    for (const family of CAPABILITY_FAMILIES) {
      const shipped = family.featureIds.filter((id) => registeredIds.has(id)).length;
      const overclaimed = family.featureIds.filter((id) => declaredIds.has(id)).length + shipped;
      const row = band
        .split('\n')
        .find((line) => line.includes(`**[${family.title}](${family.href})**`));
      expect(row, `"${family.id}" has no row on the band`).toBeDefined();
      expect(
        row.trim().endsWith(`| ${shipped} |`),
        `"${family.id}" misstates its shipped count`,
      ).toBe(true);
      if (overclaimed !== shipped) {
        expect(
          row.trim().endsWith(`| ${overclaimed} |`),
          `"${family.id}" would claim ${overclaimed} if a declared-only construct counted`,
        ).toBe(false);
      }
    }
  });

  it('links each family at an anchor that exists', () => {
    for (const family of CAPABILITY_FAMILIES) {
      const [path = '', fragment = ''] = family.href.split('#');
      expect(fragment, `"${family.id}" links to no anchor`).not.toBe('');
      expect(
        anchorIds(read(`docs/${path}`)).has(fragment),
        `"${family.id}" links to ${family.href}, which has no such heading`,
      ).toBe(true);
    }
  });

  it('sits above the gates table it summarises', () => {
    expect(bandStart).toBeLessThan(homepage.indexOf('## The gates are the product'));
    expect(homepage).toContain('](features.md)');
  });
});
