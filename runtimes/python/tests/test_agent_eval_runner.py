"""An agent as an eval subject: the runner that feeds the trajectory metrics.

The runner's job is narrow and the tests are arranged around its two failure modes. It must
report the trajectory it actually observed -- a run that called a tool and one that did not
have to be distinguishable, or ``tool-trace`` scores an absence it never measured. And it
must not answer a pause on the reviewer's behalf: a case that supplies no decision is a
case the harness cannot score, so it refuses.

The approval tests are the reason this file exists separately from the trajectory metric
tests. Pausing and resuming is where a scripted eval most easily tells a comfortable lie,
because an auto-approved run looks exactly like a run that never needed approval.
"""

from __future__ import annotations

from typing import Any, cast

import pytest
from pydantic import ValidationError

from agent_support import AUTHENTICATED, recording_tool, solo, tool_def
from aid_runtime import (
    AgentEvalRunner,
    ApprovalPolicy,
    ApprovalRespected,
    ConfigurationError,
    EvalCase,
    EvalError,
    FakeProvider,
    Provider,
    RecordedProvider,
    RecordingProvider,
    RunStatus,
    ScriptedTurn,
    ToolTrace,
    evaluate_once,
)
from aid_runtime.agents import HumanDecision
from aid_runtime.evals.dataset import Dataset
from aid_runtime.providers.recorded import Transcript

PROVIDER = "fake"
PROMPT = "You refund orders and nothing else."
QUESTION = "Refund order 4471."


def _agent(**agent_fields: Any) -> dict[str, Any]:
    """One agent, one searchable tool, scripted by the caller's fake."""
    return solo(
        prompt=PROMPT,
        tool_specs=[tool_def("t1", "search")],
        tools=["t1"],
        **agent_fields,
    )


def _gated(**agent_fields: Any) -> dict[str, Any]:
    """The same agent, except every step waits for a person.

    ``isAuthenticated()`` is true for the default principal, which makes it the
    unconditional ``when`` a spec can actually express -- there is no ``kind: always``.
    """
    return _agent(hitl={"when": AUTHENTICATED, "channel": "ops"}, **agent_fields)


def _provider(*turns: ScriptedTurn) -> FakeProvider:
    return FakeProvider(name=PROVIDER, script=list(turns))


def _runner(
    document: dict[str, Any],
    provider: Provider,
    *,
    tools: Any = None,
    policy: ApprovalPolicy | str = ApprovalPolicy.FROM_CASE,
    max_resumes: int = 8,
) -> AgentEvalRunner:
    """A runner over ``document``, registering ``search`` unless the test says otherwise.

    Registering the documented tool by default keeps every test driving a document whose
    declared tools are present. A test that cares about the tool passes its own recorder.
    """
    registered = (recording_tool()[0],) if tools is None else tools
    return AgentEvalRunner(
        document,
        "solo",
        providers={PROVIDER: provider},
        tools=registered,
        approval_policy=policy,
        max_resumes=max_resumes,
    )


