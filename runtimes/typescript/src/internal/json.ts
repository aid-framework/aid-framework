/**
 * Canonical JSON and hashing helpers.
 *
 * Every hash in this runtime is taken over a canonical serialisation rather than
 * over `JSON.stringify` of an object in insertion order, because an object built in
 * a different order must still produce the same chunk id, the same fingerprint and
 * the same fake-provider answer.
 */

import { createHash } from 'node:crypto';

/**
 * A Python-style `repr()` for a string.
 *
 * Error messages name the offending value, and quoting it the way the reference
 * runtime does keeps the two runtimes' diagnostics greppable as one corpus.
 */
export function repr(value: string): string {
  if (value.includes("'") && !value.includes('"')) {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** Round to a fixed number of decimal places. */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lowercase hex SHA-256 of UTF-8 parts, each followed by a NUL separator. */
export function sha256Parts(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part, 'utf8');
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

interface SortOptions {
  /** Drop `null` members, mirroring `model_dump(exclude_none=True)`. */
  readonly excludeNull?: boolean;
}

function sortValue(value: unknown, options: SortOptions): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry, options));
  }
  if (value instanceof Set) {
    return [...value].map((entry) => sortValue(entry, options));
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      if (options.excludeNull === true && entry === null) continue;
      sorted[key] = sortValue(entry, options);
    }
    return sorted;
  }
  return value;
}

/**
 * JSON with object keys sorted at every depth.
 *
 * Byte-for-byte stable across construction order, which is what makes it usable as
 * hash input.
 */
export function canonicalJson(value: unknown, options: SortOptions = {}): string {
  return JSON.stringify(sortValue(value, options));
}

/**
 * `json.dumps(value, sort_keys=True, default=str)`.
 *
 * Used where a tool hands back an arbitrary value: it must serialise rather than
 * throw, because a tool result is data flowing back to a model, not a place to
 * raise.
 */
export function dumpsSorted(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return String(value);
  }
}

/** The first `count` hex characters of a SHA-256 digest. */
export function digestPrefix(text: string, count = 8): string {
  return sha256Hex(text).slice(0, count);
}
