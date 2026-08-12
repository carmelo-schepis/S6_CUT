"""GET /api/status caps the returned log tail.

The per-job log buffer is bounded at the producer (job_worker.MAX_LOG_LINES),
but the status response slices to the last 500 lines so a long job never ships
a multi-thousand-line payload on every 2s poll. Driven with TestClient WITHOUT
the lifespan (same pattern as test_job_controls).
"""
from fastapi.testclient import TestClient

from clippyme.api import app as app_module

JOB_ID = "22222222-2222-4222-8222-222222222222"
ORIGIN = {"Origin": "http://localhost:5175"}


def _client():
    return TestClient(app_module.app, headers=ORIGIN)


def test_status_logs_sliced_to_last_500():
    app_module.jobs.pop(JOB_ID, None)
    try:
        app_module.jobs[JOB_ID] = {
            "status": "processing",
            "logs": [f"line {i}" for i in range(1500)],
            "result": None,
        }
        r = _client().get(f"/api/status/{JOB_ID}")
        assert r.status_code == 200
        logs = r.json().get("logs", [])
        assert len(logs) == 500
        assert logs[-1] == "line 1499"
        assert logs[0] == "line 1000"
    finally:
        app_module.jobs.pop(JOB_ID, None)


def test_status_short_logs_unchanged():
    app_module.jobs.pop(JOB_ID, None)
    try:
        app_module.jobs[JOB_ID] = {
            "status": "processing",
            "logs": ["a", "b", "c"],
            "result": None,
        }
        r = _client().get(f"/api/status/{JOB_ID}")
        assert r.status_code == 200
        assert r.json().get("logs") == ["a", "b", "c"]
    finally:
        app_module.jobs.pop(JOB_ID, None)
