/**
 * The docs guard can only be trusted if it can be shown to fail.
 *
 * `check-docs-claims.mjs` compares prose with the code that enforces it, so a
 * detector that silently stopped matching would make a drifting repository look
 * clean. Each detector is therefore tested against a synthetic violating
 * document — the shape of claim it exists to catch — as well as a clean one, and
 * the last block asserts the detectors still find claims in the real tree so a
 * class cannot go vacuous as the docs are rewritten.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  aidFlags,
  capabilityClaims,
  codeAnnotation,
  commandsNamed,
  diagnosticCodes,
  exactPins,
  fileCodeAnnotation,
  headingSlugs,
  isProposalPage,
  proposalStatus,
  slugifyHeading,
  sourceCodeAnnotation,
  targetTokens,
  withoutSourceAnnotations,
} from './docs-claims.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TARGET_SHAPE = /^(?:py|ts)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** @param {string} token */
const isTarget = (token) => token === 'py-fastapi' || token === 'ts-vercel';

/** The capabilities both generators declare today. */
const CAPABILITIES = new Set([
  'http-trigger',
  'streaming',
  'json-schema',
  'tool-calling',
  'otel',
  'embeddings',
  'rerank',
  'guardrails',
  'agents',
  'cursor-memory',
]);

describe('slugifyHeading', () => {
  it('turns the heading shapes this repository writes into VitePress slugs', () => {
    expect(slugifyHeading('`py-fastapi`')).toBe('py-fastapi');
    expect(slugifyHeading('kind: value')).toBe('kind-value');
    expect(slugifyHeading('  Deployments  ')).toBe('deployments');
    expect(slugifyHeading('Load, then serve')).toBe('load-then-serve');
    // A dotted spec path is one word to VitePress: the built page carries
    // `id="agent-humanintheloop"`, so a link that drops the hyphen would break
    // even though it looks like the heading's own spelling.
    expect(slugifyHeading('`agent.humanInTheLoop`')).toBe('agent-humanintheloop');
  });
});

describe('headingSlugs', () => {
  it('collects every heading and ignores fenced code', () => {
    const slugs = headingSlugs(
      ['# Title', '', '```md', '# not a heading', '```', '', '## `py-fastapi`'].join('\n'),
    );

    expect([...slugs]).toStrictEqual(['title', 'py-fastapi']);
  });
});

describe('commandsNamed', () => {
  it('finds a backticked command in prose', () => {
    expect(commandsNamed('Run `aid validate` before you commit.')).toStrictEqual([
      { line: 1, command: 'validate' },
    ]);
  });

  it('finds a command line inside a fence, with or without a shell prompt', () => {
    const found = commandsNamed(
      ['```sh', '$ aid gen --target py-fastapi', 'aid dev', '```'].join('\n'),
    );

    expect(found).toStrictEqual([
      { line: 2, command: 'gen' },
      { line: 3, command: 'dev' },
    ]);
  });

  it('does not mistake the product name or a bare `aid` for a command', () => {
    expect(commandsNamed('AID Framework is declarative. Run `aid` to see help.')).toStrictEqual([]);
  });

  it('catches a command the CLI does not have', () => {
    const found = commandsNamed('Then `aid frobnicate --now` finishes the job.');

    expect(found.map((claim) => claim.command)).toStrictEqual(['frobnicate']);
  });

  it('reads the package-runner spellings as the same command table', () => {
    const found = commandsNamed(
      [
        '```sh',
        'npx @aid-framework/cli init my-app',
        'npx aid validate',
        'pnpm exec aid gen --target ts-vercel',
        'npm exec aid frobnicate',
        '```',
        'Run `npx @aid-framework/cli doctor` too.',
      ].join('\n'),
    );

    expect(found).toStrictEqual([
      { line: 2, command: 'init' },
      { line: 3, command: 'validate' },
      { line: 4, command: 'gen' },
      { line: 5, command: 'frobnicate' },
      { line: 7, command: 'doctor' },
    ]);
  });
});

