"""The offline wiring the example's tests share.

`build_gateway(providers=...)`, `build_deps(gateway=..., tools=...)` and
`build_executor(lookup_customer=...)` are seams the generator emits deliberately
(see `packages/generators/py-fastapi/README.md`): a test replaces the provider or
one tool and then runs the *generated* application, rather than reimplementing
it. Nothing here reaches the network, so the eval gate below can be a CI gate.

`FakeProvider` is seeded, so every number it produces is reproducible; `accuracy`
is the knob that simulates a model getting worse.
"""

from __future__ import annotations

import json

from aid_runtime import FakeProvider, ToolExecutor

from app.generated.deps import Deps, build_deps
from app.generated.gateway import build_gateway


def _answer(category: str, confidence: float, summary: str) -> str:
    """One ideal answer, shaped the way the `Answer` schema declares it."""

    return json.dumps({"category": category, "confidence": confidence, "summary": summary})


IDEAL_ANSWERS: dict[str, str] = {
    "charged twice": _answer("billing", 0.93, "Charged twice for one subscription period."),
    "export a report": _answer("bug", 0.88, "Exporting a report crashes the application."),
    "to a CSV file": _answer("howto", 0.81, "Asks how to export their data as a CSV file."),
}
"""One ideal answer per dataset case, keyed by a phrase that case's prompt contains."""


def fake_provider(*, accuracy: float = 1.0, seed: int = 0) -> FakeProvider:
    """A seeded simulation of the `fast` model.

    At ``accuracy=1.0`` every case is answered ideally, which is how the stored
    baseline was recorded. Below 1.0 the provider returns an unparseable answer
    for a case it gets "wrong", so a lower accuracy lowers the mean of the
    `json-valid` metric -- which is the regression the gate has to catch.
    """

    return FakeProvider(answers=IDEAL_ANSWERS, accuracy=accuracy, seed=seed)


def fake_deps(
    *,
    accuracy: float = 1.0,
    seed: int = 0,
    tools: ToolExecutor | None = None,
) -> Deps:
    """The generated app's dependencies, with the network replaced by the fake provider.

    `default_providers()` is replaced wholesale, so the OpenAI adapter is never
    constructed and no API key is needed.
    """

    provider = fake_provider(accuracy=accuracy, seed=seed)
    gateway = build_gateway(providers={"fake": provider, "openai": provider})
    return build_deps(gateway=gateway, tools=tools)
