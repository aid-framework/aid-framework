/**
 * `aid resolve` -- turn one customer overlay into the concrete specification it means.
 *
 * The resolved spec is a build artifact, not code: `aid resolve customers/acme.yaml` prints
 * it, and `--out` writes it where the tree keeps it. Three things follow from that, and
 * they are why the command exists rather than `aid gen --overlay`:
 *
 * - A reviewer can read the concrete spec a customer will be built from without running
 *   a generator, which is the whole point of the overlay being declarative.
 * - Every gate runs on the *resolved* document (see `overlays.ts`), so a refusal names the
 *   customer spec a reader will open next rather than the overlay that produced it.
 * - `--check` compares the artifact in the tree against what the overlay resolves to
 *   today, which is what makes a committed resolved spec reviewable in CI. The path it
 *   compares is derived from the overlay's own path, so the check needs no second flag
 *   and no configuration to drift from the convention.
 *
 * The command writes nothing unless `--out` is given, so the default invocation is safe
 * to run in a pipeline whose stdout is read.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CliContext } from '../context.js';
import { CLI_DIAGNOSTIC_CODES, cliError } from '../diagnostics.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { resolvedPathOf, resolveOverlay } from '../overlays.js';
import { absolutePath } from '../paths.js';

export interface ResolveOptions {
  readonly overlay: string | undefined;
  readonly out: string | undefined;
  readonly check: boolean;
}

export function resolve(context: CliContext, options: ResolveOptions): CommandOutcome {
  const command = 'resolve';

  if (options.overlay === undefined) {
    return outcome({
      command,
      exitCode: EXIT_USAGE,
      diagnostics: [
        cliError({
          code: CLI_DIAGNOSTIC_CODES.resolveOverlayRequired,
          message: 'Name the overlay to resolve.',
          hint: 'Run `aid resolve customers/acme.yaml`.',
        }),
      ],
    });
  }

  const overlayPath = options.overlay;
  const target = options.out ?? (options.check ? resolvedPathOf(overlayPath) : undefined);

  const resolved = resolveOverlay(context, overlayPath);
  const counts = { applied: resolved.applied.length };
  const fields = {
    overlay: overlayPath,
    ...(resolved.customer === undefined ? {} : { customer: resolved.customer }),
    counts,
    ...(target === undefined ? {} : { out: target }),
  };

  if (!resolved.ok) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: resolved.diagnostics,
      text:
        `${overlayPath}: refused` +
        (resolved.customer === undefined ? '' : ` for "${resolved.customer}"`),
    });
  }

  const text = resolved.text ?? '';

  // No artifact named: print the specification. This is the pipeable mode, and it is the
  // one `--check` never uses because a check has nothing to compare.
  if (target === undefined) {
    return outcome({
      command,
      exitCode: EXIT_OK,
      fields,
      diagnostics: resolved.diagnostics,
      text,
    });
  }

  const path = absolutePath(context.cwd, target);
  let existing: string | undefined;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    existing = undefined;
  }
  const current = existing === text;

  if (options.check) {
    if (current) {
      return outcome({
        command,
        exitCode: EXIT_OK,
        fields: { ...fields, status: 'ok' },
        diagnostics: resolved.diagnostics,
        text: `${target}: ok`,
      });
    }
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { ...fields, status: 'outdated' },
      diagnostics: [
        ...resolved.diagnostics,
        cliError({
          code: CLI_DIAGNOSTIC_CODES.resolveOutdated,
          message:
            existing === undefined
              ? `"${target}" is not in the tree, and "${overlayPath}" resolves to it`
              : `"${target}" does not match what "${overlayPath}" resolves to`,
          path: [target],
          hint: `Run \`aid resolve ${overlayPath} --out ${target}\` and commit the result.`,
        }),
      ],
      text: `${target}: outdated`,
    });
  }

  if (current) {
    return outcome({
      command,
      exitCode: EXIT_OK,
      fields: { ...fields, status: 'unchanged' },
      diagnostics: resolved.diagnostics,
      text: `${target}: unchanged`,
    });
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return outcome({
    command,
    exitCode: EXIT_OK,
    fields: { ...fields, status: 'written' },
    diagnostics: resolved.diagnostics,
    text: `wrote ${target} (${counts.applied} override${counts.applied === 1 ? '' : 's'} applied)`,
  });
}
