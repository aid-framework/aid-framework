/**
 * The CLI's exit-code taxonomy, which is a contract with CI rather than a convention.
 *
 * `0` means the command finished *and* the project is in the shape the command asked
 * for; `1` means the command ran but the spec, a gate, the target's compiler or the
 * working tree rejected it; `2` means the command line itself was wrong, or the CLI
 * could not get far enough to judge the project at all. Nothing else is ever returned,
 * and no command maps two different outcomes onto the same code.
 */

export const EXIT_OK = 0;

/** The spec, the gates, the target's plan, or the working tree said no. */
export const EXIT_FAILURE = 1;

/** The invocation was wrong, or the CLI hit an internal failure. */
export const EXIT_USAGE = 2;

export type ExitCode = typeof EXIT_OK | typeof EXIT_FAILURE | typeof EXIT_USAGE;
