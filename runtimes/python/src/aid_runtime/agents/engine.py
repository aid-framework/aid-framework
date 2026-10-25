"""The agent-engine seam: which backend runs an agent, and on exactly which release.

Deep Agents is an *orchestration backend* selected per agent, never the IR, never
the gateway, and never the only implementation. ``native`` stays the default; both
backends run the conformance corpus. This module owns the two facts that decide
whether a ``deepagents`` agent may start at all:

**The pin.** :data:`DEEPAGENTS_PIN` is the single authoritative record of the Deep
Agents release this runtime was built and measured against. It is a bare constant
rather than a range because a range is the thing pinning exists to prevent: the
harness's middleware stack, its recursion accounting and its interrupt payload all
move between releases, so an unpinned backend would change behaviour under a
stored eval baseline. ``pyproject.toml`` installs the same version, and
:func:`check_engine` compares the IR's ``engineVersion`` against *this* constant,
not against whatever wheel happens to be importable.

**Fail closed, in one place.** Every reason a ``deepagents`` agent cannot run --
unknown engine, transfer declared, missing pin, mismatched pin, missing extra --
is raised from :func:`check_engine`. Putting them together means there is one
function to read to know whether an engine is supported, and no second path that
could grow a silent fallback to the native loop. A runtime that quietly ran a
``deepagents`` agent on the native engine would leave ``engine`` in the IR
meaning nothing at all.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version

from aid_runtime.agents.ir import AgentDefinition
from aid_runtime.errors import (
    AgentHandoffUnsupportedError,
    ConfigurationError,
    DeepAgentsUnavailableError,
    DeepAgentsVersionMismatchError,
)

__all__ = [
    "DEEPAGENTS",
    "DEEPAGENTS_PIN",
    "ENGINES",
    "NATIVE",
    "check_engine",
    "installed_deepagents_version",
]

#: The default engine, and the one every existing agent keeps using.
NATIVE = "native"

#: The Deep Agents backend.
DEEPAGENTS = "deepagents"

#: The closed set of engines the IR may name.
ENGINES = frozenset({NATIVE, DEEPAGENTS})

#: The one authoritative pin. Measured from PyPI, mirrored in
#: ``pyproject.toml``'s ``deepagents`` extra, and compared against the IR's
#: ``engineVersion`` at run time.
DEEPAGENTS_PIN = "0.7.32"

#: The optional extra that installs the harness.
DEEPAGENTS_EXTRA = "aid-runtime-python[deepagents]"

#: The distribution the extra installs.
DEEPAGENTS_DISTRIBUTION = "deepagents"


def installed_deepagents_version() -> str | None:
    """The installed ``deepagents`` version, or ``None`` when the extra is absent.

    Deliberately read from installed metadata rather than by importing the
    package: importing the harness would pull LangChain into every runtime that
    merely *declares* the extra, and the version question is answerable without
    paying for that.
    """
    try:
        return distribution_version(DEEPAGENTS_DISTRIBUTION)
    except PackageNotFoundError:
        return None


def check_engine(agent: AgentDefinition) -> str:
    """Validate this agent's engine, or raise the reason it cannot run.

    Returns the validated engine name. ``native`` always passes; ``deepagents``
    passes only when it declares no handoffs, pins ``engineVersion`` to the
    version this runtime is built for, and the extra is actually installed.
    """
    if agent.engine == NATIVE:
        return NATIVE
    if agent.engine != DEEPAGENTS:
        raise ConfigurationError(
            f"agent {agent.id!r} declares engine {agent.engine!r}; the IR admits {sorted(ENGINES)}"
        )
    if agent.handoffs:
        raise AgentHandoffUnsupportedError(agent.id, agent.handoffs, DEEPAGENTS)
    if agent.engine_version != DEEPAGENTS_PIN:
        raise DeepAgentsVersionMismatchError(agent.id, agent.engine_version, DEEPAGENTS_PIN)
    if installed_deepagents_version() is None:
        raise DeepAgentsUnavailableError(DEEPAGENTS_EXTRA, DEEPAGENTS_DISTRIBUTION)
    return DEEPAGENTS
