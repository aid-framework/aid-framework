"""The tool calls a run made, in the order it made them.

A prediction is what a pipeline *said*; a trajectory is how an agent got there. Scoring
"did it look the order up before issuing the refund" needs the second, and the agent loop
already records it: every :class:`~aid_runtime.agents.state.StepRecord` carries the tool
names that step called, so the sequence is a flatten, not a new instrumentation point.

:class:`RunOutput` is how a runner hands both back. A runner that returns a plain ``str``
still works and still scores every text metric; what it cannot do is satisfy a
``tool-trace`` metric, which refuses rather than passing over a run it was never told the
tool calls of.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict

if TYPE_CHECKING:
    # Type-only: this module reaches into a record's shape, never its definitions, so
    # importing the agent package at runtime would only buy an import cycle.
    from aid_runtime.agents.state import RunResult, StepRecord

__all__ = ["RunOutput", "Trajectory"]


class Trajectory(BaseModel):
    """Every tool call a run made, flattened into the order they happened.

    Deliberately just the names, not arguments or results: an expectation is written
    against *what* a run did, and pinning the arguments of a model-authored call would
    make the assertion fail on a paraphrase that was equally correct.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    calls: tuple[str, ...] = ()

    @classmethod
    def from_steps(cls, steps: Sequence[StepRecord]) -> Trajectory:
        return cls(calls=tuple(name for step in steps for name in step.tool_names))

    @classmethod
    def from_run(cls, result: RunResult) -> Trajectory:
        """The trajectory of an agent run, read off the steps it recorded.

        A paused or blocked run still has one: the loop records a step before it decides
        what to do with it, so a run that stopped at an approval records the calls that
        asked for it.
        """
        return cls.from_steps(result.steps)

    def __bool__(self) -> bool:
        return bool(self.calls)


class RunOutput(BaseModel):
    """An answer, plus how the run arrived at it.

    Returning this instead of a bare string is the whole opt-in for trajectory evals: a
    runner that has nothing to say about tool calls keeps returning ``str``.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    text: str
    trajectory: Trajectory = Trajectory()
