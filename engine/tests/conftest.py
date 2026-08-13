from __future__ import annotations

import os
import tempfile


os.environ.setdefault("S6_DATA_PATH", tempfile.mkdtemp(prefix="s6-cut-tests-"))
os.environ.setdefault("S6_MAX_QUEUED_JOBS", "12")
