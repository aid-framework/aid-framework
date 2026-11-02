"""The guardrails engine: the IR's ``guardrails`` collection, actually evaluated.

The IR already carries the *declaration* -- stages, policy kinds, an action, the
fields a redaction may touch. This module is the missing other half: something
that looks at text and decides. It is deliberately small and offline. Every
detector is a regular expression, so the answer for a given input does not depend
on a model, a network call, or a random seed, and a spec that passes here will
pass here again tomorrow.

Four stages, in the order a run meets them:

``input``
    before the model sees the user's turn.
``retrieval``
    around the chunks a retriever would splice into the prompt.
``tool-call``
    before a tool's handler body runs, over the call's arguments.
``output``
    after the model answers.

Three decisions this module owns, all of them recorded in ``docs/design.md`` §7.6:

**Undecidable is a block.** A guardrail naming a policy with no evaluator, or
whose ``redact`` fields do not cover the text it matched, raises
:class:`~aid_runtime.errors.GuardrailBlockedError`. There is no path from "the
check could not run" to "no violation found".

**Evaluation order is declaration order, except that ``block`` outranks it.** At
one stage the engine walks the agent's guardrails in the order the IR declared
them and collects every guardrail that fired. If *any* of them is a ``block``,
the first such guardrail decides -- a later ``flag`` cannot talk an earlier
``block`` down. Otherwise the first guardrail that fired decides. Both halves are
pinned by tests: swapping the order changes which record is ``deciding`` while a
``block`` keeps winning.

**``flag`` cannot be ignored, but it does not stop anything.** A flag is recorded
on the run (``RunResult.guardrails``) and on the ``aid.guardrail`` span event, and
the guarded text passes through unchanged. The consumer is whoever reads the run
result -- an eval, a log shipper, a reviewer. It is *not* an allow: a flag means a
detector matched, and the run carried on because the spec said the run may.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, cast

from pydantic import BaseModel, ConfigDict

from aid_runtime.agents.ir import DecisionDefinition, GuardrailDefinition
from aid_runtime.decisions import DecisionClient, DecisionQuestion, DecisionResponse
from aid_runtime.errors import ConfigurationError, GuardrailBlockedError

__all__ = [
    "ACTION_BLOCK",
    "ACTION_ESCALATE",
    "ACTION_FLAG",
    "ACTION_REDACT",
    "DETECTORS",
    "GUARDRAIL_ACTIONS",
    "GUARDRAIL_STAGES",
    "Detection",
    "GuardrailEngine",
    "GuardrailEscalation",
    "GuardrailRecord",
    "GuardrailVerdict",
    "detect",
]

GuardrailStage = Literal["input", "output", "retrieval", "tool-call"]
GuardrailAction = Literal["block", "redact", "flag", "escalate"]

ACTION_BLOCK: GuardrailAction = "block"
ACTION_REDACT: GuardrailAction = "redact"
ACTION_FLAG: GuardrailAction = "flag"
ACTION_ESCALATE: GuardrailAction = "escalate"

GUARDRAIL_STAGES: tuple[GuardrailStage, ...] = ("input", "retrieval", "tool-call", "output")
GUARDRAIL_ACTIONS: tuple[GuardrailAction, ...] = (
    ACTION_BLOCK,
    ACTION_REDACT,
    ACTION_FLAG,
    ACTION_ESCALATE,
)

#: What a redacted span is replaced with. Carrying the policy name means a log line
#: says *why* the text vanished, which a bare ``***`` does not.
_REDACTION = "[REDACTED:{policy}]"


@dataclass(frozen=True, slots=True)
class Detection:
    """One match: which policy fired, and the half-open span it fired on."""

    policy: str
    start: int
    end: int


class GuardrailRecord(BaseModel):
    """One guardrail that fired at one stage. The audit trail's unit."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    guardrail: str
    stage: GuardrailStage
    action: GuardrailAction
    policies: tuple[str, ...]
    message: str
    #: Set when a decision answered rather than a detector, so a reviewer can tell
    #: "the classifier said block" from "the regex matched" without the log message.
    decision: str | None = None
    label: str | None = None
    confidence: float | None = None


