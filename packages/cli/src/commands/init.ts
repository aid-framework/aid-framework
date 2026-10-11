/**
 * `aid init` — scaffold a project: a starter spec and a README.
 *
 * It does not generate. `aid gen` generates, and `--gen` is the convenience for the one
 * thing a person types next; keeping the two apart is what makes "scaffold" and "compile"
 * separately testable and separately re-runnable.
 *
 * Two deliberate refusals, because scaffolding is the command most likely to be pointed at
 * a directory that already has something in it:
 *
 * - An existing spec is not overwritten without `--force`. That file is the project's
 *   source of truth; replacing it silently is the worst thing this command could do.
 * - An existing README is left exactly as it is, and reported as skipped -- under `--force`
 *   too. A README is the file a directory is most likely to already have, its contents are
 *   the author's, and `--force` here is usually aimed at the spec.
 *
 * `--from <spec>` imports a spec rather than copying one: the imported text has to lower to
 * an IR and pass the gates before anything is written, so `aid init --from` cannot produce a
 * project that `aid validate` immediately rejects.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { CliContext } from '../context.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { absolutePath, parentPath } from '../paths.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import type { Target } from '../targets.js';
import { resolveTarget, unknownTargetDiagnostic } from '../targets.js';
import { generate } from './gen.js';

export interface InitOptions {
  readonly dir: string | undefined;
  readonly from: string | undefined;
  readonly target: string | undefined;
  readonly force: boolean;
  readonly gen: boolean;
}

/**
 * Lower-case a directory name, keep only `[a-z0-9]`, and collapse every run of anything
 * else into a single `-`.
 *
 * A loop rather than a regular expression on purpose: trimming with `/^-+|-+$/g` after
 * collapsing is quadratic on a name that is mostly separators, and the directory name is
 * input this command does not control. Emitting the separator only between two kept
 * characters means the result can never begin or end with one, so no trim pass is needed.
 */
function slugify(name: string): string {
  let slug = '';
  let separatorPending = false;
  for (const character of name.toLowerCase()) {
    if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9'))) {
      separatorPending = true;
      continue;
    }
    if (separatorPending && slug !== '') slug += '-';
    separatorPending = false;
    slug += character;
  }
  return slug;
}

/**
 * A `project.name` from a directory name. The spec's pattern is `^[a-z][a-z0-9-]{0,63}$`,
 * and a directory called `My App` or `2024-prototype` is not a reason to fail `aid init`
 * with a schema error about a field the caller never wrote.
 */
export function projectNameFor(directory: string): string {
  const slug = slugify(basename(directory)).slice(0, 64);
  if (slug === '') return 'app';
  const first = slug.charAt(0);
  return first >= 'a' && first <= 'z' ? slug : `app-${slug}`.slice(0, 64);
}

export function starterSpec(target: string, projectName: string): string {
  return [
    'specVersion: "0.1"',
    '',
    '# This file is the source of truth: `aid gen` compiles it into app/generated/,',
    '# `aid validate` checks it, and `aid eval` gates the behaviour it declares.',
    'project:',
    `  name: ${projectName}`,
    '  targets:',
    `    - ${target}`,
    '',
  ].join('\n');
}

function starterReadme(projectName: string, target: Target): string {
  return [
    `# ${projectName}`,
    '',
    `An AID Framework project targeting \`${target.name}\`. \`${target.specPath}\` is the source`,
    'of truth: the types, prompts, tools, pipelines and evals the application is made of.',
    '',
    '```bash',
    'aid validate        # parse the spec, reduce it to the IR, run every build-time gate',
    'aid gen             # compile the spec and reconcile the tree with it',
    'aid gen --dry-run   # report what would change, and write nothing',
    'aid eval            # run the eval gate',
    '```',
    '',
    `\`${target.generatedDir}/\` is owned by the generator: \`aid gen\` writes it, and refuses to`,
    'overwrite it once you have edited it, keeping the rejected bytes beside the file.',
    `\`${target.businessDir}/\` is yours: \`aid gen\` creates a file there once and never touches it`,
    'again.',
    '',
  ].join('\n');
}

