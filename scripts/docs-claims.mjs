/**
 * Pure detectors behind `check-docs-claims.mjs`.
 *
 * Each detector answers one question about a block of prose and returns the
 * claims it found, without knowing which claims are true. The caller compares
 * those claims with the code that enforces them. Keeping the parsing here means
 * the detectors can be tested against a synthetic violating document, so a
 * guard that silently stopped matching is caught rather than passing as a clean
 * repository.
 */

/**
 * The slug VitePress derives from a heading, for the heading shapes this
 * repository writes: backticked identifiers, `kind: value` labels, and prose.
 *
 * @param {string} heading
 * @returns {string}
 */
export function slugifyHeading(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Every heading slug in a Markdown document, ignoring fenced code blocks.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function headingSlugs(text) {
  /** @type {Set<string>} */
  const slugs = new Set();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading !== null) slugs.add(slugifyHeading(heading[1] ?? ''));
  }
  return slugs;
}

/**
 * The opening of a command that names this CLI, allowing the package-runner
 * forms the docs actually use.
 *
 * `npx @aid-framework/cli init` and `aid init` are the same claim about the
 * same command table, so a check that only recognises the bare `aid` spelling
 * leaves the READMEs unguarded -- which is how a retired `--record` survived in
 * `packages/cli/README.md` after it had been corrected in `docs/`.
 */
const INVOCATION =
  /^(?:\$\s+)?(?:(?:npx|pnpm|npm|yarn|bunx)\s+(?:(?:exec|dlx)\s+)?(?:-y\s+|--yes\s+)?)?(?:@aid-framework\/cli|aid)\b/;

/**
 * Every `aid <command>` a document names.
 *
 * Three shapes count: a backticked command in prose, a fenced line that starts
 * with the invocation, and either of those behind a package runner. That skips
 * prose like "AID Framework" and a bare `aid`, which are not command claims.
 *
 * @param {string} text
 * @returns {{ line: number, command: string }[]}
 */
export function commandsNamed(text) {
  /** @type {{ line: number, command: string }[]} */
  const found = [];
  let inFence = false;

  /** @param {number} line @param {string} body */
  function collect(line, body) {
    const invoked = body.match(INVOCATION);
    if (invoked === null) return;
    const command = body.slice(invoked[0].length).match(/^\s+([a-z][a-z0-9-]*)\b/);
    if (command !== null) found.push({ line, command: command[1] ?? '' });
  }

  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      collect(index + 1, line.trim());
      return;
    }
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      collect(index + 1, (span[1] ?? '').trim());
    }
  });
  return found;
}

/**
 * Every backticked token that looks like a target id.
 *
 * The shape is deliberately narrow: a two-letter stack prefix followed by a
 * lowercase name. A token in that shape is a claim about a registered generator,
 * so an unregistered one is a stale name rather than a typo in prose.
 *
 * @param {string} text
 * @param {RegExp} shape
 * @returns {{ line: number, token: string }[]}
 */
export function targetTokens(text, shape) {
  /** @type {{ line: number, token: string }[]} */
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      const token = (span[1] ?? '').trim();
      if (shape.test(token)) found.push({ line: index + 1, token });
    }
  });
  return found;
}

/**
 * Every `--flag` passed to `aid`.
 *
 * The flag has to belong to the invocation: on a fenced line that starts with
 * the invocation, or inside the same backticked span. That is what keeps
 * `node --import ...` or `git commit --amend` from being read as CLI flags when
 * the surrounding sentence happens to mention `aid`.
 *
 * @param {string} text
 * @returns {{ line: number, flag: string }[]}
 */
export function aidFlags(text) {
  /** @type {{ line: number, flag: string }[]} */
  const found = [];
  let inFence = false;

  /** @param {number} line @param {string} body */
  function collect(line, body) {
    const invoked = body.match(INVOCATION);
    if (invoked === null) return;
    for (const match of body.slice(invoked[0].length).matchAll(/--([a-z0-9][a-z0-9-]*)/g)) {
      found.push({ line, flag: match[1] ?? '' });
    }
  }

  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      collect(index + 1, line.trim());
      return;
    }
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      collect(index + 1, (span[1] ?? '').trim());
    }
  });
  return found;
}

/**
 * Exact pins stated in prose, such as `deepagents==0.7.32`.
 *
 * A version written into a sentence is a claim about a manifest the project does
 * not own the only copy of: bumping the dependency without editing the sentence
 * leaves the docs describing a release the runtime no longer builds against.
 * Only backticked pins are read, because a bare `name==1.2.3` in running prose is
 * not the shape anyone writes a claim in.
 *
 * @param {string} text
 * @returns {{ line: number, pin: string }[]}
 */
export function exactPins(text) {
  /** @type {{ line: number, pin: string }[]} */
  const found = [];
  let inFence = false;

  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    for (const span of line.matchAll(/`([a-z][a-z0-9_.-]*==\d+\.\d+\.\d+)`/g)) {
      found.push({ line: index + 1, pin: span[1] ?? '' });
    }
  });
  return found;
}

/** A sentence that states what a named target can do. */
const AFFIRMATIVE = /\b(declare|declares|declaring|support|supports|ship|ships)\b/i;

/**
 * A negation anywhere on the line makes it a refusal, not a capability claim, so
 * "`ts-vercel` does not support `rerank`" is not read as attributing `rerank`.
 */
const NEGATED =
  /\b(?:not|never|no|without|cannot|refuse|refused|refuses|unsupported|deferred|omit|omits|omitted)\b|n't\b/i;

/**
 * Sentences that name a target and a capability together.
 *
 * The line is the unit because a claim is written on one line here; a sentence
 * split across lines would make the reader guess where the claim ends. A line
 * naming several targets claims the capability for all of them.
 *
 * @param {string} text
 * @param {(token: string) => boolean} isTarget
 * @param {Set<string>} knownCapabilities
 * @returns {{ line: number, targets: string[], capabilities: string[] }[]}
 */
export function capabilityClaims(text, isTarget, knownCapabilities) {
  /** @type {{ line: number, targets: string[], capabilities: string[] }[]} */
  const found = [];
  let inFence = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (!AFFIRMATIVE.test(line)) return;
    if (NEGATED.test(line)) return;

    const tokens = [...line.matchAll(/`([^`\n]+)`/g)].map((span) => (span[1] ?? '').trim());
    const targets = tokens.filter((token) => isTarget(token));
    if (targets.length === 0) return;
    const capabilities = tokens.filter((token) => knownCapabilities.has(token));
    if (capabilities.length === 0) return;
    found.push({ line: index + 1, targets, capabilities });
  });
  return found;
}
