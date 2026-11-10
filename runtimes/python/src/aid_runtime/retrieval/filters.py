"""Filter expressions over a chunk's identity and metadata.

The IR carries ``filters`` as strings, because the two hosted knowledge bases take
strings and a structured shape would have to be translated twice. This module pins
the grammar the *local* pipeline reads, and pins it narrowly: five comparison
operators, ANDed, no boolean algebra, no regular expressions.

The restriction is deliberate. A filter is a security boundary -- a tenant or
classification selector -- so it must be impossible to express one that silently
matches more than it says. Regex would make ``*=` a denial-of-service surface and
would not port to either hosted engine.

A mature library was considered and rejected. JMESPath (``jmespath``) is the closest
fit and exists in both Python and JavaScript, but its ``!=`` on an absent field is
true, which is the fail-open behaviour this module exists to prevent, and its grammar
is far larger than the five operators documented here. Wrapping it would mean writing
the validator and the absence rule by hand anyway, so the parser stays here where
both runtimes can be held to the same table.

Grammar::

    filter  := field op value
    op      := "==" | "!=" | "^=" (prefix) | "$=" (suffix) | "*=" (contains)
    field   := "doc_id" | "uri" | metadata key
    value   := bare token, or "..." / '...' quoted

Every entry in the list is ANDed. Evaluation is per chunk: a field the chunk does not
carry matches nothing, *including* under ``!=`` -- absence is not a value, and
treating it as one would widen a selector instead of narrowing it.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from aid_runtime.errors import ConfigurationError

__all__ = [
    "FILTER_OPERATORS",
    "Filter",
    "compile_filters",
    "matches",
    "matches_all",
    "metadata_fields",
    "parse_filter",
]

#: The operators the grammar admits, in the order a diagnostic lists them.
FILTER_OPERATORS: tuple[str, ...] = ("==", "!=", "^=", "$=", "*=")


class ChunkLike(Protocol):
    """The slice of a chunk a filter observes.

    Retrieval's ``Chunk`` satisfies this structurally. Naming the shape here rather
    than importing it keeps this module free of a cycle back into ``retrieval.types``,
    which imports :func:`metadata_fields` at module level.
    """

    doc_id: str
    uri: str
    metadata: dict[str, str]


_FIELD = r"[A-Za-z0-9_.\-]+"
_OPERATOR = r"==|!=|\^=|\$=|\*="
_EXPRESSION = re.compile(rf"^\s*({_FIELD})\s*({_OPERATOR})\s*(.*)", re.DOTALL)

#: Fields resolved from the chunk itself, never from ``chunk.metadata``.
_RESERVED_FIELDS = frozenset({"doc_id", "uri"})


@dataclass(frozen=True, slots=True)
class Filter:
    """One parsed comparison. ``value`` is already unquoted."""

    field: str
    operator: str
    value: str


def parse_filter(expression: str) -> Filter:
    """Parse one expression, or explain precisely what is wrong with it.

    An unsupported operator is reported against the operator itself rather than as a
    generic "invalid expression": the five spellings are short enough to list, and a
    user who wrote ``=`` instead of ``==`` should be told so.
    """
    if not isinstance(expression, str):
        raise ConfigurationError(
            f"a filter expression must be a string, not {type(expression).__name__}"
        )
    match = _EXPRESSION.match(expression)
    if match is None:
        raise ConfigurationError(
            f"filter expression {expression!r} is not '<field> <op> <value>'; the operators are "
            + ", ".join(FILTER_OPERATORS)
        )
    field, operator, raw = match.groups()
    value = _unquote(raw.strip(), expression)
    if not value:
        raise ConfigurationError(
            f"filter expression {expression!r} names field {field!r} with an empty value"
        )
    return Filter(field=field, operator=operator, value=value)


def _unquote(raw: str, expression: str) -> str:
    """Strip one matching pair of quotes, and nothing else."""
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        return raw[1:-1]
    if raw[:1] in {'"', "'"}:
        raise ConfigurationError(
            f"filter expression {expression!r} starts a quoted value but does not close it"
        )
    return raw


def compile_filters(expressions: Sequence[str]) -> tuple[Filter, ...]:
    """Parse every expression once, at a point where a mistake is still local."""
    return tuple(parse_filter(expression) for expression in expressions)


def metadata_fields(expressions: Sequence[str]) -> tuple[str, ...]:
    """The metadata keys ``expressions`` read, in declaration order, without repeats.

    A chunk only carries the metadata ``chunking.keepMetadata`` names, so a filter on
    a key that is not kept would match nothing. The binder unions this into
    ``keepMetadata`` rather than asking a user to remember the same key twice.
    """
    fields = (parsed.field for parsed in compile_filters(expressions))
    return tuple(dict.fromkeys(field for field in fields if field not in _RESERVED_FIELDS))


def matches(chunk: ChunkLike, condition: Filter) -> bool:
    """Whether ``chunk`` satisfies one comparison.

    A missing field is a non-match for every operator. ``!=`` therefore means "this
    field is present and differs", not "this field is absent or differs".
    """
    if condition.field == "doc_id":
        actual: str | None = chunk.doc_id
    elif condition.field == "uri":
        actual = chunk.uri
    else:
        actual = chunk.metadata.get(condition.field)
    if actual is None:
        return False
    if condition.operator == "==":
        return actual == condition.value
    if condition.operator == "!=":
        return actual != condition.value
    if condition.operator == "^=":
        return actual.startswith(condition.value)
    if condition.operator == "$=":
        return actual.endswith(condition.value)
    return condition.value in actual


def matches_all(chunk: ChunkLike, filters: Sequence[Filter]) -> bool:
    """Whether ``chunk`` satisfies every filter. An empty list admits everything."""
    return all(matches(chunk, condition) for condition in filters)
