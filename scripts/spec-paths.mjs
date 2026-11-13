/**
 * Extractors and a resolver for the facts Phase C holds documents to.
 *
 * Both live here rather than in `check-docs-claims.mjs` because that file does its
 * IO and its checking at import time, which makes it untestable. Everything below
 * is pure: it takes text and a schema and returns claims or a verdict.
 */

/** Suffixes that make a dotted token a file path (`agents.py`) or a line cite. */
const SOURCE_EXTENSIONS = new Set([
  'py',
  'pyi',
  'ts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'json',
  'yml',
  'yaml',
  'md',
  'mdx',
  'toml',
  'txt',
  'sh',
  'tf',
  'hcl',
  'lock',
]);

/** `&lt;id&gt;` is a placeholder the author wrote in prose, not a literal key. */
/**
 * @param {string} value
 * @returns {string}
 */
function unescapeHtml(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/**
 * True when a document token is shaped like a spec field path.
 *
 * Deliberately narrow: the first segment must be a top-level schema property, so
 * `app/business/x.py`, `pnpm check` and `resume.token` are never claims about the
 * spec. That keeps the rule to the tokens that would send a reader to a field.
 *
 * @param {string} token
 * @param {(name: string) => boolean} isTopLevel
 */
export function looksLikeSpecPath(token, isTopLevel) {
  if (!token.includes('.')) return false;
  // A line citation (`observability.ts:213`) names a place in the source, not a field.
  if (token.includes(':')) return false;
  const segments = token.split('.');
  if (segments.some((segment) => segment === '')) return false;
  const last = segments.at(-1) ?? '';
  if (SOURCE_EXTENSIONS.has(last.toLowerCase())) return false;
  // `[].` and `[]` are the array/map idiom; the head is still the top-level name.
  const head = (segments[0] ?? '').replace(/\[\]$/, '');
  return isTopLevel(head);
}

/**
 * Backticked tokens in a document that claim to be spec field paths.
 *
 * @param {string} text
 * @param {(name: string) => boolean} isTopLevel
 * @returns {{ token: string, line: number }[]}
 */
export function specPathClaims(text, isTopLevel) {
  /** @type {{ token: string, line: number }[]} */
  const claims = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/`([^`\s]+)`/g)) {
      const token = unescapeHtml(match[1] ?? '');
      if (looksLikeSpecPath(token, isTopLevel)) claims.push({ token, line: index + 1 });
    }
  }
  return claims;
}

/**
 * Names a document asserts are operating profiles.
 *
 * `standard` and `enterprise` are ordinary English words, but the reverse hazard is
 * worse: "the `azure-gpt-4o-mini` profile" is a *cost* profile, so the shape
 * "`name` profile" cannot be read as an operating-profile claim at all. Only
 * unambiguous grammar is checked: an assignment inside a fenced block (where spec
 * examples live), and the "profile `x`" / "profile: `x`" orderings, which no other
 * kind of profile uses in this repository.
 *
 * @param {string} text
 * @returns {{ token: string, line: number }[]}
 */
export function profileClaims(text) {
  /** @type {{ token: string, line: number }[]} */
  const claims = [];
  const lines = text.split('\n');
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const shapes = [/\bprofile\s+`([a-z][a-z0-9-]*)`/g, /\bprofile\s*:\s*`([a-z][a-z0-9-]*)`/g];
    if (fenced) shapes.push(/^\s*profile\s*:\s*`?"?([a-z][a-z0-9-]*)`?"?\s*(?:#.*)?$/g);
    for (const shape of shapes) {
      for (const match of line.matchAll(shape)) {
        const token = match[1] ?? '';
        if (token !== '') claims.push({ token, line: index + 1 });
      }
    }
  }
  return claims;
}

/**
 * Follow a local `$ref`; anything else (remote or absent) comes back as-is.
 *
 * @param {any} schema
 * @param {any} node
 * @returns {any}
 */
