/**
 * Holds the homepage example to itself.
 *
 * `/` publishes the only spec most readers ever see, and it publishes it as fragments a
 * visitor reads as one document. Nothing compiled them, so round 3 shipped an overlay that
 * moved three paths the base did not define under a comment calling the rest "abridged",
 * and a `specVersion` three releases stale. Both are invisible to prose review and both
 * would have failed here.
 *
 * The rules are deliberately relational rather than literal, so a version bump or a renamed
 * model does not require editing this file:
 *   - the base fragments, read as one document, pass the spec gate and build;
 *   - the page declares the *latest* spec version, not a number copied here;
 *   - every path the base lists as `overridable` exists in that base;
 *   - the overlay moves only `overridable` paths, and stays inside each declared bound;
 *   - the `aid fleet` row the page prints is the overlay's own values.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIR } from '@aid-framework/ir';
import { checkSpecText, SPEC_VERSION_LATEST } from '@aid-framework/spec';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './support-data.mjs';

const page = readFileSync(join(repoRoot, 'docs', 'index.md'), 'utf8');

/**
 * The body of every fenced block in the page that declares `language`.
 *
 * @param {string} text
 * @param {string} language
 * @returns {string[]}
 */
function fences(text, language) {
  const pattern = new RegExp(`^\`\`\`${language}\\r?\\n([\\s\\S]*?)^\`\`\`$`, 'gm');
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '');
}

/**
 * The value at a dotted path, or `undefined` where the path does not exist.
 *
 * @param {unknown} root
 * @param {string} path
 * @returns {unknown}
 */
function at(root, path) {
  /** @type {unknown} */
  let node = root;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    if (!(key in node)) return undefined;
    node = /** @type {Record<string, unknown>} */ (node)[key];
  }
  return node;
}

const yamlBlocks = fences(page, 'yaml');
const overlayText = yamlBlocks.find((block) => /^base:\s/m.test(block));
const baseText = yamlBlocks.filter((block) => !/^base:\s/m.test(block)).join('\n');
const consoleText = fences(page, 'console').join('\n');

/**
 * @typedef {object} Overridable
 * @property {unknown[]} [from]
 * @property {number} [max]
 */

const base = parse(baseText);
const overlay = parse(overlayText ?? '') ?? {};
const overridable = base.overridable ?? {};
const overrides = overlay.overrides ?? {};

describe('the homepage example', () => {
  it('publishes a base and an overlay', () => {
    expect(baseText.length).toBeGreaterThan(0);
    expect(overlayText).toBeDefined();
    expect(consoleText).toContain('$ aid fleet');
  });

  it('declares the latest spec version, so the example cannot go stale', () => {
    expect(base.specVersion).toBe(SPEC_VERSION_LATEST);
  });

  it('passes the spec gate and builds without a diagnostic', () => {
    const checked = checkSpecText(baseText, { file: 'docs/index.md' });
    const named = checked.ok
      ? []
      : checked.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
    expect(named).toEqual([]);

    if (!checked.ok) return;
    const built = buildIR(checked.value, { file: 'docs/index.md' });
    expect(built.diagnostics).toEqual([]);
  });
});

describe('the homepage overlay', () => {
  it('lists only paths the base defines', () => {
    for (const path of Object.keys(overridable)) {
      expect(at(base, path), `overridable path "${path}" is not in the base`).toBeDefined();
    }
  });

  it('moves only paths the base makes overridable', () => {
    const allowed = new Set(Object.keys(overridable));
    for (const path of Object.keys(overrides)) {
      expect(allowed.has(path), `"${path}" is moved but not overridable`).toBe(true);
    }
  });

  it('stays inside every declared bound', () => {
    for (const [path, value] of Object.entries(overrides)) {
      const bound = overridable[path];
      if (bound === undefined) continue;
      if (bound.from !== undefined) {
        expect(bound.from, `"${path}" accepts ${bound.from.join(', ')}`).toContain(value);
      }
      if (bound.max !== undefined) {
        expect(typeof value).toBe('number');
        expect(value).toBeLessThanOrEqual(bound.max);
      }
    }
  });

  it('prints a fleet row that is the overlay it just resolved', () => {
    expect(consoleText).toContain(`${Object.keys(overrides).length} overrides applied`);

    const customer = String(overlay.customer);
    const row = consoleText.split(/\r?\n/).find((line) => line.trim().startsWith(`${customer} `));
    expect(row, `no fleet row for "${customer}"`).toBeDefined();

    const model = String(overrides['models.fast.modelId']);
    const region = String(overrides['deployments.api.region']);
    const ceiling = `$${Number(overrides['agents.triage_agent.maxCostBudget']).toFixed(2)}`;
    expect(row).toContain(model);
    expect(row).toContain(region);
    expect(row).toContain(ceiling);
    expect(row?.trimEnd().endsWith('ok')).toBe(true);
  });
});
