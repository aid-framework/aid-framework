/**
 * `app/generated/agents.py`: the spec's agents, the runtime built over them, and the
 * HTTP routes that reach it.
 *
 * The runtime ships the loop (`aid_runtime.agents.AgentRuntime`); this module is wiring,
 * not semantics. It carries three things and nothing else:
 *
 * 1. `DOCUMENT` -- the slice of the IR the agent runtime reads, as a Python literal. The
 *    runtime's `from_ir` is the only consumer, so the projection is written by hand here
 *    rather than by dumping the whole IR: a reader can see exactly which declarations
 *    cross the boundary, and a field the runtime does not read cannot sneak across.
 * 2. `build_runtime` -- one constructor over the app's own gateway and executor, so an
 *    agent route and a pipeline route price against the same ledger and call the same
 *    tool objects.
 * 3. The routes. `POST /agents/{agent_id}/run` starts a run. `POST /agents/resume` exists
 *    only when some agent can actually pause -- see below.
 *
 * ## Why the resume route is conditional
 *
 * `RunStatus.PAUSED` is reachable from three independent sources, not one: a declared
 * `humanInTheLoop`, **any called tool with `requiresConfirmation`** (the loop checks the
 * tools before it consults `agent.approval`), and **any guardrail with `action: escalate`**
 * (the loop pauses at the `input`, `output` and `tool-call` stages with no approval
 * involved). Emitting the route only for a declared approval would ship an app that pauses
 * with no way to continue, so `hasResumeRoute` unions all three, and the route exists iff
 * some agent can pause by any of them.
 *
 * ## `/resume` accepts a checkpoint this app signed, and each one only once
 *
 * The body of a resume request *is* the checkpoint the previous call returned, and a
 * checkpoint replays a conversation and its pending tool calls -- including a held write
 * awaiting approval. Whoever holds one can continue that run, so the checkpoint is a bearer
 * capability over it rather than a resource with an owner.
 *
 * From spec 0.32 the route narrows that to something a holder cannot forge: when the spec
 * declares `state.signingKeyEnv`, `build_runtime` signs every checkpoint it returns and
 * `resume` verifies the signature before it continues. The signature covers everything but
 * itself -- the pending call and its arguments, the approval decision, the expiry and the
 * nonce -- so an edited answer, swapped arguments, an extended deadline and a replayed body
 * are each refused with a 403 that names which of the four happened. The nonce is claimed in
 * the store the spec's `state` points at, so a replay is refused by every replica rather
 * than only by the worker that issued the checkpoint.
 *
 * What this does *not* do is decide *who* may resume. No token verification is generated:
 * the app still expects the deployment to authenticate the caller in front of it. What the
 * profile refuses is the unsigned and the replayable case -- `profile: enterprise` makes
 * both errors (`ir/resume-unsigned`, `ir/resume-replay-weak`) and `profile: standard` warns
 * about both, because an unsigned checkpoint is only ever as good as the endpoint that
 * accepts it.
 */

import type {
  AgentShape,
  AgentStateShape,
  GuardrailShape,
  IR,
  MemoryShape,
  ModelShape,
  ToolShape,
} from '@aid-framework/ir';

import { INDENT, MAX_LINE, pythonStatement, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom, tupleLiteral } from '../template.js';
import { agentCanPause, agentModelClosure } from '../validate.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { orderedAgents, orderedGuardrails, orderedMemory, orderedTools } from './order.js';
import { pythonDoc } from './text.js';

export const AGENTS_PATH = `${GENERATED_ROOT}/agents.py`;

/** Whether this app has any agent, and so whether `agents.py` exists at all. */
export function hasAgents(ir: IR): boolean {
  return (ir.agents ?? []).length > 0;
}

/** The agents that can end a run in `PAUSED`, in declared-id order. */
export function pausingAgents(ir: IR): AgentShape[] {
  return orderedAgents(ir).filter((agent) => agentCanPause(ir, agent));
}

