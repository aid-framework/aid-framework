"""The tool calls a run made, in the order it made them.

A prediction is what a pipeline *said*; a trajectory is how an agent got there. Scoring
"did it look the order up before issuing the refund" needs the second, and the agent loop
already records it: every :class:`~aid_runtime.agents.state.StepRecord` carries the tool
names that step called, so the sequence is a flatten, not a new instrumentation point.

:class:`RunOutput` is how a runner hands both back. A runner that returns a plain ``str``
still works and still scores every text metric; what it cannot do is satisfy a
``tool-trace`` metric, which refuses rather than passing over a run it was never told the
tool calls of.

The same holds for approvals. A pause, the decision that answered it, and whether a
rejected call ran anyway are facts about the run that no metric can recover from the
answer text, so a runner that resumes a paused agent records them on the trajectory it
returns. ``approval-respected`` reads them and refuses a trajectory that carries no
record at all.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict, Field

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

    ``steps`` counts model calls, not tool calls: one step can raise several tools, and a
    run that pauses records the step that asked before it stops. The two are separate
    because they answer different questions -- "did it stay inside its step ceiling" is
    about ``steps``, "did it reach for a tool it was told not to use" is about ``calls``.

    ``pauses``, ``decisions`` and ``ignored`` are the approval record. A metric cannot
    reconstruct them from a finished answer: whether a case paused, what the harness
    answered, and whether a call ran after a rejection are all facts only the runner
    observes, so it writes them here.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    calls: tuple[str, ...] = ()
    steps: int = Field(default=0, ge=0)
    pauses: int = Field(default=0, ge=0)
    decisions: tuple[str, ...] = ()
    ignored: tuple[str, ...] = ()

    @classmethod
    def from_steps(cls, steps: Sequence[StepRecord]) -> Trajectory:
        return cls(
            calls=tuple(name for step in steps for name in step.tool_names),
            steps=len(steps),
        )

    @classmethod
    def from_run(
        cls,
        result: RunResult,
        *,
        pauses: int = 0,
        decisions: tuple[str, ...] = (),
        ignored: tuple[str, ...] = (),
    ) -> Trajectory:
        """The trajectory of an agent run, read off the steps it recorded.

        A paused or blocked run still has one: the loop records a step before it decides
        what to do with it, so a run that stopped at an approval records the calls that
        asked for it.

        The keyword arguments carry what only the runner knows. A caller that ran the
        loop directly leaves them at their defaults, which reads as "no approval was
        involved" -- and ``approval-respected`` refuses that reading rather than passing
        on it when the case asked for one.
        """
        return cls(
            calls=tuple(name for step in result.steps for name in step.tool_names),
            steps=len(result.steps),
            pauses=pauses,
            decisions=decisions,
            ignored=ignored,
        )

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
