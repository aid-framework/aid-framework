"""The managed-engine half of guardrails: the IR's word, the wire's answer.

The engine tests use a :class:`GuardrailClient` double rather than a transport, so
what they prove is the seam the generated pipeline calls. The client tests use a
provider double, so what they prove is the request the adapter builds -- signed by
the same ``send`` the model provider uses -- without an AWS call.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from aid_runtime import GuardrailBlockedError
from aid_runtime.agents import (
    BedrockGuardrailPolicy,
    GuardrailDefinition,
    GuardrailEngine,
    GuardrailOutcome,
    ManagedGuardrailSettings,
)
from aid_runtime.agents.ir import _bedrock_policy, _guardrail
from aid_runtime.agents.managed import (
    CONTENT_STRENGTHS,
    CONTENT_TYPES,
    PII_TYPES,
    BedrockGuardrailClient,
    _parse,
    managed_guardrail_settings,
)
from aid_runtime.errors import ConfigurationError, ProviderError

ON_FAIL: dict[str, Any] = {"message": "refused", "log": True}


def entry(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "stages": ["input"],
        "action": "block",
        "onFail": ON_FAIL,
    }
    values.update(overrides)
    return values


def guarded(**overrides: Any) -> GuardrailDefinition:
    return _guardrail("shield", entry(**overrides), {})


def managed_definition(**overrides: Any) -> GuardrailDefinition:
    values: dict[str, Any] = {
        "engine": "bedrock",
        "bedrock": {"content": {"hate": "high"}, "pii": ["email"]},
    }
    values.update(overrides)
    return _guardrail("shield", entry(**values), {})


@dataclass
class FakeGuardrailClient:
    outcome: GuardrailOutcome
    calls: list[tuple[str, str]]

    def __init__(self, outcome: GuardrailOutcome) -> None:
        self.outcome = outcome
        self.calls = []

    async def apply(self, *, source: str, text: str) -> GuardrailOutcome:
        self.calls.append((source, text))
        return self.outcome


def engine_with(outcome: GuardrailOutcome) -> tuple[GuardrailEngine, FakeGuardrailClient]:
    client = FakeGuardrailClient(outcome)
    return GuardrailEngine(guardrail_client_factory=lambda: client), client


# --- the IR's word -------------------------------------------------------


def test_builtin_is_the_engine_when_none_is_named() -> None:
    assert guarded().engine == "builtin"
    assert guarded().bedrock is None


def test_a_managed_guardrail_keeps_the_specs_vocabulary_in_declared_order() -> None:
    definition = guarded(
        engine="bedrock",
        bedrock={
            "content": {"prompt-attack": "high", "hate": "low"},
            "topics": {"investments": "avoid financial advice"},
            "words": ["swordfish"],
            "pii": ["credit-card", "email"],
        },
    )

    assert definition.engine == "bedrock"
    assert definition.bedrock == BedrockGuardrailPolicy(
        content=(("prompt-attack", "high"), ("hate", "low")),
        topics=(("investments", "avoid financial advice"),),
        words=("swordfish",),
        pii=("credit-card", "email"),
    )


def test_a_managed_redaction_names_the_one_field_the_service_rewrites() -> None:
    # The managed service rewrites the content it is given, and the engine only
    # ever gives it the text. A managed guardrail therefore carries no `redact:`
    # fields in the document, and the runtime supplies the only sensible one.
    definition = guarded(
        action="redact",
        engine="bedrock",
        bedrock={"pii": ["email"]},
    )

    assert definition.redact == ("text",)


def test_an_unknown_engine_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="has engine 'azure'"):
        guarded(engine="azure")


def test_a_managed_guardrail_with_no_policy_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="with no bedrock policy"):
        guarded(engine="bedrock", bedrock={})


def test_an_unknown_content_filter_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="unknown content filter 'profanity'"):
        guarded(engine="bedrock", bedrock={"content": {"profanity": "high"}})


def test_an_unknown_content_strength_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="strength 'extreme'"):
        guarded(engine="bedrock", bedrock={"content": {"hate": "extreme"}})


def test_an_unknown_pii_entity_is_refused() -> None:
    with pytest.raises(ConfigurationError, match="unknown PII entities"):
        guarded(engine="bedrock", bedrock={"pii": ["dna"]})


def test_a_policy_of_the_wrong_shape_is_no_policy() -> None:
    assert _bedrock_policy([], "guardrail 'shield'") is None


# --- the wire's vocabulary ----------------------------------------------


def test_every_spec_pii_name_has_a_wire_enum() -> None:
    spec = {
        "email",
        "phone",
        "name",
        "address",
        "ssn",
        "credit-card",
        "bank-account",
        "passport",
        "drivers-license",
        "ip-address",
        "url",
        "aws-access-key",
        "aws-secret-key",
    }

    assert set(PII_TYPES) == spec
    assert len(set(PII_TYPES.values())) == len(spec)


def test_the_content_and_strength_vocabularies_are_closed() -> None:
    assert set(CONTENT_TYPES) == {
        "sexual",
        "violence",
        "hate",
        "insults",
        "misconduct",
        "prompt-attack",
    }
    assert set(CONTENT_STRENGTHS) == {"low", "medium", "high"}


# --- the settings the deployment provides --------------------------------


def test_missing_settings_explain_which_name_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BEDROCK_GUARDRAIL_ID", raising=False)
    monkeypatch.setenv("BEDROCK_GUARDRAIL_VERSION", "3")

    with pytest.raises(ConfigurationError, match="BEDROCK_GUARDRAIL_ID"):
        managed_guardrail_settings()


def test_a_draft_version_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BEDROCK_GUARDRAIL_ID", "abc")
    monkeypatch.setenv("BEDROCK_GUARDRAIL_VERSION", "DRAFT")

    with pytest.raises(ConfigurationError, match="DRAFT"):
        managed_guardrail_settings()


def test_a_numbered_version_is_read(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BEDROCK_GUARDRAIL_ID", "abc")
    monkeypatch.setenv("BEDROCK_GUARDRAIL_VERSION", "3")

    settings = managed_guardrail_settings()

    assert (settings.id, settings.version) == ("abc", "3")


# --- the service's answer ------------------------------------------------


def test_a_pass_is_no_intervention() -> None:
    outcome = _parse('{"action": "NONE"}')

    assert outcome == GuardrailOutcome(intervened=False)


def test_an_intervention_names_what_fired_and_returns_the_rewrite() -> None:
    body = json.dumps(
        {
            "action": "GUARDRAIL_INTERVENED",
            "actionReason": "Sensitive information detected",
            "assessments": [
                {
                    "contentPolicy": {"filters": [{"type": "HATE", "confidence": "HIGH"}]},
                    "sensitiveInformationPolicy": {
                        "piiEntities": [{"type": "EMAIL", "match": "a@b.c", "action": "ANONYMIZED"}]
                    },
                }
            ],
            "outputs": [{"text": "write to {EMAIL}"}],
        }
    )

    outcome = _parse(body)

    assert outcome.intervened is True
    assert outcome.policies == ("content:HATE", "pii:EMAIL")
    assert outcome.text == "write to {EMAIL}"


def test_an_unknown_action_is_a_provider_error() -> None:
    with pytest.raises(Exception, match="unknown action 'MAYBE'"):
        _parse('{"action": "MAYBE"}')


def test_a_non_json_answer_is_a_provider_error() -> None:
    with pytest.raises(Exception, match="non-JSON"):
        _parse("<html>502</html>")


# --- the adapter's request ----------------------------------------------


class FakeProvider:
    """The two provider members the adapter uses, plus the signed POST seam."""

    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, str, dict[str, str]]] = []

    def resolve_region(self) -> str:
        return "eu-west-1"

    async def credentials(self) -> dict[str, Any]:
        return {"access_key_id": "AKID", "secret_access_key": "secret"}

    async def send(self, url: str, *, body: str, headers: dict[str, str]) -> httpx.Response:
        self.requests.append((url, body, headers))
        return self.responses.pop(0)


def client_with(provider: FakeProvider) -> BedrockGuardrailClient:
    return BedrockGuardrailClient(
        settings=ManagedGuardrailSettings(id="abc", version="3"),
        provider=provider,  # type: ignore[arg-type]
        backoff_seconds=0.0,
        now=lambda: datetime(2026, 10, 4, tzinfo=UTC),
    )


async def test_the_request_names_the_pinned_version_and_the_source() -> None:
    provider = FakeProvider([httpx.Response(200, text='{"action": "NONE"}')])
    client = client_with(provider)

    await client.apply(source="INPUT", text="hello")

    url, body, headers = provider.requests[0]
    assert url == "https://bedrock.eu-west-1.amazonaws.com/guardrail/abc/version/3/apply"
    assert json.loads(body) == {"source": "INPUT", "content": [{"text": {"text": "hello"}}]}
    assert headers["x-amz-date"]
    assert "/eu-west-1/bedrock/aws4_request" in headers["authorization"]


async def test_a_throttled_check_is_retried_once_then_answers() -> None:
    provider = FakeProvider(
        [
            httpx.Response(429, text="slow down"),
            httpx.Response(200, text='{"action": "NONE"}'),
        ]
    )
    client = client_with(provider)

    outcome = await client.apply(source="OUTPUT", text="hello")

    assert outcome.intervened is False
    assert len(provider.requests) == 2


async def test_a_second_failure_fails_closed() -> None:
    provider = FakeProvider([httpx.Response(500, text="boom"), httpx.Response(500, text="boom")])
    client = client_with(provider)

    with pytest.raises(ProviderError, match="500"):
        await client.apply(source="INPUT", text="hello")
    assert len(provider.requests) == 2


# --- the engine ---------------------------------------------------------


async def test_a_managed_block_withholds_the_input() -> None:
    engine, client = engine_with(GuardrailOutcome(intervened=True, policies=("content:HATE",)))

    verdict = await engine.check_input_async((managed_definition(),), "hateful")

    assert verdict.action == "block"
    assert verdict.deciding is not None
    assert verdict.deciding.policies == ("content:HATE",)
    assert verdict.deciding.message == "refused"
    assert client.calls == [("INPUT", "hateful")]


async def test_a_managed_pass_records_nothing_and_keeps_the_text() -> None:
    engine, _ = engine_with(GuardrailOutcome(intervened=False))

    verdict = await engine.check_input_async((managed_definition(),), "hello")

    assert verdict.action is None
    assert verdict.records == ()
    assert verdict.text == "hello"


async def test_a_managed_redaction_ships_the_providers_rewrite() -> None:
    engine, _ = engine_with(
        GuardrailOutcome(intervened=True, policies=("pii:EMAIL",), text="write to {EMAIL}")
    )
    definition = managed_definition(action="redact", bedrock={"pii": ["email"]})

    verdict = await engine.check_input_async((definition,), "write to a@b.c")

    assert verdict.action == "redact"
    assert verdict.text == "write to {EMAIL}"
    assert verdict.arguments["text"] == "write to {EMAIL}"


async def test_the_output_stage_is_checked_as_output() -> None:
    engine, client = engine_with(GuardrailOutcome(intervened=True, policies=("content:HATE",)))
    definition = managed_definition(stages=["output"])

    verdict = await engine.check_output_async((definition,), "hateful")

    assert verdict.action == "block"
    assert client.calls == [("OUTPUT", "hateful")]


def test_the_synchronous_path_refuses_a_managed_guardrail() -> None:
    # Fail closed: skipping the check would allow input the deployment asked a
    # managed service to judge.
    engine = GuardrailEngine(
        guardrail_client_factory=lambda: FakeGuardrailClient(GuardrailOutcome(intervened=False))
    )

    with pytest.raises(GuardrailBlockedError, match="needs the async check"):
        engine.check_input((managed_definition(),), "hello")


def test_no_managed_client_is_built_until_a_managed_guardrail_runs() -> None:
    built: list[int] = []

    def factory() -> FakeGuardrailClient:
        built.append(1)
        return FakeGuardrailClient(GuardrailOutcome(intervened=False))

    engine = GuardrailEngine(guardrail_client_factory=factory)

    assert (
        engine.check_input((guarded(policies=["pii-detect"]),), "mail me at a@b.c").action
        == "block"
    )
    assert built == []
