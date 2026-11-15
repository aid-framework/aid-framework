/**
 * Where a paused run is written, and what the app emits to read it back.
 *
 * Before this, a paused agent run outlived the HTTP request and not the process: the
 * checkpoint went back to the caller, so an approval arriving on another replica, or after
 * the pod that paused the run was replaced, had nothing to continue. The runtime gained a
 * `RunStore` and a `resume_run`; this pins the half the generator owns -- that the store is
 * actually wired into `build_runtime`, that the response carries the id of the stored run,
 * and that the route which takes that id exists exactly when the spec declared a store.
 *
 * The last two claims are the ones worth having a test for, because they are the ones a
 * plausible mistake would get wrong:
 *
 * 1. **Durability is not conditional on the signing key.** A document may declare a store
 *    without declaring `signingKeyEnv` -- `ir/resume-unsigned` warns about it under
 *    `profile: standard` -- and that document still deserves a run that survives its
 *    process. Deriving the store from `_resume_protection` would withdraw it from exactly
 *    the documents the gate merely warned about.
 * 2. **The emitted text is ruff's canonical form, not merely valid Python.** The two calls
 *    below fit on one line without `retain_seconds` and do not with it, and `ruff format`
 *    collapses a wrapped call that fits. Emitting one fixed shape would make the generated
 *    file one a developer cannot leave alone, so both shapes are asserted.
 */

import { describe, expect, it } from 'vitest';

import { buildForSpecText, fileMap } from './helpers.js';

const AGENTS_PATH = 'app/generated/agents.py';

interface StateOptions {
  /** `state:` at all. False leaves the app with the pre-store contract. */
  store?: boolean;
  /** 'sqlite' or 'postgres'. */
  kind?: string;
  /** Omit `signingKeyEnv`, which is a warning rather than an error under `standard`. */
  signed?: boolean;
  /** `ttlHours`, which is the retention the store prunes by. */
  ttlHours?: number;
}

function spec(options: StateOptions = {}): string {
  const { store = true, kind = 'sqlite', signed = true, ttlHours } = options;
  const state = store
    ? `
state:
  kind: ${kind}
  urlEnv: AID_STATE_DB${signed ? '\n  signingKeyEnv: AID_CHECKPOINT_KEY' : ''}${
    ttlHours === undefined ? '' : `\n  ttlHours: ${ttlHours}`
  }`
    : '';
  return `specVersion: "0.32"

project:
  name: runs
  namespace: aid.test.runs
  description: One pausing agent, for exercising the store a paused run is written to.
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
    maxCostBudget: 0.05
    humanInTheLoop:
      when: "true"
      channel: reviews
${state}`;
}

function agentsModule(options: StateOptions = {}): string {
  const file = fileMap(buildForSpecText(spec(options)).plan.files).get(AGENTS_PATH);
  if (file === undefined) throw new Error(`the plan does not emit ${AGENTS_PATH}`);
  return file;
}

/** `build_runtime`'s body, so a claim about its arguments is not a claim about the module. */
function buildRuntime(source: string): string {
  const start = source.indexOf('def build_runtime(');
  if (start < 0) throw new Error('the module has no build_runtime');
  const end = source.indexOf('\ndef ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe('a spec that declares no store', () => {
  it('keeps the hand-back contract instead of emitting a store nothing reads', () => {
    const module = agentsModule({ store: false });

    // The resume route still exists -- the agent can still pause -- but the app has nowhere
    // to write the run, so it does not claim otherwise.
    expect(module).toContain('@agent_router.post("/agents/resume"');
    expect(module).not.toContain('RunStore');
    expect(module).not.toContain('run_store_from_env');
    expect(module).not.toContain('resume_stored_run');
    expect(module).not.toContain('/agents/runs/');
    expect(buildRuntime(module)).not.toContain('runs=');
  });

  it('does not carry a run id in the response, so no field is always empty', () => {
    const module = agentsModule({ store: false });

    expect(module).not.toContain('run_id');
  });
});

