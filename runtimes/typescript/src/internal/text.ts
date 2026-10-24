/**
 * Small string helpers that are deliberately not written with regular expressions.
 *
 * Every function here takes arbitrary-length input, and a regex with a quantifier
 * costs steps proportional to the run it consumes: `/\/+$/` on a string of a hundred
 * thousand slashes is a polynomial number of steps for a one-line trim. Scans are
 * linear whatever arrives, so these call sites cannot be turned into a denial of
 * service by the value they are handed.
 */

/**
 * Drop every trailing `/`.
 *
 * Mirrors `/\/+$/` exactly, including the degenerate `'https://'` -> `'https:'`:
 * stripping is unconditional, so a URL that is nothing but a scheme loses its `//`.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}
