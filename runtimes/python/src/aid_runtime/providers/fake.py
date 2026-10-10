"""A deterministic provider for tests.

This is not a mock in the "returns a canned value" sense. It is a *seeded
simulation* of a probabilistic model: given the same seed and the same request it
produces byte-identical output, but it deliberately answers correctly only a
configurable fraction of the time. That is the whole point -- it lets the eval
gate be tested against genuine non-determinism, so a test can prove that run-to-run
variation is tolerated while a real regression is caught.
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Callable, Mapping, Sequence

from aid_runtime.errors import ProviderError
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    ModelSpec,
    TokenUsage,
)

__all__ = ["FakeProvider"]

# A responder sees the request and returns the model's text. Receiving the index
# of the call lets a responder model "the third call fails" without mutable state.
Responder = Callable[[CompletionRequest, int], str]


class FakeProvider:
    """Deterministic, seedable, and optionally inaccurate."""

    def __init__(
        self,
        *,
        responder: Responder | None = None,
        answers: Mapping[str, str] | None = None,
        accuracy: float = 1.0,
        seed: int = 0,
        name: str = "fake",
        fail_with: Sequence[str] = (),
        tokens_per_char: float = 0.25,
        overhead_tokens: int = 8,
    ) -> None:
        if not 0.0 <= accuracy <= 1.0:
            raise ValueError("accuracy must be between 0.0 and 1.0")
        self._responder = responder
        # `answers` maps the *user message* to the ideal response, which lets a
        # test wire a dataset to a provider without writing a callable.
        self._answers = dict(answers or {})
        self._accuracy = accuracy
        self._seed = seed
        self._name = name
        # Each entry is a message for a successive call. Once exhausted the
        # provider behaves normally, so a test can prove retry-then-succeed.
        self._failures = list(fail_with)
        self._tokens_per_char = tokens_per_char
        self._overhead_tokens = overhead_tokens
        self.calls: list[CompletionRequest] = []

    @property
    def name(self) -> str:
        return self._name

    @property
    def capabilities(self) -> frozenset[Capability]:
        return frozenset(
            {
                Capability.TOOL_CALLING,
                Capability.STRUCTURED_OUTPUT,
                Capability.STREAMING,
                Capability.LONG_CONTEXT,
            }
        )

    async def complete(self, request: CompletionRequest, *, model: ModelSpec) -> CompletionResponse:
        self.calls.append(request)
        index = len(self.calls) - 1

        if self._failures:
            raise ProviderError(str(self._failures.pop(0)))

        text = self._respond_to(request, index)
        return CompletionResponse(
            text=text,
            model=model.name,
            provider=self._name,
            usage=TokenUsage(
                input_tokens=self._count_tokens(_prompt_text(request)),
                output_tokens=self._count_tokens(text),
            ),
            finish_reason="stop",
        )

    async def aclose(self) -> None:
        return None

    def _respond_to(self, request: CompletionRequest, index: int) -> str:
        if self._responder is not None:
            return self._responder(request, index)

        prompt = _prompt_text(request)
        ideal = self._answers.get(prompt)
        if ideal is None:
            for key, value in self._answers.items():
                if key in prompt:
                    ideal = value
                    break

        if ideal is None:
            # No expectation to hit, so accuracy does not apply: echo deterministically.
            return f"echo:{_digest(prompt, self._seed)}"

        if self._accuracy >= 1.0:
            return ideal
        if self._draw(prompt, index) < self._accuracy:
            return ideal
        # A wrong answer must still be deterministic and visibly wrong.
        return f"{ideal}#{_digest(prompt, self._seed + index)}"

    def _draw(self, prompt: str, index: int) -> float:
        """A stable pseudo-random draw for this (seed, call index, prompt) triple.

        Deriving the draw from a hash rather than a sequential PRNG stream means a
        recorded baseline reproduces exactly: the same call in the same position
        always draws the same number. It is deliberately *not* stable across
        positions -- the call index is part of the input -- so re-running a dataset
        re-draws every case and an N-run sample genuinely varies. That variation is
        what the eval gate has to tolerate, so it has to exist here.
        """
        rng = random.Random(f"{self._seed}:{index}:{prompt}")
        return rng.random()

    def _count_tokens(self, text: str) -> int:
        return int(len(text) * self._tokens_per_char) + self._overhead_tokens


def _prompt_text(request: CompletionRequest) -> str:
    return "\n".join(message.content for message in request.messages)


def _digest(prompt: str, seed: int) -> str:
    return hashlib.sha256(f"{seed}:{prompt}".encode()).hexdigest()[:8]


def with_accuracy(accuracy: float, *, seed: int = 0) -> FakeProvider:
    """Convenience factory used by the eval-gate tests."""
    return FakeProvider(accuracy=accuracy, seed=seed)
