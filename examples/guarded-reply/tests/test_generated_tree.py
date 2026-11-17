"""The test `aid gen` scaffolds so `pytest` has something to collect.

The scaffolded CI runs `pytest -q`, which exits 5 when it collects nothing, so a
project with no tests yet would fail for the wrong reason. This asserts what is true
of every generated tree: the schemas module exists and imports.
"""

import importlib


def test_the_generated_tree_imports() -> None:
    module = importlib.import_module("app.generated.schemas")

    assert module.__name__ == "app.generated.schemas"
