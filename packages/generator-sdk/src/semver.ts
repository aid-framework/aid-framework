/**
 * The minimal semver surface a generator manifest needs: parse a version, parse a
 * range, and decide whether a version satisfies a range.
 *
 * This exists because `Generator.irRange` (§8.1) and `AidManifest.generatorVersion`
 * (§10) are both version contracts, and "does this generator support the IR it was
 * handed" must be answered before codegen, not discovered at runtime. It is
 * deliberately not a full semver library: no build metadata in comparisons, and
 * prereleases follow the npm rule that a prerelease only matches a comparator whose
 * bound version carries a prerelease at the same `major.minor.patch`. That rule is
 * what stops `1.2.3-rc.1` silently satisfying `^1.2.3`.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
}

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

const IDENTIFIER_PATTERN = /^\d+$/;

export function parseVersion(text: string): Version | undefined {
  const match = VERSION_PATTERN.exec(text.trim());
  if (match === null) return undefined;

  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: parsePrerelease(prerelease),
  };
}

function parsePrerelease(text: string | undefined): (string | number)[] {
  if (text === undefined || text === '') return [];
  return text.split('.').map((part) => (IDENTIFIER_PATTERN.test(part) ? Number(part) : part));
}

export function formatVersion(version: Version): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  if (version.prerelease.length === 0) return base;
  return `${base}-${version.prerelease.join('.')}`;
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== undefined;
}

/** Semver precedence. Build metadata is not part of precedence and is not parsed. */
export function compareVersions(left: Version, right: Version): -1 | 0 | 1 {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): -1 | 0 | 1 {
  // An empty prerelease outranks any prerelease: 1.0.0 > 1.0.0-rc.1.
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    // A shorter prerelease is lower when its identifiers are exhausted.
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = typeof a === 'number';
    const bNumeric = typeof b === 'number';
    if (aNumeric && bNumeric) return a < b ? -1 : 1;
    // Numeric identifiers always rank below alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

const OPERATORS = ['>=', '<=', '^', '~', '>', '<', '='] as const;

type Operator = (typeof OPERATORS)[number];

interface Bound {
  operator: '>' | '>=' | '<' | '<=' | '=';
  version: Version;
}

/** One whitespace-separated conjunct, already expanded into `>`, `>=`, `<`, `<=`, `=` bounds. */
type Conjunct = Bound[];

interface Range {
  /** One entry per `||` alternative; a version satisfies the range if any satisfies. */
  alternatives: Conjunct[];
  /** True when the range is a bare wildcard, which no version can fail. */
  any: boolean;
}

export function isValidRange(text: string): boolean {
  return parseRange(text) !== undefined;
}

/**
 * Parses the range grammar the repo's manifests use: `||` alternatives, and each
 * alternative a whitespace-separated list of comparators. A comparator is an
 * operator plus a version that may be partial or wildcarded (`1.2.x`, `1`, `*`).
 * Anything outside the grammar is `undefined`, never a permissive default.
 */
export function parseRange(text: string): Range | undefined {
  const source = text.trim();
  if (source === '') return undefined;

  const alternatives: Conjunct[] = [];
  for (const alternative of source.split('||')) {
    const trimmed = alternative.trim();
    if (trimmed === '') return undefined;

    // `-` ranges are deliberately unsupported: a range we cannot expand exactly
    // must fail validation rather than match approximately.
    if (/\s-\s/.test(trimmed)) return undefined;

    const conjunct = expandConjunct(trimmed);
    if (conjunct === undefined) return undefined;
    alternatives.push(conjunct);
  }

  if (alternatives.length === 0) return undefined;
  return { alternatives, any: alternatives.some((conjunct) => conjunct.length === 0) };
}

function expandConjunct(text: string): Bound[] | undefined {
  if (text === '*' || text === 'x' || text === 'X') return [];

  const bounds: Bound[] = [];
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    const expanded = expandComparator(token);
    if (expanded === undefined) return undefined;
    bounds.push(...expanded);
  }
  return bounds.length === 0 ? [] : bounds;
}

function splitOperator(token: string): { operator: Operator; rest: string } {
  for (const operator of OPERATORS) {
    if (token.startsWith(operator)) return { operator, rest: token.slice(operator.length) };
  }
  return { operator: '=', rest: token };
}

interface PartialVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  /** How many of `major.minor.patch` were written as explicit numbers. */
  specified: 0 | 1 | 2 | 3;
}

