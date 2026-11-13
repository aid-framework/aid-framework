/**
 * The severity each diagnostic code is actually emitted at, read from its emit sites.
 *
 * A page that says "refusal" about a code that warns is wrong in the one direction that
 * matters: a reader decides whether their document will pass on the strength of that word.
 * So the severity is not copied into the page or into the registry. It is derived here from
 * the call that emits the diagnostic, and the reference generator refuses to publish a code
 * whose severity it cannot resolve.
 *
 * A code with several emit sites may hold more than one severity -- `ir/eval-uncovered`
 * warns under `standard` and refuses under `enterprise` -- and that is a fact about the code,
 * not a defect. The caller decides how to word it, from metadata that the generator requires
 * to be present.
 */

/**
 * The factories that carry a severity, and the severity each one carries.
 *
 * The position-bearing policy factories are listed because they build an `irError`
 * internally: a code emitted through `policyDiagnostic` is a refusal like any other. An
 * emit form that is not listed is invisible here, so a code published only through a new
 * factory resolves to no severity, and the reference generator refuses to publish it. That
 * is the intent: a new factory is classified, never assumed.
 */
export const FACTORY_SEVERITIES = new Map([
  ['report.error', 'error'],
  ['report.warn', 'warning'],
  ['errorDiagnostic', 'error'],
  ['warningDiagnostic', 'warning'],
  ['irError', 'error'],
  ['irWarning', 'warning'],
  ['cliError', 'error'],
  ['cliWarning', 'warning'],
  ['generatorError', 'error'],
  ['generatorWarning', 'warning'],
  ['unknownTargetDiagnostic', 'error'],
  ['policyDiagnostic', 'error'],
  ['predicateDiagnostic', 'error'],
  // `report(...)` and `refusal(...)` are local wrappers: the policy parsers build an
  // `irError`, and `aid trace export` builds a `cliError`. Naming them here is how a
  // published code emitted only through a wrapper still resolves to its severity.
  ['this.report', 'error'],
  ['refusal', 'error'],
]);

/** A factory name as a regex alternation, with the `.` in `report.error` escaped. */
const FACTORY_PATTERN = [...FACTORY_SEVERITIES.keys()]
  .map((name) => name.replaceAll('.', '\\.'))
  .join('|');
/**
 * The index of the character that closes the bracket at `index`, whichever of `(`, `[` or `{`
 * it is.
 *
 * String, template and comment contents are skipped, because a diagnostic message is prose:
 * `hint: 'add the matching ")"'` is a real hint in this tree, and a scanner that counted that
 * `)` would close the call early and attribute the diagnostic to whatever came next.
 *
 * @param {string} text
 * @param {number} index Index of the opening bracket.
 * @returns {number} Index of the matching closer, or `text.length` when it is unclosed.
 */
export function closingBracket(text, index) {
  const open = text[index];
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  if (close === undefined) return index;
  let depth = 0;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === '"' || character === "'" || character === '`') {
      cursor += 1;
      while (cursor < text.length && text[cursor] !== character) {
        if (text[cursor] === '\\') cursor += 1;
        cursor += 1;
      }
      continue;
    }
    if (character === '/' && text[cursor + 1] === '/') {
      while (cursor < text.length && text[cursor] !== '\n') cursor += 1;
      continue;
    }
    if (character === '/' && text[cursor + 1] === '*') {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end === -1 ? text.length : end + 1;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return text.length;
}

/**
 * Every severity this text emits a code at, keyed by `<registry>.<enum key>`.
 *
 * A code is attributed to the call whose parentheses contain it, so `report.error({ code })`
 * and `withPosition(irError({ code }))` both read as a refusal. A code held in a variable and
 * emitted later (`const init = { code }; ... report.warn(init)`) has no severity here: what
 * decides it is the use site, which is why the caller must record an escalation for it.
 *
 * @param {string} text
 * @param {readonly string[]} registries
 * @returns {Map<string, Set<'error' | 'warning'>>}
 */
export function callsWithSeverity(text, registries) {
  const call = new RegExp(`(${FACTORY_PATTERN})\\(`, 'g');
  const code = new RegExp(`(${registries.join('|')})\\.(\\w+)`, 'g');
  /** @type {Map<string, Set<'error' | 'warning'>>} */
  const found = new Map();
  for (const opened of text.matchAll(call)) {
    const severity = FACTORY_SEVERITIES.get(opened[1]);
    if (severity === undefined) continue;
    const start = opened.index + opened[0].length - 1;
    const body = text.slice(start + 1, closingBracket(text, start));
    for (const reference of body.matchAll(code)) {
      const id = `${reference[1]}.${reference[2]}`;
      const severities = found.get(id) ?? new Set();
      severities.add(severity);
      found.set(id, severities);
    }
  }
  return found;
}

/**
 * Every severity each requested code is emitted at, keyed by `<registry>.<enum key>`.
 *
 * Only the codes asked for are resolved, and that is deliberate: this check exists so a
 * published page cannot state a severity the code does not have, and a code no page
 * publishes has no claim to verify.
 *
 * An empty set is a real answer -- see `callsWithSeverity`. The caller must have a recorded
 * escalation before publishing one, because the page cannot say what it does not know.
 *
 * @param {object} sources
 * @param {readonly { path: string, text: string }[]} sources.files Files to scan.
 * @param {readonly string[]} sources.registries The registry identifiers to follow, for
 *   example `IR_DIAGNOSTIC_CODES`; ids are keyed `<registry>.<enum key>`.
 * @param {ReadonlySet<string>} sources.only The ids to resolve.
 * @returns {Map<string, Set<'error' | 'warning'>>} One entry per requested id, in the order
 *   requested, holding the severities its emit sites carry.
 */
export function emitSeverities({ files, registries, only }) {
  /** @type {Map<string, Set<'error' | 'warning'>>} */
  const resolved = new Map([...only].map((id) => [id, new Set()]));
  for (const file of files) {
    for (const [id, severities] of callsWithSeverity(file.text, registries)) {
      const target = resolved.get(id);
      if (target === undefined) continue;
      for (const severity of severities) target.add(severity);
    }
  }
  return resolved;
}
