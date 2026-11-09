"""The managed-guardrail adapter: ``ApplyGuardrail``, and the policy names it takes.

A ``bedrock`` guardrail is evaluated by AWS, not by this process. The deployment
creates the policy and a numbered version; the app knows only
``BEDROCK_GUARDRAIL_ID`` and ``BEDROCK_GUARDRAIL_VERSION``. That split is what
keeps an account number out of the spec: the spec says *what* to refuse, the
deployment says *where* the resource lives, and neither has to know the other's
identifier.

Two decisions this module owns:

**The IR's vocabulary, not AWS's, is the input.** ``content``/``strength``/``pii``
arrive as the spec spells them -- ``prompt-attack: high``, ``credit-card`` -- and
this is the one table that maps them to ``PROMPT_ATTACK`` and
``CREDIT_DEBIT_CARD_NUMBER``. The generator therefore never carries a second copy
of the provider's enum, and a test can pin the mapping without an AWS call.

**Every failure is a block.** A non-2xx answer, a body this module cannot read, an
unknown ``action``, a missing identifier: each raises, and
:class:`~aid_runtime.agents.guardrails.GuardrailEngine` turns that into a
:class:`~aid_runtime.errors.GuardrailBlockedError`. There is no path from "the
managed check did not run" to "the text was fine".
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx

from aid_runtime.errors import ConfigurationError, ProviderError, ProviderResponseError
from aid_runtime.providers.bedrock import BedrockProvider, rfc3986, sigv4_headers
from aid_runtime.providers.vertex import VertexProvider

__all__ = [
    "CONTENT_STRENGTHS",
    "CONTENT_TYPES",
    "GUARDRAIL_ID_ENV",
    "GUARDRAIL_VERSION_ENV",
    "MODEL_ARMOR_TEMPLATE_ENV",
    "PII_TYPES",
    "BedrockGuardrailClient",
    "GuardrailClient",
    "GuardrailOutcome",
    "ManagedGuardrailSettings",
    "ModelArmorGuardrailClient",
    "ModelArmorGuardrailSettings",
    "managed_client_for",
    "managed_guardrail_settings",
    "model_armor_settings",
]

GUARDRAIL_ID_ENV = "BEDROCK_GUARDRAIL_ID"
GUARDRAIL_VERSION_ENV = "BEDROCK_GUARDRAIL_VERSION"

#: The full resource name of the Model Armor template the deployment owns.
MODEL_ARMOR_TEMPLATE_ENV = "MODEL_ARMOR_TEMPLATE"

#: ``projects/{project}/locations/{location}/templates/{id}``, the only address the
#: sanitize methods take. The location embedded in it selects the regional endpoint.
_MODEL_ARMOR_TEMPLATE = re.compile(
    r"^projects/[^/]+/locations/(?P<location>[^/]+)/templates/[^/]+$"
)

_MODEL_ARMOR_METHODS: Mapping[str, str] = {
    "INPUT": "sanitizeUserPrompt",
    "OUTPUT": "sanitizeModelResponse",
}

#: One entry per ``BedrockContentFilter`` in ``packages/ir/src/shapes.ts``.
CONTENT_TYPES: Mapping[str, str] = {
    "sexual": "SEXUAL",
    "violence": "VIOLENCE",
    "hate": "HATE",
    "insults": "INSULTS",
    "misconduct": "MISCONDUCT",
    "prompt-attack": "PROMPT_ATTACK",
}

CONTENT_STRENGTHS: Mapping[str, str] = {
    "low": "LOW",
    "medium": "MEDIUM",
    "high": "HIGH",
}

#: One entry per ``BedrockPiiEntity``. Names with a jurisdiction are the ones AWS
#: spells out; the rest are the entity type verbatim.
PII_TYPES: Mapping[str, str] = {
    "email": "EMAIL",
    "phone": "PHONE",
    "name": "NAME",
    "address": "ADDRESS",
    "ssn": "US_SOCIAL_SECURITY_NUMBER",
    "credit-card": "CREDIT_DEBIT_CARD_NUMBER",
    "bank-account": "US_BANK_ACCOUNT_NUMBER",
    "passport": "PASSPORT_NUMBER",
    "drivers-license": "DRIVERS_LICENSE_NUMBER",
    "ip-address": "IP_ADDRESS",
    "url": "URL",
    "aws-access-key": "AWS_ACCESS_KEY",
    "aws-secret-key": "AWS_SECRET_KEY",
}

_SOURCES = frozenset({"INPUT", "OUTPUT"})
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


@dataclass(frozen=True, slots=True)
class ManagedGuardrailSettings:
    """Where the deployment put the managed guardrail."""

    id: str
    version: str


def managed_guardrail_settings() -> ManagedGuardrailSettings:
    """Read the two environment names, or explain which one is missing.

    ``DRAFT`` is refused on purpose: AWS lets an app call a draft, and a draft
    changes under it. A deployment ships a numbered version, so the version this
    process names is the policy it actually enforces.
    """
    guardrail_id = os.environ.get(GUARDRAIL_ID_ENV)
    version = os.environ.get(GUARDRAIL_VERSION_ENV)
    missing = [
        name
        for name, value in ((GUARDRAIL_ID_ENV, guardrail_id), (GUARDRAIL_VERSION_ENV, version))
        if not value
    ]
    if missing:
        raise ConfigurationError(
            "the spec declares a managed guardrail, so "
            + " and ".join(missing)
            + " must be set: the deployment creates the resource, the app only names it"
        )
    if version == "DRAFT":
        raise ConfigurationError(
            f"{GUARDRAIL_VERSION_ENV}=DRAFT is not a pinned policy; name the numbered "
            "version the deployment created"
        )
    return ManagedGuardrailSettings(id=guardrail_id or "", version=version or "")


@dataclass(frozen=True, slots=True)
class ModelArmorGuardrailSettings:
    """Where the deployment put the Model Armor template.

    ``template`` is the full resource name, because that is the only address the
    sanitize methods take. ``location`` is derived from it rather than read from a
    second environment name: the two cannot disagree, and a deployment that moved
    the template across regions cannot leave the app calling the old endpoint.
    """

    template: str
    location: str


def model_armor_settings() -> ModelArmorGuardrailSettings:
    """Read the template name, or explain what is missing or malformed.

    A Model Armor template has no version in its name. Pinning is the template's own
    ``filter_version_selector``, which the operator sets on the resource -- so unlike
    ``BEDROCK_GUARDRAIL_VERSION`` there is nothing here for the app to refuse.
    """
    template = os.environ.get(MODEL_ARMOR_TEMPLATE_ENV)
    if not template:
        raise ConfigurationError(
            "the spec declares a model-armor guardrail, so "
            f"{MODEL_ARMOR_TEMPLATE_ENV} must be set: the deployment creates the template, "
            "the app only names it"
        )
    match = _MODEL_ARMOR_TEMPLATE.match(template)
    if match is None:
        raise ConfigurationError(
            f"{MODEL_ARMOR_TEMPLATE_ENV} must be a template resource name "
            "projects/{project}/locations/{location}/templates/{id}, not "
            f"{template!r}"
        )
    return ModelArmorGuardrailSettings(template=template, location=match.group("location"))


@dataclass(frozen=True, slots=True)
class GuardrailOutcome:
    """One ``ApplyGuardrail`` answer, in terms the engine can act on.

    ``text`` is the service's rewritten content, present when the policy
    anonymised something. ``policies`` names what fired, for the audit trail:
    ``content:HATE``, ``pii:EMAIL``, ``topic:investments``.
    """

    intervened: bool
    policies: tuple[str, ...] = ()
    text: str | None = None


class GuardrailClient(Protocol):
    """The one call the engine makes, so a test double need not sign anything."""

    async def apply(self, *, source: str, text: str) -> GuardrailOutcome: ...


class BedrockGuardrailClient:
    """``POST /guardrail/{id}/version/{version}/apply`` with SigV4.

    Retries once -- the summary's "retry once on throttling" -- and then gives up
    loudly. A retry is worth it for a throttled control-plane call; a third
    attempt would keep a user waiting for a check that is failing closed anyway.
    """

    def __init__(
        self,
        *,
        settings: ManagedGuardrailSettings | None = None,
        provider: BedrockProvider | None = None,
        region: str | None = None,
        base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 15.0,
        max_attempts: int = 2,
        backoff_seconds: float = 0.25,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._settings = settings
        self._base_url = base_url.rstrip("/") if base_url is not None else None
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds
        self._now = now or (lambda: datetime.now(UTC))
        self._owns_client = provider is None and client is None
        self._provider = provider or BedrockProvider(
            region=region,
            timeout_seconds=timeout_seconds,
            max_attempts=1,
            client=client,
            name="bedrock-guardrail",
        )

    @property
    def settings(self) -> ManagedGuardrailSettings:
        if self._settings is None:
            self._settings = managed_guardrail_settings()
        return self._settings

    async def aclose(self) -> None:
        if self._owns_client:
            await self._provider.aclose()

    async def apply(self, *, source: str, text: str) -> GuardrailOutcome:
        if source not in _SOURCES:
            raise ValueError(f"source must be INPUT or OUTPUT, not {source!r}")
        settings = self.settings
        region = self._provider.resolve_region()
        credentials = await self._provider.credentials()
        payload = json.dumps(
            {"source": source, "content": [{"text": {"text": text}}]},
            separators=(",", ":"),
        )
        url = self._url(region, settings)
        headers = sigv4_headers(
            url=url,
            body=payload,
            region=region,
            credentials=credentials,
            moment=self._now(),
        )
        answer = await self._post(url, headers, payload)
        return _parse(answer)

    def _url(self, region: str, settings: ManagedGuardrailSettings) -> str:
        base = self._base_url or f"https://bedrock.{region}.amazonaws.com"
        return f"{base}/guardrail/{rfc3986(settings.id)}/version/{rfc3986(settings.version)}/apply"

    async def _post(self, url: str, headers: dict[str, str], body: str) -> str:
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._provider.send(url, body=body, headers=headers)
            except httpx.TransportError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    break
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue
            if response.status_code in _RETRYABLE_STATUS and attempt < self._max_attempts:
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue
            if response.status_code >= 400:
                raise ProviderError(
                    f"the managed guardrail returned {response.status_code}: {response.text[:500]}"
                )
            return response.text
        raise ProviderError(f"the managed guardrail could not be reached: {last_error}")


def _parse(body: str) -> GuardrailOutcome:
    try:
        answer = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ProviderResponseError("the managed guardrail returned a non-JSON body", body) from exc
    if not isinstance(answer, dict):
        raise ProviderResponseError("the managed guardrail returned no object", body)
    action = answer.get("action")
    if action == "NONE":
        return GuardrailOutcome(intervened=False)
    if action != "GUARDRAIL_INTERVENED":
        raise ProviderResponseError(
            f"the managed guardrail returned unknown action {action!r}", body
        )
    return GuardrailOutcome(
        intervened=True,
        policies=_policy_labels(answer.get("assessments")),
        text=_output_text(answer.get("outputs")),
    )


def _output_text(outputs: Any) -> str | None:
    if not isinstance(outputs, list) or not outputs:
        return None
    first = outputs[0]
    if isinstance(first, Mapping):
        text = first.get("text")
        if isinstance(text, str):
            return text
    return None


def _policy_labels(assessments: Any) -> tuple[str, ...]:
    """What fired, named the way the spec would name it.

    AWS reports an assessment per policy family, each with its own list shape.
    Flattening them into ``family:value`` strings is enough for a log line and a
    trace event, and avoids inventing a second schema for the audit trail.
    """
    labels: list[str] = []
    if not isinstance(assessments, Sequence) or isinstance(assessments, (str, bytes)):
        return ()

    def add(label: str | None) -> None:
        if label is not None and label not in labels:
            labels.append(label)

    for assessment in assessments:
        if not isinstance(assessment, Mapping):
            continue
        content = assessment.get("contentPolicy")
        if isinstance(content, Mapping):
            for entry in _entries(content.get("filters")):
                add(_prefixed("content", entry.get("type")))
        topics = assessment.get("topicPolicy")
        if isinstance(topics, Mapping):
            for entry in _entries(topics.get("topics")):
                add(_prefixed("topic", entry.get("name")))
        words = assessment.get("wordPolicy")
        if isinstance(words, Mapping):
            for entry in _entries(words.get("customWords")):
                add(_prefixed("word", entry.get("match")))
            for entry in _entries(words.get("managedWordLists")):
                add(_prefixed("word", entry.get("type")))
        sensitive = assessment.get("sensitiveInformationPolicy")
        if isinstance(sensitive, Mapping):
            for entry in _entries(sensitive.get("piiEntities")):
                add(_prefixed("pii", entry.get("type")))
            for entry in _entries(sensitive.get("regexes")):
                add(_prefixed("regex", entry.get("name")))
    return tuple(labels)


def _entries(value: Any) -> tuple[Mapping[str, Any], ...]:
    if not isinstance(value, list):
        return ()
    return tuple(entry for entry in value if isinstance(entry, Mapping))


def _prefixed(family: str, value: Any) -> str | None:
    return f"{family}:{value}" if isinstance(value, str) and value else None


class ModelArmorGuardrailClient:
    """``sanitizeUserPrompt`` / ``sanitizeModelResponse`` with a bearer token.

    Model Armor is Google Cloud's counterpart to ``ApplyGuardrail``: the template
    holds the policy, and the call takes text and answers with a verdict. The wire
    shape differs in one way the engine must not paper over -- there is a single
    overall ``filterMatchState`` plus a per-filter ``matchState``, not a per-assessment
    action -- so the labels below name the filter that matched rather than an AWS
    policy family.

    Two rules keep the fail-closed promise:

    * ``invocationResult`` must be ``SUCCESS``. ``PARTIAL`` means a filter was
      skipped, so "no match" would be a verdict about filters that never ran.
    * Only DLP's ``deidentifyResult`` rewrites text. A template without an advanced
      de-identify configuration inspects and reports; the spec layer refuses
      ``action: redact`` for this engine rather than promising a rewrite the service
      may not perform.
    """

    def __init__(
        self,
        *,
        settings: ModelArmorGuardrailSettings | None = None,
        provider: VertexProvider | None = None,
        base_url: str | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 15.0,
        max_attempts: int = 2,
        backoff_seconds: float = 0.25,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self._settings = settings
        self._base_url = base_url.rstrip("/") if base_url is not None else None
        self._max_attempts = max_attempts
        self._backoff = backoff_seconds
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_client = client is None
        self._provider = provider or VertexProvider(
            name="model-armor", timeout_seconds=timeout_seconds, client=self._client
        )

    @property
    def settings(self) -> ModelArmorGuardrailSettings:
        if self._settings is None:
            self._settings = model_armor_settings()
        return self._settings

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def apply(self, *, source: str, text: str) -> GuardrailOutcome:
        if source not in _SOURCES:
            raise ValueError(f"source must be INPUT or OUTPUT, not {source!r}")
        settings = self.settings
        token = await self._provider.access_token()
        method = _MODEL_ARMOR_METHODS[source]
        field = "userPromptData" if source == "INPUT" else "modelResponseData"
        payload = json.dumps({field: {"text": text}}, separators=(",", ":"))
        url = self._url(settings, method)
        answer = await self._post(
            url,
            {"authorization": f"Bearer {token}", "content-type": "application/json"},
            payload,
        )
        return _parse_model_armor(answer)

    def _url(self, settings: ModelArmorGuardrailSettings, method: str) -> str:
        base = self._base_url or f"https://modelarmor.{settings.location}.rep.googleapis.com"
        return f"{base}/v1/{settings.template}:{method}"

    async def _post(self, url: str, headers: dict[str, str], body: str) -> str:
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.post(url, content=body, headers=headers)
            except httpx.TransportError as exc:
                last_error = exc
                if attempt == self._max_attempts:
                    break
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue
            if response.status_code in _RETRYABLE_STATUS and attempt < self._max_attempts:
                await asyncio.sleep(self._backoff * 2 ** (attempt - 1))
                continue
            if response.status_code >= 400:
                raise ProviderError(
                    "the Model Armor template returned "
                    f"{response.status_code}: {response.text[:500]}"
                )
            return response.text
        raise ProviderError(f"the Model Armor template could not be reached: {last_error}")


def managed_client_for(engine: str) -> GuardrailClient:
    """The client an engine needs, chosen from the engine alone.

    Model Armor is not Bedrock with different names: the two read different
    environment variables and call different APIs. Selecting here keeps the engine
    from constructing a Bedrock client for a deployment that named a template.
    """
    return ModelArmorGuardrailClient() if engine == "model-armor" else BedrockGuardrailClient()


def _parse_model_armor(body: str) -> GuardrailOutcome:
    try:
        answer = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ProviderResponseError(
            "the Model Armor template returned a non-JSON body", body
        ) from exc
    if not isinstance(answer, dict):
        raise ProviderResponseError("the Model Armor template returned no object", body)
    result = answer.get("sanitizationResult")
    if not isinstance(result, Mapping):
        raise ProviderResponseError("the Model Armor response has no sanitizationResult", body)
    invocation = result.get("invocationResult")
    if invocation != "SUCCESS":
        raise ProviderResponseError(
            "the Model Armor template could not evaluate every filter "
            f"(invocationResult {invocation!r})",
            body,
        )
    state = result.get("filterMatchState")
    if state == "NO_MATCH_FOUND":
        return GuardrailOutcome(intervened=False)
    if state != "MATCH_FOUND":
        raise ProviderResponseError(
            f"the Model Armor template returned unknown filterMatchState {state!r}", body
        )
    filters = result.get("filterResults")
    return GuardrailOutcome(
        intervened=True,
        policies=_model_armor_labels(filters),
        text=_model_armor_text(filters),
    )


def _model_armor_labels(filters: Any) -> tuple[str, ...]:
    """What matched, named the way the spec would name it.

    ``rai:hate_speech``, ``pi-and-jailbreak``, ``sdp:EMAIL_ADDRESS``,
    ``malicious-uri``: one label per filter that matched, so a trace line says which
    check refused the text without carrying the provider's nested response.
    """
    if not isinstance(filters, Mapping):
        return ()
    labels: list[str] = []

    def add(label: str | None) -> None:
        if label is not None and label not in labels:
            labels.append(label)

    rai = _inner(filters, "rai", "raiFilterResult")
    if isinstance(rai, Mapping):
        types = rai.get("raiFilterTypeResults")
        if isinstance(types, Mapping):
            for name, entry in types.items():
                if isinstance(entry, Mapping) and entry.get("matchState") == "MATCH_FOUND":
                    add(_prefixed("rai", name))

    if _matched(_inner(filters, "pi_and_jailbreak", "piAndJailbreakFilterResult")):
        add("pi-and-jailbreak")

    sdp = _inner(filters, "sdp", "sdpFilterResult")
    if isinstance(sdp, Mapping):
        inspect = sdp.get("inspectResult")
        if isinstance(inspect, Mapping) and inspect.get("matchState") == "MATCH_FOUND":
            for finding in _entries(inspect.get("findings")):
                add(_prefixed("sdp", finding.get("infoType")))
        if _matched(sdp.get("deidentifyResult")):
            add("sdp")

    if _matched(_inner(filters, "malicious_uris", "maliciousUriFilterResult")):
        add("malicious-uri")
    if _matched(_inner(filters, "csam", "csamFilterFilterResult")):
        add("csam")
    return tuple(labels)


def _model_armor_text(filters: Any) -> str | None:
    """The de-identified text, when the template was configured to produce one."""
    if not isinstance(filters, Mapping):
        return None
    sdp = _inner(filters, "sdp", "sdpFilterResult")
    if sdp is None:
        return None
    deidentify = sdp.get("deidentifyResult")
    if not isinstance(deidentify, Mapping) or deidentify.get("matchState") != "MATCH_FOUND":
        return None
    data = deidentify.get("data")
    if isinstance(data, Mapping):
        text = data.get("text")
        if isinstance(text, str):
            return text
    return None


def _inner(filters: Mapping[str, Any], key: str, inner: str) -> Mapping[str, Any] | None:
    entry = filters.get(key)
    if not isinstance(entry, Mapping):
        return None
    value = entry.get(inner)
    return value if isinstance(value, Mapping) else None


def _matched(entry: Any) -> bool:
    return isinstance(entry, Mapping) and entry.get("matchState") == "MATCH_FOUND"