describe('aidFlags', () => {
  it('finds flags on a line that invokes aid, in prose and in a fence', () => {
    const found = aidFlags(
      [
        'Run `aid infra --iac cdk` to emit one.',
        '```sh',
        'aid gen --target py-fastapi --check',
        '```',
      ].join('\n'),
    );

    expect(found).toStrictEqual([
      { line: 1, flag: 'iac' },
      { line: 3, flag: 'target' },
      { line: 3, flag: 'check' },
    ]);
  });

  it("does not attribute a neighbouring tool's flag to aid", () => {
    expect(aidFlags("`aid eval` passes `ts-loader.ts` as Node's `--import` hook.")).toStrictEqual(
      [],
    );
    expect(aidFlags('git commit --amend and pnpm install --frozen-lockfile')).toStrictEqual([]);
  });

  it('catches a flag the CLI does not define', () => {
    const found = aidFlags('`aid infra --backend cdk` emits a CDK app.');
    const defined = ['infra', 'iac', 'cloud', 'env', 'dry-run', 'check', 'force'];

    expect(found.map((claim) => claim.flag)).toStrictEqual(['backend']);
    expect(found.filter((claim) => !defined.includes(claim.flag))).toHaveLength(1);
  });

  it('catches a retired flag behind a package runner', () => {
    // The exact shape that survived in packages/cli/README.md after `--record`
    // had been corrected everywhere under docs/.
    const found = aidFlags(['```sh', 'npx aid eval --record', '```'].join('\n'));

    expect(found).toStrictEqual([{ line: 2, flag: 'record' }]);
  });
});

describe('targetTokens', () => {
  it('finds registered target ids in prose', () => {
    const found = targetTokens('Deploy to `py-fastapi` or `ts-vercel`.', TARGET_SHAPE);

    expect(found.map((claim) => claim.token)).toStrictEqual(['py-fastapi', 'ts-vercel']);
  });

  it('does not treat a token outside the target shape as a target', () => {
    expect(targetTokens('The `ai-framework` package and `streaming`.', TARGET_SHAPE)).toStrictEqual(
      [],
    );
  });

  it('catches a target-shaped token that names no registered generator', () => {
    const found = targetTokens('Also supported: `py-django`.', TARGET_SHAPE);

    expect(found.map((claim) => claim.token)).toStrictEqual(['py-django']);
    expect(found.filter((claim) => !isTarget(claim.token))).toHaveLength(1);
  });
});

describe('capabilityClaims', () => {
  const known = new Set(['streaming', 'cursor-memory']);

  it('finds a capability attributed to a target', () => {
    const found = capabilityClaims(
      'Both `py-fastapi` and `ts-vercel` declare `streaming`.',
      isTarget,
      known,
    );

    expect(found).toStrictEqual([
      { line: 1, targets: ['py-fastapi', 'ts-vercel'], capabilities: ['streaming'] },
    ]);
  });

  it('ignores a line that names a target without claiming a capability', () => {
    expect(
      capabilityClaims('The `py-fastapi` target is the Python default.', isTarget, known),
    ).toStrictEqual([]);
  });

  it('ignores a line that claims a capability without naming a target', () => {
    expect(
      capabilityClaims('Every service supports `streaming` by default.', isTarget, known),
    ).toStrictEqual([]);
  });

  it('ignores a line that refuses a capability instead of claiming it', () => {
    expect(
      capabilityClaims('`py-fastapi` does not support `cursor-memory`.', isTarget, known),
    ).toStrictEqual([]);
    expect(
      capabilityClaims('`ts-vercel` never shipped `cursor-memory`.', isTarget, known),
    ).toStrictEqual([]);
  });

  it('catches a capability attributed to a target that does not declare it', () => {
    const found = capabilityClaims(
      '`py-fastapi` ships `cursor-memory` out of the box.',
      isTarget,
      known,
    );

    expect(found).toStrictEqual([
      { line: 1, targets: ['py-fastapi'], capabilities: ['cursor-memory'] },
    ]);
    // The checker's rule: a claim is wrong when the named target's manifest
    // omits the capability. py-fastapi declares `streaming` only.
    const declared = ['streaming'];
    const rejected = found.flatMap((claim) =>
      claim.capabilities.filter((capability) => !declared.includes(capability)),
    );
    expect(rejected).toStrictEqual(['cursor-memory']);
  });
});

