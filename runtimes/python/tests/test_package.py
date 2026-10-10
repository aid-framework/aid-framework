"""Package-level invariants.

These lock the packaging facts other layers and the CI job depend on, and turn two
ratified design decisions -- "no orchestration dependency" and "one HTTP adapter
only" -- into executable checks rather than prose in a plan.
"""

from __future__ import annotations

import inspect
import re
import tomllib
from pathlib import Path
from typing import Any

import aid_runtime

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = PACKAGE_ROOT / "pyproject.toml"

#: Orchestration libraries deferred to Phase 2. Adopting one before the branching
#: and interrupt requirements exist would put an unobservable graph between a user
#: and their own trace.
BANNED_ORCHESTRATION = (
    "langgraph",
    "langchain",
    "crewai",
    "autogen",
    "haystack",
    "llama-index",
    "dspy",
)

#: One HTTP provider adapter is the whole of Phase 0's vendor surface.
EXPECTED_RUNTIME_DEPENDENCIES = (
    "httpx",
    "opentelemetry-api",
    "pydantic",
    "pydantic-ai-slim",
)

#: Every tool the `python` CI job invokes must be declared here, or the job would
#: be relying on whatever the runner image happens to ship.
EXPECTED_GATE_TOOLS = ("mypy", "opentelemetry-sdk", "pytest", "pytest-asyncio", "ruff")


def _load_pyproject() -> dict[str, Any]:
    return tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))


def _names(entries: list[str]) -> list[str]:
    """Peel a PEP 508 requirement down to its distribution name."""
    return sorted(re.split(r"[<>=!~ ]", entry)[0] for entry in entries)


def test_version_matches_pyproject() -> None:
    """The barrel's ``__version__`` is what callers read, so it must not drift."""
    assert aid_runtime.__version__ == _load_pyproject()["project"]["version"]


def test_distribution_name_differs_from_import_package() -> None:
    """Documents the intentional asymmetry that trips up every first-time user."""
    assert _load_pyproject()["project"]["name"] == "aid-runtime-python"
    assert aid_runtime.__name__ == "aid_runtime"


def test_requires_python_matches_ruff_target() -> None:
    config = _load_pyproject()
    assert config["project"]["requires-python"] == ">=3.11"
    assert config["tool"]["ruff"]["target-version"] == "py311"


def test_runtime_dependencies_are_exactly_the_declared_seam() -> None:
    declared = _names(_load_pyproject()["project"]["dependencies"])
    assert declared == list(EXPECTED_RUNTIME_DEPENDENCIES)


def test_no_orchestration_dependency_is_declared() -> None:
    """Phase 0 control flow is plain async; this is the enforcement point."""
    config = _load_pyproject()
    every = list(config["project"]["dependencies"])
    for extra in config["project"]["optional-dependencies"].values():
        every.extend(extra)
    joined = " ".join(every).lower()
    for banned in BANNED_ORCHESTRATION:
        assert banned not in joined, f"{banned} is deferred to Phase 2"


def test_gate_tools_are_declared_in_the_dev_extra() -> None:
    dev = _names(_load_pyproject()["project"]["optional-dependencies"]["dev"])
    for tool in EXPECTED_GATE_TOOLS:
        assert tool in dev, f"the python CI job would invoke undeclared tool {tool}"


def test_all_names_resolve() -> None:
    for name in aid_runtime.__all__:
        assert hasattr(aid_runtime, name), f"{name} is exported but missing"


def test_all_is_unique() -> None:
    exported = aid_runtime.__all__
    duplicates = sorted({name for name in exported if exported.count(name) > 1})
    assert duplicates == []


def test_all_groups_constants_before_names() -> None:
    """``__all__`` is grouped for readability; within each group it is sorted."""
    exported = list(aid_runtime.__all__)
    constants = [name for name in exported if name.isupper()]
    others = [name for name in exported if name not in constants]
    assert exported == constants + others, "constants must come first, then names"
    assert constants == sorted(constants)
    assert others == sorted(others)


def test_every_exported_class_and_function_is_ours() -> None:
    """Catches an accidental re-export of a third-party symbol as AID API."""
    for name in aid_runtime.__all__:
        target = getattr(aid_runtime, name)
        if not (inspect.isclass(target) or inspect.isfunction(target)):
            continue
        module = getattr(target, "__module__", "")
        assert module.startswith("aid_runtime"), f"{name} originates in {module}"


def test_py_typed_marker_is_shipped() -> None:
    """Without this file downstream type checkers ignore every annotation here."""
    assert (PACKAGE_ROOT / "src" / "aid_runtime" / "py.typed").is_file()