/**
 * Create a file, reporting whether this call is the one that created it.
 *
 * The exclusive flag makes the create itself the existence check, so a file that appears
 * between a probe and a write cannot be clobbered -- a check-then-act refusal is not a
 * refusal. Returns `false` when the path already exists, and rethrows anything else.
 */
function createExclusively(path: string, data: string): boolean {
  try {
    writeFileSync(path, data, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST'
  );
}

export function init(context: CliContext, options: InitOptions): CommandOutcome {
  const command = 'init';
  const target = resolveTarget(options.target);
  if (target === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [unknownTargetDiagnostic(options.target ?? '')],
    });
  }

  const root = options.dir === undefined ? context.cwd : resolve(context.cwd, options.dir);
  const specPath = target.specPath;
  const displayed = options.dir ?? '.';
  const fields = { dir: displayed, target: target.name, spec: specPath };

  const source =
    options.from === undefined
      ? { ok: true as const, text: starterSpec(target.name, projectNameFor(root)) }
      : readSpec(context, options.from);
  if (!source.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: source.diagnostics });
  }

  // Checked against the path the spec will actually live at, so the diagnostics carry the
  // file the reader will open rather than the one it was imported from.
  const lowered = lowerSpec(source.text, specPath);
  if (!lowered.ok) {
    return outcome({ command, exitCode: EXIT_FAILURE, fields, diagnostics: lowered.diagnostics });
  }

  const specAbsolute = absolutePath(root, specPath);
  const written: string[] = [];
  const skipped: string[] = [];

  mkdirSync(absolutePath(root, parentPath(specPath)), { recursive: true });

  // Created exclusively so that "does it already exist" and "write it" are one syscall. The
  // refusal holds even if the file appears between a check and a write, and no separate
  // `existsSync` has to stay true for the guarantee to mean anything. `--force` is the one
  // path meant to replace the file, so it writes normally; nothing else reaches the write.
  if (!createExclusively(specAbsolute, source.text)) {
    if (!options.force) {
      return outcome({
        command,
        exitCode: EXIT_FAILURE,
        fields,
        diagnostics: [
          cliError({
            code: CLI_DIAGNOSTIC_CODES.refusingToOverwrite,
            message: `"${specPath}" already exists.`,
            path: [specPath],
            hint: 'Pass --force to overwrite it, or run `aid gen` to regenerate from the spec that is already there.',
          }),
        ],
      });
    }
    writeFileSync(specAbsolute, source.text, 'utf8');
  }
  written.push(specPath);

  // A README is the one file written here whose contents are the caller's, so it is
  // created once and then never replaced -- not even under `--force`, which is passed
  // routinely just to overwrite a spec. Replacing prose a person wrote as a side effect
  // of resetting a spec is not what `--force` was asked for.
  const readmeAbsolute = join(root, 'README.md');
  if (createExclusively(readmeAbsolute, starterReadme(projectNameFor(root), target))) {
    written.push('README.md');
  } else {
    skipped.push('README.md');
  }

  // The generation runs against the scaffolded project root, not the caller's working
  // directory: `aid init sub/project --gen` must generate into `sub/project`.
  const generation = options.gen
    ? generate(
        { ...context, cwd: root },
        { spec: specPath, target: target.name, dryRun: false, force: false },
      )
    : undefined;

  const text = [
    ...written.map((path) => `created ${path}`),
    ...skipped.map((path) => `kept ${path} (already there; it is never replaced)`),
    ...(generation === undefined ? ['next: aid validate, then aid gen'] : [generation.text]),
  ].filter((line) => line !== '');

  return outcome({
    command,
    exitCode: generation?.exitCode ?? EXIT_OK,
    diagnostics: [...lowered.diagnostics, ...(generation?.diagnostics ?? [])],
    text: text.join('\n'),
    fields: { ...fields, written, skipped, generation: generation?.report ?? null },
  });
}
