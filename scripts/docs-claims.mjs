/**
 * Pure detectors behind `check-docs-claims.mjs`.
 *
 * Each detector answers one question about a block of prose and returns the
 * claims it found, without knowing which claims are true. The caller compares
 * those claims with the code that enforces them. Keeping the parsing here means
 * the detectors can be tested against a synthetic violating document, so a
 * guard that silently stopped matching is caught rather than passing as a clean
 * repository.
 *
 * docs-claims-file: family; it defines the syntax those worked examples are written in
 */

/**
 * The slug VitePress derives from a heading, for the heading shapes this
 * repository writes: backticked identifiers, `kind: value` labels, and prose.
 * Punctuation becomes a hyphen, not nothing -- so `agent.humanInTheLoop` is
 * `#agent-humanintheloop`, which is what the built site emits.
 *
 * @param {string} heading
 * @returns {string}
 */
export function slugifyHeading(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]+/gu, '-')
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
 * How far into a file a file-wide marker may sit. A header, not a haystack: a marker a
 * thousand lines in would be a comment nobody reviewing the file's purpose would read.
 */
const FILE_ANNOTATION_WINDOW = 15;

/**
 * The namespaces a diagnostic code can belong to, each backed by a
 * `*DIAGNOSTIC_CODES` constant in the package that emits it.
 */
export const DIAGNOSTIC_NAMESPACES = Object.freeze(['ir', 'spec', 'overlay', 'cli', 'generator']);

/**
 * A diagnostic code, or a family of them written with a trailing `*`.
 *
 * The surrounding guards are what keep this from matching a file path: a token may
 * not be preceded by a path character and may not be followed by `/`, so
 * `ir/src/gates/promotion.ts` is a path rather than a code named `ir/src`. A
 * trailing `.` is allowed, because a code often ends a sentence, and a trailing `*`
 * is captured rather than left behind, so `ir/policy-*` is one token and not the
 * code `ir/policy-` followed by an asterisk.
 */
const DIAGNOSTIC_CODE = new RegExp(
  String.raw`(?<![\w/.-])(?:${DIAGNOSTIC_NAMESPACES.join('|')})\/[a-z0-9][a-z0-9-]*\*?(?![\w/-])`,
  'g',
);

/**
 * A Markdown link destination, or an autolink, replaced by spaces of the same
 * length so column positions survive. A path in a link target is a link, not a
 * citation: `[...](./ir/eval-uncovered)` names a file.
 *
 * @param {string} line
 * @returns {string}
 */
function withoutLinkTargets(line) {
  return line
    .replace(/\]\([^)\s]*\)/g, (match) => ' '.repeat(match.length))
    .replace(/<https?:\/\/[^>\s]*>/g, (match) => ' '.repeat(match.length));
}

/**
 * Every diagnostic code a document cites, including the wildcard form.
 *
 * A code is a claim that a named gate exists, so it is checked against the
 * registry rather than trusted — which is the failure this detector exists to
 * catch: a page citing a gate that was never registered reads exactly like one
 * citing a gate that is.
 *
 * Fenced blocks are scanned, unlike the prose detectors above: sample `aid validate`
 * output cites codes, and it is published claims of the same kind.
 *
 * @param {string} text
 * @returns {{ line: number, token: string, wildcard: boolean }[]}
 */
export function diagnosticCodes(text) {
  /** @type {{ line: number, token: string, wildcard: boolean }[]} */
  const found = [];
  text.split('\n').forEach((raw, index) => {
    for (const match of withoutLinkTargets(raw).matchAll(DIAGNOSTIC_CODE)) {
      const token = match[0];
      found.push({ line: index + 1, token, wildcard: token.endsWith('*') });
    }
  });
  return found;
}

/**
 * The line-level marker that says a code-shaped token is not a citation of a
 * registered gate.
 *
 * Two kinds, and no others. `retired` marks a code that a migration note names on
 * purpose, in the column describing what the old release said. `family` marks a
 * wildcard, such as `ir/policy-*`, that stands for a group of registered codes.
 * Each requires a written reason, because this marker is the one place a bad
 * citation could hide, and a reason is what a reviewer reads.
 *
 * The marker is an HTML comment, so the published page does not show it.
 *
 * @param {string} line
 * @returns {{ kind: string, reason: string } | undefined}
 */
