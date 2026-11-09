"""The Model Armor half of managed guardrails: the template's verdict, the adapter's request.

The parser tests state the fail-closed rule directly: a body this module cannot read,
or one the service says it could not fully evaluate, must never become "the text was
fine". The adapter tests use :class:`httpx.MockTransport`, so the URL, the method and
the JSON body are proven without a GCP call.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from aid_runtime import GuardrailBlockedError
from aid_runtime.agents import GuardrailDefinition, GuardrailEngine, GuardrailOutcome
from aid_runtime.agents.ir import _guardrail
from aid_runtime.agents.managed import (
    MODEL_ARMOR_TEMPLATE_ENV,
    ModelArmorGuardrailClient,
    ModelArmorGuardrailSettings,
    _parse_model_armor,
    managed_client_for,
    model_armor_settings,
)
from aid_runtime.errors import ConfigurationError, ProviderError, ProviderResponseError

TEMPLATE = "projects/p/locations/europe-west4/templates/guard"

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


def armor_definition(**overrides: Any) -> GuardrailDefinition:
    values: dict[str, Any] = {"engine": "model-armor", "stages": ["input", "output"]}
    values.update(overrides)
    return _guardrail("shield", entry(**values), {})


def passed() -> dict[str, Any]:
    return {"invocationResult": "SUCCESS", "filterMatchState": "NO_MATCH_FOUND"}


def matched(**filters: Any) -> dict[str, Any]:
    return {
        "invocationResult": "SUCCESS",
        "filterMatchState": "MATCH_FOUND",
        "filterResults": filters,
    }


def body(result: dict[str, Any]) -> str:
    return json.dumps({"sanitizationResult": result})


# --- the IR's word -------------------------------------------------------


def test_the_template_is_the_policy_so_the_definition_carries_none() -> None:
    definition = armor_definition()

    assert definition.engine == "model-armor"
    assert definition.policies == ()
    assert definition.bedrock is None


def test_a_model_armor_redaction_is_refused() -> None:
    # The gate refuses it at build time for the same reason: only an advanced DLP
    # de-identify template rewrites text, and that is invisible from here.
    with pytest.raises(ConfigurationError, match="advanced DLP de-identify"):
        guarded(engine="model-armor", action="redact")


# --- the settings the deployment provides --------------------------------


def test_a_missing_template_names_the_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(MODEL_ARMOR_TEMPLATE_ENV, raising=False)

    with pytest.raises(ConfigurationError, match=MODEL_ARMOR_TEMPLATE_ENV):
        model_armor_settings()


def test_a_template_name_that_is_not_a_resource_name_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(MODEL_ARMOR_TEMPLATE_ENV, "guard")

    with pytest.raises(ConfigurationError, match="template resource name"):
        model_armor_settings()


def test_the_region_comes_from_the_template_not_a_second_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(MODEL_ARMOR_TEMPLATE_ENV, TEMPLATE)

    settings = model_armor_settings()

    assert settings == ModelArmorGuardrailSettings(template=TEMPLATE, location="europe-west4")


# --- the service's answer ------------------------------------------------


def test_a_pass_is_no_intervention() -> None:
    assert _parse_model_armor(body(passed())) == GuardrailOutcome(intervened=False)


def test_a_match_names_every_filter_that_fired_and_returns_the_rewrite() -> None:
    result = matched(
        rai={
            "raiFilterResult": {
                "matchState": "MATCH_FOUND",
                "raiFilterTypeResults": {
                    "hate_speech": {"matchState": "MATCH_FOUND"},
                    "dangerous": {"matchState": "NO_MATCH_FOUND"},
                },
            }
        },
        pi_and_jailbreak={"piAndJailbreakFilterResult": {"matchState": "MATCH_FOUND"}},
        sdp={
            "sdpFilterResult": {
                "inspectResult": {
                    "matchState": "MATCH_FOUND",
                    "findings": [{"infoType": "EMAIL_ADDRESS"}],
                },
                "deidentifyResult": {
                    "matchState": "MATCH_FOUND",
                    "data": {"text": "write to [EMAIL]"},
                },
            }
        },
        malicious_uris={"maliciousUriFilterResult": {"matchState": "MATCH_FOUND"}},
    )

    outcome = _parse_model_armor(body(result))

    assert outcome.intervened is True
    # A filter that did not match contributes no label, and the de-identified text is
    # the only rewrite the service returns.
    assert outcome.policies == (
        "rai:hate_speech",
        "pi-and-jailbreak",
        "sdp:EMAIL_ADDRESS",
        "sdp",
        "malicious-uri",
    )
    assert outcome.text == "write to [EMAIL]"


def test_a_deidentify_without_inspect_still_names_the_family() -> None:
    result = matched(
        sdp={
            "sdpFilterResult": {
                "deidentifyResult": {"matchState": "MATCH_FOUND", "data": {"text": "x"}}
            }
        }
    )

    outcome = _parse_model_armor(body(result))

    assert outcome.policies == ("sdp",)
    assert outcome.text == "x"


def test_a_partial_evaluation_is_a_provider_error() -> None:
    # PARTIAL means a filter was skipped, so NO_MATCH_FOUND would be a verdict about
    # checks that did not run.
    with pytest.raises(ProviderResponseError, match="invocationResult"):
        _parse_model_armor(
            body({"invocationResult": "PARTIAL", "filterMatchState": "NO_MATCH_FOUND"})
        )


def test_a_failed_evaluation_is_a_provider_error() -> None:
    with pytest.raises(ProviderResponseError, match="invocationResult"):
        _parse_model_armor(
            body({"invocationResult": "FAILURE", "filterMatchState": "NO_MATCH_FOUND"})
        )


def test_a_missing_verdict_is_a_provider_error() -> None:
    with pytest.raises(ProviderResponseError, match="sanitizationResult"):
        _parse_model_armor("{}")


def test_an_unknown_match_state_is_a_provider_error() -> None:
    with pytest.raises(ProviderResponseError, match="filterMatchState"):
        _parse_model_armor(body({"invocationResult": "SUCCESS", "filterMatchState": "MAYBE"}))


def test_a_non_json_answer_is_a_provider_error() -> None:
    with pytest.raises(ProviderResponseError, match="non-JSON"):
        _parse_model_armor("<html>502</html>")


# --- the adapter's request ----------------------------------------------


class FakeTokenProvider:
    """The one provider member this adapter uses."""

    async def access_token(self) -> str:
        return "tok"


def client_with(
    handler: Any,
    *,
    max_attempts: int = 2,
) -> ModelArmorGuardrailClient:
    return ModelArmorGuardrailClient(
        settings=ModelArmorGuardrailSettings(template=TEMPLATE, location="europe-west4"),
        provider=FakeTokenProvider(),  # type: ignore[arg-type]
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        max_attempts=max_attempts,
        backoff_seconds=0.0,
    )


async def test_the_request_names_the_template_and_the_source() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"sanitizationResult": passed()})

    client = client_with(handler)
    await client.apply(source="INPUT", text="hello")

    (request,) = seen
    assert str(request.url) == (
        f"https://modelarmor.europe-west4.rep.googleapis.com/v1/{TEMPLATE}:sanitizeUserPrompt"
    )
    assert json.loads(request.content) == {"userPromptData": {"text": "hello"}}
    assert request.headers["authorization"] == "Bearer tok"
    assert request.headers["content-type"] == "application/json"
    await client.aclose()


async def test_the_output_source_calls_the_other_method() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"sanitizationResult": passed()})

    client = client_with(handler)
    await client.apply(source="OUTPUT", text="bye")

    (request,) = seen
    assert str(request.url).endswith(":sanitizeModelResponse")
    assert json.loads(request.content) == {"modelResponseData": {"text": "bye"}}
    await client.aclose()


async def test_a_source_outside_the_two_stages_is_refused() -> None:
    client = client_with(lambda request: httpx.Response(200))

    with pytest.raises(ValueError, match="INPUT or OUTPUT"):
        await client.apply(source="RETRIEVAL", text="hello")
    await client.aclose()


async def test_a_throttled_check_is_retried_once_then_answers() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, text="slow down")
        return httpx.Response(200, json={"sanitizationResult": passed()})

    client = client_with(handler)
    outcome = await client.apply(source="OUTPUT", text="hello")

    assert outcome.intervened is False
    assert len(calls) == 2
    await client.aclose()


async def test_a_second_failure_fails_closed() -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(500, text="boom")

    client = client_with(handler)

    with pytest.raises(ProviderError, match="500"):
        await client.apply(source="INPUT", text="hello")
    assert len(calls) == 2
    await client.aclose()


# --- the engine ---------------------------------------------------------


class FakeGuardrailClient:
    def __init__(self, outcome: GuardrailOutcome) -> None:
        self.outcome = outcome
        self.calls: list[tuple[str, str]] = []

    async def apply(self, *, source: str, text: str) -> GuardrailOutcome:
        self.calls.append((source, text))
        return self.outcome


async def test_a_model_armor_block_withholds_the_input() -> None:
    client = FakeGuardrailClient(GuardrailOutcome(intervened=True, policies=("rai:hate_speech",)))
    engine = GuardrailEngine(guardrail_client_factory=lambda: client)

    verdict = await engine.check_input_async((armor_definition(),), "hateful")

    assert verdict.action == "block"
    assert verdict.deciding is not None
    assert verdict.deciding.policies == ("rai:hate_speech",)
    assert client.calls == [("INPUT", "hateful")]


async def test_a_model_armor_pass_records_nothing_and_keeps_the_text() -> None:
    engine = GuardrailEngine(
        guardrail_client_factory=lambda: FakeGuardrailClient(GuardrailOutcome(intervened=False))
    )

    verdict = await engine.check_input_async((armor_definition(),), "hello")

    assert verdict.action is None
    assert verdict.records == ()
    assert verdict.text == "hello"


def test_the_engine_names_the_client_its_engine_needs() -> None:
    # Constructing either client reads no environment, so this proves the choice
    # without a deployment or a GCP call.
    assert isinstance(managed_client_for("model-armor"), ModelArmorGuardrailClient)
    assert type(managed_client_for("bedrock")).__name__ == "BedrockGuardrailClient"


def test_the_synchronous_path_refuses_a_model_armor_guardrail() -> None:
    engine = GuardrailEngine(
        guardrail_client_factory=lambda: FakeGuardrailClient(GuardrailOutcome(intervened=False))
    )

    with pytest.raises(GuardrailBlockedError, match="needs the async check"):
        engine.check_input((armor_definition(),), "hello")


def test_no_model_armor_client_is_built_until_it_runs() -> None:
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
