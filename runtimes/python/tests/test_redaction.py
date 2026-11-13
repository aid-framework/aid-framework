"""Redaction: a redact set names fields, and a rendered prompt binds values to them."""

from __future__ import annotations

from aid_runtime import REDACTED_FORMAT, CompletionRequest, PromptTemplate, redact_values
from aid_runtime.gateway import _prompt_text

EMAIL = "ada@example.com"


def test_a_bound_value_is_replaced_with_its_field_name() -> None:
    text = f"contact: {EMAIL}"

    assert redact_values(text, [("email", EMAIL)]) == "contact: [redacted:email]"


def test_no_pairs_leaves_the_text_alone() -> None:
    assert redact_values(f"contact: {EMAIL}", []) == f"contact: {EMAIL}"


def test_a_blank_value_is_never_applied() -> None:
    """``str.replace("")`` would insert a marker everywhere and destroy the copy."""
    assert redact_values("hello", [("email", "   ")]) == "hello"


def test_the_longest_value_is_stripped_before_a_shorter_one_inside_it() -> None:
    text = "id ada@example.com extra end"
    pairs = [("email", "ada@example.com"), ("contact", "ada@example.com extra")]

    redacted = redact_values(text, pairs)

    assert redacted == f"id {REDACTED_FORMAT.format(name='contact')} end"


def test_every_occurrence_of_a_value_is_stripped() -> None:
    text = f"{EMAIL} and {EMAIL}"

    assert redact_values(text, [("email", EMAIL)]) == "[redacted:email] and [redacted:email]"


def test_a_rendered_prompt_exposes_only_the_bindings_that_were_named() -> None:
    template = PromptTemplate(
        name="classify",
        version="1",
        template="message: {message}\ncontact: {email}",
    )
    rendered = template.render(message="refund please", email=EMAIL)

    assert rendered.redactions(["email"]) == (("email", EMAIL),)
    assert rendered.redactions([]) == ()


def test_the_trace_keeps_the_redacted_copy_and_the_model_keeps_the_original() -> None:
    """Redaction is a recording decision: it must never edit what was sent."""
    template = PromptTemplate(
        name="classify",
        version="1",
        template="message: {message}\ncontact: {email}",
    )
    rendered = template.render(message="refund please", email=EMAIL)
    request = CompletionRequest.prompt(
        rendered.text,
        redactions=rendered.redactions(["email"]),
    )

    assert EMAIL not in _prompt_text(request)
    assert "[redacted:email]" in _prompt_text(request)
    assert EMAIL in request.messages[-1].content


def test_redactions_do_not_change_the_fingerprint() -> None:
    """A redact set describes the recording, not the call, so a cache key survives it."""
    plain = CompletionRequest.prompt("hello")
    redacted = CompletionRequest.prompt("hello", redactions=[("email", EMAIL)])

    assert plain.fingerprint() == redacted.fingerprint()
