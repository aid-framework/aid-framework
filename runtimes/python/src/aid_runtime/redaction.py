"""Value-bound redaction for recorded traces.

``observability.redact`` names *fields*, and a field name cannot be stripped out of
prose. What can be stripped is a **value**: the moment a prompt is rendered, the
runtime knows which variable supplied which substring, so a name in the redact set
becomes an exact value to remove from the copy that is written to a trace.

Redaction applies to the recorded copy only. The model still receives what the
application sent, because editing a request would change the answer and a framework
that silently rewrote one could not honestly report what it ran.

An agent run has no render, so it has no interpolation to learn values from. It binds
them from the structured records it handles instead -- see :func:`bind_redactions` --
and the loop hands the result to the gateway, which is the one place that writes model
text to a trace. Free text the caller sent carries no field name, so a value that
appears only there is not bound and the limit is stated wherever the guarantee is.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any

__all__ = ["REDACTED_FORMAT", "bind_redactions", "redact_values"]

#: What replaces a stripped value. The field name, not the value, so a trace reader
#: can still see that a field was present and which one it was.
REDACTED_FORMAT = "[redacted:{name}]"

#: One ``(name, value)`` pair bound when a prompt was rendered.
Redaction = tuple[str, str]


def _usable(pairs: Iterable[Redaction]) -> list[Redaction]:
    """The pairs that can be applied at all.

    A blank value is dropped rather than replaced: ``str.replace("", marker)``
    inserts a marker at every position, so an empty variable would destroy the
    text it was meant to protect instead of protecting it.
    """
    return [(name, value) for name, value in pairs if value.strip() != ""]


def bind_redactions(names: Iterable[str], payload: Any) -> tuple[Redaction, ...]:
    """Bind declared field names to the string values a structured payload carries.

    This is the agent path's equivalent of a render. A pipeline learns a value from the
    variables it interpolated; an agent loop has no interpolation, so it learns values
    from the structured records it handles -- the arguments of the tool calls the model
    composed, recursing into nested objects and lists. What comes back is the same
    ``(name, value)`` pair the gateway already knows how to strip from a recorded copy.

    Only strings are bound. A field holding a number or a boolean has no text to match
    in prose, and binding ``"1"`` would rewrite every digit in the transcript instead of
    protecting one field.

    A name may bind more than one value. Two customers' addresses in one long run are
    two pairs with the same name, and both are stripped: keeping only the first would
    leave the second in every copy recorded after it appeared.
    """
    wanted = frozenset(names)
    if not wanted:
        return ()
    bound: list[Redaction] = []
    _bind_into(wanted, payload, bound)
    return tuple(bound)


def _bind_into(wanted: frozenset[str], payload: Any, bound: list[Redaction]) -> None:
    if isinstance(payload, Mapping):
        for key, value in payload.items():
            if isinstance(key, str) and key in wanted and isinstance(value, str):
                pair = (key, value)
                if value.strip() != "" and pair not in bound:
                    bound.append(pair)
            else:
                _bind_into(wanted, value, bound)
    elif isinstance(payload, (list, tuple)):
        for item in payload:
            _bind_into(wanted, item, bound)


def redact_values(text: str, pairs: Sequence[Redaction]) -> str:
    """Replace every occurrence of a bound value with ``[redacted:name]``."""
    if not text or not pairs:
        return text
    redacted = text
    # Longest value first: where one value contains another, the shorter pass would
    # otherwise leave a fragment of the longer one on either side of its marker.
    for name, value in sorted(_usable(pairs), key=lambda pair: len(pair[1]), reverse=True):
        redacted = redacted.replace(value, REDACTED_FORMAT.format(name=name))
    return redacted
