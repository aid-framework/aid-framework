"""The native agent runtime: a loop, control transfer and delegation, budgets, HITL.

The entry point is :class:`AgentRuntime`. Build it with
:meth:`AgentRuntime.from_ir` from an emitted IR document and call
:meth:`AgentRuntime.run`; a run that stops for a person returns a
:class:`RunResult` whose ``checkpoint`` is what :meth:`AgentRuntime.resume` needs.

Naming, because the IR's two control edges are easy to conflate:

* ``handoffs`` -> :meth:`AgentRuntime._transfer`. Control **moves**; the target
  produces the final answer and the caller does not resume.
* ``delegates`` -> :meth:`AgentRuntime._delegate`. Control is **lent**; the
  delegate returns one observation and the caller produces the final answer.
"""

from __future__ import annotations

from aid_runtime.agents.guardrails import (
    DETECTORS,
    GUARDRAIL_ACTIONS,
    GUARDRAIL_STAGES,
    DecisionAsker,
    Detection,
    GuardrailEngine,
    GuardrailEscalation,
    GuardrailRecord,
    GuardrailVerdict,
    detect,
)
from aid_runtime.agents.ir import (
    AgentDefinition,
    BedrockGuardrailPolicy,
    DecisionDefinition,
    GuardrailDefinition,
    HumanApproval,
    MemoryDefinition,
    RuntimeSpec,
    ToolSpec,
)
from aid_runtime.agents.loop import AgentRuntime
from aid_runtime.agents.managed import (
    MODEL_ARMOR_TEMPLATE_ENV,
    BedrockGuardrailClient,
    GuardrailClient,
    GuardrailOutcome,
    ManagedGuardrailSettings,
    ModelArmorGuardrailClient,
    ModelArmorGuardrailSettings,
    managed_guardrail_settings,
    model_armor_settings,
)
from aid_runtime.agents.memory import (
    IMPLEMENTED_MEMORY_KINDS,
    MEMORY_SCOPES,
    FileMemoryStore,
    InProcessMemoryStore,
    MemoryStore,
    ThreadMemory,
    check_memory_supported,
    render_context,
)
from aid_runtime.agents.policy import Principal, evaluate_policy, policy_source
from aid_runtime.agents.resume import (
    DEFAULT_CHECKPOINT_TTL_MINUTES,
    CheckpointRefusal,
    CheckpointSigner,
    InProcessNonceStore,
    NonceStore,
    PostgresNonceStore,
    SqliteNonceStore,
    nonce_store_for,
    nonce_store_from_env,
    signer_from_env,
)
from aid_runtime.agents.state import (
    AgentCheckpoint,
    CheckpointIntegrity,
    HumanDecision,
    PendingApproval,
    RunResult,
    RunStatus,
    StepKind,
    StepRecord,
)

__all__ = [
    "DETECTORS",
    "DEFAULT_CHECKPOINT_TTL_MINUTES",
    "GUARDRAIL_ACTIONS",
    "GUARDRAIL_STAGES",
    "IMPLEMENTED_MEMORY_KINDS",
    "MEMORY_SCOPES",
    "MODEL_ARMOR_TEMPLATE_ENV",
    "AgentCheckpoint",
    "AgentDefinition",
    "AgentRuntime",
    "BedrockGuardrailClient",
    "BedrockGuardrailPolicy",
    "CheckpointIntegrity",
    "CheckpointRefusal",
    "CheckpointSigner",
    "DecisionAsker",
    "DecisionDefinition",
    "Detection",
    "FileMemoryStore",
    "GuardrailClient",
    "GuardrailDefinition",
    "GuardrailEngine",
    "GuardrailEscalation",
    "GuardrailOutcome",
    "GuardrailRecord",
    "GuardrailVerdict",
    "HumanApproval",
    "HumanDecision",
    "InProcessMemoryStore",
    "InProcessNonceStore",
    "ManagedGuardrailSettings",
    "MemoryDefinition",
    "MemoryStore",
    "ModelArmorGuardrailClient",
    "ModelArmorGuardrailSettings",
    "NonceStore",
    "PendingApproval",
    "Principal",
    "PostgresNonceStore",
    "RunResult",
    "RunStatus",
    "RuntimeSpec",
    "SqliteNonceStore",
    "StepKind",
    "StepRecord",
    "ThreadMemory",
    "ToolSpec",
    "check_memory_supported",
    "detect",
    "evaluate_policy",
    "managed_guardrail_settings",
    "model_armor_settings",
    "nonce_store_for",
    "nonce_store_from_env",
    "policy_source",
    "render_context",
    "signer_from_env",
]
