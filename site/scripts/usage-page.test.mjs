/**
 * Holds `/usage` to the inventory it promises to explain.
 *
 * `/features` says what shipped; `/usage` says how to use it. The page is hand-written
 * because a worked example is prose, so nothing but a test stops it from falling behind:
 * a family with no section, a registered capability no section explains, or a capability
 * explained in two places and therefore maintained twice.
 *
 * Each section is marked with the family it answers for, which is the same partition the
 * homepage band renders. That keeps the three surfaces -- band, inventory, usage -- on one
 * set of ids.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_INFRA,
  CAPABILITY_FAMILIES,
  DECLARED_FEATURES,
  SHIPPED_FEATURES,
} from './features-data.mjs';
import { repoRoot } from './support-data.mjs';

const usage = readFileSync(join(repoRoot, 'docs', 'usage.md'), 'utf8');
const homepage = readFileSync(join(repoRoot, 'docs', 'index.md'), 'utf8');
const config = readFileSync(join(repoRoot, 'site', '.vitepress', 'config.mts'), 'utf8');

const registered = new Map(
  [...SHIPPED_FEATURES, ...AI_INFRA, ...DECLARED_FEATURES].map((entry) => [entry.id, entry.title]),
);

/** @type {Map<string, string>} */
const sections = new Map();
const marker = /<!-- capability-family: ([a-z-]+) -->/g;
const markers = [...usage.matchAll(marker)];
markers.forEach((match, index) => {
  const start = (match.index ?? 0) + match[0].length;
  const next = markers[index + 1];
  sections.set(match[1] ?? '', usage.slice(start, next?.index ?? usage.length));
});

describe('the usage page', () => {
  it('has one section per capability family, in the order the band lists them', () => {
    expect(markers.length, 'a family is marked twice').toBe(sections.size);
    expect([...sections.keys()]).toEqual(CAPABILITY_FAMILIES.map((family) => family.id));
  });

  it('explains every capability registered in that family', () => {
    for (const family of CAPABILITY_FAMILIES) {
      const section = sections.get(family.id) ?? '';
      for (const id of family.featureIds) {
        const title = registered.get(id);
        expect(title, `"${id}" is claimed but not registered`).toBeDefined();
        expect(section, `"${family.id}" does not explain "${title}"`).toContain(`**${title}**`);
      }
    }
  });

  it('explains each capability exactly once', () => {
    for (const [id, title] of registered) {
      const mentions = [...sections.values()].filter((section) =>
        section.includes(`**${title}**`),
      ).length;
      expect(mentions, `"${id}" is explained in ${mentions} sections`).toBe(1);
    }
  });

  it('is reachable from the nav, the sidebar and the homepage', () => {
    expect(config).toContain("text: 'Usage', link: '/usage'");
    expect(homepage).toContain('](usage.md)');
    expect(usage.startsWith('---\ndescription: ')).toBe(true);
    expect(usage).toContain('# Usage, by capability');
  });

  it('links only to pages that exist', () => {
    for (const link of usage.matchAll(/\]\(([a-z0-9./-]+\.md)(?:#[a-z0-9-]+)?\)/gu)) {
      const target = link[1] ?? '';
      expect(
        () => readFileSync(join(repoRoot, 'docs', target)),
        `"${target}" is linked but does not exist`,
      ).not.toThrow();
    }
  });
});
