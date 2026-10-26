"""The generated agent routes, exercised the way a caller reaches them.

The point of these is not that `AgentRuntime` works -- the runtime's own suite covers
that -- but that the *emitted* wiring reaches it: the route builds a runtime over the
app's own gateway and tool tuple, pauses on the checkpoint the loop hands back, and
resumes from the JSON a client can actually hold. A hand-written copy of the route would
pass every runtime test and still not prove the generator emitted anything.

`fake_deps(script=...)` is built **once** per test rather than per request. A
`FakeProvider` consumes its script one turn per call, so a provider rebuilt by the
dependency override on the resume would restart the script and drive a second tool call
instead of answering -- which is the failure the end-to-end test in `scripts/` has to
avoid for the same reason.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from aid_runtime import AgentRuntime, InProcessMemoryStore, ScriptedTurn
from aid_runtime.agents import check_memory_supported
from aid_runtime.agents.ir import from_ir
from fastapi.testclient import TestClient

from app.generated import agents
from app.generated.deps import Deps, get_deps
from app.main import app
from tests.fake_gateway import fake_deps

REQUEST: dict[str, str] = {
    "subject": "Acme: I was charged twice this month",
    "body": "Please refund the duplicate charge.",
}
"""The ticket the whole example is about."""

ANSWER = "Acme Corp is on the enterprise plan; the duplicate charge was refunded."
"""What the model says once it has looked the account up."""

SCRIPT: tuple[ScriptedTurn, ...] = (
    ScriptedTurn.tool("lookup_customer", REQUEST),
    ScriptedTurn.answer(ANSWER),
)
"""One tool call, then an answer: the shortest run that pauses and can be resumed."""


@pytest.fixture
def client() -> Iterator[TestClient]:
    """The app with the network replaced once, so the script survives both requests."""

    deps: Deps = fake_deps(script=SCRIPT)
    app.dependency_overrides[get_deps] = lambda: deps
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_deps, None)


def test_a_run_pauses_and_the_checkpoint_resumes_it(client: TestClient) -> None:
    """Run to the approval, hand the checkpoint back, and get the answer.

    The pause is the contract, not an accident of the fake: `refund_agent` declares
    `humanInTheLoop`, so the loop stops before the tool runs and there is no answer yet.
    The resume is the same run continued -- the second model turn is the answer rather
    than the tool call, which is only true because the script kept counting.
    """

    started = client.post("/agents/refund_agent/run", json={"text": REQUEST["subject"]})
    assert started.status_code == 200, started.text
    paused = started.json()
    assert paused["status"] == "paused"
    assert paused["answer"] == ""
    assert paused["pending"] is not None
    assert paused["checkpoint"] is not None

    resumed = client.post(
        "/agents/resume",
        json={"checkpoint": paused["checkpoint"], "decision": "approve"},
    )
    assert resumed.status_code == 200, resumed.text
    finished = resumed.json()
    assert finished["status"] == "completed"
    assert finished["answer"] == ANSWER
    assert finished["checkpoint"] is None


def test_the_paused_checkpoint_is_json_a_client_can_hold(client: TestClient) -> None:
    """The checkpoint crosses the wire as JSON, so a client can store and replay it.

    This is the property the bearer-capability position rests on: the route does not keep
    run state between requests, so what the response carries *is* the run. A checkpoint
    that needed a server-side record would make `/resume` unusable by any other process.
    """

    paused = client.post("/agents/refund_agent/run", json={"text": REQUEST["subject"]}).json()

    assert isinstance(paused["checkpoint"], dict)
    assert paused["checkpoint"]["agent_id"] == "refund_agent"
    replayed = client.post(
        "/agents/resume",
        json={"checkpoint": paused["checkpoint"], "decision": "approve"},
    )
    assert replayed.status_code == 200, replayed.text


def test_the_run_route_refuses_an_agent_the_app_does_not_declare(client: TestClient) -> None:
    """A 404 from the app, naming nothing about the document it holds."""

    response = client.post("/agents/not_an_agent/run", json={"text": "hello"})

    assert response.status_code == 404
    assert "not_an_agent" in response.json()["detail"]


def test_a_malformed_checkpoint_is_a_validation_error(client: TestClient) -> None:
    """Pydantic rejects it before the runtime sees it, so it is a 422 and not a 500."""

    response = client.post(
        "/agents/resume",
        json={"checkpoint": {"agent_id": 1}, "decision": "approve"},
    )

    assert response.status_code == 422


def test_the_agent_route_and_the_pipeline_route_share_one_tool_set(
    client: TestClient,
) -> None:
    """The seam the two routes meet at: same tool objects, same permission flags.

    `build_executor` and `build_agent_tools` are two spellings of one list. If they could
    drift, a tool could be authorized on the agent route and unguarded on the pipeline
    route with nothing to notice -- so what is asserted is identity of ids *and* of the
    flags the runtime authorizes on.
    """

    deps = app.dependency_overrides[get_deps]()

    assert deps.tools.names == tuple(sorted(tool.name for tool in deps.agent_tools))
    for tool in deps.agent_tools:
        # The executor returns the very definition the agent runtime was handed, so the
        # parameter schema, the side effects and `requires_confirmation` cannot differ
        # between the two routes -- they are one object, not two equal ones.
        assert deps.tools.definition(tool.name) is tool.definition
    assert {tool.name for tool in deps.agent_tools} == {"lookup_customer", "issue_refund"}


def test_the_thread_tier_is_served_and_stays_run_local() -> None:
    """The memory the spec declares is one the runtime accepts, and one that persists nothing.

    Two claims, and the second is the one worth pinning. `check_memory_supported` is the
    runtime's own gate, so calling it on the *emitted* tier is what proves the generator and
    the runtime agree on the kind -- a tier emitted with a kind the runtime refuses would
    otherwise only fail on the first request.

    `scope: thread` is deliberately run-local: `_remember` skips a thread tier, because its
    turns live in the run's own `ThreadMemory` and outlive nothing. A test that expected the
    in-process store to hold this answer would be asserting the bug.
    """

    document = agents.DOCUMENT
    tier = document["memory"][0]
    assert tier["id"] == "ticket_thread"
    assert tier["scope"] == "thread"

    # Raises if the generator ever emits a kind the runtime does not implement.
    check_memory_supported(
        memory_id=tier["id"],
        kind=tier["kind"],
        summarize_model=tier.get("summarizeModel"),
        ttl=tier.get("ttl"),
        redact=tuple(tier.get("redact") or ()),
    )

    deps = fake_deps()
    store = InProcessMemoryStore()
    runtime = AgentRuntime(
        from_ir(document),
        deps.gateway,
        tools=deps.agent_tools,
        memory_store=store,
    )
    result = asyncio.run(runtime.run("refund_agent", REQUEST["subject"]))

    assert result.completed, result
    assert asyncio.run(store.read(scope="thread", key="refund_agent")) == ()
