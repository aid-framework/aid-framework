"""The store a paused run waits in, and the loop that writes to it.

The claim being tested is narrow enough to state: after a pause, a request that does not
hold the checkpoint -- a different replica, a later process, an approver clicking a link an
hour later -- can still continue the run, and can do so exactly once. The properties that
matter are therefore claim-once, survive-a-reopen, and refuse-a-stale-id, not "the row is
in the table".

The last group is the loop's half: a pause reports a ``run_id``, ``resume_run`` continues
it, and the id stops working afterwards. Store and loop are tested apart because a bug in
either would look like the same bug through the route.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from agent_support import ADMIN_ONLY, build, recording_tool, solo, tool_def
from aid_runtime import ConfigurationError, ScriptedTurn
from aid_runtime.agents import (
    AgentCheckpoint,
    CheckpointRefusalError,
    InProcessRunStore,
    Principal,
    RunStatus,
    SqliteRunStore,
    run_store_for,
    run_store_from_env,
)

NOW = 1_000_000
WINDOW = 900
ADMIN = Principal(roles=frozenset({"admin"}))
QUESTION = "Refund this order."


def _checkpoint(**overrides: Any) -> AgentCheckpoint:
    fields: dict[str, Any] = {
        "agent_id": "solo",
        "step": 1,
        "messages": (),
        "cost_anchor_usd": 0.0,
        "token_anchor": 0,
        "spent_usd": 0.0,
        "spent_tokens": 0,
    }
    fields.update(overrides)
    return AgentCheckpoint(**fields)


# --- InProcessRunStore: the store a document without agentState gets --------------------


async def test_an_in_process_run_resumes_once() -> None:
    store = InProcessRunStore()
    await store.save(run_id="run_a", checkpoint=_checkpoint(), expires_at=None, now=NOW)

    assert (await store.load(run_id="run_a", now=NOW)).agent_id == "solo"

    with pytest.raises(CheckpointRefusalError) as caught:
        await store.load(run_id="run_a", now=NOW)

    assert caught.value.reason == "replayed"


async def test_an_id_nothing_is_stored_under_is_unknown_not_expired() -> None:
    store = InProcessRunStore()

    with pytest.raises(CheckpointRefusalError) as caught:
        await store.load(run_id="run_nothing", now=NOW)

    assert caught.value.reason == "unknown-run"


async def test_a_run_past_its_deadline_is_refused_and_stays_claimed() -> None:
    """The refusal is not a claim, so the reason a caller sees is the true one."""
    store = InProcessRunStore()
    await store.save(run_id="run_a", checkpoint=_checkpoint(), expires_at=NOW + WINDOW, now=NOW)

    with pytest.raises(CheckpointRefusalError) as caught:
        await store.load(run_id="run_a", now=NOW + WINDOW)

    assert caught.value.reason == "expired"
    # An expiry refusal must not spend the row: a caller who is merely early on one
    # replica and late on another should still see `expired`, never `replayed`.
    assert (await store.load(run_id="run_a", now=NOW)).agent_id == "solo"


async def test_an_unsigned_run_records_no_deadline_rather_than_inventing_one() -> None:
    store = InProcessRunStore()
    await store.save(run_id="run_a", checkpoint=_checkpoint(), expires_at=None, now=NOW)

    # A document that declared no signing key declared no window either, so a load far
    # past any plausible TTL still finds the run.
    assert (await store.load(run_id="run_a", now=NOW + 365 * 24 * 3600)).agent_id == "solo"


# --- SqliteRunStore: the store a `state: sqlite` document gets -------------------------


async def test_a_sqlite_run_survives_the_process_that_paused_it(tmp_path: Path) -> None:
    path = tmp_path / "runs.db"
    await SqliteRunStore(path).save(
        run_id="run_a", checkpoint=_checkpoint(), expires_at=None, now=NOW
    )

    # A second store over the same file stands in for a restarted pod.
    reopened = await SqliteRunStore(path).load(run_id="run_a", now=NOW)

    assert reopened.agent_id == "solo"


async def test_a_sqlite_run_is_claimed_once_across_two_openers(tmp_path: Path) -> None:
    path = tmp_path / "runs.db"
    await SqliteRunStore(path).save(
        run_id="run_a", checkpoint=_checkpoint(), expires_at=None, now=NOW
    )

    assert (await SqliteRunStore(path).load(run_id="run_a", now=NOW)).agent_id == "solo"

    with pytest.raises(CheckpointRefusalError) as caught:
        await SqliteRunStore(path).load(run_id="run_a", now=NOW)

    assert caught.value.reason == "replayed"


async def test_a_sqlite_save_is_idempotent_for_the_same_id(tmp_path: Path) -> None:
    """A retried write must not fail on the key, and must not resurrect the run."""
    path = tmp_path / "runs.db"
    store = SqliteRunStore(path)
    await store.save(run_id="run_a", checkpoint=_checkpoint(), expires_at=None, now=NOW)
    await store.load(run_id="run_a", now=NOW)

    # Re-saving is what a caller retrying a timed-out pause does; the row it writes is
    # the same pause, so a fresh id is what the loop uses and this only has to not raise.
    await store.save(run_id="run_b", checkpoint=_checkpoint(), expires_at=None, now=NOW)

    assert (await store.load(run_id="run_b", now=NOW)).agent_id == "solo"


async def test_a_sqlite_run_past_its_deadline_is_refused(tmp_path: Path) -> None:
    store = SqliteRunStore(tmp_path / "runs.db")
    await store.save(run_id="run_a", checkpoint=_checkpoint(), expires_at=NOW + WINDOW, now=NOW)

    with pytest.raises(CheckpointRefusalError) as caught:
        await store.load(run_id="run_a", now=NOW + WINDOW)

    assert caught.value.reason == "expired"


async def test_an_unknown_id_is_not_created_by_a_load(tmp_path: Path) -> None:
    store = SqliteRunStore(tmp_path / "runs.db")

    with pytest.raises(CheckpointRefusalError) as caught:
        await store.load(run_id="run_nothing", now=NOW)

    assert caught.value.reason == "unknown-run"


async def test_retention_prunes_expired_rows_on_the_next_save(tmp_path: Path) -> None:
    """No deletion job: a row is cheap to keep and this is the smallest honest bound."""
    path = tmp_path / "runs.db"
    store = SqliteRunStore(path, retain_seconds=60)
    await store.save(run_id="run_old", checkpoint=_checkpoint(), expires_at=None, now=NOW)
    await store.save(run_id="run_new", checkpoint=_checkpoint(), expires_at=None, now=NOW + 60)

    with sqlite3.connect(path) as connection:
        rows = [row[0] for row in connection.execute("SELECT run_id FROM agent_run")]

    assert rows == ["run_new"]


async def test_a_row_without_retention_is_never_pruned(tmp_path: Path) -> None:
    """An operator who declared no ttl got no retention policy, not an accidental one."""
    path = tmp_path / "runs.db"
    store = SqliteRunStore(path)
    await store.save(run_id="run_a", checkpoint=_checkpoint(), expires_at=None, now=NOW)
    await store.save(run_id="run_b", checkpoint=_checkpoint(), expires_at=None, now=NOW + 10**6)

    with sqlite3.connect(path) as connection:
        rows = sorted(row[0] for row in connection.execute("SELECT run_id FROM agent_run"))

    assert rows == ["run_a", "run_b"]


# --- choosing a store ------------------------------------------------------------------


def test_no_declaration_builds_the_in_process_store() -> None:
    assert isinstance(run_store_for(None, None), InProcessRunStore)


def test_a_declared_kind_with_a_location_builds_the_durable_store(tmp_path: Path) -> None:
    assert isinstance(run_store_for("sqlite", str(tmp_path / "runs.db")), SqliteRunStore)


def test_a_declared_kind_with_no_resolved_location_falls_back_rather_than_raising() -> None:
    """A library embedder is not forced to own a database it never asked for."""
    assert isinstance(run_store_for("sqlite", None), InProcessRunStore)


def test_a_kind_this_build_does_not_implement_falls_back() -> None:
    assert isinstance(run_store_for("dynamodb", "some-table"), InProcessRunStore)


def test_an_unset_variable_is_refused_by_name(monkeypatch: pytest.MonkeyPatch) -> None:
    """Quietly using one worker's memory would withdraw what the gate promised."""
    monkeypatch.delenv("AID_RUNS_TEST_URL", raising=False)

    with pytest.raises(ConfigurationError, match="AID_RUNS_TEST_URL"):
        run_store_from_env("sqlite", "AID_RUNS_TEST_URL")