function parsePartial(text: string): PartialVersion | undefined {
  const [core, ...rest] = text.split('-');
  if (core === undefined) return undefined;
  const prerelease = rest.length === 0 ? [] : parsePrerelease(rest.join('-'));
  const parts = core.split('.');

  const numbers: number[] = [];
  let wildcards = 0;
  for (const part of parts) {
    if (/(?:x|X|\*)/.test(part)) {
      wildcards += 1;
      continue;
    }
    if (!/^\d+$/.test(part)) return undefined;
    numbers.push(Number(part));
  }
  if (parts.length > 3) return undefined;
  if (wildcards > 0 && numbers.length + wildcards !== parts.length) return undefined;

  const [major = 0, minor = 0, patch = 0] = numbers;
  return {
    major,
    minor,
    patch,
    prerelease,
    specified: Math.min(numbers.length, 3) as 0 | 1 | 2 | 3,
  };
}

function makeVersion(
  major: number,
  minor: number,
  patch: number,
  prerelease: (string | number)[] = [],
): Version {
  return { major, minor, patch, prerelease };
}

function expandComparator(token: string): Bound[] | undefined {
  const { operator, rest } = splitOperator(token);

  // A bare operator (`>=`) names nothing and is a typo; an operator in front of a
  // wildcard (`^x`) names no version at all, so it constrains nothing.
  if (rest === '') return undefined;
  if (rest === '*' || rest === 'x' || rest === 'X') return [];

  const partial = parsePartial(rest);
  if (partial === undefined) return undefined;
  const { major, minor, patch, prerelease, specified } = partial;

  if (specified === 3) {
    const exact = makeVersion(major, minor, patch, prerelease);
    switch (operator) {
      case '=':
      case '>':
      case '>=':
      case '<':
      case '<=':
        return [{ operator, version: exact }];
      case '~':
        return [
          { operator: '>=', version: exact },
          { operator: '<', version: makeVersion(major, minor + 1, 0) },
        ];
      case '^': {
        const upper =
          major > 0
            ? makeVersion(major + 1, 0, 0)
            : minor > 0
              ? makeVersion(0, minor + 1, 0)
              : makeVersion(0, 0, patch + 1);
        return [
          { operator: '>=', version: exact },
          { operator: '<', version: upper },
        ];
      }
      default:
        return undefined;
    }
  }

  if (operator === '>' || operator === '<' || operator === '>=' || operator === '<=') {
    return [{ operator, version: makeVersion(major, minor, patch, prerelease) }];
  }
  // `^`/`~`/`=` with a partial version: partial versions lower-bound at zero and
  // upper-bound at the last position that was actually written.
  return partialBounds(major, minor, patch, specified);
}

/** A partial version (`1`, `1.2`, `1.2.x`) has a zero lower bound and a bumped upper bound. */
function partialBounds(major: number, minor: number, patch: number, specified: 0 | 1 | 2): Bound[] {
  // `^x.y` names no version at all, so it constrains nothing rather than guessing.
  if (specified === 0) return [];

  const lower: Bound = { operator: '>=', version: makeVersion(major, minor, patch) };
  const upper: Bound =
    specified === 1
      ? { operator: '<', version: makeVersion(major + 1, 0, 0) }
      : { operator: '<', version: makeVersion(major, minor + 1, 0) };
  return [lower, upper];
}

export function satisfies(versionText: string, rangeText: string): boolean {
  const parsedVersion = parseVersion(versionText);
  const range = parseRange(rangeText);
  if (parsedVersion === undefined || range === undefined) return false;
  if (range.any) return true;

  return range.alternatives.some((conjunct) => satisfiesConjunct(parsedVersion, conjunct));
}

function satisfiesConjunct(candidate: Version, conjunct: Conjunct): boolean {
  if (conjunct.length === 0) return true;

  if (candidate.prerelease.length > 0) {
    const anchored = conjunct.some(
      (bound) =>
        bound.version.prerelease.length > 0 &&
        bound.version.major === candidate.major &&
        bound.version.minor === candidate.minor &&
        bound.version.patch === candidate.patch,
    );
    if (!anchored) return false;
  }

  return conjunct.every((bound) => satisfiesBound(candidate, bound));
}

/** No `default`: a new operator must be handled here, not silently pass. */
function satisfiesBound(candidate: Version, bound: Bound): boolean {
  const order = compareVersions(candidate, bound.version);
  switch (bound.operator) {
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '=':
      return order === 0;
  }
}
