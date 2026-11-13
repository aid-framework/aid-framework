"""The environment the generated app needs before it will serve an agent run.

`app.spec.yaml` declares `state.signingKeyEnv: AID_CHECKPOINT_KEY`, and the generated
route refuses to run without it: a key that is read lazily fails at the first approval,
which is the worst moment to discover it. Declaring the variable means *every* run needs
it, including the pipeline's `triage` step, which can never pause -- so the tests set it
here rather than in one file.

The values are a test key and a temporary database, never anything a deployment would
use; the real pair comes from the release's secret manager, which the generated deploy
plan names (`tofu`/`cdk` output, `serviceSecrets`).
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest


@pytest.fixture(scope="session", autouse=True)
def checkpoint_environment(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """Point the checkpoint signer and the replay store at throwaway resources."""

    state_db = tmp_path_factory.mktemp("state") / "aid-state.db"
    previous = {
        name: os.environ.get(name)
        for name in ("AID_CHECKPOINT_KEY", "AID_STATE_DB")
    }
    os.environ["AID_CHECKPOINT_KEY"] = "test-key-not-used-in-a-deployment"
    os.environ["AID_STATE_DB"] = str(state_db)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