describe('exactPins', () => {
  it('finds a backticked exact pin in prose', () => {
    const text = [
      'The extra is authoritative.',
      'It declares `deepagents==0.7.32` today.',
      '',
    ].join('\n');
    expect(exactPins(text)).toEqual([{ line: 2, pin: 'deepagents==0.7.32' }]);
  });

  it('ignores a pin inside a fence, where it is sample output rather than a claim', () => {
    expect(exactPins(['```text', 'deepagents==0.7.32', '```', ''].join('\n'))).toEqual([]);
  });

  it('ignores a range, which names no single release to compare', () => {
    expect(exactPins('Install `deepagents>=0.7` or `deepagents~=0.7.32`.').length).toBe(0);
  });

  it('catches a pin the runtime no longer declares', () => {
    const declared = 'deepagents = ["deepagents==0.7.32"]';
    const pins = new Set(['deepagents==0.7.32']);
    expect(declared).toContain('deepagents==0.7.32');
    const claimed = exactPins('Pinned by `deepagents==0.7.33`.');
    expect(claimed.map((claim) => pins.has(claim.pin))).toEqual([false]);
  });
});

describe('the real documents', () => {
  const documents = walkMarkdown();

  it('still contain command, target, and capability claims for the guard to compare', () => {
    const commands = documents.flatMap((file) => commandsNamed(read(file)));
    const targets = documents.flatMap((file) => targetTokens(read(file), TARGET_SHAPE));
    const capabilities = documents.flatMap((file) =>
      capabilityClaims(read(file), isTarget, CAPABILITIES),
    );
    const flags = documents.flatMap((file) => aidFlags(read(file)));
    const pins = documents.flatMap((file) => exactPins(read(file)));

    // If any of these drops to zero the corresponding check has stopped
    // checking anything, which would hide the drift it exists to catch.
    expect(commands.length).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThan(0);
    expect(capabilities.length).toBeGreaterThan(0);
    expect(flags.length).toBeGreaterThan(0);
    expect(pins.length).toBeGreaterThan(0);
  });

  it('include the package READMEs, where install commands live', () => {
    const paths = documents.map((file) => file.replaceAll('\\', '/'));

    expect(paths).toContain('packages/cli/README.md');
    expect(paths).toContain('runtimes/typescript/README.md');
  });

  it('name only generator targets that exist', () => {
    const registered = new Set(readdirSync(join(ROOT, 'packages', 'generators')));

    for (const file of documents) {
      for (const claim of targetTokens(read(file), TARGET_SHAPE)) {
        expect(registered.has(claim.token), `${file}:${claim.line} names ${claim.token}`).toBe(
          true,
        );
      }
    }
  });

  it('carry headings, so a fragment check has something to resolve against', () => {
    expect(headingSlugs(read('docs/reference/spec.md')).size).toBeGreaterThan(0);
  });
});

describe('isProposalPage', () => {
  it('claims only the directory RFCs live in', () => {
    expect(isProposalPage('docs/rfcs/0001-agents-at-scale.md')).toBe(true);
    expect(isProposalPage('docs/rfcs\\0001-agents-at-scale.md')).toBe(true);
    expect(isProposalPage('docs/guide/writing-a-spec.md')).toBe(false);
    expect(isProposalPage('docs/rfcs.md')).toBe(false);
    expect(isProposalPage('packages/cli/README.md')).toBe(false);
  });

  it('does not exempt a guide that merely mentions an rfc', () => {
    expect(isProposalPage('docs/guide/rfcs/0001.md')).toBe(false);
  });
});

describe('proposalStatus', () => {
  it('reads the status a proposal declares', () => {
    expect(proposalStatus('| Field | Value |\n| --- | --- |\n| Status | **Draft** |\n')).toBe(
      '**Draft**',
    );
  });

  it('is undefined for a page that declares none, which is what the guard refuses', () => {
    expect(proposalStatus('# An RFC\n\n| Command | Purpose |\n| --- | --- |\n')).toBeUndefined();
  });

  it('is undefined for a status written as prose rather than a row', () => {
    expect(proposalStatus('Status: draft\n')).toBeUndefined();
  });

  it('finds a status the real RFCs declare', () => {
    const proposals = walkMarkdown().filter((file) => isProposalPage(file));
    expect(proposals.length).toBeGreaterThan(0);
    for (const file of proposals) expect(proposalStatus(read(file))).toBeDefined();
  });
});

/**
 * @param {string} repositoryPath
 * @returns {string}
 */
function read(repositoryPath) {
  return readFileSync(join(ROOT, repositoryPath), 'utf8');
}