export function codeAnnotation(line) {
  const match = line.match(/<!--\s*docs-claims:\s*(retired|family);\s*(.*?)\s*-->/);
  if (match === null) return undefined;
  return { kind: match[1] ?? '', reason: (match[2] ?? '').trim() };
}

/**
 * The same marker, written in a source file's own comment syntax.
 *
 * A docstring in product code cites diagnostics the same way a page does, and drifted
 * the same way: `packages/ir/src/gates/resume.ts` described a gate that no registry
 * declares, and nothing failed, because the citation check only read Markdown. Source
 * comments are not published, so the marker is a line comment, and the same two kinds
 * and the same written reason apply.
 *
 * Both `//` and `#` are accepted because the runtime is Python and the packages are
 * TypeScript, and a check that only understood one would silently cover half the tree.
 *
 * @param {string} line
 * @returns {{ kind: string, reason: string } | undefined}
 */
export function sourceCodeAnnotation(line) {
  const match = line.match(/(?:\/\/|#)?\s*docs-claims:\s*(retired|family);\s*(.*?)\s*$/);
  if (match === null) return undefined;
  return { kind: match[1] ?? '', reason: (match[2] ?? '').trim() };
}

/**
 * A file-wide marker for source that has to name unresolvable tokens to do its job.
 *
 * The citation checker and this parser hold the regular expression that recognises a
 * code, so their own comments spell tokens that resolve to nothing. Marking those lines
 * one by one would put markers inside the text that explains markers, so a file may opt
 * out once, in its header, with a reason. Every file that does is printed by the check,
 * so the exemption is visible in the build log rather than buried in code.
 *
 * @param {string} text
 * @returns {{ line: number, kind: string, reason: string } | undefined}
 */
export function fileCodeAnnotation(text) {
  const lines = text.split('\n').slice(0, FILE_ANNOTATION_WINDOW);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/(?:\/\/|#)?\s*docs-claims-file:\s*(retired|family);\s*(.*?)\s*$/);
    if (match === null) continue;
    return { line: index + 1, kind: match[1] ?? '', reason: (match[2] ?? '').trim() };
  }
  return undefined;
}

/**
 * A source line with its marker removed, so the reason a reviewer wrote is not itself
 * scanned for codes. A reason reads like prose and may well name the family it excuses.
 *
 * @param {string} line
 * @returns {string}
 */
export function withoutSourceAnnotations(line) {
  return line.replace(/(?:\/\/|#)?\s*docs-claims(?:-file)?:\s*(?:retired|family);.*$/, '');
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

/**
 * Whether a document is a design proposal rather than a description of what ships.
 *
 * An RFC exists to name commands, flags and constructs that do not exist yet -- that is what
 * proposing means -- so holding one to "every command it names is in `COMMANDS`" would force
 * every proposal to be vague about its own deliverables. The caller skips only the two
 * *existence* comparisons for these files; links, target names and pins are still checked,
 * because a broken link or an unregistered generator is wrong in a proposal too.
 *
 * The exclusion is not a hole: `proposalStatus` below requires the document to declare its own
 * status, so a file cannot land under `docs/rfcs/` and be read as a promise. A page whose status
 * says it is implemented has no business being an RFC.
 *
 * @param {string} file repository-relative path
 * @returns {boolean}
 */
export function isProposalPage(file) {
  return file.replace(/\\/g, '/').startsWith('docs/rfcs/');
}

/** The status a proposal page declares in its front table, or `undefined`. */
const STATUS_ROW = /^\|\s*Status\s*\|\s*(.+?)\s*\|\s*$/m;

/**
 * The stated status of a proposal page, or `undefined` when it declares none.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
export function proposalStatus(text) {
  return text.match(STATUS_ROW)?.[1];
}
