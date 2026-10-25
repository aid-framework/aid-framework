"""Deterministic variant generation for the red-team corpus.

The point of a variant is to answer one question: does the detector still fire when
the attack arrives wrapped in ordinary prose? Carriers therefore only add text
around the payload, and case transforms are applied only where the detector is
case-insensitive. A transform that could break detection -- inserting punctuation
inside a phrase, splitting a digit run -- is deliberately absent, because a variant
the detector misses would be measuring the generator rather than the engine.

Seeding is by content, not by call order: two callers asking for variants of the
same payload get the same variants, and adding a fixture cannot renumber the rest.
No network, no clock, no environment reads: ``random.Random`` seeded with a string
uses a stable hash, so the output is identical in CI and locally.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

#: Wrappers that only ever add surrounding text. ``{payload}`` is the identity.
CARRIERS: tuple[str, ...] = (
    "{payload}",
    "Quick question before I continue: {payload}",
    "{payload}\n\nThanks in advance!",
    "CONTEXT: quarterly report\n{payload}\nEND CONTEXT",
    'A colleague wrote: "{payload}" -- can you handle that?',
)

#: Policies whose patterns are all ``re.IGNORECASE``. Case perturbation is applied
#: only to these; the credential and PII patterns are case-sensitive or anchored on
#: digits, so folding them would test something the detector never claimed.
CASE_INSENSITIVE: frozenset[str] = frozenset(
    {"prompt-injection", "jailbreak", "moderation", "toxicity"}
)


@dataclass(frozen=True, slots=True)
class Variant:
    """One generated payload, with enough context to explain a failure."""

    text: str
    carrier: int
    folded: bool

    @property
    def description(self) -> str:
        kind = "case-folded" if self.folded else "verbatim"
        return f"carrier {self.carrier}, {kind}"


def _fold(payload: str, rng: random.Random) -> str:
    return "".join(
        character.upper() if rng.random() < 0.5 else character.lower() for character in payload
    )


def variants(
    payload: str,
    *,
    policy: str,
    count: int = 3,
    seed: int = 0,
) -> tuple[Variant, ...]:
    """``count`` deterministic variants of ``payload``, the first one unmodified."""
    if count < 1:
        raise ValueError(f"count must be at least 1, got {count}")
    # Reproducibility, not secrecy: a seeded Mersenne twister is exactly right here
    # and a cryptographic source would make the corpus unrepeatable.
    rng = random.Random(f"{seed}:{policy}:{payload}")  # noqa: S311
    foldable = policy in CASE_INSENSITIVE
    generated: list[Variant] = []
    for position in range(count):
        carrier = position % len(CARRIERS)
        folded = foldable and position % 2 == 1
        body = _fold(payload, rng) if folded else payload
        generated.append(
            Variant(text=CARRIERS[carrier].format(payload=body), carrier=carrier, folded=folded)
        )
    return tuple(generated)