class TestTrajectory:
    async def test_reports_the_tools_the_run_called_in_order(self) -> None:
        tool, recorder = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        runner = _runner(_agent(), provider, tools=(tool,))

        output = await runner(EvalCase(id="refund", input=QUESTION))

        assert output.text == "refunded"
        assert output.trajectory.calls == ("search",)
        assert recorder.queries == ["4471"]

    async def test_reports_no_trajectory_for_a_run_that_never_called_a_tool(self) -> None:
        """An empty trajectory is a finding, not a missing measurement."""
        provider = _provider(ScriptedTurn.answer("refunded"))
        runner = _runner(_agent(), provider)

        output = await runner(EvalCase(id="refund", input=QUESTION))

        assert output.trajectory.calls == ()
        assert not output.trajectory

    async def test_reports_every_call_across_several_steps(self) -> None:
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.tools(("search", {"query": "status"}), ("search", {"query": "total"})),
            ScriptedTurn.answer("refunded"),
        )
        tool, _ = recording_tool()
        runner = _runner(_agent(max_steps=6), provider, tools=(tool,))

        output = await runner(EvalCase(id="refund", input=QUESTION))

        assert output.trajectory.calls == ("search", "search", "search")

    async def test_scores_tool_trace_through_the_harness(self) -> None:
        """The end-to-end claim: a trajectory reaches a metric through evaluate_once."""
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        tool, _ = recording_tool()
        runner = _runner(_agent(), provider, tools=(tool,))
        dataset = Dataset(
            name="refunds", version="1", cases=(EvalCase(id="refund", input=QUESTION),)
        )

        # Ordered: the expectation only passes if the call happened, in that sequence.
        result = await evaluate_once(dataset, runner, [ToolTrace(expect=["search"], ordered=True)])

        assert result.outcomes[0].scores[0].passed
        assert result.outcomes[0].trajectory is not None
        assert result.outcomes[0].trajectory.calls == ("search",)

    async def test_a_missing_expected_tool_fails_rather_than_passes(self) -> None:
        provider = _provider(ScriptedTurn.answer("refunded"))
        runner = _runner(_agent(), provider)
        dataset = Dataset(name="refunds", version="1", cases=(EvalCase(id="c1", input=QUESTION),))

        result = await evaluate_once(dataset, runner, [ToolTrace(expect=["search"])])

        assert not result.outcomes[0].scores[0].passed

    async def test_the_wrong_order_fails_an_ordered_expectation(self) -> None:
        # Two distinct tools, so order is observable: one tool name twice in the same
        # sequence cannot distinguish correct order from reversed.
        document = solo(
            prompt=PROMPT,
            tool_specs=[tool_def("t1", "search"), tool_def("t2", "refund")],
            tools=["t1", "t2"],
            max_steps=6,
        )
        provider = _provider(
            ScriptedTurn.tool("refund", {"order": "4471"}),
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        search, _ = recording_tool("search")
        refund, _ = recording_tool("refund", answer="ok")
        runner = _runner(document, provider, tools=(search, refund))
        dataset = Dataset(name="d", version="1", cases=(EvalCase(id="c1", input=QUESTION),))

        result = await evaluate_once(
            dataset, runner, [ToolTrace(expect=["search", "refund"], ordered=True)]
        )

        assert not result.outcomes[0].scores[0].passed


class TestCost:
    async def test_reports_cumulative_spend_so_the_harness_can_difference_it(self) -> None:
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        tool, _ = recording_tool()
        runner = _runner(_agent(), provider, tools=(tool,))

        await runner(EvalCase(id="c1", input=QUESTION))
        first = runner.cost_usd
        await runner(EvalCase(id="c2", input=QUESTION))

        assert first > 0.0
        assert runner.cost_usd > first

    async def test_a_second_case_does_not_inherit_the_first_cases_spend(self) -> None:
        """A shared ledger would charge case two for case one's tokens."""
        provider = _provider(
            ScriptedTurn.answer("refunded"),
            ScriptedTurn.answer("refunded"),
        )
        runner = _runner(_agent(), provider)

        await runner(EvalCase(id="c1", input=QUESTION))
        assert runner.last_result is not None
        first_run = runner.last_result.cost_usd
        first_total = runner.cost_usd

        await runner(EvalCase(id="c2", input=QUESTION))
        assert runner.last_result is not None

        # The second run was charged the same as the first, and the cumulative total grew
        # by exactly that much -- not by twice it, which is what a carried-over ledger does.
        assert first_run > 0.0
        assert runner.last_result.cost_usd == pytest.approx(first_run)
        assert runner.cost_usd == pytest.approx(first_total + first_run)


class TestApproval:
    async def test_resumes_a_pause_with_the_decision_the_case_supplied(self) -> None:
        tool, recorder = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        runner = _runner(_gated(), provider, tools=(tool,))

        output = await runner(EvalCase(id="refund", input=QUESTION, approvals=("approve",)))

        assert runner.last_result is not None
        assert runner.last_result.status is RunStatus.COMPLETED
        assert output.text == "refunded"
        assert recorder.queries == ["4471"]

    async def test_a_rejection_prevents_the_call_and_keeps_the_pre_pause_steps(self) -> None:
        """The trajectory must include the call that *asked* for approval.

        A rejected tool call is not a failed run: the loop hands the model
        ``rejected by the human approver`` as the tool result and the model answers. What
        the rejection has to be observable as is the tool *not running*, which is why the
        assertion is on the recorder rather than on the status.
        """
        tool, recorder = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("I could not look that order up."),
        )
        runner = _runner(_gated(), provider, tools=(tool,))

        output = await runner(EvalCase(id="refund", input=QUESTION, approvals=("reject",)))

        assert runner.last_result is not None
        assert runner.last_result.status is RunStatus.COMPLETED
        assert recorder.queries == []
        assert output.trajectory.calls == ("search",)
        assert output.text == "I could not look that order up."

    async def test_refuses_a_pause_the_case_did_not_answer(self) -> None:
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        runner = _runner(_gated(), provider)

        with pytest.raises(EvalError) as raised:
            await runner(EvalCase(id="refund", input=QUESTION))

        message = str(raised.value)
        assert "declared no decision" in message
        assert "ApprovalPolicy.APPROVE" in message

    async def test_an_explicit_policy_answers_without_a_case_decision(self) -> None:
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        tool, _ = recording_tool()
        runner = _runner(_gated(), provider, tools=(tool,), policy=ApprovalPolicy.APPROVE)

        output = await runner(EvalCase(id="refund", input=QUESTION))

        assert output.text == "refunded"

    async def test_a_reject_policy_rejects_without_a_case_decision(self) -> None:
        tool, recorder = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("blocked by policy"),
        )
        runner = _runner(_gated(), provider, tools=(tool,), policy=ApprovalPolicy.REJECT)

        await runner(EvalCase(id="refund", input=QUESTION))

        assert runner.last_result is not None
        assert recorder.queries == []

    async def test_decisions_are_consumed_in_order(self) -> None:
        """Two pauses, two decisions: the first is spent on the first pause.

        A harness that reused one decision, or took the last one, would let a rejected
        second call through and quietly score a run the reviewer actually stopped.
        """
        tool, recorder = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "first"}),
            ScriptedTurn.tool("search", {"query": "second"}),
            ScriptedTurn.answer("refunded"),
        )
        runner = _runner(_gated(max_steps=6), provider, tools=(tool,))

        output = await runner(EvalCase(id="c1", input=QUESTION, approvals=("approve", "reject")))

        assert runner.last_result is not None
        assert runner.last_result.status is RunStatus.COMPLETED
        # The approved call ran; the rejected one did not.
        assert recorder.queries == ["first"]
        assert output.trajectory.calls == ("search", "search")


