"""The prompt registry: versioned prompts rendered strictly.

Strictness is the contract. A prompt that silently interpolates an empty string
for a variable nobody supplied produces a plausible-looking answer to the wrong
question, which is the one failure mode a quality gate cannot see.
"""

from __future__ import annotations

import pytest

from aid_runtime import (
    Example,
    PromptNotFoundError,
    PromptRegistry,
    PromptRenderError,
    PromptTemplate,
    RenderedPrompt,
)
from aid_runtime.prompts import ordered_versions


def _template(
    *, name: str = "p", version: str = "1", template: str = "Hi {name}"
) -> PromptTemplate:
    return PromptTemplate(name=name, version=version, template=template)


def test_a_template_needs_a_name_a_version_and_a_body() -> None:
    with pytest.raises(ValueError, match="String should have at least 1 character"):
        PromptTemplate(name="p", version="1", template="")


def test_variables_come_from_the_template_body() -> None:
    template = _template(template="{a} and {b} and {a}")
    assert template.variables == frozenset({"a", "b"})


def test_render_interpolates_and_carries_the_version() -> None:
    template = PromptTemplate(
        name="p",
        version="2",
        template="Hi {name}!",
        examples=(Example(input="in", output="out"),),
    )
    rendered = template.render(name="Ada")

    assert rendered.text == "Hi Ada!"
    assert rendered.name == "p"
    assert rendered.version == "2"
    assert rendered.examples == (Example(input="in", output="out"),)


def test_render_refuses_a_variable_nobody_supplied() -> None:
    with pytest.raises(PromptRenderError, match=r"is missing variables: name"):
        _template().render()


def test_render_refuses_a_supplied_variable_the_template_never_uses() -> None:
    with pytest.raises(PromptRenderError, match=r"received unused variables: typo"):
        _template().render(name="Ada", typo="Ada")


def test_the_unused_variable_error_names_what_the_template_does_use() -> None:
    with pytest.raises(PromptRenderError, match=r"template uses name"):
        _template().render(name="Ada", typo="Ada")


def test_a_declared_required_variable_is_enforced_even_when_the_body_omits_it() -> None:
    template = PromptTemplate(name="p", version="1", template="static body", required=("tenant",))
    with pytest.raises(PromptRenderError, match=r"is missing variables: tenant"):
        template.render()


def test_a_declared_required_variable_is_not_itself_an_unused_variable() -> None:
    template = PromptTemplate(name="p", version="1", template="static body", required=("tenant",))
    rendered = template.render(tenant="acme")
    assert rendered.text == "static body"


def test_a_malformed_template_body_is_reported_as_a_render_error() -> None:
    template = PromptTemplate(name="p", version="1", template="{name")
    with pytest.raises(PromptRenderError, match=r"has a malformed template"):
        template.render(name="Ada")


def test_a_format_spec_that_cannot_be_applied_fails_as_a_render_error() -> None:
    template = PromptTemplate(name="p", version="1", template="{name:d}")
    with pytest.raises(PromptRenderError, match=r"failed to render"):
        template.render(name="Ada")


def test_as_messages_inlines_examples_as_few_shot_turns() -> None:
    rendered = RenderedPrompt(
        name="p",
        version="1",
        text="Question",
        examples=(Example(input="in", output="out"),),
    )
    assert rendered.as_messages() == (
        ("user", "in"),
        ("assistant", "out"),
        ("user", "Question"),
    )
    assert rendered.as_messages(system="sys") == (
        ("system", "sys"),
        ("user", "in"),
        ("assistant", "out"),
        ("user", "Question"),
    )


def test_register_returns_the_registry_so_registration_chains() -> None:
    registry = PromptRegistry().register(_template())
    assert registry.names() == ("p",)


def test_registering_the_same_name_and_version_twice_is_refused() -> None:
    registry = PromptRegistry([_template(template="first")])
    with pytest.raises(PromptRenderError, match="is already registered"):
        registry.register(_template(template="second"))


def test_names_and_versions_are_sorted_and_a_name_may_have_many_versions() -> None:
    registry = PromptRegistry(
        [
            _template(name="p", version="2"),
            _template(name="p", version="1"),
            _template(name="q", version="1"),
        ]
    )
    assert registry.names() == ("p", "q")
    assert registry.versions("p") == ("1", "2")
    assert registry.versions("absent") == ()


def test_latest_is_resolved_numerically_not_lexicographically() -> None:
    registry = PromptRegistry(
        [
            _template(version="v9", template="nine"),
            _template(version="v10", template="ten"),
        ]
    )
    assert registry.latest("p").version == "v10"
    assert registry.get("p").version == "v10"
    assert registry.get("p", "v9").template == "nine"


def test_ordered_versions_sorts_per_dotted_segment() -> None:
    assert ordered_versions(("v10", "v9", "v2.1", "v2.10", "v2.2")) == (
        "v2.1",
        "v2.2",
        "v2.10",
        "v9",
        "v10",
    )


def test_ordered_versions_puts_numeric_segments_before_text() -> None:
    assert ordered_versions(("beta", "v1")) == ("v1", "beta")


def test_an_unknown_prompt_or_version_raises() -> None:
    registry = PromptRegistry([_template()])
    with pytest.raises(PromptNotFoundError, match=r"no prompt 'missing' \(latest\)"):
        registry.latest("missing")
    with pytest.raises(PromptNotFoundError, match=r"no prompt 'p' version '9'"):
        registry.get("p", "9")


def test_the_not_found_error_lists_what_is_registered() -> None:
    registry = PromptRegistry([_template(name="p")])
    with pytest.raises(PromptNotFoundError, match=r"registered: p"):
        registry.latest("missing")


def test_registry_render_passes_values_through_to_the_template() -> None:
    registry = PromptRegistry([_template()])
    assert registry.render("p", values={"name": "Ada"}).text == "Hi Ada"
    assert registry.render("p", version="1", values={"name": "Ada"}).version == "1"


def test_registry_render_is_strict_too() -> None:
    registry = PromptRegistry([_template()])
    with pytest.raises(PromptRenderError, match=r"is missing variables: name"):
        registry.render("p")


def test_registry_render_without_values_renders_a_static_template() -> None:
    registry = PromptRegistry([PromptTemplate(name="p", version="1", template="static")])
    assert registry.render("p").text == "static"
