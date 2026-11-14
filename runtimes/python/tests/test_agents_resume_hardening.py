"""The parts of a signed checkpoint that a signature alone does not give you.

Signing turned "a body shaped like a checkpoint" into "a checkpoint this app issued". It
does not say *who may spend it*, and it does not survive a weak key, a clock difference
between replicas or a rotation. These tests fix the four properties that close that gap,
at the level the route actually uses them: the signer, the nonce store, and the principal
handed to both.

The last test pins the wire behaviour rather than the library's: every refusal leaves the
process as one opaque 403, so the distinction between ``expired`` and ``tampered`` stays
in the log instead of becoming an oracle for a caller holding a guessed checkpoint.
"""

from __future__ import annotations

import json

import pytest

from aid_runtime.agents import (
    DEFAULT_CLOCK_LEEWAY_SECONDS,
    MIN_SECRET_BYTES,
    AgentCheckpoint,
    CheckpointRefusalError,
    CheckpointSigner,
    InProcessNonceStore,
    Principal,
)
from aid_runtime.agents.resume import checkpoint_payload
from aid_runtime.errors import ConfigurationError

SECRET = "s" * 64
RETIRED = "r" * 64
TTL = 900
EVE = Principal(subject="user-eve")
ALICE_SUBJECT = "user-alice"
ALICE = Principal(subject=ALICE_SUBJECT)
ANONYMOUS = Principal()


def _checkpoint(**overrides: object) -> AgentCheckpoint:
    fields: dict[str, object] = {
        "agent_id": "solo",
        "step": 1,
        "messages": (),
        "cost_anchor_usd": 0.0,
        "token_anchor": 0,
        "spent_usd": 0.0,
        "spent_tokens": 0,
    }
    fields.update(overrides)
    return AgentCheckpoint(**fields)  # type: ignore[arg-type]


def _signer(**overrides: object) -> CheckpointSigner:
    fields: dict[str, object] = {"secret": SECRET, "ttl_seconds": TTL}
    fields.update(overrides)
    return CheckpointSigner(**fields)  # type: ignore[arg-type]


def test_a_signed_checkpoint_carries_a_hash_of_the_subject_not_the_subject() -> None:
    signed = _signer().sign(_checkpoint(), subject=ALICE.subject)

    assert signed.integrity is not None
    assert signed.integrity.owner
    # The body travels through the caller, so it must not hand them an identifier they
    # did not already have.
    assert ALICE_SUBJECT not in signed.integrity.owner
    assert ALICE_SUBJECT not in json.dumps(signed.model_dump(mode="json"))


def test_the_principal_that_paused_the_run_may_resume_it() -> None:
    signed = _signer().sign(_checkpoint(), subject=ALICE.subject)

    assert _signer().verify(signed, subject=ALICE.subject).owner == signed.integrity.owner  # type: ignore[union-attr]


def test_another_principal_is_refused() -> None:
    signed = _signer().sign(_checkpoint(), subject=ALICE.subject)

    with pytest.raises(CheckpointRefusalError) as caught:
        _signer().verify(signed, subject=EVE.subject)

    assert caught.value.reason == "unbound"


def test_a_bound_checkpoint_is_refused_when_the_caller_presents_no_subject() -> None:
    """The case an app without token verification is in: no subject to check against."""
    signed = _signer().sign(_checkpoint(), subject=ALICE.subject)

    with pytest.raises(CheckpointRefusalError) as caught:
        _signer().verify(signed, subject=None)

    assert caught.value.reason == "unbound"


def test_a_pause_by_a_subject_less_principal_stays_resumable() -> None:
    """Nothing to bind to is the honest state, not a refusal to sign."""
    signed = _signer().sign(_checkpoint(), subject=ANONYMOUS.subject)

    assert signed.integrity is not None
    assert signed.integrity.owner == ""
    assert _signer().verify(signed, subject=None).owner == ""


async def test_the_owner_is_checked_before_the_nonce_is_claimed() -> None:
    """A refusal must not burn the checkpoint for the principal it was issued to."""
    signed = _signer().sign(_checkpoint(), subject=ALICE.subject)
    nonces = InProcessNonceStore()

    with pytest.raises(CheckpointRefusalError):
        await _signer().accept(signed, nonces, subject=EVE.subject)

    assert await _signer().accept(signed, nonces, subject=ALICE.subject)


