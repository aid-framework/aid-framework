"""The `refund_trajectory` eval, and the one thing it has to get right before it ever runs.

An agent eval measures a *run*, so its metrics read a trajectory rather than an
answer. That mapping is the fragile part. `tool-trace` belongs to a subject that
has a trajectory, and a prompt eval is refused one at generation time -- so when
the emitter asked the mapping without saying it was measuring an agent, every
metric of this eval mapped to nothing. The module still imported, still
typechecked, and still satisfied every gate, while measuring nothing at all.

`test_the_shipped_eval_scores_the_trajectory_it_names` is what fails if that
returns: it asserts the metric objects the module builds, not merely that the
module builds.

What a green run of this eval does *not* mean is in the module's own docstring and
in `docs/reference/eval-metrics.md`. The agent's model has no offline fallback, so
a run either replays a recorded transcript or calls the vendor: either way the
model choices are fixed before the run starts, and what is under test is policy
and plumbing -- the pause, the tool allow-list, spend attribution -- not how a
model would behave.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from aid_runtime import (
    Capability,
    CompletionRequest,
    EvalError,
    ModelSpec,
    RecordingProvider,
    RecordingProviders,
    ReplayDivergenceError,
)
from aid_runtime.evals import (
    EvalCase,
    Metric,
    MetricResult,
    RunContext,
    Trajectory,
)
from aid_runtime.providers import RecordedProvider, Transcript
from aid_runtime.providers.fake import FakeProvider, ScriptedTurn
from aid_runtime.types import CostProfile

from app.generated.evals import refund_trajectory


def test_the_shipped_eval_names_the_agent_it_measures() -> None:
    """The subject is the agent, and a baseline recorded under it is keyed the same way."""

    assert refund_trajectory.AGENT == "refund_agent"
    # `aid eval --baseline` reads MODEL from every suite, so an agent eval names the agent
    # there rather than leaving the reader to special-case this module.
    assert refund_trajectory.MODEL == refund_trajectory.AGENT
    assert refund_trajectory.EVAL_ID == "refund_trajectory"


_CASE = EvalCase(id="refund_order_4471", input="Refund order 4471")


def _metric(name: str) -> Metric:
    """The one metric this eval declares under `name`.

    A metric the module measures but does not threshold, or thresholds but does not
    measure, both read as a pass -- so the lookup fails rather than picking a match.
    """

    found = [metric for metric in refund_trajectory.metrics() if metric.name == name]
    assert len(found) == 1, refund_trajectory.metrics()
    return found[0]


def _score(
    metric: Metric,
    *,
    calls: tuple[str, ...] = (),
    cost_usd: float = 0.0,
    metered: bool = False,
) -> MetricResult:
    async def score() -> MetricResult:
        return await metric.score(
            _CASE,
            "refunded",
            context=RunContext(
                cost_usd=cost_usd,
                metered=metered,
                trajectory=Trajectory(calls=calls),
            ),
        )

    return asyncio.run(score())


def test_the_shipped_eval_scores_the_trajectory_it_names() -> None:
    """The spec's `tool-trace` reaches the module as a metric that reads the run's calls.

    This is the assertion the emitter's original bug would have failed: `metrics()`
    returned only the cost ceiling, so the eval passed while never looking at which
    tools the run called.
    """

    trace = _metric("tool-trace")

    assert _score(trace, calls=("lookup_customer", "issue_refund")).passed
    # `ordered: true` is what makes the expectation a subsequence rather than a set. Had
    # the emitter dropped it, refunding before looking the customer up would pass.
    assert not _score(trace, calls=("issue_refund", "lookup_customer")).passed
    # Extra calls on the way are tolerated, and that is deliberate: the metric asks
    # whether the tools were called, not whether the run did anything else.
    assert _score(trace, calls=("lookup_customer", "order_status", "issue_refund")).passed


def test_the_shipped_eval_prices_each_run_at_five_cents() -> None:
    """The spec's `cost: max: 0.05` is the ceiling the run is actually held to."""

    ceiling = _metric("cost")

    assert _score(ceiling, cost_usd=0.049, metered=True).passed
    assert not _score(ceiling, cost_usd=0.051, metered=True).passed


def test_every_metric_the_module_measures_is_also_thresholded() -> None:
    """A metric with no threshold is measured and then ignored, which reads as a pass.

    The two tuples are built from one spec block, so this is really a check that neither
    is assembled from a different source than the other.
    """

    named = {threshold.metric for threshold in refund_trajectory.thresholds()}

    assert named == {"cost", "tool-trace"}
    assert len(refund_trajectory.thresholds()) == len(refund_trajectory.metrics())
    # `max_regression` is a tolerance over the mean of `SAMPLES` runs, so it has to be the
    # spec's number rather than a default that happens to agree with nothing.
    assert {threshold.max_regression for threshold in refund_trajectory.thresholds()} == {
        refund_trajectory.MAX_REGRESSION
    }


