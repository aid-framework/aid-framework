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

from aid_runtime.agents.ir import (
    AgentDefinition,
    HumanApproval,
    MemoryDefinition,
    RuntimeSpec,
    ToolSpec,
)
from aid_runtime.agents.loop import AgentRuntime
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
from aid_runtime.agents.state import (
    AgentCheckpoint,
    HumanDecision,
    PendingApproval,
    RunResult,
    RunStatus,
    StepKind,
    StepRecord,
)

__all__ = [
    "IMPLEMENTED_MEMORY_KINDS",
    "MEMORY_SCOPES",
    "AgentCheckpoint",
    "AgentDefinition",
    "AgentRuntime",
    "FileMemoryStore",
    "HumanApproval",
    "HumanDecision",
    "InProcessMemoryStore",
    "MemoryDefinition",
    "MemoryStore",
    "PendingApproval",
    "Principal",
    "RunResult",
    "RunStatus",
    "RuntimeSpec",
    "StepKind",
    "StepRecord",
    "ThreadMemory",
    "ToolSpec",
    "check_memory_supported",
    "evaluate_policy",
    "policy_source",
    "render_context",
]
