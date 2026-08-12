from fastapi.testclient import TestClient

from s6_cut.api.app import app


def test_health_exposes_secret_free_runtime_diagnostics():
    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert body["runtime"]["selected_device"] in {"cpu", "cuda"}
    assert body["runtime"]["cpu_first"] is True
    assert "whisper_model" in body["runtime"]
