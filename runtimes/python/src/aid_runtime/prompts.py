"""Versioned prompt registry with strict typed rendering.

Rendering is *strict*: a template that references a variable nobody supplied, or
a caller that supplies a variable the template never uses, is an error. In a
framework whose promise is that regenerating an app is safe, a silently-blank
prompt variable is exactly the class of bug that must not survive to runtime.
"""

from __future__ import annotations

import string
from collections.abc import Iterable, Mapping, Sequence
from typing import Self

from pydantic import BaseModel, ConfigDict, Field

from aid_runtime.errors import PromptNotFoundError, PromptRenderError

__all__ = ["Example", "PromptRegistry", "PromptTemplate", "RenderedPrompt"]


class Example(BaseModel):
    """One few-shot example. Rendered into the prompt, not interpolated as text."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    input: str
    output: str


class PromptTemplate(BaseModel):
    """A versioned prompt with declared variables and optional few-shot examples."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(min_length=1)
    version: str = Field(min_length=1)
    template: str = Field(min_length=1)
    description: str = ""
    examples: tuple[Example, ...] = ()
    #: Variable names that must be supplied even when the template body omits them.
    #: Empty by default: the template body is the source of truth.
    required: tuple[str, ...] = ()

    @property
    def variables(self) -> frozenset[str]:
        """Every field name the template body interpolates."""
        try:
            parsed = string.Formatter().parse(self.template)
            return frozenset(field_name for _, field_name, _, _ in parsed if field_name is not None)
        except ValueError as exc:
            # A brace the formatter cannot parse is a broken template, not a bad
            # variable, so it is reported as the render error the caller handles
            # rather than escaping as a bare ValueError.
            raise PromptRenderError(
                f"prompt {self.name!r} v{self.version} has a malformed template: {exc}"
            ) from exc

    def render(self, **values: str) -> RenderedPrompt:
        """Interpolate ``values``, rejecting missing and unused variables."""
        expected = self.variables
        required = expected | frozenset(self.required)
        supplied = set(values)

        missing = sorted(name for name in required if name not in supplied)
        if missing:
            raise PromptRenderError(
                f"prompt {self.name!r} v{self.version} is missing variables: {', '.join(missing)}"
            )
        # ``required`` is subtracted here as well as added above: a variable the
        # caller was told to supply without an interpolation site is supplied
        # deliberately, not "unused".
        unused = sorted(supplied - required)
        if unused:
            raise PromptRenderError(
                f"prompt {self.name!r} v{self.version} received unused variables: "
                f"{', '.join(unused)}; template uses {', '.join(sorted(required)) or '<none>'}"
            )

        try:
            body = self.template.format(**values)
        except (KeyError, IndexError, ValueError) as exc:
            raise PromptRenderError(
                f"prompt {self.name!r} v{self.version} failed to render: {exc}"
            ) from exc

        return RenderedPrompt(
            name=self.name,
            version=self.version,
            text=body,
            examples=self.examples,
        )


class RenderedPrompt(BaseModel):
    """A prompt ready to send, carrying the version that produced it.

    The version travels with the text so a trace can answer "which prompt was
    this?" -- without it, a baseline diff cannot distinguish a model change from
    a prompt change.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    version: str
    text: str
    examples: tuple[Example, ...] = ()

    def as_messages(self, *, system: str | None = None) -> tuple[tuple[str, str], ...]:
        """Flatten to ``(role, content)`` pairs, examples inlined as few-shot turns."""
        messages: list[tuple[str, str]] = []
        if system is not None:
            messages.append(("system", system))
        for example in self.examples:
            messages.append(("user", example.input))
            messages.append(("assistant", example.output))
        messages.append(("user", self.text))
        return tuple(messages)


class PromptRegistry:
    """A registry keyed by prompt name, with per-name version pinning."""

    def __init__(self, templates: Iterable[PromptTemplate] = ()) -> None:
        self._by_name: dict[str, dict[str, PromptTemplate]] = {}
        for template in templates:
            self.register(template)

    def register(self, template: PromptTemplate) -> Self:
        """Add a template. Re-registering the same name+version is an error."""
        versions = self._by_name.setdefault(template.name, {})
        if template.version in versions:
            raise PromptRenderError(
                f"prompt {template.name!r} version {template.version!r} is already registered"
            )
        versions[template.version] = template
        return self

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_name))

    def versions(self, name: str) -> tuple[str, ...]:
        return tuple(sorted(self._by_name.get(name, {})))

    def latest(self, name: str) -> PromptTemplate:
        """The highest registered version, compared numerically per segment."""
        versions = ordered_versions(self.versions(name))
        if not versions:
            raise PromptNotFoundError(name, None, self.names())
        return self._by_name[name][versions[-1]]

    def get(self, name: str, version: str | None = None) -> PromptTemplate:
        if version is None:
            return self.latest(name)
        try:
            return self._by_name[name][version]
        except KeyError:
            raise PromptNotFoundError(name, version, self.versions(name)) from None

    def render(
        self,
        name: str,
        *,
        version: str | None = None,
        values: Mapping[str, str] | None = None,
    ) -> RenderedPrompt:
        return self.get(name, version).render(**(dict(values) if values else {}))


def ordered_versions(versions: Sequence[str]) -> tuple[str, ...]:
    """Sort version strings numerically per dotted segment.

    String sorting puts ``v10`` before ``v9``; a prompt registry that silently
    resolves "latest" to the wrong version is worse than one that refuses.
    """

    def key(version: str) -> tuple[tuple[int, int, str], ...]:
        segments: list[tuple[int, int, str]] = []
        for segment in version.lstrip("v").split("."):
            digits = "".join(char for char in segment if char.isdigit())
            segments.append((0, int(digits), "") if digits else (1, 0, segment))
        return tuple(segments)

    return tuple(sorted(versions, key=key))
