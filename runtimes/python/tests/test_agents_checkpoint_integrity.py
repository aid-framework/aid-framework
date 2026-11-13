"""A checkpoint is a capability, so resuming one has to prove it was issued here.

A pause hands the caller a document that the resume route treats as authority to run
the held call -- including a write. Before signing, that document *was* the authority:
whoever held it could resume, and could edit the pending arguments on the way. These
tests fix the two properties that replace that: the checkpoint is signed by this app
with a key it holds, and it is spendable once.

The tests drive the real loop rather than the signer alone, so what is asserted is the
route's behaviour -- a refused resume must not run the held tool.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from agent_support import ADMIN_ONLY, Harness, Recorder, build, recording_tool, solo, tool_def
from aid_runtime.agents import (
    AgentCheckpoint,
    CheckpointRefusalError,
    CheckpointSigner,
    HumanDecision,
    InProcessNonceStore,
    Principal,
    RunStatus,
)
from aid_runtime.errors import ConfigurationError

SOLO_PROMPT = "You are a helpful assistant."
QUESTION = "Refund this order."
ADMIN = Principal(roles=frozenset({"admin"}))
SECRET = "a" * 64
TTL = 900


def _supervised() -> dict[str, Any]:
    return solo(
        prompt=SOLO_PROMPT,
        tool_specs=[tool_def("t1", "search")],
        tools=["t1"],
        hitl={"when": ADMIN_ONLY, "channel": "ops"},
    )


def _signer() -> CheckpointSigner:
    return CheckpointSigner(secret=SECRET, ttl_seconds=TTL)


async def _paused(
    *, signer: CheckpointSigner | None = None, nonces: Any = None
) -> tuple[Harness, Recorder, AgentCheckpoint]:
    """Run a supervised agent until it pauses, with the recording tool wired in."""
    from aid_runtime import ScriptedTurn

    tool, recorder = recording_tool()
    harness = build(
        _supervised(),
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")],
        signer=signer,
        nonces=nonces,
    )
    result = await harness.runtime.run("solo", QUESTION, principal=ADMIN)
    assert result.status is RunStatus.PAUSED
    assert result.checkpoint is not None
    return harness, recorder, result.checkpoint


async def test_a_pause_is_signed_and_names_its_own_expiry() -> None:
    _, _, checkpoint = await _paused(signer=_signer())

    assert checkpoint.integrity is not None
    assert checkpoint.integrity.signature
    assert checkpoint.integrity.nonce
    assert checkpoint.integrity.expires_at - checkpoint.integrity.issued_at == TTL


async def test_an_edited_approval_decision_is_refused() -> None:
    """The finding the round exists for: flip the answer and the resume must not run."""
    harness, recorder, checkpoint = await _paused(signer=_signer())
    edited = checkpoint.model_copy(update={"channel": "someone-elses-queue"})

    with pytest.raises(CheckpointRefusalError) as caught:
        await harness.runtime.resume(edited, HumanDecision.APPROVE)

    assert caught.value.reason == "tampered"
    assert recorder.calls == 0


async def test_swapping_the_held_call_arguments_is_refused() -> None:
    """Signature covers the pending call, not just the fact that something is pending."""
    harness, recorder, checkpoint = await _paused(signer=_signer())
    call = checkpoint.calls[0]
    swapped = checkpoint.model_copy(
        update={"calls": (call.model_copy(update={"arguments": {"query": "everything"}}),)}
    )

    with pytest.raises(CheckpointRefusalError) as caught:
        await harness.runtime.resume(swapped, HumanDecision.APPROVE)

    assert caught.value.reason == "tampered"
    assert recorder.calls == 0


async def test_an_extended_deadline_is_refused_as_tampering() -> None:
    """The expiry is inside the signature, so it cannot be moved forward either."""
    harness, recorder, checkpoint = await _paused(signer=_signer())
    assert checkpoint.integrity is not None
    extended = checkpoint.model_copy(
        update={
            "integrity": checkpoint.integrity.model_copy(
                update={"expires_at": checkpoint.integrity.expires_at + 86400}
            )
        }
    )

    with pytest.raises(CheckpointRefusalError) as caught:
        await harness.runtime.resume(extended, HumanDecision.APPROVE)

    assert caught.value.reason == "tampered"
    assert recorder.calls == 0


async def test_a_genuine_expiry_is_refused() -> None:
    """No forged bytes: the checkpoint was issued short-lived and simply ran out."""
    from aid_runtime import ScriptedTurn

    tool, recorder = recording_tool()
    harness = build(
        _supervised(),
        tools=[tool],
        script=[ScriptedTurn.tool("search", {"query": "order"}), ScriptedTurn.answer("done")],
        signer=CheckpointSigner(secret=SECRET, ttl_seconds=1),
    )
    paused = await harness.runtime.run("solo", QUESTION, principal=ADMIN)
    assert paused.checkpoint is not None

    integrity = paused.checkpoint.integrity
    assert integrity is not None
    now = int(time.time())
    # Accept at a moment past the recorded expiry, without touching the signed bytes.
    with pytest.raises(CheckpointRefusalError) as caught:
        await _signer().accept(paused.checkpoint, harness.runtime._nonces, now=integrity.expires_at)

    assert caught.value.reason == "expired"
    assert now >= integrity.issued_at
    assert recorder.calls == 0


async def test_the_same_checkpoint_is_spendable_once() -> None:
    harness, recorder, checkpoint = await _paused(signer=_signer())
    first = await harness.runtime.resume(checkpoint, HumanDecision.APPROVE)
    assert first.completed
    assert recorder.calls == 1

    with pytest.raises(CheckpointRefusalError) as caught:
        await harness.runtime.resume(checkpoint, HumanDecision.APPROVE)

    assert caught.value.reason == "replayed"
    # The first resume ran the tool; the second must not run it again.
    assert recorder.calls == 1


async def test_the_nonce_is_signed_so_it_cannot_be_swapped_to_replay() -> None:
    """Without this, replay protection is decorative: edit the nonce, look fresh."""
    harness, recorder, checkpoint = await _paused(signer=_signer())
    await harness.runtime.resume(checkpoint, HumanDecision.APPROVE)
    assert recorder.calls == 1

    assert checkpoint.integrity is not None
    respent = checkpoint.model_copy(
        update={"integrity": checkpoint.integrity.model_copy(update={"nonce": "never-seen"})}
    )

    with pytest.raises(CheckpointRefusalError) as caught:
        await harness.runtime.resume(respent, HumanDecision.APPROVE)

    assert caught.value.reason == "tampered"
    assert recorder.calls == 1


async def test_an_unsigned_checkpoint_is_refused_by_a_signed_app() -> None:
    _, recorder, checkpoint = await _paused()
    harness, _, _ = await _paused(signer=_signer())
    harness.runtime._nonces = InProcessNonceStore()

    with pytest.raises(CheckpointRefusalError) as caught:
        await harness.runtime.resume(checkpoint, HumanDecision.APPROVE)

    assert caught.value.reason == "unsigned"
    assert recorder.calls == 0


async def test_a_checkpoint_signed_with_another_key_is_refused() -> None:
    _, recorder, checkpoint = await _paused(
        signer=CheckpointSigner(secret="b" * 64, ttl_seconds=TTL)
    )
    harness, _, _ = await _paused(signer=_signer())

    with pytest.raises(CheckpointRefusalError) as caught:
        await harness.runtime.resume(checkpoint, HumanDecision.APPROVE)

    assert caught.value.reason == "tampered"
    assert recorder.calls == 0


async def test_a_runtime_without_a_signer_keeps_the_library_behaviour() -> None:
    """A direct embedder that never opted in is not silently locked out."""
    harness, recorder, checkpoint = await _paused()

    result = await harness.runtime.resume(checkpoint, HumanDecision.APPROVE)

    assert result.completed
    assert recorder.calls == 1


def test_the_signer_refuses_an_unset_or_empty_variable() -> None:
    from aid_runtime.agents import signer_from_env

    with pytest.raises(ConfigurationError) as caught:
        signer_from_env("AID_TEST_MISSING_CHECKPOINT_KEY")
    assert "AID_TEST_MISSING_CHECKPOINT_KEY" in str(caught.value)


def test_the_signer_reads_the_named_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    from aid_runtime.agents import signer_from_env

    monkeypatch.setenv("AID_TEST_CHECKPOINT_KEY", "c" * 64)
    signer = signer_from_env("AID_TEST_CHECKPOINT_KEY", ttl_seconds=60)

    assert signer.ttl_seconds == 60
