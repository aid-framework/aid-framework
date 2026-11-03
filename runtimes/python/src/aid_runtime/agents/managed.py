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
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

import httpx

from aid_runtime.errors import ConfigurationError, ProviderError, ProviderResponseError
from aid_runtime.providers.bedrock import BedrockProvider, rfc3986, sigv4_headers

__all__ = [
    "CONTENT_STRENGTHS",
    "CONTENT_TYPES",
    "GUARDRAIL_ID_ENV",
    "GUARDRAIL_VERSION_ENV",
    "PII_TYPES",
    "BedrockGuardrailClient",
    "GuardrailClient",
    "GuardrailOutcome",
    "ManagedGuardrailSettings",
    "managed_guardrail_settings",
]

GUARDRAIL_ID_ENV = "BEDROCK_GUARDRAIL_ID"
GUARDRAIL_VERSION_ENV = "BEDROCK_GUARDRAIL_VERSION"

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
