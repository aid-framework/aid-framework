/**
 * The agent engine: IR, guardrails, memory, and the loop.
 *
 * Mirrors the Python package's `aid_runtime.agents`. Both engines are here: the native
 * loop, and the opt-in `deepagents` backend that runs the harness at the pinned release
 * behind our gateway, guardrails and tool executor. Agent-span tracing is still decision
 * D-7.
 */

export {
  checkEngine,
  DEEPAGENTS,
  DEEPAGENTS_DISTRIBUTION,
  DEEPAGENTS_EXTRA,
  DEEPAGENTS_PIN,
  ENGINES,
  installedDeepagentsVersion,
  NATIVE,
} from './engine.js';
export {
  ACTION_BLOCK,
  ACTION_ESCALATE,
  ACTION_FLAG,
  ACTION_REDACT,
  DETECTORS,
  type Detection,
  detect,
  fired,
  type GuardrailAction,
  GuardrailEngine,
  type GuardrailEscalation,
  type GuardrailRecord,
  type GuardrailStage,
  type GuardrailVerdict,
} from './guardrails.js';
export {
  type AgentDefinition,
  fromIr,
  GUARDRAIL_ACTIONS,
  GUARDRAIL_POLICIES,
  GUARDRAIL_STAGES,
  type GuardrailDefinition,
  type HumanApproval,
  hasControlTools,
  type MemoryDefinition,
  RuntimeSpec,
  stageGuardrails,
  type ToolSpec,
} from './ir.js';
export { AgentRuntime, CONTROL_ARGUMENT, DELEGATE_PREFIX, TRANSFER_PREFIX } from './loop.js';
export {
  checkMemorySupported,
  FileMemoryStore,
  IMPLEMENTED_MEMORY_KINDS,
  InProcessMemoryStore,
  MEMORY_SCOPES,
  type MemoryStore,
  renderContext,
  ThreadMemory,
} from './memory.js';
export {
  type AgentCheckpoint,
  checkpointFromJson,
  checkpointsEqual,
  checkpointToJson,
  type HumanDecision,
  type PendingApproval,
  pendingApprovalFrom,
  RUN_STATUSES,
  RunResult,
  type RunStatus,
  STEP_KINDS,
  type StepKind,
  type StepRecord,
} from './state.js';
