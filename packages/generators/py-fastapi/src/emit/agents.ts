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
 * ## `/resume` is a bearer capability, and that is a deliberate Phase 2 position
 *
 * The body of a resume request *is* the checkpoint the previous call returned, and a
 * checkpoint replays a conversation and its pending tool calls. Whoever holds one can
 * continue that run, so the checkpoint is a bearer capability over it rather than a
 * resource with an owner. Authentication and authorization are Phase 3's; until then this
 * route refuses nothing, and the risk is recorded in the PR that shipped it rather than
 * left for a reader to discover.
 */

import type {
  AgentShape,
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
      'The checkpoint carries the run, so this request is a bearer capability over it; ' +
      'see the module docstring.',
    INDENT,
  ),
  `${INDENT}model_config = ConfigDict(extra="forbid")`,
  '',
  `${INDENT}checkpoint: dict[str, Any]`,
  `${INDENT}decision: HumanDecision`,
].join('\n');

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

const BUILD_RUNTIME = [
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
  `${INDENT}return AgentRuntime(from_ir(DOCUMENT), gateway, tools=tools)`,
].join('\n');

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
    'Continue a paused run. The checkpoint is validated into the runtime type first, so a body ' +
      'this app did not issue is a 422 rather than a runtime error mid-conversation.',
    INDENT,
  ),
  `${INDENT}try:`,
  `${INDENT}${INDENT}checkpoint = AgentCheckpoint.model_validate(event.checkpoint)`,
  `${INDENT}except ValidationError as error:`,
  `${INDENT}${INDENT}raise HTTPException(status_code=422, detail=str(error)) from error`,
  `${INDENT}runtime = build_runtime(gateway=deps.gateway, tools=deps.agent_tools)`,
  `${INDENT}result = await runtime.resume(checkpoint, event.decision)`,
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
            ...(resume ? ['AgentCheckpoint'] : []),
            'AgentRuntime',
            ...(resume ? ['HumanDecision'] : []),
            'ModelGateway',
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
      REQUEST,
      ...(resume ? [RESUME_REQUEST] : []),
      response(resume),
      BUILD_RUNTIME,
      TO_RESPONSE,
      ROUTER,
      RUN_ROUTE,
      ...(resume ? [RESUME_ROUTE] : []),
      exports(ir),
    ]),
  );
}
