/**
 * The command's whole result: what to print, what to embed in `--json`, and what to
 * exit with.
 *
 * Commands return this instead of printing and exiting themselves, so that a command
 * can be asserted on directly and so that `init --gen` can run the generation pipeline
 * and fold its outcome into its own. `ok` is derived from the exit code rather than
 * passed alongside it, because two fields that can disagree eventually will.
 */

import { formatDiagnostics } from '@aid-framework/spec';
import type { CliContext } from './context.js';
import type { CliDiagnostic } from './diagnostics.js';
import type { ExitCode } from './exit.js';
import { EXIT_OK } from './exit.js';

export interface CommandOutcome {
  readonly exitCode: ExitCode;
  /** The `--json` document. */
  readonly report: Record<string, unknown>;
  readonly diagnostics: readonly CliDiagnostic[];
  /** The human rendering on stdout. Empty when there is nothing to say. */
  readonly text: string;
  /**
   * Text a subprocess wrote to its own stderr, carried through to the CLI's stderr.
   *
   * `aid eval` is the only user. It cannot be folded into {@link text}: `--json` swaps
   * stdout for a single JSON document, and an eval that explains on stderr why it could
   * not measure something would have that explanation dropped by the one mode a machine
   * reads.
   */
  readonly stderr?: string;
}

export interface OutcomeInit {
  readonly command: string;
  readonly exitCode: ExitCode;
  readonly fields?: Record<string, unknown>;
  readonly diagnostics?: readonly CliDiagnostic[];
  readonly text?: string;
  readonly stderr?: string;
}

/**
 * Group digits so a reader can count them: `1234567` becomes `1,234,567`.
 *
 * `toLocaleString` would follow the host's locale, which makes a golden test — and a
 * pasted CI log — depend on where the machine thinks it is. This does not.
 */
export function group(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)));
  const sign = value < 0 ? '-' : '';
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ',';
    out += digits[index];
  }
  return sign + out;
}

/**
 * Money, rounded for reading. `digits` is the default of two cents for a total, and callers
 * showing a single cheap model call pass more, because `$0.00` for a real charge is a lie.
 */
export function usd(value: number, digits = 2): string {
  const scale = 10 ** digits;
  const rounded = Math.round(Math.abs(value) * scale) / scale;
  const [whole = '0', fraction = ''] = rounded.toFixed(digits).split('.');
  const negative = value < 0 && rounded !== 0;
  const tail = digits === 0 ? '' : `.${fraction}`;
  return `${negative ? '-' : ''}$${group(Number(whole))}${tail}`;
}

export function outcome(init: OutcomeInit): CommandOutcome {
  const diagnostics = init.diagnostics ?? [];
  return {
    exitCode: init.exitCode,
    diagnostics,
    text: init.text ?? '',
    ...(init.stderr === undefined ? {} : { stderr: init.stderr }),
    report: {
      command: init.command,
      ok: init.exitCode === EXIT_OK,
      ...init.fields,
      diagnostics,
    },
  };
}

/**
 * Print an outcome and hand back its exit code.
 *
 * Diagnostics go to stderr in both modes. In `--json` mode stdout carries exactly one
 * JSON document and nothing else, so that `aid ... --json | jq` is always well formed;
 * the diagnostics are in that document *and* on stderr, which is what a caller piping
 * stdout wants and what a human watching a terminal wants.
 */
export function emit(context: CliContext, json: boolean, command: CommandOutcome): ExitCode {
  if (json) {
    context.stdout(`${JSON.stringify(command.report, null, 2)}\n`);
  } else if (command.text !== '') {
    context.stdout(command.text.endsWith('\n') ? command.text : `${command.text}\n`);
  }
  if (command.stderr !== undefined && command.stderr !== '') {
    context.stderr(command.stderr.endsWith('\n') ? command.stderr : `${command.stderr}\n`);
  }
  if (command.diagnostics.length > 0) {
    context.stderr(formatDiagnostics(command.diagnostics));
  }
  return command.exitCode;
}