describe('diagnosticCodes', () => {
  it('finds a code and the line it is on', () => {
    expect(
      diagnosticCodes('# A page\n\nRefused by `ir/eval-uncovered`, which names the fix.\n'),
    ).toEqual([{ line: 3, token: 'ir/eval-uncovered', wildcard: false }]);
  });

  it('catches an invented code, which is the failure the check exists for', () => {
    const found = diagnosticCodes('`ir/eval-coverage` refuses nothing.\n');
    expect(found).toHaveLength(1);
    expect(found[0]?.token).toBe('ir/eval-coverage');
  });

  it('keeps a wildcard whole instead of reading the stem as a code', () => {
    expect(diagnosticCodes('the `ir/policy-*` family\n')).toEqual([
      { line: 1, token: 'ir/policy-*', wildcard: true },
    ]);
  });

  it('reads a code followed by a full stop as one token', () => {
    const found = diagnosticCodes('It refuses with `cli/doctor-dirty`.\n');
    expect(found[0]?.token).toBe('cli/doctor-dirty');
  });

  it('does not read a file path as a code', () => {
    expect(diagnosticCodes('see `ir/src/gates/promotion.ts:134` and `packages/ir/src`\n')).toEqual(
      [],
    );
  });

  it('does not read a link destination as a code', () => {
    expect(diagnosticCodes('see [the gate](./ir/eval-uncovered)\n')).toEqual([]);
    expect(diagnosticCodes('see <https://example.com/ir/eval-uncovered>\n')).toEqual([]);
  });

  it('finds every namespace', () => {
    const found = diagnosticCodes(
      '`ir/one` `spec/two` `overlay/three` `cli/four` `generator/five`\n',
    );
    expect(found.map((entry) => entry.token.split('/')[0])).toEqual([
      'ir',
      'spec',
      'overlay',
      'cli',
      'generator',
    ]);
  });

  it('ignores a token that is not in a registered namespace', () => {
    expect(diagnosticCodes('`http/not-a-code` and `docs/a-file`\n')).toEqual([]);
  });
});

describe('codeAnnotation', () => {
  it('reads a retired marker and its reason', () => {
    expect(codeAnnotation('| `a/b`<!-- docs-claims: retired; the old name --> |')).toEqual({
      kind: 'retired',
      reason: 'the old name',
    });
  });

  it('reads a family marker', () => {
    expect(codeAnnotation('the `ir/policy-*`<!-- docs-claims: family; shared prefix -->')).toEqual({
      kind: 'family',
      reason: 'shared prefix',
    });
  });

  it('is undefined for a line with no marker, so an unmarked citation is still checked', () => {
    expect(codeAnnotation('`ir/eval-coverage`')).toBeUndefined();
  });

  it('ignores a marker that names another kind', () => {
    expect(codeAnnotation('<!-- docs-claims: allowed; because -->')).toBeUndefined();
  });
});

/**
 * An independent read of the registries: the point of these tests is that the
 * published pages and the source comments resolve, so it re-derives the set rather
 * than trusting the checker's own parser to agree with itself.
 *
 * @returns {Set<string>}
 */
function registered() {
  /** @type {Set<string>} */
  const codes = new Set();
  const registries = [
    'packages/ir/src/diagnostics.ts',
    'packages/spec/src/diagnostics.ts',
    'packages/spec/src/overlay.ts',
    'packages/cli/src/diagnostics.ts',
    'packages/generator-sdk/src/diagnostics.ts',
  ];
  for (const path of registries) {
    for (const match of read(path).matchAll(
      /export const [A-Z0-9_]*DIAGNOSTIC_CODES = \{([\s\S]*?)\n\} as const;/g,
    )) {
      for (const code of (match[1] ?? '').matchAll(/'([a-z]+\/[a-z0-9-]+)'/g)) {
        if (code[1]) codes.add(code[1]);
      }
    }
  }
  return codes;
}

