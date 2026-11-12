"""An agent as an eval subject: run it, and score what it did.

The runner is the seam between a dataset and the agent loop, and it exists so that the
loop does not have to know it is being evaluated. A case goes in, an answer plus the
trajectory comes out, and ``tool-trace`` can then ask whether the run looked the order up
before issuing the refund.

Two things this runner is careful about, because getting either wrong makes an agent eval
say something it cannot back:

**It reports the trajectory or it says nothing.** ``RunOutput.trajectory`` is read off the
steps the loop recorded, so a run that paused at an approval still reports the calls that
asked for it. A runner that returned a bare string would satisfy every text metric and
fail every ``tool-trace`` one, which is the correct outcome: refusing beats passing on
evidence that was never collected.

**It does not answer on the reviewer's behalf.** A run pauses because the spec said a
person must decide. The decisions come from the case (``EvalCase.approvals``), and a case
that pauses without supplying one is refused. The one exception is deliberate and opt-in:
``ApprovalPolicy.APPROVE``/``REJECT`` exist for datasets that are testing something other
than the approval, and they are named so a reader of the eval sees the scripted answer.

What this measures is worth stating plainly, since the module is named after the eval and
not the model. When the provider is a recorded transcript or a scripted fake, the model's
choices are fixed input: the run verifies that the machinery around the model obeys the
spec -- the step ceiling stops the run, an interior tool stays interior, a rejected
approval blocks the call, the spend is attributed to the case. It does not measure whether
a model chooses those calls, because no model is consulted. Verifying model behaviour
needs a pinned provider and belongs with the baselines, not with a gate.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from enum import StrEnum

from aid_runtime.agents.loop import AgentRuntime
from aid_runtime.agents.memory import InProcessMemoryStore
from aid_runtime.agents.state import HumanDecision, RunResult, RunStatus
from aid_runtime.errors import ConfigurationError, EvalError
from aid_runtime.evals.dataset import EvalCase
from aid_runtime.evals.trajectory import RunOutput, Trajectory
from aid_runtime.providers.base import Provider
from aid_runtime.tools import Tool

__all__ = ["AgentEvalRunner", "ApprovalPolicy"]


class ApprovalPolicy(StrEnum):
    """How the harness answers when a run pauses for a person.

    ``FROM_CASE`` is the default and the only policy that claims to model approval: every
    pause consumes the next decision the case declared. The other two exist for datasets
    whose subject is something else, and they are explicit so a reader is not left
    guessing whether a paused case was approved or merely allowed through.
    """

    #: Take each decision from ``EvalCase.approvals``; refuse when the case runs out.
    FROM_CASE = "from-case"
    #: Approve every pause. Only for a case that is not about approval.
    APPROVE = "approve"
    #: Reject every pause.
    REJECT = "reject"


#: How many pauses one case may resume through before the runner calls it a loop. The
#: agent's own ``maxSteps`` bounds the run; this bounds the *harness*, so a case that
#: keeps supplying decisions to a run that keeps pausing cannot spin forever.
_DEFAULT_MAX_RESUMES = 8


class AgentEvalRunner:
    """Turns an :class:`~aid_runtime.evals.dataset.EvalCase` into a :class:`RunOutput`.

    Constructed once per eval and called once per case. The runtime is rebuilt per case
    rather than reused, because the cost ledger, the step counter, and the memory store
    are per-run state: a shared runtime would charge case two for case one's tokens and
    let a later case see an earlier case's thread memory.
    """

    def __init__(
        self,
        document: Mapping[str, object],
        agent_id: str,
        *,
        providers: Mapping[str, Provider],
        tools: Iterable[Tool] = (),
        approval_policy: ApprovalPolicy | str = ApprovalPolicy.FROM_CASE,
        max_resumes: int = _DEFAULT_MAX_RESUMES,
    ) -> None:
        if not providers:
            raise ConfigurationError(
                "an agent eval needs at least one provider: an agent run is model calls, and "
                "a runner with no provider would report an empty trajectory as a real one"
            )
        if max_resumes < 0:
            raise ConfigurationError("max_resumes cannot be negative")
        declared = _declared_agents(document)
        if agent_id not in declared:
            raise ConfigurationError(
                f"no agent {agent_id!r} in the eval's document; declared agents: {sorted(declared)}"
            )
        self._document = document
        self._agent_id = agent_id
        self._providers = dict(providers)
        self._tools = tuple(tools)
        self._policy = ApprovalPolicy(approval_policy)
        self._max_resumes = max_resumes
        #: Cumulative model spend, which is what ``evaluate_once`` differences to charge
        #: each case. Read from the ledger of the most recent run.
        self._cost_usd = 0.0
        self._last: RunResult | None = None

    @property
    def agent_id(self) -> str:
        return self._agent_id

    @property
    def approval_policy(self) -> ApprovalPolicy:
        return self._policy

    @property
    def cost_usd(self) -> float:
        """Total spend across every case so far, so a caller can difference it."""
        return self._cost_usd

    @property
    def last_result(self) -> RunResult | None:
        """The most recent run, for a caller that needs more than the trajectory.

        ``evaluate_once`` only hands a metric the trajectory, so this exists for the
        direct caller -- a walkthrough, a report, or a test -- that wants the status and
        the steps. Metrics do not reach through it.
        """
        return self._last

    async def __call__(self, case: EvalCase) -> RunOutput:
        runtime = self._runtime()
        before = runtime.gateway.ledger.cost_usd
        try:
            result = await runtime.run(self._agent_id, case.input)
            result = await self._settle(runtime, case, result)
        finally:
            # Charged even when the run raised: a case stopped by a guardrail was billed,
            # and a cost series that only saw completed cases would under-report exactly
            # when the guardrails fire.
            self._cost_usd += max(runtime.gateway.ledger.cost_usd - before, 0.0)
        self._last = result
        return RunOutput(text=result.answer, trajectory=Trajectory.from_run(result))

    def _runtime(self) -> AgentRuntime:
        # A fresh memory store per case, for the same reason as the fresh ledger: ``run``
        # keys thread memory on the agent id when the caller passes no ``memory_key``, so a
        # shared store would hand case two the first case's conversation.
        return AgentRuntime.from_ir(
            self._document,
            providers=self._providers,
            tools=self._tools,
            memory_store=InProcessMemoryStore(),
        )

    async def _settle(self, runtime: AgentRuntime, case: EvalCase, result: RunResult) -> RunResult:
        """Resume through every pause the case has decisions for."""
        decisions = iter(case.approvals)
        resumes = 0
        while result.status is RunStatus.PAUSED:
            checkpoint = result.checkpoint
            if checkpoint is None:
                raise EvalError(
                    f"case {case.id!r} is paused but its run carries no checkpoint, so it "
                    "cannot be resumed; the loop must record one before reporting a pause"
                )
            decision = self._decision(case, decisions)
            resumes += 1
            if resumes > self._max_resumes:
                raise EvalError(
                    f"case {case.id!r} paused {self._max_resumes} times and is still asking; "
                    "the case is supplying decisions to a run that is not converging, and "
                    "resuming it again would only multiply the spend"
                )
            result = await runtime.resume(checkpoint, decision)
        return result

    def _decision(self, case: EvalCase, decisions: Iterator[str]) -> HumanDecision:
        if self._policy is ApprovalPolicy.APPROVE:
            return HumanDecision.APPROVE
        if self._policy is ApprovalPolicy.REJECT:
            return HumanDecision.REJECT
        for decision in decisions:
            return HumanDecision(decision)
        raise EvalError(
            f"case {case.id!r} paused for approval and declared no decision for it: add "
            "`approvals` to the case (in order, one per pause) to say what the reviewer "
            "answered, or construct the runner with ApprovalPolicy.APPROVE when this eval "
            "is not about approval"
        )


def _declared_agents(document: Mapping[str, object]) -> set[str]:
    """The ids the document declares, read structurally so a typo fails before case one.

    The full IR parser would answer this too, but it wants the tools registered, and a
    caller that mistyped the agent id should hear about it at construction -- not after a
    fifty-case dataset has charged the budget.
    """
    entries = document.get("agents")
    if not isinstance(entries, list):
        return set()
    return {
        entry["id"]
        for entry in entries
        if isinstance(entry, Mapping) and isinstance(entry.get("id"), str)
    }
