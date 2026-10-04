/**
 * Canonical JSON serializer: the determinism contract for the IR.
 *
 * Object keys sort deterministically, arrays keep their declared order (an
 * array's order is meaningful, an object's is not), output is LF-terminated with
 * exactly one trailing newline, and `undefined`-valued keys are omitted rather
 * than serialized as `null`. `NaN` and `Infinity` are refused instead of being
 * written as invalid JSON.
 */

import type { IR } from './shapes.js';

export const CANONICAL_INDENT = '  ';

export function canonicalJson(value: unknown): string {
  return encode(value, '');
}

/** Canonical JSON for an IR, with exactly one trailing LF. */
export function serializeIR(ir: IR): string {
  return `${canonicalJson(ir)}\n`;
}

function encode(value: unknown, indent: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonical JSON cannot represent a non-finite number');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonical JSON cannot represent a ${typeof value}`);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = indent + CANONICAL_INDENT;
    const items = value.map((item) => inner + encode(item, inner));
    return `[\n${items.join(',\n')}\n${indent}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  if (keys.length === 0) return '{}';

  const inner = indent + CANONICAL_INDENT;
  const entries = keys.map(
    (key) => `${inner}${JSON.stringify(key)}: ${encode(record[key], inner)}`,
  );
  return `{\n${entries.join(',\n')}\n${indent}}`;
}
