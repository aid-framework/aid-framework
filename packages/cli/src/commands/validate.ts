/**
 * `aid validate` — parse the spec, reduce it to the IR, and run every build-time gate.
 *
 * This is the "is this spec buildable" question, asked without touching the tree and
 * without asking the target to compile anything. It stops at the first stage that
 * produced an error, because lowering a spec whose own schema did not validate reports a
 * cascade of consequences of the first mistake and buries it. Warnings from the stages
 * that did run are kept and printed: the eval-coverage gate warns by design, and a
 * validation that swallowed warnings would make a deliberate signal invisible.
 *
 * `aid gen` asks the same question and then goes further, into the target's compiler and
 * its plan. So a spec can pass `aid validate` and still fail `aid gen` -- that is the
 * honest split, and it is why the two commands report their own stage rather than
 * pretending to be one command with a flag.
 */

import { countBySeverity } from '@aid-framework/spec';

import type { CliContext } from '../context.js';
import { EXIT_FAILURE, EXIT_OK } from '../exit.js';
import type { CommandOutcome } from '../output.js';
import { outcome } from '../output.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import { DEFAULT_SPEC_PATH } from '../targets.js';

export interface ValidateOptions {
  readonly spec: string | undefined;
}

export function validate(context: CliContext, options: ValidateOptions): CommandOutcome {
  const command = 'validate';
  const specPath = options.spec ?? DEFAULT_SPEC_PATH;

  const read = readSpec(context, specPath);
  if (!read.ok) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields: { spec: specPath },
      diagnostics: read.diagnostics,
    });
  }

  const lowered = lowerSpec(read.text, specPath);
  const counts = countBySeverity(lowered.diagnostics);
  const fields = { spec: specPath, counts };

  if (!lowered.ok) {
    return outcome({
      command,
      exitCode: EXIT_FAILURE,
      fields,
      diagnostics: lowered.diagnostics,
      text: `${specPath}: ${counts.error} error(s), ${counts.warning} warning(s)`,
    });
  }

  return outcome({
    command,
    exitCode: EXIT_OK,
    fields,
    diagnostics: lowered.diagnostics,
    text: `${specPath}: ok (${counts.error} errors, ${counts.warning} warnings)`,
  });
}