class GuardrailEscalation(BaseModel):
    """A guardrail that entered human-in-the-loop instead of deciding by itself.

    ``text`` is the guarded payload, kept so that approving an ``output``
    escalation can release the model's answer without re-running the model -- and
    so that a rejection can show the human what they rejected.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    guardrail: str
    stage: GuardrailStage
    message: str
    channel: str = ""
    text: str = ""


@dataclass(frozen=True, slots=True)
class GuardrailVerdict:
    """The engine's answer for one stage of one turn.

    ``records`` is every guardrail that fired, not only the deciding one: a
    ``flag`` next to a ``block`` still has to reach the audit trail. ``action`` and
    ``deciding`` are the outcome; ``text`` and ``arguments`` are the payload after
    any ``redact`` was applied.
    """

    stage: GuardrailStage
    records: tuple[GuardrailRecord, ...] = ()
    action: str | None = None
    deciding: GuardrailRecord | None = None
    text: str = ""
    arguments: Mapping[str, Any] = field(default_factory=dict)

    @property
    def fired(self) -> bool:
        """Whether any guardrail matched, whatever it decided to do about it."""
        return bool(self.records)


def _phrase(*phrases: str) -> re.Pattern[str]:
    joined = "|".join(re.escape(phrase) for phrase in phrases)
    return re.compile(rf"\b(?:{joined})\b", re.IGNORECASE)


#: One entry per ``GuardrailPolicyKind`` in ``packages/ir/src/shapes.ts``. The keys
#: are closed on both sides: the IR gate rejects an unknown kind at build time and
#: :meth:`GuardrailEngine.check` rejects it again at run time.
#:
#: These are *heuristics*, and saying so is the honest description. They catch the
#: shapes a red-team corpus is built from -- an instruction-override phrase, a
#: well-formed email or card-like digit run, a jailbreak persona -- and they will
#: not catch a paraphrase. The corpus in ``tests/redteam`` measures that recall
#: against fixtures with recorded provenance instead of asserting it in prose.
DETECTORS: Mapping[str, tuple[re.Pattern[str], ...]] = {
    "prompt-injection": (
        _phrase(
            "ignore previous instructions",
            "ignore all previous instructions",
            "ignore the previous instructions",
            "ignore your instructions",
            "disregard previous instructions",
            "disregard your instructions",
            "forget your instructions",
            "override your instructions",
            "ignore the system prompt",
            "reveal the system prompt",
            "reveal your system prompt",
            "print the system prompt",
            "show me your system prompt",
        ),
        re.compile(
            r"\byou are now (?:a|an|the|in|no longer)\b",
            re.IGNORECASE,
        ),
        re.compile(r"<\|\s*im_start\s*\|>", re.IGNORECASE),
    ),
    "jailbreak": (
        _phrase(
            "do anything now",
            "developer mode",
            "jailbreak mode",
            "dan mode",
            "without any restrictions",
            "no ethical guidelines",
            "no restrictions apply",
        ),
        re.compile(r"\bpretend (?:that )?you (?:have no|are not bound)", re.IGNORECASE),
        re.compile(r"\bact as (?:an? )?(?:unrestricted|uncensored)\b", re.IGNORECASE),
    ),
    "pii-detect": (
        re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
        re.compile(r"(?<!\d)(?:\+?\d{1,3}[ -]?)?(?:\(\d{3}\)[ -]?|\d{3}[ -])\d{3}[ -]\d{4}(?!\d)"),
        re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"),
        re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)"),
    ),
    "pii-redact": (
        re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
        re.compile(r"(?<!\d)(?:\+?\d{1,3}[ -]?)?(?:\(\d{3}\)[ -]?|\d{3}[ -])\d{3}[ -]\d{4}(?!\d)"),
        re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"),
        re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)"),
    ),
    "secret-scan": (
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
        re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b"),
        re.compile(r"\bsk-[A-Za-z0-9]{16,}\b"),
        re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    ),
    "moderation": (
        _phrase(
            "how to build a bomb",
            "how to make a bomb",
            "build an explosive device",
            "synthesize sarin",
            "make nerve agent",
        ),
    ),
    "toxicity": (
        _phrase(
            "kill yourself",
            "go die",
            "you should die",
            "subhuman",
        ),
    ),
}

#: Policy kinds whose detection is about a *value* that a redaction can erase. The
#: others match intent, and masking an intent phrase would not make the request
#: safe -- which is why a ``redact`` guardrail over them fails closed below.
_REDACTABLE = frozenset({"pii-detect", "pii-redact", "secret-scan"})

#: The outcomes a decision label may map to. ``allow`` is the one that records
#: nothing; ``redact`` is absent because a label cannot name the field to rewrite.
_DECISION_OUTCOMES = frozenset({"allow", "block", "flag", "escalate"})


def detect(policy: str, text: str) -> tuple[Detection, ...]:
    """Every match of ``policy`` in ``text``, in document order.

    Raise :class:`~aid_runtime.errors.ConfigurationError` for an unknown policy:
    that is a caller bug, not untrusted input, and the engine reports it as a
    block before it ever gets here.
    """
    patterns = DETECTORS.get(policy)
    if patterns is None:
        raise ConfigurationError(
            f"no detector for guardrail policy {policy!r}; known policies: {sorted(DETECTORS)}"
        )
    hits: list[Detection] = []
    for pattern in patterns:
        hits.extend(
            Detection(policy=policy, start=match.start(), end=match.end())
            for match in pattern.finditer(text)
        )
    hits.sort(key=lambda hit: (hit.start, hit.end))
    return tuple(hits)


def _mask(policy: str, text: str) -> str:
    hits = detect(policy, text)
    replacement = _REDACTION.format(policy=policy)
    # Right to left, so an earlier replacement cannot move a later span's offsets.
    for hit in reversed(hits):
        text = f"{text[: hit.start]}{replacement}{text[hit.end :]}"
    return text


def _texts(payload: Mapping[str, Any]) -> tuple[tuple[str, str], ...]:
    """The ``(field, value)`` pairs a detector may look at.

    Only strings: a detector that coerced an integer or a nested object to text
    would fire on payloads a redaction cannot edit, and the redaction's fail-closed
    re-check below would then block a run it could have repaired.
    """
    return tuple(
        (name, value) for name, value in payload.items() if isinstance(value, str) and value
    )


class DecisionAsker(Protocol):
    """The one call the engine makes, so a test double need not subclass the client."""

    async def decide(
        self,
        *,
        model: str,
        state: Any,
        questions: Mapping[str, DecisionQuestion],
        reproducible: bool = False,
    ) -> DecisionResponse: ...


class GuardrailEngine:
    """Evaluates an agent's guardrails at one stage.

    Constructed once per runtime, from the document's resolved guardrail
    definitions. It holds no state: the same engine answers the same question the
    same way, which is what makes the corpus results reproducible.
    """

    def __init__(
        self,
        guardrails: Mapping[str, GuardrailDefinition] | None = None,
        decisions: Mapping[str, DecisionDefinition] | None = None,
        client_factory: Callable[[], DecisionAsker] | None = None,
    ) -> None:
        self._declared = dict(guardrails or {})
        self._decisions = dict(decisions or {})
        #: Built on first use, not at import: an app with no TypeSafe key must still
        #: boot when no request reaches a decision-backed guardrail.
        self._client_factory = client_factory or DecisionClient
        self._client: DecisionAsker | None = None

    def declared(self, guardrail_id: str) -> GuardrailDefinition | None:
        return self._declared.get(guardrail_id)

    def check_input(
        self,
        guardrails: Sequence[GuardrailDefinition],
        text: str,
    ) -> GuardrailVerdict:
        return self._check("input", guardrails, {"text": text}, tool_id=None)

    async def check_input_async(
        self,
        guardrails: Sequence[GuardrailDefinition],
        text: str,
    ) -> GuardrailVerdict:
        """The ``input`` stage with decisions: the same rules, one awaitable question.

        This is the only stage a decision may guard, so it is the only stage with an
        async twin; ``check_input`` stays synchronous and unchanged for callers that
        have no network check to make. Order is preserved across both kinds of
        guardrail -- declaration order still decides between comparable actions, and
        ``block`` still outranks it.

        A guardrail that declares both policies and a decision asks the decision only
        when its policies found nothing: asking a model about input a detector already
        refused would spend tokens to learn what the detector said.
        """
        payload: Mapping[str, Any] = {"text": text}
        applicable = [guardrail for guardrail in guardrails if "input" in guardrail.stages]
        records: list[GuardrailRecord] = []
        fired: list[GuardrailDefinition] = []
        for guardrail in applicable:
            policies = _firing_policies(guardrail, "input", payload)
            record: GuardrailRecord | None = None
            if policies:
                record = GuardrailRecord(
                    guardrail=guardrail.id,
                    stage="input",
                    action=_action(guardrail),
                    policies=policies,
                    message=guardrail.message,
                )
            elif guardrail.decision is not None:
                record = await self._ask_decision(guardrail, text)
            if record is None:
                continue
            fired.append(guardrail)
            records.append(record)

        deciding = _decide(records)
        if deciding is None:
            return GuardrailVerdict(stage="input", text=text, arguments=dict(payload))

        redacted = payload
        if deciding.action == ACTION_REDACT:
            redacted = _redact(
                "input",
                [guardrail for guardrail in fired if guardrail.action == ACTION_REDACT],
                payload,
            )
        return GuardrailVerdict(
            stage="input",
            records=tuple(records),
            action=deciding.action,
            deciding=deciding,
            text=_text_of(redacted),
            arguments=dict(redacted),
        )

    async def _ask_decision(
        self,
        guardrail: GuardrailDefinition,
        text: str,
    ) -> GuardrailRecord | None:
        """Ask one ``choice`` decision and turn its label into a record, or ``None``.

        Everything that is not a usable answer is a :class:`GuardrailBlockedError`:
        an undeclared decision, an unmapped label, a confidence below the declared
        floor, or a call that raised. That is the same rule the policy path follows
        -- there is no path from "the check could not run" to "no violation found".
        """
        name = guardrail.decision or ""
        definition = self._decisions.get(name)
        if definition is None:
            raise GuardrailBlockedError(
                guardrail.id,
                "input",
                f"decision {name!r} has no definition in this runtime",
            )
        outcomes = dict(guardrail.on_decision)
        if not outcomes:
            raise GuardrailBlockedError(
                guardrail.id,
                "input",
                f"decision {name!r} maps no answer label, so no answer could be acted on",
            )
        if self._client is None:
            self._client = self._client_factory()
        question = DecisionQuestion(
            type="choice",
            instructions=definition.instructions,
            criteria=definition.criteria,
        )
        try:
            response = await self._client.decide(
                model=definition.model,
                state=text,
                questions={name: question},
            )
        except Exception as error:
            raise GuardrailBlockedError(
                guardrail.id,
                "input",
                f"decision {name!r} could not answer: {error}",
            ) from error

        answer = response.answers.get(name)
        if answer is None:
            raise GuardrailBlockedError(
                guardrail.id,
                "input",
                f"decision {name!r} returned no answer for its own question",
            )
        label = answer.choice
        if label is None or label not in outcomes:
            raise GuardrailBlockedError(
                guardrail.id,
                "input",
                f"decision {name!r} answered {label!r}, which this guardrail does not map",
            )
        if guardrail.min_confidence > 0 and answer.confidence is None:
            # A `noul` answer carries only its probability, and the wire contract forbids
            # a confidence on it. A floor that cannot be read must not pass: silently
            # treating the missing value as "no opinion, therefore allow" is exactly the
            # failure this check exists to stop.
            raise GuardrailBlockedError(
                guardrail.id,
                "input",
                f"decision {name!r} answered without a confidence, and this guardrail "
                f"requires at least {guardrail.min_confidence:.2f}",
            )
        if answer.confidence is not None and answer.confidence < guardrail.min_confidence:
            raise GuardrailBlockedError(
                guardrail.id,
                "input",
                f"decision {name!r} answered {label!r} with confidence "
                f"{answer.confidence:.2f}, below the declared minimum "
                f"{guardrail.min_confidence:.2f}",
            )
        outcome = outcomes[label]
        if outcome not in _DECISION_OUTCOMES:
            raise GuardrailBlockedError(
                guardrail.id,
                "input",
                f"decision {name!r} maps {label!r} to unknown outcome {outcome!r}",
            )
        if outcome == "allow":
            return None
        return GuardrailRecord(
            guardrail=guardrail.id,
            stage="input",
            action=cast(GuardrailAction, outcome),
            policies=(),
            message=guardrail.message,
            decision=name,
            label=label,
            confidence=answer.confidence,
        )

    def check_output(
        self,
        guardrails: Sequence[GuardrailDefinition],
        text: str,
    ) -> GuardrailVerdict:
        return self._check("output", guardrails, {"text": text}, tool_id=None)

    def check_retrieval(
        self,
        guardrails: Sequence[GuardrailDefinition],
        results: Sequence[str],
    ) -> GuardrailVerdict:
        """Guard what a retriever would splice into the prompt.

        Only the *results* are in the payload, not the query. The stage is about the
        text a model is handed, and putting the user's question in the same payload
        would let a ``redact`` guardrail over the ``text`` field fire on a violation
        it cannot remove -- which fails closed as a block and hides the real cause.
        The query's own checks belong to the ``input`` stage.
        """
        return self._check(
            "retrieval",
            guardrails,
            {"text": "\n".join(results)},
            tool_id=None,
        )

    def check_tool_call(
        self,
        guardrails: Sequence[GuardrailDefinition],
        tool_id: str,
        arguments: Mapping[str, Any],
    ) -> GuardrailVerdict:
        return self._check("tool-call", guardrails, dict(arguments), tool_id=tool_id)

    def _check(
        self,
        stage: GuardrailStage,
        guardrails: Sequence[GuardrailDefinition],
        payload: Mapping[str, Any],
        tool_id: str | None,
    ) -> GuardrailVerdict:
        applicable = [
            guardrail
            for guardrail in guardrails
            if stage in guardrail.stages and _covers(guardrail, stage, tool_id)
        ]
        records: list[GuardrailRecord] = []
        fired: list[GuardrailDefinition] = []
        for guardrail in applicable:
            policies = _firing_policies(guardrail, stage, payload)
            if not policies:
                continue
            fired.append(guardrail)
            records.append(
                GuardrailRecord(
                    guardrail=guardrail.id,
                    stage=stage,
                    action=_action(guardrail),
                    policies=policies,
                    message=guardrail.message,
                )
            )

        deciding = _decide(records)
        if deciding is None:
            return GuardrailVerdict(
                stage=stage,
                text=_text_of(payload),
                arguments=dict(payload),
            )

        redacted = payload
        if deciding.action == ACTION_REDACT:
            redacted = _redact(
                stage,
                [guardrail for guardrail in fired if guardrail.action == ACTION_REDACT],
                payload,
            )
        return GuardrailVerdict(
            stage=stage,
            records=tuple(records),
            action=deciding.action,
            deciding=deciding,
            text=_text_of(redacted),
            arguments=dict(redacted),
        )


def _covers(guardrail: GuardrailDefinition, stage: str, tool_id: str | None) -> bool:
    """Whether ``guardrail`` applies to this particular call.

    ``tools`` is only meaningful on a ``tool-call`` guardrail, and an empty list
    means "every tool that reaches the stage" -- absent and empty are the same
    thing in the IR, and reading them differently here would be a second,
    undocumented meaning for an empty array.
    """
    if stage != "tool-call" or not guardrail.tools:
        return True
    return tool_id is not None and tool_id in guardrail.tools


def _text_of(payload: Mapping[str, Any]) -> str:
    value = payload.get("text")
    return value if isinstance(value, str) else ""


def _firing_policies(
    guardrail: GuardrailDefinition,
    stage: str,
    payload: Mapping[str, Any],
) -> tuple[str, ...]:
    texts = _texts(payload)
    hits: list[str] = []
    for policy in guardrail.policies:
        if policy not in DETECTORS:
            # Fail closed: a policy the engine cannot evaluate is a block, and it is
            # reported with the guardrail that named it so an operator knows which
            # declaration to fix.
            raise GuardrailBlockedError(
                guardrail.id,
                stage,
                f"policy {policy!r} has no evaluator in this runtime",
            )
        if any(detect(policy, text) for _, text in texts):
            hits.append(policy)
    return tuple(hits)


def _action(guardrail: GuardrailDefinition) -> GuardrailAction:
    """The guardrail's action, refused if it is outside the closed vocabulary.

    ``GuardrailDefinition.action`` is a ``str`` because the IR layer reads it out of
    JSON, so this is where the closed set is enforced. It has to be enforced rather
    than assumed: ``_decide`` looks for ``block`` by equality, so an unrecognised
    action cannot decide a block and would otherwise fall through to whatever the
    caller does with "not block" -- an allow nobody declared.
    """
    action = guardrail.action
    if action not in GUARDRAIL_ACTIONS:
        raise ConfigurationError(
            f"guardrail {guardrail.id!r} declares unknown action {action!r}; "
            f"expected one of {', '.join(GUARDRAIL_ACTIONS)}"
        )
    return action


def _decide(records: Sequence[GuardrailRecord]) -> GuardrailRecord | None:
    """The deciding record: the first ``block``, else the first record declared.

    ``block`` outranks declaration order deliberately. Ordering is about which of
    two *comparable* actions wins, and "stop the run" is not comparable to "let it
    continue with a note"; if declaration order could overrule a block, an author
    could neuter a strict guardrail by declaring a permissive one first.

    Only ``block`` is exempt. ``escalate``, ``redact`` and ``flag`` are comparable
    with one another, so declaration order alone decides between them: a ``flag``
    declared before an ``escalate`` flags and does not escalate, and a ``flag``
    declared before a ``redact`` does not mask the payload -- ``_redact`` runs only
    when the deciding action is ``redact``. That is intended: an unconditional
    redaction pass would let a guardrail rewrite a payload under an action the
    author did not select. The loser is still recorded, so a caller can see which
    declaration decided and which merely fired.
    """
    for record in records:
        if record.action == ACTION_BLOCK:
            return record
    return records[0] if records else None


def _redact(
    stage: str,
    guardrails: Sequence[GuardrailDefinition],
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    """Mask the declared fields, then prove nothing the detectors saw survived.

    The re-check is the part that matters. A spec that declares ``redact: [answer]``
    for a payload whose violation is in some other field would otherwise "redact"
    successfully while shipping the violation, so this raises instead of returning
    a payload it could not clean.
    """
    redacted = dict(payload)
    for guardrail in guardrails:
        for name in guardrail.redact:
            value = redacted.get(name)
            if not isinstance(value, str):
                continue
            for policy in guardrail.policies:
                if policy not in _REDACTABLE:
                    raise GuardrailBlockedError(
                        guardrail.id,
                        stage,
                        f"policy {policy!r} detects intent, which masking field "
                        f"{name!r} cannot remove; use 'block', 'flag' or 'escalate'",
                    )
                value = _mask(policy, value)
            redacted[name] = value

    for guardrail in guardrails:
        remaining = _firing_policies(guardrail, stage, redacted)
        if remaining:
            raise GuardrailBlockedError(
                guardrail.id,
                stage,
                f"redacting {list(guardrail.redact)} left a {remaining[0]!r} match; "
                "the declared fields do not cover the payload",
            )
    return redacted