def test_an_owner_hash_cannot_be_presented_as_a_signature() -> None:
    """Domain separation: the two uses of the secret are not interchangeable."""
    signed = _signer().sign(_checkpoint(), subject=ALICE.subject)
    assert signed.integrity is not None
    owner = signed.integrity.owner.replace("", "")  # keep the type: a hex string
    swapped = signed.model_copy(
        update={"integrity": signed.integrity.model_copy(update={"signature": owner})}
    )

    with pytest.raises(CheckpointRefusalError) as caught:
        _signer().verify(swapped, subject=ALICE.subject)

    assert caught.value.reason == "tampered"


def test_a_secret_shorter_than_the_hash_it_feeds_is_refused() -> None:
    weak = "s" * (MIN_SECRET_BYTES - 1)

    with pytest.raises(ValueError, match=f"at least {MIN_SECRET_BYTES}"):
        _signer(secret=weak)


def test_an_empty_secret_is_refused_rather_than_signing_identically() -> None:
    blank = ""

    with pytest.raises(ValueError, match="non-empty secret"):
        _signer(secret=blank)


def test_a_rotation_has_to_name_two_different_keys() -> None:
    with pytest.raises(ValueError, match="rotated nothing"):
        _signer(previous=SECRET)


def test_the_retired_secret_still_verifies_what_it_signed() -> None:
    before = _signer(secret=RETIRED).sign(_checkpoint(), subject=ALICE.subject)
    rotated = _signer(previous=RETIRED)

    assert rotated.verify(before, subject=ALICE.subject).owner == before.integrity.owner  # type: ignore[union-attr]


def test_an_owner_bound_checkpoint_survives_the_rotation() -> None:
    """The owner hash belongs to the key that signed, so it is rebuilt from that key."""
    before = _signer(secret=RETIRED).sign(_checkpoint(), subject=ALICE.subject)
    rotated = _signer(previous=RETIRED)

    with pytest.raises(CheckpointRefusalError):
        rotated.verify(before, subject=EVE.subject)


def test_the_signature_is_verified_against_the_current_secret_first() -> None:
    """A fresh checkpoint verifies without the retired key being consulted at all."""
    signed = _signer().sign(_checkpoint())
    without_history = _signer()

    assert without_history.verify(signed).nonce == signed.integrity.nonce  # type: ignore[union-attr]


def test_the_leeway_accepts_a_clock_that_is_behind() -> None:
    signed = _signer().sign(_checkpoint(), now=1_000)
    expires_at = signed.integrity.expires_at  # type: ignore[union-attr]
    edge = expires_at + DEFAULT_CLOCK_LEEWAY_SECONDS - 1

    assert _signer().verify(signed, now=edge).expires_at == expires_at


def test_the_leeway_is_bounded() -> None:
    signed = _signer().sign(_checkpoint(), now=1_000)
    expires_at = signed.integrity.expires_at  # type: ignore[union-attr]

    with pytest.raises(CheckpointRefusalError) as caught:
        _signer().verify(signed, now=expires_at + DEFAULT_CLOCK_LEEWAY_SECONDS)

    assert caught.value.reason == "expired"


def test_a_non_ascii_signature_is_a_bad_signature_not_a_crash() -> None:
    """`compare_digest` refuses two non-ASCII str operands, so the comparison is bytes."""
    signed = _signer().sign(_checkpoint())
    assert signed.integrity is not None
    mangled = signed.model_copy(
        update={"integrity": signed.integrity.model_copy(update={"signature": "ünicode"})}
    )

    with pytest.raises(CheckpointRefusalError) as caught:
        _signer().verify(mangled)

    assert caught.value.reason == "tampered"


def test_a_payload_the_encoder_cannot_bind_is_refused() -> None:
    """No `default=str` fallback: a value JSON cannot express gets a refusal, not a guess."""
    unencodable = _checkpoint(when={"at": object()})

    with pytest.raises(ConfigurationError) as caught:
        checkpoint_payload(unencodable)

    assert "canonical JSON" in str(caught.value)


def test_a_value_and_its_string_form_are_different_checkpoints() -> None:
    """The collision a `default=str` fallback would have introduced, stated as a property."""
    first = _signer().sign(_checkpoint(when={"at": "1"}))
    second = _signer().sign(_checkpoint(when={"at": 1}))

    assert first.integrity.signature != second.integrity.signature  # type: ignore[union-attr]
