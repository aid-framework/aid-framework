"""Value-bound redaction for recorded traces.

``observability.redact`` names *fields*, and a field name cannot be stripped out of
prose. What can be stripped is a **value**: the moment a prompt is rendered, the
runtime knows which variable supplied which substring, so a name in the redact set
becomes an exact value to remove from the copy that is written to a trace.

Redaction applies to the recorded copy only. The model still receives what the
application sent, because editing a request would change the answer and a framework
that silently rewrote one could not honestly report what it ran.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

__all__ = ["REDACTED_FORMAT", "redact_values"]

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