def test_the_dataset_supplies_a_decision_for_every_pause() -> None:
    """`refund_agent` pauses on every run, so a case with no decision would stall the eval.

    `humanInTheLoop.when` is `"true"` for this agent, and the runner consumes one
    decision per pause in the order the pauses occur. Absent decisions mean "this case
    must not pause", which would be a false statement about this agent.
    """

    dataset = refund_trajectory.load_dataset()

    assert len(dataset.cases) == 3
    assert [case.approvals for case in dataset.cases] == [("approve",)] * 3
    # The subject the cases are asked of is the agent's own input, so a case that names
    # nothing would measure the same empty run three times.
    assert all(case.input.strip() for case in dataset.cases)


def test_the_run_is_live_until_a_transcript_is_named(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Two modes, chosen by one variable, and neither is reachable by accident.

    `triage` has no offline fallback, so the default here is the provider-wired app: a
    live run. Naming a transcript is the only way to take the eval offline, and the
    choice is visible in the file rather than implicit in an import.
    """

    monkeypatch.delenv(refund_trajectory.TRANSCRIPT_ENV, raising=False)

    live = refund_trajectory.providers()
    assert set(live) == set(refund_trajectory.PROVIDER_KEYS)
    assert not any(isinstance(provider, RecordedProvider) for provider in live.values())

    Transcript(provider="fake", model="fake-deterministic-1").save(tmp_path / "t.json")
    monkeypatch.setenv(refund_trajectory.TRANSCRIPT_ENV, str(tmp_path / "t.json"))

    replayed = refund_trajectory.providers()
    # One recording serves every provider key, because it is the sequence of calls the run
    # makes rather than a per-vendor cache -- which provider answered is part of the replay.
    assert set(replayed) == set(refund_trajectory.PROVIDER_KEYS)
    assert all(isinstance(provider, RecordedProvider) for provider in replayed.values())


def test_one_recording_serves_every_provider_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A transcript is the sequence of calls the run made, not one vendor's answer cache.

    Which provider answered a call is inside the recording, so building a provider per key
    from a single file is correct -- and sharing one object per key is what keeps `served`
    from disagreeing with itself when the run reads it.
    """

    path = tmp_path / "recorded.json"
    Transcript(provider="fake", model="fake-deterministic-1").save(path)
    monkeypatch.setenv(refund_trajectory.TRANSCRIPT_ENV, str(path))

    providers = refund_trajectory.providers()

    assert all(isinstance(provider, RecordedProvider) for provider in providers.values())
    assert len({id(provider) for provider in providers.values()}) == 1
    # The recording was actually parsed rather than the path merely accepted.
    replayed = next(iter(providers.values()))
    assert isinstance(replayed, RecordedProvider)
    assert replayed.remaining == 0


def test_a_named_transcript_is_loaded_or_the_run_refuses(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The one thing a replay must never do is quietly become a live call.

    An eval that falls through to the vendor when its recording is missing spends money and
    passes on a model nobody recorded, so the refusal is part of the contract.
    """

    monkeypatch.setenv(refund_trajectory.TRANSCRIPT_ENV, str(tmp_path / "absent.json"))

    with pytest.raises(FileNotFoundError, match="no recorded transcript"):
        refund_trajectory.providers()


_ASK = CompletionRequest.prompt("Refund order 4471")
_MODEL = ModelSpec(
    name="gpt-4o-mini-2024-07-18",
    provider="openai",
    cost=CostProfile(input_per_1k_usd=0.00015, output_per_1k_usd=0.0006),
    context_window=128_000,
    max_output_tokens=16_384,
    capabilities=frozenset({Capability.TOOL_CALLING}),
)


def _answer_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the app's providers a fake that answers, so a capture has something to record.

    `refund_agent` is declared on a real vendor, which is what makes recording legal for
    this eval at all -- so the fake is installed at the module's own reference to
    `default_providers`, the seam the generated code calls, rather than by rewriting the
    spec. The capture then records a real call, over a stand-in transport.
    """

    monkeypatch.setattr(
        refund_trajectory,
        "default_providers",
        lambda: dict.fromkeys(
            refund_trajectory.PROVIDER_KEYS,
            FakeProvider(script=[ScriptedTurn.answer("refunded")]),
        ),
    )


def test_a_capture_writes_the_transcript_a_replay_reads(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Capture and replay are two halves of one file, and this is the seam between them.

    The capture half did not exist for a long time: `AID_EVAL_TRANSCRIPT` made a run
    offline, but nothing but a test ever wrote a transcript, so a trajectory could only be
    recorded by hand. What this asserts is that the file a live run writes is the file the
    next run replays -- through the module's own entry points, not through the runtime's
    constructors, because it is the generated wiring that has to agree.
    """

    path = tmp_path / "refund.json"
    _answer_once(monkeypatch)
    monkeypatch.delenv(refund_trajectory.TRANSCRIPT_ENV, raising=False)
    monkeypatch.setenv(refund_trajectory.RECORD_ENV, str(path))
    monkeypatch.setattr(refund_trajectory, "_RECORDER", None)

    capturing = refund_trajectory.providers()
    provider = capturing["openai"]
    assert isinstance(provider, RecordingProvider)
    answered = asyncio.run(provider.complete(_ASK, model=_MODEL))
    refund_trajectory.save_recording()

    # The file describes the document that produced it, so a later bump can ask whether the
    # recording still matches what the eval would run.
    recorded = Transcript.from_path(path)
    assert recorded.spec_version == refund_trajectory.SPEC_VERSION
    assert len(recorded) == 1
    assert recorded.entries[0].response.text == answered.text

    monkeypatch.delenv(refund_trajectory.RECORD_ENV)
    monkeypatch.setenv(refund_trajectory.TRANSCRIPT_ENV, str(path))

    replayed = refund_trajectory.providers()["openai"]
    assert isinstance(replayed, RecordedProvider)
    assert replayed.remaining == 1
    assert asyncio.run(replayed.complete(_ASK, model=_MODEL)).text == answered.text
    # Served exactly once: a recording with a call left over means the run took fewer steps
    # than the one it replays, and a silent fall-through would hide that.
    assert replayed.remaining == 0

    with pytest.raises(ReplayDivergenceError):
        asyncio.run(replayed.complete(_ASK, model=_MODEL))


def test_a_capture_refuses_a_run_that_could_not_be_replayed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Three ways a capture would be worthless, refused rather than written.

    Both modes at once would describe this document while holding another run's turns; a
    scripted agent has no model call to record; and a run that never reached the model has
    no trajectory to replay. Each is refused by the module, because each is a property of
    the run rather than of the flag.
    """

    path = tmp_path / "refund.json"
    _answer_once(monkeypatch)
    monkeypatch.setattr(refund_trajectory, "_RECORDER", None)
    monkeypatch.delenv(refund_trajectory.TRANSCRIPT_ENV, raising=False)

    Transcript(provider="fake", model="fake-deterministic-1").save(path)
    monkeypatch.setenv(refund_trajectory.RECORD_ENV, str(path))
    with pytest.raises(EvalError, match="never overwrites"):
        refund_trajectory.providers()

    monkeypatch.setenv(refund_trajectory.TRANSCRIPT_ENV, str(path))
    with pytest.raises(EvalError, match="replays a recording or captures one"):
        refund_trajectory.providers()

    # A scripted agent would record its script, which is not what a transcript is for.
    monkeypatch.delenv(refund_trajectory.TRANSCRIPT_ENV)
    monkeypatch.setenv(refund_trajectory.RECORD_ENV, str(tmp_path / "fresh.json"))
    monkeypatch.setattr(refund_trajectory, "SCRIPTED", True)
    with pytest.raises(EvalError, match="runs on the scripted provider"):
        refund_trajectory.providers()

    # And a run that made no call is refused at the point it would be saved, rather than
    # writing an empty transcript that replays a shorter run than this one took.
    monkeypatch.setattr(refund_trajectory, "SCRIPTED", False)
    monkeypatch.setattr(
        refund_trajectory, "_RECORDER", RecordingProviders({"openai": FakeProvider()})
    )
    monkeypatch.setenv(refund_trajectory.RECORD_ENV, str(tmp_path / "fresh.json"))
    with pytest.raises(EvalError, match="made no model call"):
        refund_trajectory.save_recording()


def test_provenance_names_where_the_model_turns_came_from(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A green gate means something different in each mode, so the mode is printed.

    `scripted` and `recorded` verify policy and plumbing -- the step ceiling, the tool
    allow-list, the approval pause, spend attribution -- and say nothing about whether a
    model would have made those calls. Only a live run does, and a reader cannot tell the
    three apart from a summary alone.
    """

    monkeypatch.delenv(refund_trajectory.TRANSCRIPT_ENV, raising=False)
    monkeypatch.delenv(refund_trajectory.RECORD_ENV, raising=False)
    monkeypatch.setattr(refund_trajectory, "SCRIPTED", False)
    assert refund_trajectory.provenance() == "live"

    transcript = tmp_path / "t.json"
    Transcript(provider="fake", model="fake-deterministic-1").save(transcript)
    monkeypatch.setenv(refund_trajectory.TRANSCRIPT_ENV, str(transcript))
    assert refund_trajectory.provenance() == "recorded"

    monkeypatch.delenv(refund_trajectory.TRANSCRIPT_ENV)
    capture = tmp_path / "capture.json"
    monkeypatch.setenv(refund_trajectory.RECORD_ENV, str(capture))
    assert refund_trajectory.provenance() == f"live, capturing to {capture}"

    # The scripted provider wins over both, because it is the stronger statement: a scripted
    # run consulted no model at all, whatever the environment was trying to arrange.
    monkeypatch.setattr(refund_trajectory, "SCRIPTED", True)
    assert refund_trajectory.provenance() == "scripted"
