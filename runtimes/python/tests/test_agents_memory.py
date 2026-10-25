"""D5: in-process memory, one durable adapter, and no plugin zoo.

``thread`` scope is the checkpointer unit -- the transcript the loop already
carries -- so it is a trimmer and never a store. ``user`` and ``global`` scope are
the cross-run facts, and they are the only reason ``MemoryStore`` exists.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Tracer

from agent_support import build, memory_def, recording_tool, solo, tool_def
from aid_runtime import ATTRIBUTES, ConfigurationError, FeatureDeferredError, ScriptedTurn
from aid_runtime.agents import FileMemoryStore, InProcessMemoryStore, render_context
from aid_runtime.types import Message

PROMPT = "You are a helpful assistant."
QUESTION = "How long does delivery take?"
LONG = "y" * 300


class SpyStore:
    """A store that records every touch, so "never stored" is observable."""

    def __init__(self) -> None:
        self.reads: list[tuple[str, str]] = []
        self.appends: list[tuple[str, str, str]] = []

    async def read(self, *, scope: str, key: str) -> tuple[str, ...]:
        self.reads.append((scope, key))
        return ()

    async def append(self, *, scope: str, key: str, value: str) -> None:
        self.appends.append((scope, key, value))


def _remembering(*, scope: str, backend: str | None = None) -> dict[str, Any]:
    return solo(prompt=PROMPT, memory=[memory_def("m1", scope=scope, backend=backend)])


def _loopy(*, token_budget: int) -> dict[str, Any]:
    return solo(
        prompt=PROMPT,
        tool_specs=[tool_def("t1", "search")],
        memory=[memory_def("m1", scope="thread", token_budget=token_budget)],
        tools=["t1"],
        max_steps=6,
    )


def _script() -> list[ScriptedTurn]:
    return [
        ScriptedTurn.tool("search", {"query": "one"}),
        ScriptedTurn.tool("search", {"query": "two"}),
        ScriptedTurn.tool("search", {"query": "three"}),
        ScriptedTurn.answer("done"),
    ]


def _tracer() -> tuple[Tracer, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider.get_tracer("aid-runtime-tests"), exporter


def test_render_context_keeps_stored_entries_in_chronological_order() -> None:
    text, tokens = render_context(["first", "second"], 100)

    assert text == "first\nsecond"
    assert tokens > 0


def test_render_context_drops_the_oldest_first_when_the_budget_is_tight() -> None:
    text, _ = render_context(["old" * 40, "new" * 40], 60)

    assert text == "new" * 40


async def test_thread_scope_trims_the_replayed_transcript() -> None:
    trimmed_tool, trimmed_calls = recording_tool(answer=LONG)
    full_tool, full_calls = recording_tool(answer=LONG)
    trimmed = build(_loopy(token_budget=120), tools=[trimmed_tool], script=_script())
    untrimmed = build(_loopy(token_budget=100_000), tools=[full_tool], script=_script())

    assert (await trimmed.runtime.run("solo", QUESTION)).answer == "done"
    assert (await untrimmed.runtime.run("solo", QUESTION)).answer == "done"

    # Same conversation, same work: only what was replayed differs.
    assert (trimmed_calls.calls, full_calls.calls) == (3, 3)
    kept = trimmed.provider.calls[-1].messages
    untrimmed_messages = untrimmed.provider.calls[-1].messages
    assert len(kept) < len(untrimmed_messages)

    # The system prompt and the user's question are never trimmed away.
    assert kept[0] == Message.system(PROMPT)
    assert kept[1] == Message.user(QUESTION)

    # Whole tool-call groups: no observation outlives its call, and no call is
    # left behind without its observation.
    seen: set[str] = set()
    for message in kept:
        seen.update(call.id for call in message.tool_calls)
        if message.role == "tool":
            assert message.tool_call_id in seen
    answered = {message.tool_call_id for message in kept if message.role == "tool"}
    assert answered == seen


async def test_thread_scope_never_touches_a_store() -> None:
    spy = SpyStore()
    tool, _ = recording_tool(answer=LONG)
    harness = build(_loopy(token_budget=120), tools=[tool], script=_script(), memory_store=spy)

    await harness.runtime.run("solo", QUESTION)

    assert spy.reads == []
    assert spy.appends == []


async def test_user_scope_is_remembered_across_runs() -> None:
    store = InProcessMemoryStore()
    harness = build(
        _remembering(scope="user"),
        script=[ScriptedTurn.answer("first answer"), ScriptedTurn.answer("second answer")],
        memory_store=store,
    )

    first = await harness.runtime.run("solo", QUESTION)
    # Nothing was stored yet, so the transcript is just the prompt and the question.
    assert [message.content for message in harness.provider.calls[0].messages] == [PROMPT, QUESTION]

    await harness.runtime.run("solo", QUESTION)

    assert first.answer == "first answer"
    assert harness.provider.calls[1].messages[1] == Message.system("[m1]\nfirst answer")


async def test_user_scope_is_keyed_per_caller() -> None:
    store = InProcessMemoryStore()
    document = _remembering(scope="user")
    alice = build(document, script=[ScriptedTurn.answer("alice secret")], memory_store=store)
    bob = build(document, script=[ScriptedTurn.answer("bob answer")], memory_store=store)

    await alice.runtime.run("solo", QUESTION, memory_key="alice")
    await bob.runtime.run("solo", QUESTION, memory_key="bob")

    assert [message.content for message in bob.provider.calls[0].messages] == [PROMPT, QUESTION]


async def test_global_scope_is_shared_by_every_caller() -> None:
    store = InProcessMemoryStore()
    document = _remembering(scope="global")
    alice = build(document, script=[ScriptedTurn.answer("shared fact")], memory_store=store)
    bob = build(document, script=[ScriptedTurn.answer("bob answer")], memory_store=store)

    await alice.runtime.run("solo", QUESTION, memory_key="alice")
    await bob.runtime.run("solo", QUESTION, memory_key="bob")

    assert bob.provider.calls[0].messages[1] == Message.system("[m1]\nshared fact")


async def test_a_registered_backend_is_the_store_the_document_named() -> None:
    store = InProcessMemoryStore()
    harness = build(
        _remembering(scope="user", backend="pg"),
        script=[ScriptedTurn.answer("kept")],
        stores={"pg": store},
    )

    await harness.runtime.run("solo", QUESTION)

    # The default key is the agent id, so the storage key is scoped by both.
    assert await store.read(scope="user", key="solo:m1") == ("kept",)


async def test_an_unregistered_backend_fails_closed() -> None:
    harness = build(_remembering(scope="user", backend="postgres"), script=[])

    with pytest.raises(ConfigurationError, match="which is not registered here"):
        await harness.runtime.run("solo", QUESTION)


async def test_the_file_store_is_the_one_durable_adapter(tmp_path: Path) -> None:
    path = tmp_path / "memory.json"
    document = _remembering(scope="user")
    first = build(
        document, script=[ScriptedTurn.answer("first answer")], memory_store=FileMemoryStore(path)
    )

    await first.runtime.run("solo", QUESTION, memory_key="alice")

    assert json.loads(path.read_text(encoding="utf-8")) == {"user": {"alice:m1": ["first answer"]}}

    # A fresh runtime and a fresh store object: whatever it sees came off the disk.
    second = build(
        document, script=[ScriptedTurn.answer("second answer")], memory_store=FileMemoryStore(path)
    )
    await second.runtime.run("solo", QUESTION, memory_key="alice")

    assert second.provider.calls[0].messages[1] == Message.system("[m1]\nfirst answer")
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "user": {"alice:m1": ["first answer", "second answer"]}
    }


@pytest.mark.parametrize("kind", ["summary", "semantic", "episodic", "vector"])
async def test_memory_kinds_without_an_implementation_are_refused_by_name(kind: str) -> None:
    harness = build(
        solo(prompt=PROMPT, memory=[memory_def("m1", kind=kind)]), script=[ScriptedTurn.answer("x")]
    )

    with pytest.raises(FeatureDeferredError, match=kind):
        await harness.runtime.run("solo", QUESTION)


@pytest.mark.parametrize(
    ("field", "value", "needle"),
    [
        ("summarize_model", "cheap", "summarizeModel"),
        ("ttl", "PT1H", "ttl"),
        ("redact", ("email",), "redaction"),
    ],
)
async def test_memory_features_without_an_implementation_are_refused_by_name(
    field: str, value: Any, needle: str
) -> None:
    harness = build(
        solo(prompt=PROMPT, memory=[memory_def("m1", scope="user", **{field: value})]),
        script=[ScriptedTurn.answer("x")],
    )

    with pytest.raises(FeatureDeferredError, match=needle):
        await harness.runtime.run("solo", QUESTION)


async def test_memory_scope_and_entries_reach_the_agent_span() -> None:
    tracer, exporter = _tracer()
    harness = build(
        _remembering(scope="user"),
        script=[ScriptedTurn.answer("remembered"), ScriptedTurn.answer("again")],
        tracer=tracer,
    )

    await harness.runtime.run("solo", QUESTION)
    await harness.runtime.run("solo", QUESTION)

    spans = [span for span in exporter.get_finished_spans() if span.name == "invoke_agent solo"]
    empty_run, populated_run = (dict(span.attributes or {}) for span in spans)
    # The scope is declared either way; the count and the tokens appear only once
    # there is something stored, so an absent count is not mistaken for zero.
    assert empty_run[ATTRIBUTES["memory_scope"]] == "user"
    assert ATTRIBUTES["memory_entries"] not in empty_run
    assert populated_run[ATTRIBUTES["memory_scope"]] == "user"
    assert populated_run[ATTRIBUTES["memory_entries"]] == 1
    memory_tokens = populated_run[ATTRIBUTES["memory_tokens"]]
    assert isinstance(memory_tokens, int)
    assert memory_tokens >= 1
