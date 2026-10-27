/**
 * The two `agent`-step combinations a pipeline cannot honour, pinned rather than assumed.
 *
 * `AgentRuntime.run` can hand back two things an `agent` step has nowhere to put:
 *
 *   1. a **PAUSED** outcome, which carries a checkpoint the *caller* must return on a
 *      resume route. A step's result is a value in the pipeline context, not a route, so
 *      the checkpoint would be dropped and the run would stop with nothing to report.
 *   2. **memory**, which `run` keys by `memory_key or agent.id` when the caller passes
 *      neither. A step passes neither, so every request would read the thread the one
 *      before it wrote.
 *
 * `validate.ts` refuses both. Neither refusal was asserted anywhere: the shipped examples
 * declare neither combination, so both guards could be deleted and the suite stayed
 * green. These three cases are the pin -- the clean app plans, and each refusal names its
 * own reason, so disabling one fails one test rather than none.
 *
 * The fixture is the committed `examples/guarded-reply` spec with a single insertion, so
 * the *only* difference between the passing and failing cases is the thing under test.
 * That app is used because it is the smallest one that already hangs an `agent` step off
 * a pipeline; its own tests own its behaviour, and this file owns only the refusals.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildForSpecText, REPO_ROOT } from './helpers.js';

const SPEC = readFileSync(
  join(REPO_ROOT, 'examples', 'guarded-reply', 'app', 'app.spec.yaml'),
  'utf8',
);

/** The last line of the `triage_agent` block, used as the insertion point. */
const AGENT_TAIL = '    maxCostBudget: 0.02';

/** `SPEC` with `text` inserted after the anchor, failing loudly if the anchor moved. */
function insertAfter(anchor: string, text: string): string {
  if (!SPEC.includes(anchor)) {
    throw new Error(`the fixture's anchor ${JSON.stringify(anchor)} is gone`);
  }
  return SPEC.replace(anchor, anchor + text);
}

/** A `buffer` tier whose id the agent's `memory` list can name. */
const MEMORY_TIER = `
memory:
  thread:
    kind: buffer
    scope: thread
    tokenBudget: 2000
`;

describe('an `agent` step refuses a target the runtime cannot hand back as a value', () => {
  it('plans the same app when the agent can neither pause nor remember', () => {
    // The control. Without it the two cases below could pass on a fixture that is
    // broken for an unrelated reason.
    expect(() => buildForSpecText(SPEC)).not.toThrow();
  });

  it('refuses a pausable agent, because a step has no checkpoint to return', () => {
    const pausable = insertAfter(
      AGENT_TAIL,
      '\n    humanInTheLoop:\n      when: "true"\n      channel: reviews',
    );

    expect(() => buildForSpecText(pausable)).toThrow(
      /can end a run in PAUSED[\s\S]*no checkpoint to return/,
    );
  });

  it('refuses a memory-bearing agent, because a step opens no thread', () => {
    const stateful = insertAfter(AGENT_TAIL, '\n    memory: [thread]') + MEMORY_TIER;

    expect(() => buildForSpecText(stateful)).toThrow(/declares memory, and a step opens no thread/);
  });
});