describe('the diagnostic codes the docs cite', () => {
  it('reads all five registries', () => {
    const codes = registered();
    expect(codes.size).toBeGreaterThan(200);
    for (const namespace of ['ir', 'spec', 'overlay', 'cli', 'generator']) {
      expect([...codes].some((code) => code.startsWith(`${namespace}/`))).toBe(true);
    }
  });

  it('resolves every code a published page cites', () => {
    const codes = registered();
    /** @type {string[]} */
    const unresolved = [];
    for (const file of walkMarkdown().filter((path) => !isProposalPage(path))) {
      const lines = read(file).split('\n');
      for (const citation of diagnosticCodes(read(file))) {
        const annotation = codeAnnotation(lines[citation.line - 1] ?? '');
        if (citation.wildcard) {
          const prefix = citation.token.slice(0, -1);
          const family = [...codes].filter((code) => code.startsWith(prefix));
          if (family.length === 0 || annotation?.kind !== 'family') {
            unresolved.push(`${file}:${citation.line}: ${citation.token}`);
          }
          continue;
        }
        if (!codes.has(citation.token) && annotation?.kind !== 'retired') {
          unresolved.push(`${file}:${citation.line}: ${citation.token}`);
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});

/**
 * @returns {string[]}
 */
function walkMarkdown() {
  const files = ['README.md', 'examples/README.md'];

  // Must match `markdownFiles()` in check-docs-claims.mjs: the package and
  // runtime READMEs carry install and per-target claims, so a surface the test
  // skips is a surface where drift is invisible.
  const PRUNED = new Set([
    'node_modules',
    'dist',
    'build',
    '.venv',
    '__pycache__',
    '.pytest_cache',
    // Tool caches `pnpm check` creates beside the trees it lints.
    '.mypy_cache',
    '.ruff_cache',
  ]);

  /** @param {string} directory */
  function walk(directory) {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!PRUNED.has(entry.name)) walk(path);
      } else if (entry.name.endsWith('.md')) {
        files.push(relative(ROOT, join(ROOT, path)));
      }
    }
  }

  for (const directory of ['docs', 'packages', 'runtimes', 'examples']) {
    if (statSync(join(ROOT, directory), { throwIfNoEntry: false }) !== undefined) walk(directory);
  }
  return files;
}

describe('source comments that cite diagnostics', () => {
  it('reads a line-comment marker, a hash marker, and a bare one in a block comment', () => {
    expect(sourceCodeAnnotation('// docs-claims: retired; the old name')).toEqual({
      kind: 'retired',
      reason: 'the old name',
    });
    expect(sourceCodeAnnotation('# docs-claims: family; one prefix, ten codes')).toEqual({
      kind: 'family',
      reason: 'one prefix, ten codes',
    });
    expect(sourceCodeAnnotation(' * families: `ir/policy-*` docs-claims: family; a group')).toEqual(
      {
        kind: 'family',
        reason: 'a group',
      },
    );
  });

  it('is undefined without a marker, so an unmarked citation is still checked', () => {
    expect(sourceCodeAnnotation(' * - `ir/resume-key-alias` — the variable already holds')).toBe(
      undefined,
    );
    expect(sourceCodeAnnotation('// docs-claims: allowed; because')).toBeUndefined();
  });

  /**
   * The defect this check was written for, kept as a fixture: the docstring of
   * `packages/ir/src/gates/resume.ts` named a gate that no registry declares, and the
   * Markdown-only check could not see it. Nothing excuses this line, so the check sees
   * the token, and the registry does not have it — which is exactly the failure.
   */
  it('leaves an unmarked, unregistered code visible to the check', () => {
    const line = ' * - `ir/resume-secret-inline` — the signing key must be named';

    expect(sourceCodeAnnotation(line)).toBeUndefined();
    expect(diagnosticCodes(withoutSourceAnnotations(line)).map((code) => code.token)).toEqual([
      'ir/resume-secret-inline',
    ]);
    expect(registered().has('ir/resume-secret-inline')).toBe(false);
    expect(registered().has('ir/resume-key-alias')).toBe(true);
  });

  it('reports a wildcard as a wildcard, so an unnamed family cannot pass as a code', () => {
    const line = ' * the derived number of registered `ir/policy-*` codes.';
    const found = diagnosticCodes(withoutSourceAnnotations(line));

    expect(found.map((code) => code.wildcard)).toEqual([true]);
    expect(registered().has('ir/policy-*')).toBe(false);
  });

  it('does not scan the reason a marker carries', () => {
    const line = ' * signing families docs-claims: family; covers ir/policy-* and ir/predicate-*';

    expect(diagnosticCodes(withoutSourceAnnotations(line))).toEqual([]);
  });

  it('reads a file-wide marker and the line it sits on', () => {
    const text = '/**\n * Purpose.\n *\n * docs-claims-file: family; it defines the syntax\n */\n';

    expect(fileCodeAnnotation(text)).toEqual({
      line: 4,
      kind: 'family',
      reason: 'it defines the syntax',
    });
  });

  it('does not find a file-wide marker past the header', () => {
    const text = `${'\n'.repeat(20)}// docs-claims-file: family; too far down\n`;

    expect(fileCodeAnnotation(text)).toBeUndefined();
  });
});