def test_a_kind_with_no_url_env_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="urlEnv"):
        run_store_from_env("sqlite", None)


def test_no_kind_means_the_in_process_store_without_touching_the_environment() -> None:
    assert isinstance(run_store_from_env(None, "AID_RUNS_TEST_URL"), InProcessRunStore)


def test_a_set_variable_is_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AID_RUNS_TEST_URL", str(tmp_path / "runs.db"))

    store = run_store_from_env("sqlite", "AID_RUNS_TEST_URL")

    assert isinstance(store, SqliteRunStore)


# --- the loop's half -------------------------------------------------------------------


def _supervised() -> dict[str, Any]:
    return solo(
        prompt="You are a helpful assistant.",
        tool_specs=[tool_def("t1", "search")],
        tools=["t1"],
        hitl={"when": ADMIN_ONLY, "channel": "ops"},
    )


def _pausing_harness(runs: Any, script: list[ScriptedTurn]) -> Any:
    tool, recorder = recording_tool()
    harness = build(_supervised(), tools=[tool], script=script, runs=runs)
    return harness, recorder


async def test_a_pause_reports_the_id_it_is_stored_under() -> None:
    store = InProcessRunStore()
    harness, _ = _pausing_harness(
        store, [ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")]
    )

    result = await harness.runtime.run("solo", QUESTION, principal=ADMIN)

    assert result.status is RunStatus.PAUSED
    assert result.run_id.startswith("run_")
    # The checkpoint still comes back, so a caller that ignores `run_id` keeps working.
    assert result.checkpoint is not None
    assert (await store.load(run_id=result.run_id, now=1)) is not None


async def test_resume_run_continues_a_stored_pause() -> None:
    store = InProcessRunStore()
    harness, recorder = _pausing_harness(
        store, [ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")]
    )
    paused = await harness.runtime.run("solo", QUESTION, principal=ADMIN)

    resumed = await harness.runtime.resume_run(paused.run_id, "approve", principal=ADMIN)

    assert resumed.status is RunStatus.COMPLETED
    assert resumed.answer == "done"
    assert resumed.run_id == ""
    assert recorder.calls == 1


async def test_a_stored_run_resumes_once() -> None:
    store = InProcessRunStore()
    harness, _ = _pausing_harness(
        store, [ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")]
    )
    paused = await harness.runtime.run("solo", QUESTION, principal=ADMIN)
    await harness.runtime.resume_run(paused.run_id, "approve", principal=ADMIN)

    with pytest.raises(CheckpointRefusalError) as caught:
        await harness.runtime.resume_run(paused.run_id, "approve", principal=ADMIN)

    assert caught.value.reason == "replayed"


async def test_a_completed_run_is_not_stored() -> None:
    """Nothing to continue, so nothing to keep: a `run_id` here would be a lie."""
    store = InProcessRunStore()
    harness, _ = _pausing_harness(store, [ScriptedTurn.answer("done")])

    result = await harness.runtime.run("solo", QUESTION)

    assert result.status is RunStatus.COMPLETED
    assert result.run_id == ""


async def test_a_runtime_without_a_store_answers_pauses_as_before() -> None:
    harness, _ = _pausing_harness(
        None, [ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")]
    )

    result = await harness.runtime.run("solo", QUESTION, principal=ADMIN)

    assert result.status is RunStatus.PAUSED
    assert result.run_id == ""
    assert result.checkpoint is not None

    with pytest.raises(ConfigurationError, match="run store"):
        await harness.runtime.resume_run("run_anything", "approve")
