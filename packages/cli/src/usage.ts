/**
 * Usage text, rendered from the same flag specs the parser enforces.
 *
 * Help that is written by hand drifts from the parser the first time a flag is added, and
 * a help text listing a flag that does not exist is worse than no help. So one command
 * table is the single source: `main.ts` registers each command with its flags, the parser
 * validates against those flags, and these functions render them.
 */

import type { FlagSpec } from './args.js';

export interface CommandSpec {
  readonly name: string;
  /** One line, shown in the global listing. */
  readonly summary: string;
  /** The invocation shape, as the user would type it. */
  readonly usage: string;
  readonly flags: readonly FlagSpec[];
}

/** The parser treats `help` specially; the help text still has to mention it. */
const HELP: FlagSpec = {
  name: 'help',
  kind: 'boolean',
  summary: "print this command's usage",
};

function flagLabel(flag: FlagSpec): string {
  return flag.kind === 'value' ? `--${flag.name} <${flag.value ?? 'value'}>` : `--${flag.name}`;
}

export function commandUsage(command: CommandSpec): string {
  const flags = [...command.flags, HELP];
  const width = Math.max(...flags.map((flag) => flagLabel(flag).length));
  return [
    `Usage: aid ${command.usage}`,
    '',
    command.summary,
    '',
    'Options:',
    ...flags.map((flag) => `  ${flagLabel(flag).padEnd(width)}  ${flag.summary}`),
    '',
  ].join('\n');
}

export function globalUsage(commands: readonly CommandSpec[]): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  return [
    'aid - the AID Framework CLI.',
    '',
    'Usage: aid <command> [arguments] [options]',
    '',
    'Commands:',
    ...commands.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`),
    '',
    'Every command answers `--json` with one JSON document on stdout and `-h` with its',
    'usage. Exit codes: 0 the project is as asked, 1 the spec, a gate, the target or the',
    'working tree said no, 2 the invocation was wrong or the CLI failed internally.',
    '',
    "Run `aid <command> --help` for a command's options.",
    '',
  ].join('\n');
}
