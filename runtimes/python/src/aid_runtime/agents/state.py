"""The value types of a run: its steps, its result, and its pause.

These live together because they are one shape: a checkpoint *is* a result that
stopped early, and a resumed result is a checkpoint plus more steps. Keeping them
in one module is also what lets ``agents.loop`` and a caller share the types
without an import cycle.

:class:`AgentCheckpoint` carries the steps completed so far, so a run that paused
and resumed reports the whole transcript of steps rather than only the part that
happened after the resume -- a trace that forgets the pre-pause steps is not a
trace of the run.

``caller`` is the frame that was awaiting a *delegated* result when the pause
happened inside the delegate. Transfer has no caller to return to, which is the
distinction the loop is built on; a transfer checkpoint never has one.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.agents.guardrails import GuardrailEscalation, GuardrailRecord
from aid_runtime.types import Message, ToolCall

__all__ = [
    "AgentCheckpoint",
    "HumanDecision",
    "PendingApproval",
    "RunResult",
    "RunStatus",
    "StepKind",
    "StepRecord",
]


class RunStatus(StrEnum):
    """How a run ended.

    ``PAUSED`` is an outcome, not an error. So is ``BLOCKED``: a human rejected an
    escalation the guardrails raised, which is a decision the run respected rather
    than a failure it suffered.
    """

    COMPLETED = "completed"
    PAUSED = "paused"
    MAX_STEPS = "max-steps"
    BLOCKED = "blocked"


class StepKind(StrEnum):
    """What one model step did with its output."""

    ANSWER = "answer"
    TOOLS = "tools"
    TRANSFER = "transfer"
    DELEGATE = "delegate"


class StepRecord(BaseModel):
    """One model call, and what was done with its output.

    ``degraded_from`` is set only on the step that stepped down the alias ladder,
    so "did this run degrade?" is a question the trace answers without arithmetic.
    """

    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=1)
    agent_id: str
    kind: StepKind
    alias: str
    model: str
    cost_usd: float = Field(ge=0.0)
    total_tokens: int = Field(ge=0)
    tool_names: tuple[str, ...] = ()
    target: str | None = None
    degraded_from: str | None = None


class HumanDecision(StrEnum):
    """What a human answered. Rejection is a normal answer, not an error."""

    APPROVE = "approve"
    REJECT = "reject"


class AgentCheckpoint(BaseModel):
    """Everything a paused agent needs to continue, and nothing that is derived."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    agent_id: str = Field(min_length=1)
    step: int = Field(ge=0)
    messages: tuple[Message, ...]
    steps: tuple[StepRecord, ...] = ()
    calls: tuple[ToolCall, ...] = ()
    channel: str = ""
    when: dict[str, Any] = Field(default_factory=dict)
    # `approve`: `calls` are awaiting a person. `delegate`: `calls` holds the one
    # control call whose delegate paused, and the resumed frame must append the
    # delegate's answer rather than execute anything.
    resume_kind: Literal["approve", "delegate"] = "approve"
    cost_anchor_usd: float = Field(ge=0.0)
    token_anchor: int = Field(ge=0)
    spent_usd: float = Field(ge=0.0)
    spent_tokens: int = Field(ge=0)
    degraded: bool = False
    # The alias the paused frame was actually calling. A resumed run has to keep
    # it: `degraded` records that this run already stepped down, and resuming on
    # the dear alias would silently undo a bounded decision the trace still shows.
    alias: str = ""
    path: tuple[str, ...] = ()
    memory_key: str = ""
    caller: AgentCheckpoint | None = None
    # Set when a guardrail escalated. Its `stage` tells the resume path what to do:
    # an `input` escalation has already been checked, an `output` one holds the
    # answer to release on approval, a `tool-call` one holds `calls` to execute.
    escalation: GuardrailEscalation | None = None
    guardrails: tuple[GuardrailRecord, ...] = ()


class PendingApproval(BaseModel):
    """The question a pause is asking, separated from the resume state."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    agent_id: str
    channel: str
    step: int
    calls: tuple[ToolCall, ...]
    when: dict[str, Any] = Field(default_factory=dict)
    path: tuple[str, ...] = ()
    escalation: GuardrailEscalation | None = None

    @classmethod
    def from_checkpoint(cls, checkpoint: AgentCheckpoint) -> PendingApproval:
        return cls(
            agent_id=checkpoint.agent_id,
            channel=checkpoint.channel,
            step=checkpoint.step,
            calls=checkpoint.calls,
            when=checkpoint.when,
            path=checkpoint.path,
            escalation=checkpoint.escalation,
        )


class RunResult(BaseModel):
    """What a run produced -- including when it produced no answer."""

    model_config = ConfigDict(extra="forbid")

    status: RunStatus
    agent_id: str
    answer: str = ""
    steps: tuple[StepRecord, ...] = ()
    path: tuple[str, ...] = ()
    cost_usd: float = Field(default=0.0, ge=0.0)
    total_tokens: int = Field(default=0, ge=0)
    checkpoint: AgentCheckpoint | None = None
    guardrails: tuple[GuardrailRecord, ...] = ()

    @property
    def completed(self) -> bool:
        return self.status is RunStatus.COMPLETED

    @property
    def degraded(self) -> tuple[tuple[str, str], ...]:
        """``(from, to)`` for every step that stepped down the alias ladder."""
        pairs: list[tuple[str, str]] = []
        for step in self.steps:
            if step.degraded_from is not None:
                pairs.append((step.degraded_from, step.alias))
        return tuple(pairs)

    @property
    def approval(self) -> PendingApproval | None:
        """The question a paused run is asking, or ``None`` when it did not pause."""
        return None if self.checkpoint is None else PendingApproval.from_checkpoint(self.checkpoint)
