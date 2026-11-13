/**
 * Holds the boundary table's derived columns to the code that decides them.
 *
 * The page exists because a hand-written table drifted: a warning was described as a refusal,
 * a condition that no longer held was published, and nothing noticed. The generator now derives
 * severity from the emit sites and condition from the registry -- but a generator is only as
 * good as its refusals, so each way the render can be unstateable is asserted here against a
 * registry built for the purpose, and the committed page is asserted to be what the real
 * registry renders.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOUNDARY_CONCERNS, BOUNDARY_TABLE_METADATA } from './boundary-data.mjs';
import {
  BOUNDARY_TABLE_END,
  BOUNDARY_TABLE_START,
  boundaryPage,
  boundaryTable,
  substitute,
} from './boundary-page.mjs';
import { callsWithSeverity, closingBracket } from './diagnostic-severities.mjs';

const repoRoot = join(import.meta.dirname, '..', '..');

/**
 * A registry shaped like the real one, holding only what a fixture names.
 *
 * @param {{ code: string, key?: string, condition?: string, escalation?: string, severity?: 'error' | 'warning' | 'both' | 'none' }[]} codes
 */
function fixtureRegistry(codes) {
  const published = new Map();
  const severities = new Map();
  const registry = 'IR_DIAGNOSTIC_CODES';
  for (const entry of codes) {
    const key =
      entry.key ??
      entry.code.replace(/^[a-z]+\//, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    published.set(entry.code, {
      registry,
      key,
      condition: entry.condition ?? `the case ${entry.code} refuses`,
      ...(entry.escalation === undefined ? {} : { escalation: entry.escalation }),
    });
    const severity = entry.severity ?? 'error';
    if (severity === 'both') severities.set(`${registry}.${key}`, new Set(['error', 'warning']));
    else if (severity !== 'none') severities.set(`${registry}.${key}`, new Set([severity]));
  }
  return {
    codes: new Map(
      [...published].map(([code, meta]) => [code, { registry: meta.registry, key: meta.key }]),
    ),
    published,
    severities,
  };
}

/**
 * Renders with a fixture registry, returning the table and every refusal collected.
 *
 * @param {object} input
 * @param {ReturnType<typeof fixtureRegistry>} input.registry
 * @param {Record<string, any>} [input.metadata]
 * @param {string[]} [input.concerns]
 * @param {Record<string, string>} [input.row]
 */
function render({ registry, metadata, concerns, row }) {
  /** @type {string[]} */
  const failures = [];
  const rows = metadata ?? {
    Concern: { codes: [...registry.published.keys()], ...defaultRow(), ...row },
  };
  const table = boundaryTable({
    concerns: concerns ?? Object.keys(rows),
    metadata: rows,
    codes: registry.codes,
    published: registry.published,
    severities: registry.severities,
    values: new Map(),
    fail: (message) => failures.push(message),
  });
  return { table, failures };
}

/** @returns {Record<string, string>} */
function defaultRow() {
  return { generated: 'generated', provide: 'you provide', risk: 'the residual risk' };
}

describe('the severity scan', () => {
  const registries = ['IR_DIAGNOSTIC_CODES'];

  it('reads the severity from the factory a code is emitted through', () => {
    const source = [
      "report.error({ code: IR_DIAGNOSTIC_CODES.alpha, message: 'no' });",
      "this.report.warn({ code: IR_DIAGNOSTIC_CODES.beta, message: 'careful' });",
    ].join('\n');
    const severities = callsWithSeverity(source, registries);

    expect([...(severities.get('IR_DIAGNOSTIC_CODES.alpha') ?? [])]).toEqual(['error']);
    expect([...(severities.get('IR_DIAGNOSTIC_CODES.beta') ?? [])]).toEqual(['warning']);
  });

  it('reports both severities when the emit is a branch', () => {
    const source =
      "ir.profile === 'enterprise' ? report.error({ code: IR_DIAGNOSTIC_CODES.gamma }) : report.warn({ code: IR_DIAGNOSTIC_CODES.gamma });";
    const severities = callsWithSeverity(source, registries);

    expect([...(severities.get('IR_DIAGNOSTIC_CODES.gamma') ?? [])].sort()).toEqual([
      'error',
      'warning',
    ]);
  });

  it('follows no severity for a code held in a variable and emitted later', () => {
    // A deferred emit is the case that must fail closed: the scan cannot see the factory, so
    // the page must not state a severity the code might not have.
    const source = ['const init = { code: IR_DIAGNOSTIC_CODES.delta };', 'report.warn(init);'].join(
      '\n',
    );

    expect(callsWithSeverity(source, registries).get('IR_DIAGNOSTIC_CODES.delta')).toBeUndefined();
  });

  it('closes brackets past strings that contain one', () => {
    const text = 'call(a, ")") + rest';

    expect(text[closingBracket(text, text.indexOf('('))]).toBe(')');
    expect(closingBracket(text, text.indexOf('('))).toBe(text.lastIndexOf(')'));
  });

  it('skips a bracket that appears inside a template literal', () => {
    const text = 'report.error({ message: `x ( y` })';

    expect(text[closingBracket(text, text.indexOf('('))]).toBe(')');
    expect(closingBracket(text, text.indexOf('('))).toBe(text.length - 1);
  });
});