/**
 * Whether this app needs the resume route.
 *
 * A property of the spec rather than of the emitted text, so a test can assert it on an
 * IR without diffing a file -- and so the route's presence cannot drift from the
 * predicate that justified it.
 */
export function hasResumeRoute(ir: IR): boolean {
  return pausingAgents(ir).length > 0;
}

/**
 * The store the emitted signer and nonce store read from.
 *
 * One route serves every pausable agent, so one store has to serve all of them, and
 * `ir/resume-key-conflict` is the gate that refuses a document whose pausable agents
 * disagree about the key, the store or the lifetime. Reading one declaration is therefore
 * exact rather than a guess. `agent.state` is the *projected* store -- `buildIR` resolves
 * the document-level `state` into every agent that declares none -- so an override is
 * already visible on the agent it belongs to and this does not walk up to the document.
 *
 * The first *declaring* agent wins rather than the first agent: a document where any
 * pausable agent names a key signs every checkpoint this route issues, which is the
 * stricter of the two readings and never weaker than what was declared. The looser
 * direction -- skipping the key because agent one did not name it -- would withdraw the
 * signature from the agent that asked for one.
 */
function resumeState(ir: IR): AgentStateShape | undefined {
  return pausingAgents(ir)
    .map((agent) => agent.state)
    .find((state) => state !== undefined);
}

/**
 * The declarations the emitted protection reads, as Python module constants.
 *
 * They are emitted rather than inlined so the value the app uses is visible at the top of
 * the file an operator is asked to configure, and so the docstring can point at a name.
 * `None` is a real value here: a spec that declares no `signingKeyEnv` is one that accepted
 * `ir/resume-unsigned`, and the emitted route then behaves exactly as it did before 0.32
 * instead of inventing a key.
 *
 * The lifetime has no `None` form. An undeclared `checkpointTtlMinutes` emits no constant at
 * all and the call omits `ttl_seconds`, so the runtime's own default is the only place the
 * number lives rather than a second copy here that can drift from it.
 */
function resumeConfig(state: AgentStateShape | undefined): string {
  const lines = [
    renderOptionalString('CHECKPOINT_SIGNING_KEY_ENV', state?.signingKeyEnv),
    renderOptionalString('CHECKPOINT_STATE_KIND', state?.kind),
    renderOptionalString('CHECKPOINT_STATE_URL_ENV', state?.urlEnv),
  ];
  if (state?.checkpointTtlMinutes !== undefined) {
    lines.push(`CHECKPOINT_TTL_SECONDS = ${state.checkpointTtlMinutes * 60}`);
  }
  return lines.join('\n');
}

function renderOptionalString(name: string, value: string | undefined): string {
  return `${name}: str | None = ${value === undefined ? 'None' : pythonString(value)}`;
}