describe('a spec that declares a store', () => {
  it('builds the store per request and passes it to the runtime', () => {
    const module = agentsModule();

    expect(module).toContain('from aid_runtime import (');
    expect(module).toContain('RunStore,');
    expect(module).toContain('run_store_from_env,');
    expect(module).toContain('def _run_store() -> RunStore:');
    expect(module).toContain(
      'return run_store_from_env(CHECKPOINT_STATE_KIND, CHECKPOINT_STATE_URL_ENV)',
    );

    // Read on each call, never at import: a module that opened a database at import could
    // not be imported by a test that only wants `DOCUMENT`.
    expect(module).not.toMatch(/^[a-zA-Z_]+ = run_store_from_env\(/m);
    expect(buildRuntime(module)).toContain('runs=_run_store(),');
  });

  it('names the stored run in the response', () => {
    const module = agentsModule();

    expect(module).toContain('run_id: str = ""');
    expect(module).toContain('run_id=result.run_id,');
  });

  it('routes a resume by id, with the id in the path and no checkpoint in the body', () => {
    const module = agentsModule();

    expect(module).toContain(
      '@agent_router.post("/agents/runs/{run_id}/resume", response_model=AgentRunResponse)',
    );
    expect(module).toContain('async def resume_stored_run(');
    expect(module).toContain(
      'result = await runtime.resume_run(run_id, event.decision, principal=principal)',
    );
    expect(module).toContain('"resume_stored_run",');

    // The body is the decision and nothing else. `extra="forbid"` is what makes that a
    // refusal rather than an ignored field, so a caller cannot smuggle a checkpoint in
    // beside the id.
    const decision = module.slice(
      module.indexOf('class AgentDecisionRequest(BaseModel):'),
      module.indexOf('class AgentRunResponse(BaseModel):'),
    );
    expect(decision).toContain('model_config = ConfigDict(extra="forbid")');
    expect(decision).toContain('decision: HumanDecision');
    expect(decision).not.toContain('checkpoint');
    expect(decision).not.toContain('run_id');
  });

  it('refuses a bad id with the same opaque 403 as a bad checkpoint', () => {
    const module = agentsModule();
    const route = module.slice(module.indexOf('async def resume_stored_run('));

    // One message for every reason: an id that never existed and one already spent must be
    // indistinguishable to the caller, or a guessed id confirms itself by the difference.
    expect(route).toContain('raise HTTPException(status_code=403, detail=RESUME_REFUSED)');
    expect(route).toContain(
      'logger.warning("refused a resume of run %s: %s", run_id, refusal.reason)',
    );
  });

  it('is wired even when the spec declares no signing key', () => {
    const module = agentsModule({ signed: false });

    // `ir/resume-unsigned` warned; the run still has to survive its process.
    expect(module).toContain('_resume_protection()');
    expect(module).toContain('return None, None');
    expect(buildRuntime(module)).toContain('runs=_run_store(),');
  });
});

describe('the retention the store prunes by', () => {
  it('is omitted when the spec declares no `ttlHours`, and the call fits one line', () => {
    const module = agentsModule();

    expect(module).not.toContain('CHECKPOINT_RETAIN_SECONDS');
    expect(module).not.toContain('retain_seconds');
    // Ruff collapses a wrapped call that fits, so one line is the canonical shape here.
    expect(module).toContain(
      '    return run_store_from_env(CHECKPOINT_STATE_KIND, CHECKPOINT_STATE_URL_ENV)\n',
    );
  });

  it('is converted to seconds and passed when `ttlHours` is declared', () => {
    const module = agentsModule({ ttlHours: 24 });

    expect(module).toContain('CHECKPOINT_RETAIN_SECONDS = 86400');
    expect(module).toContain('retain_seconds=CHECKPOINT_RETAIN_SECONDS,');
    // ...and the call no longer fits, so it is exploded the way ruff leaves it.
    expect(module).toContain(
      [
        '    return run_store_from_env(',
        '        CHECKPOINT_STATE_KIND,',
        '        CHECKPOINT_STATE_URL_ENV,',
        '        retain_seconds=CHECKPOINT_RETAIN_SECONDS,',
        '    )',
      ].join('\n'),
    );
  });

  it('is derived from the same declaration the gate compares against the window', () => {
    // `ir/state-retention` refuses a retention shorter than the checkpoint window, so a
    // spec that reaches this point has `ttlHours * 60 >= checkpointTtlMinutes`. Pinning the
    // multiplication is what keeps the gate and the emitted constant from disagreeing
    // about which unit `ttlHours` is in.
    expect(agentsModule({ ttlHours: 1 })).toContain('CHECKPOINT_RETAIN_SECONDS = 3600');
    expect(agentsModule({ ttlHours: 48 })).toContain('CHECKPOINT_RETAIN_SECONDS = 172800');
  });
});