class TestApprovalRecord:
    """What the runner writes down about a pause, which is all `approval-respected` sees.

    A metric cannot tell an approved run from a run that never needed approval, so if the
    runner does not record the pause the metric has nothing to judge. These tests pin that
    record, and the last two pin the difference between "a rejection held" and "a rejection
    was crossed" -- the only finding of the three that is a safety result.
    """

    async def test_records_the_pause_and_the_decision_that_answered_it(self) -> None:
        tool, _ = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        runner = _runner(_gated(), provider, tools=(tool,))

        output = await runner(EvalCase(id="refund", input=QUESTION, approvals=("approve",)))

        assert output.trajectory.pauses == 1
        assert output.trajectory.decisions == ("approve",)
        assert output.trajectory.ignored == ()

    async def test_records_no_pause_for_a_run_that_never_needed_one(self) -> None:
        provider = _provider(ScriptedTurn.answer("refunded"))
        runner = _runner(_agent(), provider)

        output = await runner(EvalCase(id="refund", input=QUESTION))

        assert output.trajectory.pauses == 0
        assert output.trajectory.decisions == ()

    async def test_a_held_rejection_is_not_reported_as_ignored(self) -> None:
        """The call asked for approval and did not run, which is the machinery working."""
        tool, recorder = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("I could not look that order up."),
        )
        runner = _runner(_gated(), provider, tools=(tool,))

        output = await runner(EvalCase(id="refund", input=QUESTION, approvals=("reject",)))

        assert recorder.queries == []
        assert output.trajectory.decisions == ("reject",)
        assert output.trajectory.ignored == ()

    async def test_a_rejection_lifted_by_a_later_approval_is_not_ignored(self) -> None:
        """A retried call that a second decision approved did not cross the first one.

        Without subtracting the later approval, the reappearing call name would be read as
        a rejection that was ignored -- a safety finding reported against a run a reviewer
        actually authorised.
        """
        tool, recorder = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        runner = _runner(_gated(max_steps=6), provider, tools=(tool,))

        output = await runner(
            EvalCase(id="refund", input=QUESTION, approvals=("reject", "approve"))
        )

        assert recorder.queries == ["4471"]
        assert output.trajectory.pauses == 2
        assert output.trajectory.decisions == ("reject", "approve")
        assert output.trajectory.ignored == ()

    async def test_an_approved_run_scores_approval_respected_through_the_harness(self) -> None:
        """The end-to-end claim: the record reaches the metric through evaluate_once."""
        tool, _ = recording_tool()
        provider = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        runner = _runner(_gated(), provider, tools=(tool,))
        case = EvalCase(id="refund", input=QUESTION, approvals=("approve",))
        dataset = Dataset(name="refunds", version="1", cases=(case,))

        result = await evaluate_once(dataset, runner, [ApprovalRespected()])

        assert result.outcomes[0].scores[0].passed

    async def test_a_decision_the_run_never_asked_for_fails_through_the_harness(self) -> None:
        """The same metric, over a case whose pause the document never gates."""
        provider = _provider(ScriptedTurn.answer("refunded"))
        runner = _runner(_agent(), provider)
        case = EvalCase(id="refund", input=QUESTION, approvals=("approve",))
        dataset = Dataset(name="refunds", version="1", cases=(case,))

        result = await evaluate_once(dataset, runner, [ApprovalRespected()])

        assert not result.outcomes[0].scores[0].passed
        assert result.outcomes[0].scores[0].detail.startswith("pause-missed:")


