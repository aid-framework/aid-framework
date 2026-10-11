/**
 * The one place an emitter is allowed to say "this cannot be missing".
 *
 * Every emitter runs only after :func:`checkPlan` returned no problems, so a lookup
 * that fails here is a generator bug rather than a bad spec. Funnelling that through
 * one function keeps the emitters free of scattered non-null assertions -- which
 * Biome flags, and which would silently emit `undefined` into Python source.
 */
export function require<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`internal: ${what} is missing after validation; this is a generator bug`);
  }
  return value;
}
