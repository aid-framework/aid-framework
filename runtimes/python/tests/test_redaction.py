"""Redaction: a redact set names fields, and a rendered prompt binds values to them."""

from __future__ import annotations

from aid_runtime import (
    REDACTED_FORMAT,
    CompletionRequest,
    PromptTemplate,
    bind_redactions,
    redact_values,
)
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
    redacted = CompletionRequest.prompt("hello", redactions=(("email", EMAIL),))

    assert plain.fingerprint() == redacted.fingerprint()


def test_a_binding_is_learned_from_a_structured_record_by_field_name() -> None:
    """An agent run has no render, so the name comes off the record's own keys."""
    payload = {"email": EMAIL, "note": "refund please"}

    assert bind_redactions(["email"], payload) == (("email", EMAIL),)


def test_a_name_that_is_not_declared_is_not_bound() -> None:
    assert bind_redactions(["phone"], {"email": EMAIL}) == ()


def test_a_nested_record_is_searched_because_a_tool_argument_may_hold_one() -> None:
    payload = {"customer": {"contact": {"email": EMAIL}}, "tags": [{"email": "bob@example.com"}]}

    bound = bind_redactions(["email"], payload)

    assert bound[0] == ("email", EMAIL)
    assert ("email", "bob@example.com") in bound


def test_only_a_string_value_can_be_bound() -> None:
    """A number has no text to match in a transcript, so binding it would be a no-op."""
    assert bind_redactions(["count"], {"count": 3}) == ()
    assert bind_redactions(["email"], {"email": None}) == ()


def test_a_blank_value_is_never_bound() -> None:
    """``str.replace("")`` would insert a marker everywhere and destroy the copy."""
    assert bind_redactions(["email"], {"email": "   "}) == ()


def test_every_value_seen_for_a_name_is_bound_not_just_the_first() -> None:
    """Keeping only the first would leave a second customer's address in the copy."""
    bound = bind_redactions(["email"], [{"email": EMAIL}, {"email": "other@example.com"}])

    assert bound == (("email", EMAIL), ("email", "other@example.com"))


def test_the_same_value_seen_twice_is_bound_once() -> None:
    bound = bind_redactions(["email"], [{"email": EMAIL}, {"customer": {"email": EMAIL}}])

    assert bound == (("email", EMAIL),)