function omitUndefined(entries: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

function modelEntry(model: ModelShape): Record<string, unknown> {
  return omitUndefined({
    id: model.id,
    provider: model.provider,
    modelId: model.modelId,
    capabilities: [...model.capabilities],
    limits: omitUndefined({
      contextTokens: model.limits.contextTokens,
      maxOutputTokens: model.limits.maxOutputTokens,
    }),
    costProfile:
      model.costProfile === undefined
        ? undefined
        : {
            inputPerMTok: model.costProfile.inputPerMTok,
            outputPerMTok: model.costProfile.outputPerMTok,
          },
    fallbacks: [...model.fallbacks],
  });
}

function toolEntry(tool: ToolShape): Record<string, unknown> {
  return omitUndefined({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    sideEffects: tool.sideEffects,
    requiresConfirmation: tool.requiresConfirmation,
    auth: tool.auth,
  });
}

function memoryEntry(memory: MemoryShape): Record<string, unknown> {
  return omitUndefined({
    id: memory.id,
    kind: memory.kind,
    scope: memory.scope,
    tokenBudget: memory.tokenBudget,
    backend: memory.backend,
  });
}

function guardrailEntry(guardrail: GuardrailShape): Record<string, unknown> {
  return omitUndefined({
    id: guardrail.id,
    stages: [...guardrail.stages],
    policies: [...guardrail.policies],
    action: guardrail.action,
    redact: [...guardrail.redact],
    tools: [...guardrail.tools],
    onFail: omitUndefined({
      message: guardrail.onFail.message,
      fallbackPrompt: guardrail.onFail.fallbackPrompt,
      log: guardrail.onFail.log,
    }),
  });
}

function agentEntry(agent: AgentShape): Record<string, unknown> {
  return omitUndefined({
    id: agent.id,
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    tools: [...agent.tools],
    memory: [...agent.memory],
    guardrails: [...agent.guardrails],
    maxSteps: agent.maxSteps,
    maxTokensBudget: agent.maxTokensBudget,
    maxCostBudget: agent.maxCostBudget,
    onBudgetExhausted: agent.onBudgetExhausted ?? 'fail',
    handoffs: [...agent.handoffs],
    delegates: [...agent.delegates],
    engine: agent.engine,
    engineVersion: agent.engineVersion,
    humanInTheLoop: agent.humanInTheLoop,
  });
}

/**
 * The IR projection the runtime reads.
 *
 * Every collection an agent references is emitted whole rather than pruned to what one
 * agent names: `from_ir` resolves references and refuses a dangling one by name, and a
 * pruned document would turn that refusal into a claim this module makes silently.
 *
 * `models` is the exception, and it is a narrowing rather than a pruning.
 * `_model` builds a `ModelSpec` for every model in the document and refuses one with no
 * resolved `costProfile`, so a model outside the agent route's reach--the pipeline's
 * embedder, its reranker--would fail the whole document at construction, while emitting
 * every model the route *can* reach is exactly what correctness needs. `agentModelClosure`
 * is that set: each agent's model plus everything reachable through `fallbacks`, which the
 * loop passes to every gateway call. `checkAgents` refuses the closure if any member is
 * unpriced, so nothing is dropped here that was priced.
 *
 * The arrays are in declared-id order so the literal is a property of the IR, not of
 * authoring order.
 *
 * `prompts` is the other exception: it is assigned from the registry next to this literal
 * (see `PROMPT_DOCUMENT`), because the prompt modules already own that text.
 */
export function agentDocument(ir: IR): Record<string, unknown> {
  return {
    models: agentModelClosure(ir).map(modelEntry),
    tools: orderedTools(ir).map(toolEntry),
    memory: orderedMemory(ir).map(memoryEntry),
    guardrails: orderedGuardrails(ir).map(guardrailEntry),
    agents: orderedAgents(ir).map(agentEntry),
  };
}

/**
 * The prompt entries `from_ir` resolves, borrowed from the registry rather than restated.
 *
 * `app/generated/prompts/` owns the prompt text and is the seam a business override
 * replaces, so a second copy here would be a copy an override silently misses: a pipeline
 * would answer with the override while an agent answered with the generated text. The
 * runtime's `PromptTemplate.template` is the same string `from_ir` reads verbatim -- the
 * generator refuses an agent prompt that declares variables, so nothing formats either
 * side and the two representations cannot differ while that refusal holds.
 */
const PROMPT_DOCUMENT = [
  'DOCUMENT["prompts"] = [',
  `${INDENT}{"id": template.name, "template": template.template} for template in TEMPLATES`,
  ']',
].join('\n');

const REQUEST = [
  'class AgentRunRequest(BaseModel):',
  pythonDoc('One user message for one agent.', INDENT),
  `${INDENT}model_config = ConfigDict(extra="forbid")`,
  '',
  `${INDENT}text: str = Field(min_length=1)`,
  `${INDENT}memory_key: str | None = None`,
].join('\n');

const RESUME_REQUEST = [
  'class AgentResumeRequest(BaseModel):',
  pythonDoc(
    'A checkpoint the caller already holds, and the answer to the question it asks. ' +
      'The runtime verifies its signature, its expiry and its nonce before it continues ' +
      'the run; see the module docstring for what that proves and what it does not.',
    INDENT,
  ),
  `${INDENT}model_config = ConfigDict(extra="forbid")`,
  '',
  `${INDENT}checkpoint: dict[str, Any]`,
  `${INDENT}decision: HumanDecision`,
].join('\n');

/**
 * The signer and nonce store, or `(None, None)` when the spec declares no signing key.
 *
 * Both are read from the environment on each call rather than at import, which is how the
 * rest of this app reads its credentials: a supervisor that sets the variable before the
 * first request is the normal deployment shape, and a module that opened a database at
 * import could not be imported by a test that only wants `DOCUMENT`.
 *
 * `(None, None)` is not a fallback that weakens a declared spec -- it is the emitted form of
 * a spec that declared no key, and `ir/resume-unsigned` is the diagnostic that refuses it
 * under `profile: enterprise`. The store is resolved only when a signer exists, because a
 * nonce nothing claims is a variable the app has no reason to demand.
 */
function resumeProtection(ttl: boolean): string {
  const signer =
    ttl === true
      ? 'signer_from_env(CHECKPOINT_SIGNING_KEY_ENV, ttl_seconds=CHECKPOINT_TTL_SECONDS)'
      : 'signer_from_env(CHECKPOINT_SIGNING_KEY_ENV)';
  return [
    'def _resume_protection() -> tuple[CheckpointSigner | None, NonceStore | None]:',
    pythonDoc(
      'The signer and the store that refuses a spent checkpoint, or (None, None) when ' +
        'this spec declares no signing key.',
      INDENT,
    ),
    `${INDENT}if CHECKPOINT_SIGNING_KEY_ENV is None:`,
    `${INDENT}${INDENT}return None, None`,
    `${INDENT}return (`,
    `${INDENT}${INDENT}${signer},`,
    `${INDENT}${INDENT}nonce_store_from_env(CHECKPOINT_STATE_KIND, CHECKPOINT_STATE_URL_ENV),`,
    `${INDENT})`,
  ].join('\n');
}

function buildRuntime(resume: boolean): string {
  const signature = [
    'def build_runtime(',
    `${INDENT}*,`,
    `${INDENT}gateway: ModelGateway,`,
    `${INDENT}tools: Iterable[Tool],`,
    ') -> AgentRuntime:',
    pythonDoc(
      'Build a runtime over this app, reusing the caller-supplied gateway and tools. ' +
        'Taking both as arguments rather than constructing them here is what keeps the agent ' +
        'route on the same ledger, the same provider overrides and the same tool objects as ' +
        'the pipeline routes: `AgentRuntime.from_ir` builds a gateway of its own from a ' +
        'provider mapping, which would put a second ledger and a second set of overrides ' +
        'beside the first, so the document is resolved by `from_ir` and the gateway is passed ' +
        'in instead.',
      INDENT,
    ),
  ];
  if (!resume) {
    return [
      ...signature,
      `${INDENT}return AgentRuntime(from_ir(DOCUMENT), gateway, tools=tools)`,
    ].join('\n');
  }
  return [
    ...signature,
    `${INDENT}signer, nonces = _resume_protection()`,
    `${INDENT}return AgentRuntime(`,
    `${INDENT}${INDENT}from_ir(DOCUMENT),`,
    `${INDENT}${INDENT}gateway,`,
    `${INDENT}${INDENT}tools=tools,`,
    `${INDENT}${INDENT}signer=signer,`,
    `${INDENT}${INDENT}nonces=nonces,`,
    `${INDENT})`,
  ].join('\n');
}

function response(resume: boolean): string {
  return [
    'class AgentRunResponse(BaseModel):',
    pythonDoc(
      'A run that finished, or one that stopped and is asking a question. `checkpoint` is ' +
        'present exactly when `status` is `paused`' +
        (resume ? ', and is what `/agents/resume` takes back.' : '.'),
      INDENT,
    ),
    `${INDENT}model_config = ConfigDict(extra="forbid")`,
    '',
    `${INDENT}agent_id: str`,
    `${INDENT}status: str`,
    `${INDENT}answer: str = ""`,
    `${INDENT}cost_usd: float = 0.0`,
    `${INDENT}total_tokens: int = 0`,
    `${INDENT}pending: dict[str, Any] | None = None`,
    `${INDENT}checkpoint: dict[str, Any] | None = None`,
  ].join('\n');
}

/**
 * One keyword argument of a call whose value is a conditional expression.
 *
 * The wrapped branch is not decoration. Ruff's canonical form for an argument that does
 * not fit on its line is exactly this parenthesised one, but it *collapses* a parenthesised
 * argument that does fit -- so emitting the wrap unconditionally produces a file ruff
 * reformats, and `ruff format --check` fails on generated output. The budget counts the
 * trailing comma, which `pythonStatement`'s does not, because a comma is enough to push a
 * statement one column over.
 */
function conditionalArgument(name: string, subject: string, indent: string): string {
  const value = `None if ${subject} is None else ${subject}.model_dump(mode="json")`;
  const oneLine = `${indent}${name}=${value},`;
  if (oneLine.length <= MAX_LINE) return oneLine;
  return [`${indent}${name}=(`, `${indent}${INDENT}${value}`, `${indent}),`].join('\n');
}

const TO_RESPONSE = [
  'def _response(result: RunResult) -> AgentRunResponse:',
  pythonDoc('A runtime result as the wire shape this module publishes.', INDENT),
  `${INDENT}checkpoint = result.checkpoint`,
  `${INDENT}pending = result.approval`,
  `${INDENT}return AgentRunResponse(`,
  `${INDENT}${INDENT}agent_id=result.agent_id,`,
  `${INDENT}${INDENT}status=str(result.status),`,
  `${INDENT}${INDENT}answer=result.answer,`,
  `${INDENT}${INDENT}cost_usd=result.cost_usd,`,
  `${INDENT}${INDENT}total_tokens=result.total_tokens,`,
  conditionalArgument('pending', 'pending', `${INDENT}${INDENT}`),
  conditionalArgument('checkpoint', 'checkpoint', `${INDENT}${INDENT}`),
  `${INDENT})`,
].join('\n');

const ROUTER = 'agent_router = APIRouter()';

const RUN_ROUTE = [
  '@agent_router.post("/agents/{agent_id}/run", response_model=AgentRunResponse)',
  'async def run_agent(',
  `${INDENT}agent_id: str,`,
  `${INDENT}event: AgentRunRequest,`,
  `${INDENT}deps: Annotated[Deps, Depends(get_deps)],`,
  ') -> AgentRunResponse:',
  pythonDoc(
    'Run one agent to a stop condition on one user message. The 404 is this app answering ' +
      'for its own declarations rather than the runtime raising out of the request.',
    INDENT,
  ),
  `${INDENT}if agent_id not in AGENT_IDS:`,
  `${INDENT}${INDENT}raise HTTPException(status_code=404, detail=f"unknown agent {agent_id!r}")`,
  `${INDENT}runtime = build_runtime(gateway=deps.gateway, tools=deps.agent_tools)`,
  `${INDENT}result = await runtime.run(agent_id, event.text, memory_key=event.memory_key)`,
  `${INDENT}return _response(result)`,
].join('\n');

const RESUME_ROUTE = [
  '@agent_router.post("/agents/resume", response_model=AgentRunResponse)',
  'async def resume_agent(',
  `${INDENT}event: AgentResumeRequest,`,
  `${INDENT}deps: Annotated[Deps, Depends(get_deps)],`,
  ') -> AgentRunResponse:',
  pythonDoc(
    'Continue a paused run. Two different refusals, kept apart on purpose: a body this app ' +
      'did not issue as a checkpoint at all is a 422, and a checkpoint it issued but will not ' +
      'honour -- edited, expired, unsigned, or already spent -- is a 403 carrying ' +
      '`detail.reason`, so a caller can tell which without parsing prose.',
    INDENT,
  ),
  `${INDENT}try:`,
  `${INDENT}${INDENT}checkpoint = AgentCheckpoint.model_validate(event.checkpoint)`,
  `${INDENT}except ValidationError as error:`,
  `${INDENT}${INDENT}raise HTTPException(status_code=422, detail=str(error)) from error`,
  `${INDENT}runtime = build_runtime(gateway=deps.gateway, tools=deps.agent_tools)`,
  `${INDENT}try:`,
  `${INDENT}${INDENT}result = await runtime.resume(checkpoint, event.decision)`,
  `${INDENT}except CheckpointRefusalError as refusal:`,
  `${INDENT}${INDENT}raise HTTPException(`,
  `${INDENT}${INDENT}${INDENT}status_code=403,`,
  `${INDENT}${INDENT}${INDENT}detail={"reason": refusal.reason, "message": str(refusal)},`,
  `${INDENT}${INDENT}) from refusal`,
  `${INDENT}return _response(result)`,
].join('\n');

function exports(ir: IR): string {
  const names = [
    'AGENT_IDS',
    'DOCUMENT',
    'agent_router',
    'build_runtime',
    ...(hasResumeRoute(ir) ? ['resume_agent'] : []),
    'run_agent',
  ].map(pythonString);
  const oneLine = `__all__ = [${names.join(', ')}]`;
  if (oneLine.length <= MAX_LINE) return oneLine;
  return ['__all__ = [', ...names.map((name) => `${INDENT}${name},`), ']'].join('\n');
}

export function emitAgents(ir: IR): EmittedFile {
  const agents = orderedAgents(ir);
  const resume = hasResumeRoute(ir);
  const state = resumeState(ir);
  const ttl = state?.checkpointTtlMinutes !== undefined;
  const ids = agents.map((agent) => pythonString(agent.id));
  return generated(
    AGENTS_PATH,
    assemble([
      HEADER,
      pythonDoc(
        `The agents the \`${ir.project.name}\` app declares: the IR document the runtime ` +
          'reads, the factory that builds it over this app, and the routes that reach it.',
      ),
      importBlock([
        ['from collections.abc import Iterable', 'from typing import Annotated, Any'],
        [
          importFrom('aid_runtime', [
            ...(resume ? ['AgentCheckpoint', 'CheckpointRefusalError', 'CheckpointSigner'] : []),
            'AgentRuntime',
            ...(resume ? ['HumanDecision'] : []),
            'ModelGateway',
            ...(resume ? ['NonceStore', 'nonce_store_from_env', 'signer_from_env'] : []),
            'RunResult',
            'Tool',
          ]),
          importFrom('aid_runtime.agents.ir', ['from_ir']),
          importFrom('fastapi', ['APIRouter', 'Depends', 'HTTPException']),
          importFrom('pydantic', [
            'BaseModel',
            'ConfigDict',
            'Field',
            ...(resume ? ['ValidationError'] : []),
          ]),
        ],
        [importFrom('.deps', ['Deps', 'get_deps']), importFrom('.prompts', ['TEMPLATES'])],
      ]),
      `AGENT_IDS: tuple[str, ...] = ${tupleLiteral(ids, '', 'AGENT_IDS: tuple[str, ...] = ')}`,
      pythonStatement('DOCUMENT: dict[str, Any] = ', agentDocument(ir)),
      PROMPT_DOCUMENT,
      ...(resume ? [resumeConfig(state)] : []),
      REQUEST,
      ...(resume ? [RESUME_REQUEST] : []),
      response(resume),
      ...(resume ? [resumeProtection(ttl)] : []),
      buildRuntime(resume),
      TO_RESPONSE,
      ROUTER,
      RUN_ROUTE,
      ...(resume ? [RESUME_ROUTE] : []),
      exports(ir),
    ]),
  );
}
