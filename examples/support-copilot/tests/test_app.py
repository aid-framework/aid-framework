"""The generated application, imported and exercised end to end.

Importing the app is itself part of the contract the generator owes its users:
the wiring it emits has to be importable and runnable, not merely syntactically
valid and not merely diffable against a fixture.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.business.tools.lookup_customer import LookupCustomer
from app.generated.contracts import ToolContext
from app.generated.deps import Deps, get_deps
from app.generated.gateway.models import ALIASES, FALLBACKS
from app.generated.schemas import Customer, Ticket
from app.generated.tools import build_executor
from app.main import app
from tests.fake_gateway import fake_deps

REQUEST: dict[str, str] = {
    "subject": "Acme: I was charged twice this month",
    "body": "Please refund the duplicate charge.",
}


def fake_deps_override() -> Deps:
    """The offline dependency override, with a zero-argument signature.

    `fake_deps` itself cannot be the override: FastAPI inspects the override's
    signature and would read its keyword-only seams (`tools`, `retrievers`, ...)
    as query parameters, which are not valid field types.
    """

    return fake_deps()


def test_the_model_alias_is_the_one_the_spec_pinned() -> None:
    """The spec's `fast` alias and its fallback survive into the generated gateway."""

    spec = ALIASES["fast"]
    assert spec.name == "gpt-4o-mini"
    assert spec.provider == "openai"
    assert FALLBACKS["fast"] == ("offline",)


async def test_the_business_tool_resolves_a_known_account() -> None:
    """The seed the generator wrote once is a working implementation, not a stub."""

    context = ToolContext(name="lookup_customer", arguments={})
    customer = await LookupCustomer()(context, Ticket(**REQUEST))

    assert isinstance(customer, Customer)
    assert customer.name == "Acme Corp"
    assert customer.plan == "enterprise"


async def test_the_business_tool_falls_back_for_an_unknown_account() -> None:
    """The unmatched branch is reachable, and reachable without a network."""

    context = ToolContext(name="lookup_customer", arguments={})
    ticket = Ticket(subject="Something is on fire", body="No account name here.")
    customer = await LookupCustomer()(context, ticket)

    assert customer.id == "acct_unknown"


def test_the_route_answers_a_ticket_offline() -> None:
    """The whole generated path runs: route, pipeline, tool, prompt, model gateway.

    The request only reaches a 200 if the generated `answer_ticket` pipeline ran
    both of its steps and the business tool returned a valid `Customer`.
    """

    app.dependency_overrides[get_deps] = fake_deps_override
    try:
        response = TestClient(app).post("/tickets/answer", json=REQUEST)
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["category"] == "billing"
    assert 0.0 <= body["confidence"] <= 1.0
    assert body["summary"]


def test_a_failing_tool_fails_the_request() -> None:
    """The tool is genuinely on the request path: break it and the route reports 502.

    This is the falsifying counterpart to `test_the_route_answers_a_ticket_offline`
    -- without it, a route that never called the tool at all would still pass.
    """

    class Broken:
        """A tool implementation that fails, standing in for a downstream outage."""

        async def __call__(self, ctx: ToolContext, req: Ticket) -> Customer:
            raise RuntimeError("crm is down")

    app.dependency_overrides[get_deps] = lambda: fake_deps(
        tools=build_executor(lookup_customer=Broken())
    )
    try:
        response = TestClient(app).post("/tickets/answer", json=REQUEST)
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 502
    assert "lookup_customer" in response.json()["detail"]
