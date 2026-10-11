/**
 * A hand-written parser for the flag grammar this CLI actually has.
 *
 * The whole grammar is a command, positional arguments, and
 * `--flag` / `--flag=value` / `--flag value` options, with `--` ending option parsing.
 * A CLI framework brings a plugin system, a config loader and a help renderer to that,
 * which is more code than the grammar and more surface than the design asks for.
 *
 * The parser is pure: it reports a message and lets the caller decide the exit code.
 */

export interface FlagSpec {
  readonly name: string;
  /** A `value` flag consumes the next argument; a `boolean` flag never does. */
  readonly kind: 'boolean' | 'value';
  /** The placeholder shown in help, for a `value` flag. */
  readonly value?: string;
  readonly summary: string;
}

export function booleanFlag(name: string, summary: string): FlagSpec {
  return { name, kind: 'boolean', summary };
}

export function valueFlag(name: string, value: string, summary: string): FlagSpec {
  return { name, kind: 'value', value, summary };
}

/** Every command answers `--json` with one JSON document and `-h`/`--help` with usage. */
export const JSON_FLAG = booleanFlag('json', 'print one JSON document on stdout');

const HELP_FLAG = booleanFlag('help', "print this command's usage");

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
  readonly help: boolean;
}

export type ParseOutcome =
  | { readonly ok: true; readonly args: ParsedArguments }
  | { readonly ok: false; readonly message: string };

export function parseArguments(argv: readonly string[], flags: readonly FlagSpec[]): ParseOutcome {
  const known = new Map<string, FlagSpec>();
  for (const flag of flags) known.set(flag.name, flag);
  known.set(HELP_FLAG.name, HELP_FLAG);

  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) break;

    if (optionsEnded || !token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (token === '-h') {
      booleans.add(HELP_FLAG.name);
      continue;
    }
    if (!token.startsWith('--')) {
      return { ok: false, message: `unknown option \`${token}\`` };
    }

    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const spec = known.get(name);
    if (spec === undefined) {
      return { ok: false, message: `unknown option \`--${name}\`` };
    }

    if (spec.kind === 'boolean') {
      if (equals !== -1) {
        return { ok: false, message: `\`--${name}\` does not take a value` };
      }
      booleans.add(name);
      continue;
    }

    if (equals !== -1) {
      values.set(name, token.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) {
      return { ok: false, message: `\`--${name}\` needs a value` };
    }
    index += 1;
    values.set(name, next);
  }

  return { ok: true, args: { positionals, values, booleans, help: booleans.has('help') } };
}