describe('the boundary table', () => {
  it('labels an error a refusal and a warning a warning', () => {
    const registry = fixtureRegistry([
      { code: 'ir/refused', severity: 'error' },
      { code: 'ir/warned', severity: 'warning' },
    ]);
    const { table, failures } = render({ registry });

    expect(failures).toEqual([]);
    expect(table).toContain('`ir/refused` (refusal) — the case ir/refused refuses');
    expect(table).toContain('`ir/warned` (warning) — the case ir/warned refuses');
  });

  it('states both severities when the code emits both and says what decides', () => {
    const registry = fixtureRegistry([
      {
        code: 'ir/escalating',
        severity: 'both',
        escalation: '`enterprise` refuses it; `standard` warns',
      },
    ]);
    const { table, failures } = render({ registry });

    expect(failures).toEqual([]);
    expect(table).toContain(
      '`ir/escalating` (refusal or warning) — the case ir/escalating refuses; `enterprise` refuses it; `standard` warns',
    );
  });

  it('refuses a citation of a code no registry publishes', () => {
    const registry = fixtureRegistry([{ code: 'ir/refused' }]);
    const { failures } = render({
      registry,
      metadata: { Concern: { codes: ['ir/invented'], ...defaultRow() } },
    });

    expect(failures).toEqual([
      'ir/refused is published by the registry and cited by no row; give it a row in site/scripts/boundary-data.mjs or drop its metadata',
      'docs/guide/boundary.md row "Concern" cites `ir/invented`, which no registry publishes with a condition',
    ]);
  });

  it('refuses a code whose severity the scan cannot find and whose metadata does not say', () => {
    const registry = fixtureRegistry([{ code: 'ir/deferred', severity: 'none' }]);
    const { failures } = render({ registry });

    expect(failures).toEqual([
      'ir/deferred is emitted at no site this scan can follow, so the page cannot state it without metadata.escalation saying what decides it',
    ]);
  });

  it('refuses an escalation on a code that emits one severity everywhere', () => {
    const registry = fixtureRegistry([
      { code: 'ir/settled', severity: 'error', escalation: 'it used to warn' },
    ]);
    const { failures } = render({ registry });

    expect(failures).toEqual([
      'ir/settled has one severity (error) at every emit site, but its metadata claims an escalation; the escalation would publish a condition the code no longer has',
    ]);
  });

  it('refuses a concern with no row, so a renamed concern cannot silently keep its old text', () => {
    const registry = fixtureRegistry([{ code: 'ir/refused' }]);
    const { failures } = render({
      registry,
      metadata: { Renamed: { codes: ['ir/refused'], ...defaultRow() } },
      concerns: ['Concern'],
    });

    expect(failures).toEqual([
      'site/scripts/boundary-data.mjs: no row for the registered concern "Concern"',
      'site/scripts/boundary-data.mjs: "Renamed" is not a registered concern; add it to BOUNDARY_CONCERNS or rename the row',
    ]);
  });

  it('refuses a published code no row cites, so a refusal cannot go unstated', () => {
    const registry = fixtureRegistry([{ code: 'ir/refused' }, { code: 'ir/unsaid' }]);
    const { failures } = render({
      registry,
      metadata: { Concern: { codes: ['ir/refused'], ...defaultRow() } },
    });

    expect(failures).toEqual([
      'ir/unsaid is published by the registry and cited by no row; give it a row in site/scripts/boundary-data.mjs or drop its metadata',
    ]);
  });

  it('refuses a placeholder that no value fills', () => {
    /** @type {string[]} */
    const failures = [];

    expect(substitute('a {policyCodes} b', new Map(), (m) => failures.push(m))).toBe(
      'a {policyCodes} b',
    );
    expect(failures[0]).toContain('no value for the placeholder {policyCodes}');
  });

  it('substitutes a published constant rather than letting prose state the number', () => {
    const registry = fixtureRegistry([
      { code: 'ir/versioned', severity: 'both', escalation: 'enforced from {const:MIN_VERSION}' },
    ]);
    /** @type {string[]} */
    const failures = [];
    const rows = { Concern: { codes: ['ir/versioned'], ...defaultRow() } };
    const table = boundaryTable({
      concerns: ['Concern'],
      metadata: rows,
      codes: registry.codes,
      published: registry.published,
      severities: registry.severities,
      values: new Map([['const:MIN_VERSION', '0.32']]),
      fail: (m) => failures.push(m),
    });

    expect(failures).toEqual([]);
    expect(table).toContain('enforced from 0.32');
  });
});

describe('the boundary page', () => {
  const page = readFileSync(join(repoRoot, 'docs', 'guide', 'boundary.md'), 'utf8');

  it('is a generated region between markers, with prose outside them', () => {
    const start = page.indexOf(BOUNDARY_TABLE_START);
    const end = page.indexOf(BOUNDARY_TABLE_END);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(page.slice(0, start)).toContain('## The boundary in one table');
    expect(page.slice(end)).toContain('## The four rows that decide your plan');
  });

  it('refuses a page that lost its markers instead of rewriting the whole file', () => {
    /** @type {string[]} */
    const failures = [];
    const text = boundaryPage('no markers here', {
      concerns: BOUNDARY_CONCERNS,
      metadata: BOUNDARY_TABLE_METADATA,
      codes: new Map(),
      published: new Map(),
      severities: new Map(),
      values: new Map(),
      fail: (m) => failures.push(m),
    });

    expect(text).toBe('no markers here');
    expect(failures).toEqual([
      'docs/guide/boundary.md is missing the `boundary-table` markers the generated table replaces',
    ]);
  });

  it('cites only codes the registry registers', () => {
    const registered = new Set(['ir/', 'cli/']);
    for (const row of Object.values(BOUNDARY_TABLE_METADATA)) {
      for (const code of row.codes) {
        expect(
          [...registered].some((prefix) => code.startsWith(prefix)),
          `\`${code}\` is not in a namespace the generator reads`,
        ).toBe(true);
      }
    }
  });

  it('names every concern exactly once', () => {
    const rows = Object.keys(BOUNDARY_TABLE_METADATA);
    expect(new Set(rows).size).toBe(rows.length);
    expect([...BOUNDARY_CONCERNS].sort()).toEqual([...rows].sort());
  });
});