class TestRefusal:
    def test_a_runner_with_no_provider_is_refused(self) -> None:
        with pytest.raises(ConfigurationError) as raised:
            AgentEvalRunner(_agent(), "solo", providers={})

        assert "at least one provider" in str(raised.value)

    def test_a_negative_resume_ceiling_is_refused(self) -> None:
        with pytest.raises(ConfigurationError):
            AgentEvalRunner(_agent(), "solo", providers={PROVIDER: _provider()}, max_resumes=-1)

    def test_an_unknown_agent_id_is_refused_before_the_first_case(self) -> None:
        """A typo'd id must fail at construction, not after the dataset has spent budget."""
        with pytest.raises(ConfigurationError) as raised:
            AgentEvalRunner(_agent(), "absent", providers={PROVIDER: _provider()})

        assert "absent" in str(raised.value)
        assert "solo" in str(raised.value)

    def test_a_case_rejects_an_unknown_approval_word(self) -> None:
        with pytest.raises(ValidationError):
            EvalCase(id="c1", input=QUESTION, approvals=("maybe",))

    def test_a_single_approval_string_is_coerced_to_one_decision(self) -> None:
        # The case validator coerces before it validates, so a lone string is legal JSON a
        # dataset may hold. `cast` keeps the widening deliberate rather than accidental.
        case = EvalCase(id="c1", input=QUESTION, approvals=cast(Any, "approve"))

        assert case.approvals == (HumanDecision.APPROVE,)


class TestReplay:
    async def test_a_recorded_transcript_drives_the_run_without_a_vendor(self) -> None:
        """Record once against a scripted fake, then gate on the bytes forever."""
        tool, _ = recording_tool()
        document = _agent()
        live = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        recorder_provider = RecordingProvider(live)

        recorded = await _runner(document, recorder_provider, tools=(tool,))(
            EvalCase(id="refund", input=QUESTION)
        )
        transcript: Transcript = recorder_provider.transcript()
        replayed_tool, replayed_recorder = recording_tool()

        replayed = await _runner(document, RecordedProvider(transcript), tools=(replayed_tool,))(
            EvalCase(id="refund", input=QUESTION)
        )

        assert replayed.text == recorded.text == "refunded"
        assert replayed.trajectory.calls == recorded.trajectory.calls == ("search",)
        assert replayed_recorder.queries == ["4471"]

    async def test_a_changed_prompt_stops_a_replayed_run(self) -> None:
        """The gate that makes replay worth trusting: a stale recording refuses."""
        from aid_runtime import ReplayDivergenceError

        document = _agent()
        live = _provider(
            ScriptedTurn.tool("search", {"query": "4471"}),
            ScriptedTurn.answer("refunded"),
        )
        recorder_provider = RecordingProvider(live)
        tool, _ = recording_tool()
        await _runner(document, recorder_provider, tools=(tool,))(
            EvalCase(id="refund", input=QUESTION)
        )

        changed = solo(
            prompt="You refund orders, and also send email.",
            tool_specs=[tool_def("t1", "search")],
            tools=["t1"],
        )

        with pytest.raises(ReplayDivergenceError) as raised:
            await _runner(changed, RecordedProvider(recorder_provider.transcript()))(
                EvalCase(id="refund", input=QUESTION)
            )

        assert "does not match the recording" in str(raised.value)
