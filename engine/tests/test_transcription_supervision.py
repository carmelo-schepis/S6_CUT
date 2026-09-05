from __future__ import annotations

import multiprocessing as mp
from pathlib import Path
from typing import Any

from engine.config import Settings
from engine.transcription import supervise


def _successful_worker(run_id: str, path: str, settings: Settings, events: Any) -> None:
    """Picklable worker used to exercise the real spawn boundary."""
    events.put({"type": "started", "run_id": run_id})
    events.put({"type": "progress", "run_id": run_id, "fraction": .5, "detail": Path(path).name})
    events.put({"type": "completed", "run_id": run_id, "result": {"language": "en", "words": [], "segments": []}})


def test_supervision_uses_a_fresh_spawned_interpreter(monkeypatch, tmp_path: Path) -> None:
    """A threaded server must not fork native Whisper/OpenMP state."""
    requested: list[str] = []
    real_get_context = mp.get_context

    def observed_get_context(method: str):
        requested.append(method)
        return real_get_context(method)

    monkeypatch.setattr("engine.transcription.mp.get_context", observed_get_context)
    source = tmp_path / "audio.wav"
    source.write_bytes(b"test")

    result = supervise(source, Settings.from_env(), worker=_successful_worker)

    assert requested == ["spawn"]
    assert result == {"language": "en", "words": [], "segments": []}
