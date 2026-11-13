/**
 * Renders the delivery boundary table from the diagnostics registry.
 *
 * The second column of `docs/guide/boundary.md` is where the page can lie without anyone
 * noticing: a warning described as a refusal reads as one more guarantee than the build gives.
 * So the severity comes from the code's emit sites, the condition comes from the registry, and
 * the three prose columns come from `boundary-data.mjs`. This module holds only the decisions
 * and takes everything else as arguments, so a test can hand it a deliberately wrong registry
 * and assert the refusal without writing a page.
 *
 * The caller collects every refusal into `fail` and decides what to do with them: the generator
 * refuses to emit, a test asserts on the messages.
 */

export const BOUNDARY_TABLE_START = '<!-- boundary-table:start -->';
export const BOUNDARY_TABLE_END = '<!-- boundary-table:end -->';

/** The two kinds of placeholder hand-written prose may use, and nothing else. */
const PLACEHOLDER = /\{([A-Za-z:_-]+)\}/g;

/**
 * Substitutes the `{...}` placeholders in the hand-written boundary prose.
 *
 * Two kinds are defined, and nothing else is: `{policyCodes}` is the number of registered
 * policy and predicate parse codes, and `{const:NAME}` is the value of a published constant.
 * A placeholder of any other shape fails the build, so prose cannot quietly keep a number a
 * person typed.
 *
 * @param {string} text
 * @param {Map<string, string>} values
 * @param {(message: string) => void} fail
 * @returns {string}
 */
export function substitute(text, values, fail) {
  return text.replace(PLACEHOLDER, (whole, name) => {
    const value = values.get(name);
    if (value === undefined) {
      fail(
        `site/scripts/boundary-data.mjs: no value for the placeholder ${whole}; known placeholders are ${[...values.keys()].join(', ')}`,
      );
      return whole;
    }
    return value;
  });
}

/**
 * One row of the boundary table: the derived second column, then the hand-written three.
 *
 * @param {string} concern
 * @param {object} input
 * @param {Map<string, { registry: string, key: string, condition: string, escalation?: string }>} input.published
 * @param {Map<string, Set<'error' | 'warning'>>} input.severities keyed `<REGISTRY>.<enumKey>`
 * @param {Record<string, { codes: readonly string[], generated: string, provide: string, risk: string }>} input.metadata
 * @param {Map<string, string>} input.values
 * @param {(message: string) => void} input.fail
 * @returns {string}
 */
export function boundaryRow(concern, { published, severities, metadata, values, fail }) {
  const row = metadata[concern];
  /** @type {string[]} */
  const refusals = [];
  for (const code of row.codes) {
    const meta = published.get(code);
    if (meta === undefined) {
      fail(
        `docs/guide/boundary.md row "${concern}" cites \`${code}\`, which no registry publishes with a condition`,
      );
      continue;
    }
    const emitted = severities.get(`${meta.registry}.${meta.key}`) ?? new Set();
    const found = [...emitted].sort();
    if (found.length === 1 && meta.escalation !== undefined) {
      fail(
        `${code} has one severity (${found[0]}) at every emit site, but its metadata claims an escalation; the escalation would publish a condition the code no longer has`,
      );
    }
    if (found.length !== 1 && meta.escalation === undefined) {
      fail(
        `${code} is emitted at ${found.length === 0 ? 'no site this scan can follow' : 'more than one severity'}, so the page cannot state it without metadata.escalation saying what decides it`,
      );
    }
    const label =
      found.length === 1 ? (found[0] === 'error' ? 'refusal' : 'warning') : 'refusal or warning';
    const escalation =
      meta.escalation === undefined ? '' : `; ${substitute(meta.escalation, values, fail)}`;
    refusals.push(
      `\`${code}\` (${label}) — ${substitute(meta.condition, values, fail)}${escalation}`,
    );
  }
  return `| ${concern} | ${refusals.join('<br>')} | ${substitute(row.generated, values, fail)} | ${substitute(row.provide, values, fail)} | ${substitute(row.risk, values, fail)} |`;
}

/**
 * The boundary table, rendered from the registries plus the prose in `boundary-data.mjs`.
 *
 * The checks here are the ones a reader would otherwise have to make by reading two files at
 * once: a concern with no row, a row for a concern that does not exist (a renamed concern keeps
 * its old row silently, so the page keeps claiming the old thing), and a published code no row
 * cites (a refusal the build has and the page does not state).
 *
 * @param {object} input
 * @param {readonly string[]} input.concerns
 * @param {Record<string, { codes: readonly string[], generated: string, provide: string, risk: string }>} input.metadata
 * @param {Map<string, { registry: string, key: string }>} input.codes every registered code
 * @param {Map<string, { registry: string, key: string, condition: string, escalation?: string }>} input.published
 * @param {Map<string, Set<'error' | 'warning'>>} input.severities
 * @param {Map<string, string>} input.values
 * @param {(message: string) => void} input.fail
 * @returns {string}
 */
export function boundaryTable({ concerns, metadata, codes, published, severities, values, fail }) {
  const rows = Object.keys(metadata);
  for (const concern of concerns) {
    if (!rows.includes(concern)) {
      fail(`site/scripts/boundary-data.mjs: no row for the registered concern "${concern}"`);
    }
  }
  for (const concern of rows) {
    if (!concerns.includes(concern)) {
      fail(
        `site/scripts/boundary-data.mjs: "${concern}" is not a registered concern; add it to BOUNDARY_CONCERNS or rename the row`,
      );
    }
  }
  const cited = new Set(rows.flatMap((concern) => metadata[concern].codes));
  for (const code of published.keys()) {
    if (!cited.has(code)) {
      fail(
        `${code} is published by the registry and cited by no row; give it a row in site/scripts/boundary-data.mjs or drop its metadata`,
      );
    }
  }

  const policyCodes = [...codes.keys()].filter((code) =>
    /^ir\/(policy|predicate)-/.test(code),
  ).length;
  values.set('policyCodes', String(policyCodes));

  const lines = [
    '| Concern | What the build refuses | What is generated | What you provide | Residual risk if you provide nothing |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const concern of rows) {
    lines.push(boundaryRow(concern, { published, severities, metadata, values, fail }));
  }
  return lines.join('\n');
}

/**
 * `docs/guide/boundary.md` with its table region regenerated.
 *
 * The page is prose around a table, so this is a generated region for the same reason the
 * homepage band is: the argument around the table is hand-written and reviewable, and only the
 * bytes between the markers are replaced.
 *
 * @param {string} existing the committed page
 * @param {Parameters<typeof boundaryTable>[0]} input
 * @returns {string}
 */
export function boundaryPage(existing, input) {
  const start = existing.indexOf(BOUNDARY_TABLE_START);
  const end = existing.indexOf(BOUNDARY_TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    input.fail(
      'docs/guide/boundary.md is missing the `boundary-table` markers the generated table replaces',
    );
    return existing;
  }
  return (
    `${existing.slice(0, start + BOUNDARY_TABLE_START.length)}\n\n` +
    `${boundaryTable(input)}\n\n${existing.slice(end)}`
  );
}
