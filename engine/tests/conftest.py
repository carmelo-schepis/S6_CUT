from __future__ import annotations

import atexit
import os
import shutil
import tempfile
from pathlib import Path

import pytest

_test_root = Path(tempfile.mkdtemp(prefix="s6-cut-tests-"))
atexit.register(shutil.rmtree, _test_root, ignore_errors=True)
os.environ.setdefault("S6_DATA_PATH", str(_test_root / "app-data"))
os.environ.setdefault("S6_MAX_QUEUED_JOBS", "12")


@pytest.fixture()
def tmp_path():
    """Environment-safe per-test path cleaned after process handles close."""
    return Path(tempfile.mkdtemp(prefix="case-", dir=_test_root))


@pytest.fixture(autouse=True)
def reset_creation_rate_limit():
    """Project creation is limited to 10 per minute per client; tests share one
    TestClient address, so a long suite would otherwise trip a 429 depending on
    how fast the preceding tests ran."""
    import sys

    module = sys.modules.get("engine.app")
    if module is not None:
        module.creation_times.clear()
    yield
