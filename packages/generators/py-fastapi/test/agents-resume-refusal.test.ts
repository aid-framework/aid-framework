import { describe, expect, it } from 'vitest';

import { buildForSpecText, fileMap } from './helpers.js';

/**
 * A refused resume must not tell the caller *why* it was refused.
 *
 * The reasons a checkpoint is refused -- `tampered`, `expired`, `unbound`, `replayed`,
 * `unsigned` -- are useful to an operator and an oracle to an unauthenticated caller
 * holding a guessed checkpoint: telling them apart turns one blind attempt into five
 * informed ones. So the distinction goes to the log and the response is one opaque 403,
 * and this file pins both halves of that, on the emitted source rather than the runtime,
 * because the runtime cannot see which of the two a handler chose.
 */

interface Options {
  /** Whether the agent can pause at all, and therefore whether the route is emitted. */
  readonly pause?: boolean;
}

/** One py-fastapi app whose agent either pauses for a person or does not. */
function specText(options: Options = {}): string {
  const pause = options.pause ?? true;
  const approval = pause
    ? `
    humanInTheLoop:
      when: "true"
      channel: reviews`
    : '';
  const state = pause
    ? `
state:
  kind: postgres
  urlEnv: DATABASE_URL
  signingKeyEnv: AID_CHECKPOINT_KEY`
    : '';

  return `specVersion: "0.33"

project:
  name: resumes
  namespace: aid.test.resumes
  description: One agent, for exercising the resume route's refusal.
  targets: [py-fastapi]

types:
  Customer:
    kind: struct
    fields:
      id:
        type: string
        required: true

models:
  triage:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema, tools]
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 400

prompts:
  agent_instructions:
    version: 1
    model: triage
    template: |
      Look the account up, then answer in one sentence.
    output:
      kind: text

tools:
  lookup_customer:
    description: Look up the account that filed a ticket.
    input: Customer
    output: Customer
    handler:
      kind: business
      symbol: lookup_customer
    sideEffects: read

guardrails:
  inspected:
    stages: [tool-call]
    policies: [secret-scan]
    action: block
    onFail:
      message: The call was refused.
      log: true

agents:
  helper:
    name: Helper
    instructions: agent_instructions
    model: triage
    tools: [lookup_customer]
    guardrails: [inspected]
    maxSteps: 4
    maxCostBudget: 0.05${approval}
${state}`;
}

function agentsSource(options: Options = {}): string {
  const source = fileMap(buildForSpecText(specText(options)).plan.files).get(
    'app/generated/agents.py',
  );
  if (source === undefined) throw new Error('the plan wrote no agents.py');
  return source;
}

/** The text of the one message a refused resume is answered with. */
function refusalMessage(source: string): string {
  const match = /^RESUME_REFUSED = (?:"([^"]*)"|'([^']*)')$/m.exec(source);
  if (match === null) throw new Error('the route carries no RESUME_REFUSED message');
  return match[1] ?? match[2] ?? '';
}

describe('the emitted resume refusal', () => {
  it('answers with one opaque status instead of the reason', () => {
    const source = agentsSource();

    expect(source).toContain(
      'raise HTTPException(status_code=403, detail=RESUME_REFUSED) from refusal',
    );
    // The reason exists in the emitted file, but only as a log argument.
    expect(source).toContain('refusal.reason,');
    expect(source).not.toContain('detail=refusal.reason');
    expect(source).not.toContain('detail=str(refusal');
  });

  it('names none of the reasons a caller could learn from', () => {
    const message = refusalMessage(agentsSource());

    for (const reason of ['tampered', 'expired', 'unbound', 'replayed', 'unsigned']) {
      expect(message).not.toContain(reason);
    }
    expect(message).toContain('checkpoint was refused');
  });

  it('logs the reason against the agent and the nonce, where an operator can find it', () => {
    const source = agentsSource();

    expect(source).toContain('#: Refusals are logged here rather than returned');
    expect(source).toContain('logger = logging.getLogger(__name__)');
    expect(source).toContain('"refused a resume for agent %s (nonce %s): %s"');
    expect(source).toContain('checkpoint.integrity.nonce if checkpoint.integrity else None,');
  });

  it('emits no logger at all when no agent can pause', () => {
    // `import logging` is part of the stdlib import block, so a route that needs no log
    // must not drag it in: the block is sorted and hashed, and an unused import fails ruff.
    const source = agentsSource({ pause: false });

    expect(source).not.toContain('RESUME_REFUSED');
    expect(source).not.toContain('import logging');
    expect(source).not.toContain('logging.getLogger');
  });
});