function deref(schema, node) {
  let current = node;
  const seen = new Set();
  while (current && typeof current === 'object' && typeof current.$ref === 'string') {
    if (seen.has(current.$ref)) return undefined;
    seen.add(current.$ref);
    const pointer = current.$ref.replace(/^#\//, '').split('/');
    let target = schema;
    for (const part of pointer) target = target?.[part];
    if (target === undefined) return undefined;
    current = target;
  }
  return current;
}

/**
 * Every shape a node may take at this point.
 *
 * A `oneOf` is a union: a path is admitted if any branch admits it, so both the
 * const-marker idiom and the nested idiom are walked the same way.
 *
 * @param {any} schema
 * @param {any[]} nodes
 * @returns {any[]}
 */
function expand(schema, nodes) {
  /** @type {any[]} */
  const out = [];
  /** @param {any} node */
  const visit = (node) => {
    const resolved = deref(schema, node);
    if (!resolved || typeof resolved !== 'object') return;
    // A node may carry its own properties *and* a `oneOf` (the pipeline trigger does),
    // so the union is the branches plus whatever the node declares itself.
    const own = resolved.properties ?? resolved.additionalProperties ?? resolved.items ?? undefined;
    if (Array.isArray(resolved.oneOf)) {
      for (const branch of resolved.oneOf) visit(branch);
      if (own !== undefined) out.push(resolved);
      return;
    }
    out.push(resolved);
  };
  for (const node of nodes) visit(node);
  return out;
}

/**
 * Keys a reader could have written here, for the failure message.
 *
 * @param {any[]} nodes
 * @returns {string[]}
 */
function availableAt(nodes) {
  /** @type {Set<string>} */
  const keys = new Set();
  for (const node of nodes) for (const key of Object.keys(node.properties ?? {})) keys.add(key);
  return [...keys].sort();
}

/**
 * The step from a declared container to one of its members.
 *
 * A map's members are its `additionalProperties`; a list's are its `items`. This is
 * what `deployments[]` and `deployments.api` both mean, so the two spellings cannot
 * drift apart, and `evals[].gate` reads the eval's field instead of inventing an eval
 * named `gate`.
 *
 * @param {any} schema
 * @param {any[]} nodes
 * @returns {any[]}
 */
function memberOf(schema, nodes) {
  /** @type {any[]} */
  const out = [];
  for (const node of expand(schema, nodes)) {
    if (node.type === 'array' || node.items !== undefined) {
      out.push(...expand(schema, [node.items]));
      continue;
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      out.push(...expand(schema, [node.additionalProperties]));
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * Resolve a dotted spec path against the schema.
 *
 * Map members (`deployments.api`) resolve through `additionalProperties`, so an
 * instance name is never a false positive, and the `[]` / `*` / `<id>` forms are
 * member access too rather than an array descent. A path fails when a segment
 * names nothing at the place the previous segment reached, and the failure says
 * which segment and what was available there.
 *
 * @param {any} schema
 * @param {string} token
 * @returns {{ ok: true } | { ok: false, at: string, available: string[] }}
 */
export function resolveSpecPath(schema, token) {
  const segments = token.split('.');
  let nodes = expand(schema, [schema]);
  /** @type {string[]} */
  const walked = [];

  for (const segment of segments) {
    const marked = segment.endsWith('[]');
    const key = unescapeHtml(segment.replace(/\[\]$/, ''));
    // `[]`, `*` and `<id>` all say "a member of whatever this is", never a field name.
    const placeholder = marked || key === '*' || key === '**' || /^<.+>$/.test(key);
    walked.push(key);

    /** @type {any[]} */
    const next = [];
    for (const node of nodes) {
      const resolved = deref(schema, node);
      if (!resolved) continue;

      /** @type {any[]} */
      let matched = [];
      if (resolved.type === 'array' || resolved.items !== undefined) {
        if (placeholder) matched = expand(schema, [resolved.items]);
      } else if (resolved.properties && key in resolved.properties) {
        // The base name is a real field even when the segment carries `[]`.
        matched = expand(schema, [resolved.properties[key]]);
      } else if (
        resolved.additionalProperties &&
        typeof resolved.additionalProperties === 'object'
      ) {
        matched = expand(schema, [resolved.additionalProperties]);
      } else if (placeholder) {
        matched = expand(schema, [resolved]);
      }
      // The marker selects a member, so it descends one level past the container.
      next.push(...(marked ? memberOf(schema, matched) : matched));
    }

    if (next.length === 0) {
      const prefix = walked.slice(0, -1).join('.');
      return {
        ok: false,
        at: prefix === '' ? key : `${prefix}.${key}`,
        available: availableAt(nodes),
      };
    }
    nodes = next;
  }

  return { ok: true };
}
